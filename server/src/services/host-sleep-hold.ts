import { execFileSync } from "node:child_process";
import { logger } from "../middleware/logger.js";

// Host-sleep hold: a process-local hold on new run admission while the host
// sleeps, including the short dark wakes (Power Nap, maintenance) a closed
// laptop makes, and for HOST_AWAKE_MS after the last sleep. A run started in
// a dark wake dies at the next sleep and spends a retry, so admission waits
// until the host is awake for good.
//
// index.ts starts the watch as soon as it makes the heartbeat service, before
// the server listens or startup recovery runs, and stops it at shutdown.
// Startup recovery waits for the hold to lift (waitUntilHostAwake).
// resolveHeartbeatSchedulingSuppression() in heartbeat.ts reads
// isHostSleepHeld() and reports the hold as the `host_sleep` reason, which
// keeps wakes queued like a task drain. With the watch off (tests, a disabled
// scheduler) nothing is ever held.
//
// Detection: a 1 s unref'd interval records Date.now(). The wall clock moves
// on while the host sleeps, so the first tick after a sleep sees a gap larger
// than HOST_SLEEP_GAP_MS. An event-loop stall that long reads as a sleep too; its
// cost is the hold delay only. A process has no tick from before it started,
// so on macOS the watch also seeds the hold from the kernel's last wake time
// (kern.waketime): a process started less than HOST_AWAKE_MS after a wake, as
// in a dark wake, holds like a running one. Other platforms have no seed.

export const HOST_SLEEP_GAP_MS = 5_000;
export const HOST_AWAKE_MS = 120_000;
const HOST_SLEEP_TICK_MS = 1_000;

let lastTickAt: number | null = null;
// sleptMs and sleeps add up every sleep seen since the hold started.
let hold: { startedAt: number; lastGapAt: number; sleptMs: number; sleeps: number } | null = null;
let tickInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Record one detector tick at `now` (ms since epoch). The watch calls it every
 * second; tests call it with an injected clock. A gap over HOST_SLEEP_GAP_MS
 * since the last tick starts the hold or extends it; HOST_AWAKE_MS of ticks
 * with no gap lifts it. Logs at hold start, at each further sleep, and at lift.
 */
export function recordHostSleepTick(now: number): void {
  if (lastTickAt !== null) {
    const gapMs = now - lastTickAt;
    if (gapMs > HOST_SLEEP_GAP_MS) {
      if (hold === null) {
        hold = { startedAt: now, lastGapAt: now, sleptMs: gapMs, sleeps: 1 };
        logger.info(
          { sleptMs: hold.sleptMs, heldMs: 0, sleeps: hold.sleeps },
          "host sleep detected; holding run admission",
        );
      } else {
        hold.lastGapAt = now;
        hold.sleptMs += gapMs;
        hold.sleeps += 1;
        logger.info(
          { sleptMs: hold.sleptMs, heldMs: now - hold.startedAt, sleeps: hold.sleeps },
          "host slept again; run admission stays held",
        );
      }
    } else if (hold !== null && now - hold.lastGapAt >= HOST_AWAKE_MS) {
      logger.info(
        { sleptMs: hold.sleptMs, heldMs: now - hold.startedAt, sleeps: hold.sleeps },
        "host awake; run admission resumed",
      );
      hold = null;
    }
  }
  lastTickAt = now;
}

/**
 * True while run admission must wait for the host. Also true when no tick has
 * come for more than HOST_SLEEP_GAP_MS: right after a wake, an overdue timer
 * can run before the detector's own tick, and it must not see a stale "awake".
 * False while the watch is off.
 */
export function isHostSleepHeld(now: number): boolean {
  if (lastTickAt === null) return false;
  if (now - lastTickAt > HOST_SLEEP_GAP_MS) return true;
  return hold !== null && now - hold.lastGapAt < HOST_AWAKE_MS;
}

/** Parse one sysctl timeval line, `{ sec = N, usec = M } <date>`, to ms since epoch. */
export function parseSysctlTimevalMs(line: string): number | null {
  const match = /\{ sec = (\d+), usec = (\d+) \}/.exec(line);
  return match ? Number(match[1]) * 1_000 + Math.floor(Number(match[2]) / 1_000) : null;
}

/**
 * The kernel's last wake and last sleep time, on macOS only. Null on any other
 * platform and on any error, so a failed read means no seed.
 */
export function readKernelWakeMs(): { wakeMs: number; sleepMs: number } | null {
  if (process.platform !== "darwin") return null;
  try {
    const [wakeLine = "", sleepLine = ""] = execFileSync(
      "/usr/sbin/sysctl",
      ["-n", "kern.waketime", "kern.sleeptime"],
      { encoding: "utf8", timeout: 1_000 },
    ).split("\n");
    const wakeMs = parseSysctlTimevalMs(wakeLine);
    const sleepMs = parseSysctlTimevalMs(sleepLine);
    return wakeMs === null || sleepMs === null ? null : { wakeMs, sleepMs };
  } catch {
    return null;
  }
}

/**
 * Start the detector. Calling it again restarts it with a clear state. When
 * the kernel woke less than HOST_AWAKE_MS ago, the hold starts at once and
 * lifts HOST_AWAKE_MS after that wake, unless the host sleeps again.
 * `readKernelWake` is for tests.
 */
export function startHostSleepWatch({
  readKernelWake = readKernelWakeMs,
}: { readKernelWake?: () => { wakeMs: number; sleepMs: number } | null } = {}): void {
  stopHostSleepWatch();
  const now = Date.now();
  recordHostSleepTick(now);
  let kernel: { wakeMs: number; sleepMs: number } | null = null;
  try {
    kernel = readKernelWake();
  } catch {
    kernel = null;
  }
  if (kernel && now - kernel.wakeMs >= 0 && now - kernel.wakeMs < HOST_AWAKE_MS) {
    hold = {
      startedAt: now,
      lastGapAt: kernel.wakeMs,
      sleptMs: Math.max(0, kernel.wakeMs - kernel.sleepMs),
      sleeps: 1,
    };
    logger.info(
      { sleptMs: hold.sleptMs, wokeMsAgo: now - kernel.wakeMs },
      "host woke shortly before this process started; holding run admission",
    );
  }
  tickInterval = setInterval(() => recordHostSleepTick(Date.now()), HOST_SLEEP_TICK_MS);
  tickInterval.unref?.();
}

/** Resolve once the hold lifts, or once `stopped()` is true. Startup recovery awaits it. */
export async function waitUntilHostAwake(stopped: () => boolean): Promise<void> {
  while (isHostSleepHeld(Date.now()) && !stopped()) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

/** Stop the detector and clear the hold, so nothing reads as held. */
export function stopHostSleepWatch(): void {
  if (tickInterval) clearInterval(tickInterval);
  tickInterval = null;
  lastTickAt = null;
  hold = null;
}
