import { afterEach, describe, expect, it, vi } from "vitest";

const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock("../middleware/logger.js", () => ({ logger: mockLogger }));

import {
  HOST_AWAKE_MS,
  isHostSleepHeld,
  parseSysctlTimevalMs,
  recordHostSleepTick,
  startHostSleepWatch,
  stopHostSleepWatch,
  waitUntilHostAwake,
} from "../services/host-sleep-hold.ts";

const T0 = Date.parse("2026-11-19T20:59:00.000Z");

// Ticks once a second from `from` up to and including `to`.
function tickEverySecond(from: number, to: number) {
  for (let t = from; t <= to; t += 1_000) recordHostSleepTick(t);
}

describe("host-sleep hold", () => {
  afterEach(() => {
    stopHostSleepWatch();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("never holds before the first tick or while ticks come every second", () => {
    expect(isHostSleepHeld(T0)).toBe(false);
    expect(isHostSleepHeld(T0 + 600_000)).toBe(false);

    for (let t = T0; t <= T0 + 300_000; t += 1_000) {
      recordHostSleepTick(t);
      expect(isHostSleepHeld(t)).toBe(false);
      expect(isHostSleepHeld(t + 999)).toBe(false);
    }
    expect(mockLogger.info).not.toHaveBeenCalled();
  });

  it("holds after a gap over 5 s, through a 5 s and a 62 s dark wake, and re-arms on a second gap", () => {
    tickEverySecond(T0, T0 + 10_000);
    const wake1 = T0 + 10_000 + 900_000;
    recordHostSleepTick(wake1);
    expect(isHostSleepHeld(wake1)).toBe(true);

    // A 5 s dark wake, then sleep, then a 62 s dark wake: held throughout.
    tickEverySecond(wake1 + 1_000, wake1 + 5_000);
    expect(isHostSleepHeld(wake1 + 5_000)).toBe(true);
    const wake2 = wake1 + 5_000 + 600_000;
    recordHostSleepTick(wake2);
    for (let t = wake2; t <= wake2 + 62_000; t += 1_000) {
      recordHostSleepTick(t);
      expect(isHostSleepHeld(t)).toBe(true);
    }

    // The second gap restarted the 120 s count: still held 119 s after it,
    // which is more than 120 s after the first gap.
    tickEverySecond(wake2 + 63_000, wake2 + 119_000);
    expect(isHostSleepHeld(wake2 + 119_000)).toBe(true);
  });

  it("holds at the wake instant, before the detector's first tick after the gap", () => {
    tickEverySecond(T0, T0 + 10_000);
    // An overdue one-shot timer runs first after the wake; the detector's
    // tick has not run yet, so nothing has recorded the gap.
    expect(isHostSleepHeld(T0 + 10_000 + 5_001)).toBe(true);
    expect(isHostSleepHeld(T0 + 10_000 + 900_000)).toBe(true);
  });

  it("lifts after 120 s of ticks with no gap and logs start, further sleep, and lift", () => {
    tickEverySecond(T0, T0 + 10_000);
    const wake1 = T0 + 10_000 + 900_000;
    recordHostSleepTick(wake1);
    tickEverySecond(wake1 + 1_000, wake1 + 3_000);
    const wake2 = wake1 + 3_000 + 300_000;
    recordHostSleepTick(wake2);

    tickEverySecond(wake2 + 1_000, wake2 + HOST_AWAKE_MS - 1_000);
    expect(isHostSleepHeld(wake2 + HOST_AWAKE_MS - 1_000)).toBe(true);
    recordHostSleepTick(wake2 + HOST_AWAKE_MS);
    expect(isHostSleepHeld(wake2 + HOST_AWAKE_MS)).toBe(false);

    expect(mockLogger.info.mock.calls).toEqual([
      [{ sleptMs: 900_000, heldMs: 0, sleeps: 1 }, "host sleep detected; holding run admission"],
      [{ sleptMs: 1_200_000, heldMs: 303_000, sleeps: 2 }, "host slept again; run admission stays held"],
      [{ sleptMs: 1_200_000, heldMs: 303_000 + HOST_AWAKE_MS, sleeps: 2 }, "host awake; run admission resumed"],
    ]);
  });

  describe("a process that starts in or near a short wake", () => {
    it("holds at start when the kernel woke 2 s ago, still holds 60 s later, and lifts at wake + 120 s", () => {
      vi.useFakeTimers({ now: T0 });
      const wakeMs = T0 - 2_000;
      startHostSleepWatch({ readKernelWake: () => ({ wakeMs, sleepMs: wakeMs - 900_000 }) });
      expect(isHostSleepHeld(Date.now())).toBe(true);
      expect(mockLogger.info).toHaveBeenCalledWith(
        { sleptMs: 900_000, wokeMsAgo: 2_000 },
        "host woke shortly before this process started; holding run admission",
      );

      vi.advanceTimersByTime(60_000);
      expect(isHostSleepHeld(Date.now())).toBe(true);
      vi.advanceTimersByTime(wakeMs + HOST_AWAKE_MS - Date.now() - 1_000);
      expect(isHostSleepHeld(Date.now())).toBe(true);
      vi.advanceTimersByTime(1_000);
      expect(Date.now()).toBe(wakeMs + HOST_AWAKE_MS);
      expect(isHostSleepHeld(Date.now())).toBe(false);
    });

    it("does not hold after a wake 3 h ago, or when the reader returns null or throws", () => {
      vi.useFakeTimers({ now: T0 });
      const readers = [
        () => ({ wakeMs: T0 - 3 * 3_600_000, sleepMs: T0 - 4 * 3_600_000 }),
        () => null,
        () => {
          throw new Error("sysctl failed");
        },
      ];
      for (const readKernelWake of readers) {
        startHostSleepWatch({ readKernelWake });
        expect(isHostSleepHeld(Date.now())).toBe(false);
        vi.advanceTimersByTime(10_000);
        expect(isHostSleepHeld(Date.now())).toBe(false);
      }
      expect(mockLogger.info).not.toHaveBeenCalled();
    });

    it("parses the real kern.waketime output to ms since epoch", () => {
      expect(parseSysctlTimevalMs("{ sec = 1795149290, usec = 999315 } Thu Nov 19 22:34:50 2026")).toBe(1795149290999);
      expect(parseSysctlTimevalMs("")).toBeNull();
    });

    it("waitUntilHostAwake resolves at the lift, and at once when stopped", async () => {
      vi.useFakeTimers({ now: T0 });
      startHostSleepWatch({ readKernelWake: () => ({ wakeMs: T0, sleepMs: T0 - 60_000 }) });
      let resolvedAt: number | null = null;
      const waiting = waitUntilHostAwake(() => false).then(() => {
        resolvedAt = Date.now();
      });
      await vi.advanceTimersByTimeAsync(HOST_AWAKE_MS - 1_000);
      expect(resolvedAt).toBeNull();
      await vi.advanceTimersByTimeAsync(1_000);
      await waiting;
      expect(resolvedAt).toBe(T0 + HOST_AWAKE_MS);

      startHostSleepWatch({ readKernelWake: () => ({ wakeMs: Date.now(), sleepMs: Date.now() - 60_000 }) });
      expect(isHostSleepHeld(Date.now())).toBe(true);
      const stoppedAt = Date.now();
      await waitUntilHostAwake(() => true);
      expect(Date.now()).toBe(stoppedAt);
    });
  });
});
