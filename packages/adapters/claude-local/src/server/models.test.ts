import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { refreshClaudeModels, resetClaudeModelsCacheForTests } from "./models.js";

function mockModels(ids: string[]) {
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
    new Response(JSON.stringify({ data: ids.map((id) => ({ id, display_name: id })) }), { status: 200 }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function sentHeaders(fetchMock: ReturnType<typeof mockModels>): Record<string, string> {
  const init = fetchMock.mock.calls[0]![1]!;
  return init.headers as Record<string, string>;
}

describe("refreshClaudeModels", () => {
  beforeEach(() => {
    resetClaudeModelsCacheForTests();
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("ANTHROPIC_BASE_URL", "");
    vi.stubEnv("CLAUDE_CODE_USE_BEDROCK", "");
    vi.stubEnv("ANTHROPIC_BEDROCK_BASE_URL", "");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("sends a subscription token as Bearer with the OAuth beta header", async () => {
    const fetchMock = mockModels(["claude-sonnet-5-5"]);
    await refreshClaudeModels({ token: "oauth-token", method: "subscription" });
    expect(fetchMock.mock.calls[0]![0]).toBe("https://api.anthropic.com/v1/models");
    const headers = sentHeaders(fetchMock);
    expect(headers.Authorization).toBe("Bearer oauth-token");
    expect(headers["anthropic-beta"]).toBe("oauth-2025-04-20");
    expect(headers["x-api-key"]).toBeUndefined();
  });

  it("sends an API key as x-api-key", async () => {
    const fetchMock = mockModels(["claude-sonnet-5-5"]);
    await refreshClaudeModels({ token: "sk-key", method: "api_key" });
    const headers = sentHeaders(fetchMock);
    expect(headers["x-api-key"]).toBe("sk-key");
    expect(headers.Authorization).toBeUndefined();
    expect(headers["anthropic-beta"]).toBeUndefined();
  });

  it("does not fetch without a credential or ANTHROPIC_API_KEY", async () => {
    const fetchMock = mockModels(["claude-sonnet-5-5"]);
    const models = await refreshClaudeModels();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(models.map((m) => m.id)).not.toContain("claude-sonnet-5-5");
  });

  it("shows a dated id of a known model once, under the short id, and adds new ids", async () => {
    mockModels(["claude-sonnet-5-5", "claude-haiku-4-5-20251001", "claude-sonnet-4-5-20250929"]);
    const ids = (await refreshClaudeModels({ token: "oauth-token", method: "subscription" })).map((m) => m.id);
    expect(ids.filter((id) => id === "claude-sonnet-5-5")).toHaveLength(1);
    expect(ids.filter((id) => id === "claude-haiku-4-5")).toHaveLength(1);
    expect(ids).not.toContain("claude-haiku-4-5-20251001");
  });
});
