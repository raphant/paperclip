import { describe, expect, it } from "vitest";
import { parseAcpxStdoutLine } from "./ui.js";

const TS = "2026-09-24T12:00:00.000Z";

describe("parseAcpxStdoutLine acpx.status", () => {
  it("carries context occupancy from usage_update events", () => {
    const line = JSON.stringify({
      type: "acpx.status",
      tag: "usage_update",
      used: 42_800,
      size: 200_000,
    });

    expect(parseAcpxStdoutLine(line, TS)).toEqual([
      {
        kind: "system",
        ts: TS,
        text: "usage_update (42800/200000 ctx)",
        contextUsage: { used: 42_800, size: 200_000 },
      },
    ]);
  });

  it("keeps a zero used count after compaction", () => {
    const line = JSON.stringify({ type: "acpx.status", tag: "usage_update", used: 0, size: 200_000 });

    expect(parseAcpxStdoutLine(line, TS)[0]).toMatchObject({
      contextUsage: { used: 0, size: 200_000 },
    });
  });

  it("omits context occupancy when the window size is unknown", () => {
    for (const payload of [
      { type: "acpx.status", tag: "usage_update", used: 1_000 },
      { type: "acpx.status", tag: "usage_update", used: 1_000, size: 0 },
      { type: "acpx.status", text: "Working" },
    ]) {
      const [entry] = parseAcpxStdoutLine(JSON.stringify(payload), TS);
      expect(entry).toMatchObject({ kind: "system" });
      expect(entry).not.toHaveProperty("contextUsage");
    }
  });
});
