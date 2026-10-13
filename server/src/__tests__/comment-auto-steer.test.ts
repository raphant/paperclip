import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { activityLog, agentWakeupRequests, agents, companies, createDb, heartbeatRuns, issueComments, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { autoSteerIssueComment, steeringMessageText } from "../services/comment-auto-steer.js";
import { setLegacyRunSteering } from "../services/legacy-run-steering.js";
import { initializeRunIdentity, listRunIdentityContexts } from "../services/run-identity.js";

describe("steeringMessageText", () => {
  it("sends a person's comment as written", () => {
    expect(steeringMessageText({ body: "/goal ship it", authorAgentName: null, issueIdentifier: "TST-1" })).toBe("/goal ship it");
  });
  it("names the agent that wrote a comment, so a leading slash is not a command", () => {
    expect(steeringMessageText({ body: "/goal rebase", authorAgentName: "Tech Lead", issueIdentifier: "TST-1" }))
      .toBe("Comment from Tech Lead on TST-1:\n\n/goal rebase");
  });
});

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("autoSteerIssueComment", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const steered: string[] = [];
  const runIds: string[] = [];
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-comment-auto-steer-");
    db = createDb(database.connectionString);
  }, 30_000);
  afterAll(async () => { await database?.cleanup(); }, 60_000);
  afterEach(() => {
    steered.length = 0;
    for (const runId of runIds.splice(0)) setLegacyRunSteering(runId, null);
  });

  async function seed(options: { steer?: ((message: string) => Promise<void>) | null } = {}) {
    const companyId = randomUUID(), assigneeId = randomUUID(), otherAgentId = randomUUID();
    const issueId = randomUUID(), runId = randomUUID();
    const identifier = `TST-${issueId.slice(0, 6)}`;
    await db.insert(companies).values({ id: companyId, name: "Auto steer tests", issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values([
      { id: assigneeId, companyId, name: "Engineer", role: "engineer", adapterType: "claude_local" },
      { id: otherAgentId, companyId, name: "Tech Lead", role: "cto", adapterType: "claude_local" },
    ]);
    await db.insert(issues).values({ id: issueId, companyId, title: "Build it", identifier, assigneeAgentId: assigneeId, responsibleUserId: "owner" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId: assigneeId, status: "running", runtimeMode: "legacy", contextSnapshot: { issueId } });
    await initializeRunIdentity(db, { companyId, runId, issueId, responsibleUserId: "owner", cause: "assignment" });
    const steer = options.steer === undefined ? async (message: string) => { steered.push(message); } : options.steer;
    if (steer) {
      setLegacyRunSteering(runId, steer);
      runIds.push(runId);
    }
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    const issue = { id: issueId, companyId, identifier, assigneeAgentId: assigneeId };
    const actor = { actorType: "user" as const, actorId: "owner", agentId: null, runId: null, agentApiKeyId: null };
    async function comment(author: { userId?: string; agentId?: string }, body: string) {
      const id = randomUUID();
      await db.insert(issueComments).values({ id, companyId, issueId, authorUserId: author.userId ?? null, authorAgentId: author.agentId ?? null, body });
      return { id, body, authorUserId: author.userId ?? null, authorAgentId: author.agentId ?? null };
    }
    return { companyId, assigneeId, otherAgentId, issueId, runId, run, issue, actor, comment };
  }

  async function steeredActivity(issueId: string) {
    return db.select().from(activityLog).where(and(eq(activityLog.entityId, issueId), eq(activityLog.action, "issue.queued_comment_steered")));
  }

  it("steers a person's comment as written and moves the run to that person's identity", async () => {
    const s = await seed();
    const comment = await s.comment({ userId: "raphant" }, "Rebase before you go further.");
    expect(await autoSteerIssueComment(db, { issue: s.issue, comment, run: s.run, actor: s.actor })).toBe(true);
    expect(steered).toEqual(["Rebase before you go further."]);
    const history = await listRunIdentityContexts(db, s.companyId, s.runId);
    expect(history.at(-1)).toMatchObject({ responsibleUserId: "raphant", messageId: comment.id, status: "accepted" });
    const [activity] = await steeredActivity(s.issueId);
    expect(activity?.details).toMatchObject({ commentId: comment.id, targetRunId: s.runId, duplicate: false, auto: true });
  });

  it("steers another agent's comment with its name and keeps the run's identity", async () => {
    const s = await seed();
    const before = await listRunIdentityContexts(db, s.companyId, s.runId);
    const comment = await s.comment({ agentId: s.otherAgentId }, "Rebase onto main.");
    expect(await autoSteerIssueComment(db, { issue: s.issue, comment, run: s.run, actor: s.actor })).toBe(true);
    expect(steered).toEqual([`Comment from Tech Lead on ${s.issue.identifier}:\n\nRebase onto main.`]);
    expect(await listRunIdentityContexts(db, s.companyId, s.runId)).toHaveLength(before.length);
  });

  it("keeps a new comment behind comments already waiting for the next turn", async () => {
    const s = await seed();
    const waiting = await s.comment({ userId: "raphant" }, "First");
    await db.insert(agentWakeupRequests).values({
      companyId: s.companyId, agentId: s.assigneeId, source: "automation", reason: "issue_execution_deferred",
      status: "deferred_issue_execution", payload: { issueId: s.issueId, commentId: waiting.id },
    });
    const comment = await s.comment({ userId: "raphant" }, "Second");
    expect(await autoSteerIssueComment(db, { issue: s.issue, comment, run: s.run, actor: s.actor })).toBe(false);
    expect(steered).toEqual([]);
  });

  it("queues the comment and rejects the reserved identity when the run refuses it", async () => {
    const s = await seed({ steer: async () => { throw new Error("promptRequired"); } });
    const comment = await s.comment({ userId: "raphant" }, "Between turns");
    expect(await autoSteerIssueComment(db, { issue: s.issue, comment, run: s.run, actor: s.actor })).toBe(false);
    const history = await listRunIdentityContexts(db, s.companyId, s.runId);
    expect(history.find((row) => row.messageId === comment.id)?.status).toBe("rejected");
    expect(await steeredActivity(s.issueId)).toHaveLength(0);
  });

  it("does nothing when the run takes no messages, or the comment is the assignee's own", async () => {
    const s = await seed({ steer: null });
    const comment = await s.comment({ userId: "raphant" }, "Hello");
    expect(await autoSteerIssueComment(db, { issue: s.issue, comment, run: s.run, actor: s.actor })).toBe(false);
    const t = await seed();
    const own = await t.comment({ agentId: t.assigneeId }, "Note to self");
    expect(await autoSteerIssueComment(db, { issue: t.issue, comment: own, run: t.run, actor: t.actor })).toBe(false);
    expect(steered).toEqual([]);
  });
});
