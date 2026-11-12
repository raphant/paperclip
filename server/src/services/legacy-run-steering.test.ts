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

  describe("delivery record", () => {
    it("is marked when the steer resolves, also after the timeout", async () => {
      const now = { delivered: false };
      setLegacyRunSteering("run-1", async () => {}, now);
      await steerLegacyRun({ runId: "run-1", message: "hi" });
      expect(now.delivered).toBe(true);

      let deliver!: () => void;
      const late = { delivered: false };
      setLegacyRunSteering("run-1", () => new Promise<void>((resolve) => (deliver = resolve)), late);
      await expect(steerLegacyRun({ runId: "run-1", message: "hi", timeoutMs: 20 })).rejects.toMatchObject({
        code: "steering_timeout",
      });
      expect(late.delivered).toBe(false);
      deliver();
      await vi.waitFor(() => expect(late.delivered).toBe(true));
    });

    it("is not marked on a refusal, immediate or after the timeout, with no unhandled rejection", async () => {
      const unhandled = vi.fn();
      process.on("unhandledRejection", unhandled);
      try {
        const now = { delivered: false };
        setLegacyRunSteering(
          "run-1",
          async () => {
            throw new Error("write EPIPE");
          },
          now,
        );
        await expect(steerLegacyRun({ runId: "run-1", message: "hi" })).rejects.toMatchObject({
          code: "steering_rejected",
        });

        let refuse!: () => void;
        const late = { delivered: false };
        setLegacyRunSteering(
          "run-1",
          () => new Promise<void>((_resolve, reject) => (refuse = () => reject(new Error("closed")))),
          late,
        );
        await expect(steerLegacyRun({ runId: "run-1", message: "hi", timeoutMs: 20 })).rejects.toMatchObject({
          code: "steering_timeout",
        });
        refuse();
        await new Promise((resolve) => setTimeout(resolve, 20));

        expect(now.delivered).toBe(false);
        expect(late.delivered).toBe(false);
        expect(unhandled).not.toHaveBeenCalled();
      } finally {
        process.off("unhandledRejection", unhandled);
      }
    });

    it("gives a new registration for the same run id its own record", async () => {
      let deliver!: () => void;
      const first = { delivered: false };
      setLegacyRunSteering("run-1", () => new Promise<void>((resolve) => (deliver = resolve)), first);
      await expect(steerLegacyRun({ runId: "run-1", message: "hi", timeoutMs: 20 })).rejects.toMatchObject({
        code: "steering_timeout",
      });

      const second = { delivered: false };
      setLegacyRunSteering("run-1", null);
      setLegacyRunSteering("run-1", async () => {}, second);
      deliver();
      await vi.waitFor(() => expect(first.delivered).toBe(true));
      expect(second.delivered).toBe(false);
    });

    it("gives a two-argument registration a default record, with no unhandled rejection", async () => {
      const unhandled = vi.fn();
      process.on("unhandledRejection", unhandled);
      try {
        setLegacyRunSteering("run-1", async () => {});
        await expect(steerLegacyRun({ runId: "run-1", message: "hi" })).resolves.toEqual({ turnId: "run-1" });

        setLegacyRunSteering("run-1", async () => {
          throw new Error("write EPIPE");
        });
        await expect(steerLegacyRun({ runId: "run-1", message: "hi" })).rejects.toMatchObject({
          code: "steering_rejected",
        });
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(unhandled).not.toHaveBeenCalled();
      } finally {
        process.off("unhandledRejection", unhandled);
      }
    });
  });
});
