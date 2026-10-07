import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";

type OnLog = AdapterExecutionContext["onLog"];
type OnSteerable = NonNullable<AdapterExecutionContext["onSteerable"]>;

/** CLI flags that make a run steerable. */
export const CLAUDE_STEERING_ARGS = ["--input-format", "stream-json", "--replay-user-messages"];

function userLine(text: string): string {
  return `${JSON.stringify({ type: "user", message: { role: "user", content: text } })}\n`;
}

/**
 * Lets the server steer a local Claude CLI run. Measured on Claude Code 2.1.292:
 * a message written to stdin reaches the model at the next tool boundary, or,
 * when no tool call is left, runs as its own turn in the same process.
 *
 * Steering opens at the first assistant line, so a failed start or resume never
 * swallows a message, and closes at the first `result`, which also ends stdin.
 * The CLI still answers every message it already read. `finished()` is true
 * only at a `result` that leaves no written message unread (counted by replayed
 * user lines), so the kill-after-result timer cannot cut a steered turn short.
 * Replayed user lines never reach the run log.
 *
 * execute.ts makes one per attempt: pass `stdin` and `keepStdinOpen` to the
 * process, log through `onLog`, use `finished` as the terminal-result check,
 * and call `close()` then `flush()` when the process ends.
 */
export function createClaudeCliSteering(input: {
  prompt: string;
  onLog: OnLog;
  onSteerable: OnSteerable;
}) {
  let stdin: NodeJS.WritableStream | null = null;
  let open = false;
  let ended = false;
  let written = 1;
  let read = 0;
  let finished = false;
  let partial = "";

  const steer = (message: string) =>
    new Promise<void>((resolve, reject) => {
      if (!open || !stdin) {
        reject(new Error("This Claude run no longer takes messages."));
        return;
      }
      written += 1;
      stdin.write(userLine(message), (error) => (error ? reject(error) : resolve()));
    });

  const close = () => {
    if (open) input.onSteerable(null);
    open = false;
    if (!ended) {
      ended = true;
      stdin?.end();
    }
  };

  /** Tracks one stdout line; returns false for a line the log must not get. */
  const track = (line: string): boolean => {
    if (!line.startsWith("{")) return true;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return true;
    }
    if (event.type === "user" && event.isReplay === true) {
      read += 1;
      finished = false;
      return false;
    }
    if (event.type === "assistant" && !open && !ended && stdin) {
      open = true;
      input.onSteerable(steer);
    }
    if (event.type === "result") {
      finished = read >= written;
      close();
    }
    return true;
  };

  const logLines = async (lines: string[]) => {
    const kept = lines.filter((line) => track(line.trim()));
    if (kept.length > 0) await input.onLog("stdout", kept.join(""));
  };

  return {
    stdin: userLine(input.prompt),
    keepStdinOpen: (stream: NodeJS.WritableStream) => {
      stdin = stream;
      if (ended) stream.end();
    },
    onLog: async (stream: "stdout" | "stderr", chunk: string) => {
      if (stream !== "stdout") return input.onLog(stream, chunk);
      const lines = (partial + chunk).split(/(?<=\n)/);
      partial = lines[lines.length - 1]?.endsWith("\n") ? "" : (lines.pop() ?? "");
      await logLines(lines);
    },
    finished: () => finished,
    close,
    /** Logs a last line that had no newline. */
    flush: async () => {
      const rest = partial;
      partial = "";
      if (rest) await logLines([rest]);
    },
  };
}
