import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, issueComments, issues } from "@paperclipai/db";
import { buildExecutionContinuation } from "../services/execution-continuation.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

describe("execution continuation text cap", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => { temporary = await startEmbeddedPostgresTestDatabase("continuation-cap-"); db = createDb(temporary.connectionString); }, 20_000);
  afterAll(async () => { await db?.$client.end({ timeout: 0 }); await temporary?.cleanup(); });

  it("cuts a 543 KB comment and description to the cap with a read-it-whole marker", async () => {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    const huge = `See screenshot ![x](data:image/png;base64,${"A".repeat(543_000)})`;
    await db.insert(companies).values({ id: companyId, name: "Cap fixture", issuePrefix: `C${companyId.slice(0, 6)}`, defaultResponsibleUserId: "fixture-owner" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", role: "engineer", status: "idle", adapterType: "codex_local" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Big paste", description: huge, status: "in_progress", assigneeAgentId: agentId, responsibleUserId: "fixture-owner" });
    const envelopeBefore = await buildExecutionContinuation({ db, companyId, issueId, agentId, context: {}, summary: null, exposeLowTrustRaw: true });
    expect(envelopeBefore.objective.length).toBeLessThanOrEqual(32_000);
    expect(envelopeBefore.objective).toContain(`GET /api/issues/${issueId}]`);

    const [comment] = await db.insert(issueComments).values({ companyId, issueId, authorUserId: "fixture-owner", authorType: "user", body: huge }).returning();
    const envelope = await buildExecutionContinuation({ db, companyId, issueId, agentId, context: {}, summary: null, exposeLowTrustRaw: true });
    const body = envelope.messages.find(m => m.id === comment.id)!.body;
    expect(body.length).toBeLessThanOrEqual(32_000);
    expect(body.startsWith("See screenshot")).toBe(true);
    expect(body).toContain(`of ${huge.length.toLocaleString("en-US")} chars. Read it whole: GET /api/issues/${issueId}/comments/${comment.id}]`);
    expect(envelope.objective).toBe(body);
  });
});
