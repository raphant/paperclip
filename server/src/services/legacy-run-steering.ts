import { NativeSessionSteeringError } from "./native-runtime/native-session-executor.js";

type Steer = (message: string) => Promise<void>;

// In memory, like the native session map: a server restart ends every local run.
const steerByRunId = new Map<string, Steer>();

/**
 * Records whether a running legacy (direct-adapter) run can take a message now.
 * Heartbeat passes this to the adapter as `onSteerable` and clears the run when
 * the adapter returns.
 */
export function setLegacyRunSteering(runId: string, steer: Steer | null) {
  if (steer) steerByRunId.set(runId, steer);
  else steerByRunId.delete(runId);
}

/** True while the run's adapter takes messages. The queued-comment queue reads it. */
export function legacyRunCanSteer(runId: string): boolean {
  return steerByRunId.has(runId);
}

/**
 * Delivers a queued message into a running legacy run, with the same contract
 * as `steerNativeSession`. A legacy run has no provider turn ids, so the run id
 * stands for the turn. A refusal is `steering_rejected`, so the steer route
 * rejects the reserved identity and the message stays queued. A run that does
 * not answer within `timeoutMs` (default 10 s) is `steering_timeout`: the route
 * treats that as uncertain, and `onAcknowledged` still settles the identity if
 * the run takes the message later.
 */
export async function steerLegacyRun(input: {
  runId: string;
  message: string;
  onAcknowledged?: () => Promise<void>;
  timeoutMs?: number;
}): Promise<{ turnId: string }> {
  const steer = steerByRunId.get(input.runId);
  if (!steer) {
    throw new NativeSessionSteeringError(
      "steering_temporarily_unavailable",
      "The run no longer takes messages.",
    );
  }
  const delivery = Promise.resolve()
    .then(() => steer(input.message))
    .catch((error: unknown) => {
      throw new NativeSessionSteeringError(
        "steering_rejected",
        error instanceof Error ? error.message : "The run did not take the message.",
      );
    });
  // Like the native path: settle the identity outside the route's lock, which
  // is held until this returns.
  if (input.onAcknowledged)
    void delivery.then(input.onAcknowledged).catch(() => undefined);
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      delivery,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () =>
            reject(
              new NativeSessionSteeringError(
                "steering_timeout",
                "The run did not take the message in time.",
              ),
            ),
          input.timeoutMs ?? 10_000,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
  return { turnId: input.runId };
}
