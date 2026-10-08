import { afterEach, describe, expect, it, vi } from "vitest";
import { legacyRunCanSteer, setLegacyRunSteering, steerLegacyRun } from "./legacy-run-steering.js";

describe("legacy run steering", () => {
  afterEach(() => setLegacyRunSteering("run-1", null));

  it("delivers to the run's adapter and acknowledges with the run id", async () => {
    const steer = vi.fn(async () => {});
    const onAcknowledged = vi.fn(async () => {});
    setLegacyRunSteering("run-1", steer);

    expect(legacyRunCanSteer("run-1")).toBe(true);
    await expect(steerLegacyRun({ runId: "run-1", message: "hi", onAcknowledged })).resolves.toEqual({
      turnId: "run-1",
    });
    expect(steer).toHaveBeenCalledWith("hi");
    expect(onAcknowledged).toHaveBeenCalledTimes(1);
  });

  it("is temporarily unavailable once the adapter stops taking messages", async () => {
    setLegacyRunSteering("run-1", async () => {});
    setLegacyRunSteering("run-1", null);

    expect(legacyRunCanSteer("run-1")).toBe(false);
    await expect(steerLegacyRun({ runId: "run-1", message: "hi" })).rejects.toMatchObject({
      name: "NativeSessionSteeringError",
      code: "steering_temporarily_unavailable",
    });
  });

  it("reports an adapter failure as a rejected steer, not an uncertain one", async () => {
    const onAcknowledged = vi.fn(async () => {});
    setLegacyRunSteering("run-1", async () => {
      throw new Error("write EPIPE");
    });

    await expect(steerLegacyRun({ runId: "run-1", message: "hi", onAcknowledged })).rejects.toMatchObject({
      code: "steering_rejected",
      message: "write EPIPE",
    });
    expect(onAcknowledged).not.toHaveBeenCalled();
  });

  it("times out a run that does not answer, and still acknowledges a late delivery", async () => {
    let deliver!: () => void;
    const onAcknowledged = vi.fn(async () => {});
    setLegacyRunSteering("run-1", () => new Promise<void>((resolve) => (deliver = resolve)));

    await expect(
      steerLegacyRun({ runId: "run-1", message: "hi", onAcknowledged, timeoutMs: 20 }),
    ).rejects.toMatchObject({ code: "steering_timeout" });
    expect(onAcknowledged).not.toHaveBeenCalled();

    deliver();
    await vi.waitFor(() => expect(onAcknowledged).toHaveBeenCalledTimes(1));
  });
});
