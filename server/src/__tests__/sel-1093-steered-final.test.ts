import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseClaudeStreamJson } from "@paperclipai/adapter-claude-local/server";
import { resolveHeartbeatRunResponse } from "../services/heartbeat-run-summary.js";

// SEL-1093 (2026-11-12): two steered questions answered only in the run's final
// message, both dropped for the run's earlier comment. The fixtures are the
// runs' real stdout result lines, with every field as logged except `result`,
// cut to the answer's first sentence: this repo is public and the full answers
// name internal systems. Run 1 is one CLI result; run 2 is the cleanup run, an
// error result from a stale resume, the retry notice, then the answer. The
// reused comments are shortened too.
const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

describe("SEL-1093 regression: a steered run's final answer is posted", () => {
  const runs = [
    {
      name: "run 1",
      stdout: fixture("sel-1093-run1-stdout.ndjson"),
      answer: "No, not the whole backend.",
      reusedComment: { id: "f2c19a16", body: "13:50 CST: paused before pressing the button, on the board's question." },
    },
    {
      name: "cleanup run",
      stdout: fixture("sel-1093-run2-stdout.ndjson"),
      answer: "No, I won't end up recreating the whole backend to test things.",
      reusedComment: {
        id: "0b2d23c6",
        body: "Paused on your question; the last run answered it but left no disposition.",
      },
    },
  ];

  for (const run of runs) {
    it(`${run.name}: the parser gives the answer and the resolver posts it`, () => {
      const parsed = parseClaudeStreamJson(run.stdout);
      expect(parsed.finalAssistantText).toBe(run.answer);

      const input = { resultJson: parsed.resultJson, existingComment: run.reusedComment };
      // Before the fix (no steered text): the run's comment is reused, the answer dropped.
      expect(resolveHeartbeatRunResponse(input).decision).toMatchObject({
        commentAction: "reuse",
        reasonCodes: ["explicit_non_progress_comment_precedence"],
      });
      expect(
        resolveHeartbeatRunResponse({ ...input, steeredFinalText: parsed.finalAssistantText }),
      ).toMatchObject({
        text: run.answer,
        decision: { commentAction: "create", reasonCodes: ["steered_run_final_posted"] },
      });
    });
  }
});
