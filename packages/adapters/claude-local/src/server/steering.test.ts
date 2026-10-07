import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { createClaudeCliSteering } from "./steering.js";

type Steer = ((message: string) => Promise<void>) | null;

const line = (event: Record<string, unknown>) => `${JSON.stringify(event)}\n`;
const replay = (text: string) => line({ type: "user", message: { role: "user", content: text }, isReplay: true });
const assistant = line({ type: "assistant", message: { content: [{ type: "text", text: "working" }] } });
const result = line({ type: "result", subtype: "success", result: "done" });

function setup() {
  const logged: string[] = [];
  const handles: Steer[] = [];
  const stdin = new PassThrough();
  const written: string[] = [];
  stdin.on("data", (chunk) => written.push(String(chunk)));
  const steering = createClaudeCliSteering({
    prompt: "do the task",
    onLog: async (_stream, chunk) => {
      logged.push(chunk);
    },
    onSteerable: (steer) => handles.push(steer),
  });
  steering.keepStdinOpen(stdin);
  return { steering, stdin, logged, handles, written };
}

describe("createClaudeCliSteering", () => {
  it("writes the prompt as a stream-json user line", () => {
    const { steering } = setup();
    expect(JSON.parse(steering.stdin)).toEqual({
      type: "user",
      message: { role: "user", content: "do the task" },
    });
  });

  it("takes messages from the first assistant line until the first result, which ends stdin", async () => {
    const { steering, stdin, logged, handles, written } = setup();
    await steering.onLog("stdout", replay("do the task") + assistant);
    const steer = handles[0];
    expect(steer).toBeTypeOf("function");

    await steer!("change course");
    expect(JSON.parse(written.join(""))).toEqual({
      type: "user",
      message: { role: "user", content: "change course" },
    });

    await steering.onLog("stdout", replay("change course") + result);
    expect(handles).toEqual([steer, null]);
    expect(stdin.writableEnded).toBe(true);
    expect(steering.finished()).toBe(true);
    await expect(steer!("too late")).rejects.toThrow("no longer takes messages");
    expect(logged.join("")).not.toContain("isReplay");
    expect(logged.join("")).toContain('"type":"result"');
  });

  it("is not finished at a result while a written message is still unread", async () => {
    const { steering, handles } = setup();
    await steering.onLog("stdout", replay("do the task") + assistant);
    await handles[0]!("late message");

    await steering.onLog("stdout", result);
    expect(steering.finished()).toBe(false);

    await steering.onLog("stdout", replay("late message") + assistant);
    expect(steering.finished()).toBe(false);
    await steering.onLog("stdout", result);
    expect(steering.finished()).toBe(true);
    expect(handles).toHaveLength(2);
  });

  it("never takes messages when the CLI fails before answering", async () => {
    const { steering, stdin, handles } = setup();
    await steering.onLog("stdout", line({ type: "result", subtype: "error_during_execution" }));
    expect(handles).toEqual([]);
    expect(stdin.writableEnded).toBe(true);
  });

  it("reads lines split across chunks and flushes a last line with no newline", async () => {
    const { steering, logged, handles } = setup();
    const replayLine = replay("do the task");
    await steering.onLog("stdout", replayLine.slice(0, 10));
    await steering.onLog("stdout", replayLine.slice(10) + assistant.slice(0, 5));
    expect(handles).toEqual([]);
    await steering.onLog("stdout", `${assistant.slice(5)}tail`);
    expect(handles).toHaveLength(1);
    await steering.flush();
    expect(logged.join("")).toBe(`${assistant}tail`);
  });

  it("passes stderr through untouched", async () => {
    const { steering, logged } = setup();
    await steering.onLog("stderr", "warning\n");
    expect(logged).toEqual(["warning\n"]);
  });
});
