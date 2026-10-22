import { describe, expect, it } from "vitest";
import { detectHandoff } from "./handoff";

describe("detectHandoff", () => {
  it("sees an agent move from one task to another", () => {
    const r = detectHandoff({ eng: "A" }, { eng: "B" }, null, 1000);
    expect(r.handoff).toEqual({ at: 1000, fromAgentId: "eng", fromIssueId: "A", toAgentId: "eng", toIssueId: "B" });
  });

  it("pairs a run that ends with another agent starting in the same snapshot", () => {
    const r = detectHandoff({ res: "A", simp: null }, { res: null, simp: "B" }, null, 1000);
    expect(r.handoff).toMatchObject({ fromAgentId: "res", fromIssueId: "A", toAgentId: "simp", toIssueId: "B" });
    expect(r.lastEnd).toBeNull();
  });

  it("pairs an end and a later start inside the window, not after it", () => {
    const ended = detectHandoff({ res: "A" }, { res: null }, null, 1000);
    expect(ended.handoff).toBeNull();
    expect(ended.lastEnd).toEqual({ agentId: "res", issueId: "A", at: 1000 });

    const soon = detectHandoff({ res: null, simp: null }, { res: null, simp: "B" }, ended.lastEnd, 20_000);
    expect(soon.handoff).toMatchObject({ fromAgentId: "res", toAgentId: "simp", toIssueId: "B" });

    const late = detectHandoff({ res: null, simp: null }, { res: null, simp: "B" }, ended.lastEnd, 1000 + 61_000);
    expect(late.handoff).toBeNull();
  });

  it("ignores first starts and an agent picking its own task back up", () => {
    expect(detectHandoff({}, { eng: "A", res: "B" }, null, 1000).handoff).toBeNull();
    expect(detectHandoff({ eng: null }, { eng: "A" }, { agentId: "eng", issueId: "A", at: 900 }, 1000).handoff).toBeNull();
  });
});
