import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
  projects,
  routineRevisions,
  routineRuns,
  routines,
  routineTriggers,
} from "@paperclipai/db";
import type { LiveEvent, RoutineEventFilter } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.ts";
import {
  matchesEventFilter,
  readIssueStatusChange,
  routineService,
  type RoutineIssueStatusChangeFacts,
} from "../services/routines.ts";

function facts(overrides: Partial<RoutineIssueStatusChangeFacts> = {}): RoutineIssueStatusChangeFacts {
  return {
    eventName: "issue.status_changed",
    issueId: "issue-1",
    issueIdentifier: "SEL-1",
    issueTitle: "Test",
    projectId: "project-a",
    fromStatus: "in_progress",
    toStatus: "done",
    actorType: "user",
    actorId: "user-1",
    actorName: null,
    agentId: null,
    occurredAt: "2026-10-05T00:00:00.000Z",
    ...overrides,
  };
}

function filter(match: RoutineEventFilter["match"], projectId: string | null = null): RoutineEventFilter {
  return { event: "issue.status_changed", scope: { projectId }, match };
}

function statusEvent(input: {
  companyId: string;
  issueId: string;
  from: string | null;
  to: string;
  identifier?: string;
}): LiveEvent {
  return {
    id: 1,
    companyId: input.companyId,
    type: "activity.logged",
    createdAt: new Date().toISOString(),
    payload: {
      actorType: "user",
      actorId: "board-user",
      action: "issue.updated",
      entityType: "issue",
      entityId: input.issueId,
      agentId: null,
      details: {
        status: input.to,
        identifier: input.identifier ?? null,
        changes: { status: { from: input.from, to: input.to } },
        ...(input.from ? { _previous: { status: input.from } } : {}),
      },
    },
  };
}

describe("event trigger filter", () => {
  it("matches any → done, and status lists", () => {
    expect(matchesEventFilter(filter({ from: ["any"], to: ["done"] }), facts())).toBe(true);
    expect(matchesEventFilter(filter({ from: ["any"], to: ["blocked"] }), facts())).toBe(false);
    expect(matchesEventFilter(filter({ from: ["todo"], to: ["in_progress"] }), facts({ fromStatus: "todo", toStatus: "in_progress" }))).toBe(true);
    expect(matchesEventFilter(filter({ from: ["done", "cancelled"], to: ["any"] }), facts({ fromStatus: "done", toStatus: "todo" }))).toBe(true);
    expect(matchesEventFilter(filter({ from: ["done", "cancelled"], to: ["any"] }), facts({ fromStatus: "blocked", toStatus: "todo" }))).toBe(false);
  });

  it("an unknown from matches only any", () => {
    expect(matchesEventFilter(filter({ from: ["any"], to: ["done"] }), facts({ fromStatus: null }))).toBe(true);
    expect(matchesEventFilter(filter({ from: ["in_progress"], to: ["done"] }), facts({ fromStatus: null }))).toBe(false);
  });

  it("project scope", () => {
    expect(matchesEventFilter(filter({ from: ["any"], to: ["done"] }, "project-a"), facts())).toBe(true);
    expect(matchesEventFilter(filter({ from: ["any"], to: ["done"] }, "project-b"), facts())).toBe(false);
  });

  it("reads only issue.updated rows with a real status change", () => {
    const base = statusEvent({ companyId: "c", issueId: "i", from: "todo", to: "done" });
    expect(readIssueStatusChange(base)).toMatchObject({ fromStatus: "todo", toStatus: "done", issueId: "i" });
    expect(readIssueStatusChange({ ...base, payload: { ...base.payload, action: "issue.created" } })).toBeNull();
    const noStatusChange = { ...base, payload: { ...base.payload, details: { status: "done", changes: { title: {} } } } };
    expect(readIssueStatusChange(noStatusChange)).toBeNull();
    expect(readIssueStatusChange(statusEvent({ companyId: "c", issueId: "i", from: null, to: "done" }))).toMatchObject({ fromStatus: null });
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("event trigger dispatch", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-routine-event-trigger-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(routineRuns);
    await db.delete(routineTriggers);
    await db.delete(routineRevisions);
    await db.delete(routines);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const projectId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Labs",
      issuePrefix: `E${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: randomUUID(),
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Learner",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(projects).values({ id: projectId, companyId, name: "Work", status: "in_progress" });
    // Like a real wake: the run issue gets a queued heartbeat run, which makes it "live" for coalescing.
    const svc = routineService(db, {
      runtimeEnv: {},
      heartbeat: {
        wakeup: async (wakeAgentId, opts) => {
          const issueId = typeof opts.payload?.issueId === "string" ? opts.payload.issueId : null;
          if (!issueId) return null;
          const runId = randomUUID();
          await db.insert(heartbeatRuns).values({
            id: runId,
            companyId,
            agentId: wakeAgentId,
            invocationSource: "assignment",
            status: "queued",
            contextSnapshot: { issueId },
          });
          await db.update(issues).set({ executionRunId: runId, executionLockedAt: new Date() }).where(eq(issues.id, issueId));
          return { id: runId };
        },
      },
    });
    const issueSvc = issueService(db);
    const routine = await svc.create(
      companyId,
      {
        projectId,
        goalId: null,
        parentIssueId: null,
        title: "Learning pass",
        description: "Move lessons",
        assigneeAgentId: agentId,
        priority: "medium",
        status: "active",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
      },
      {},
    );
    await svc.createTrigger(routine.id, {
      kind: "event",
      label: "Any issue done",
      eventFilter: { event: "issue.status_changed", scope: { projectId: null }, match: { from: ["any"], to: ["done"] } },
    }, {});
    return { companyId, projectId, svc, issueSvc, routine };
  }

  async function runsOf(routineId: string) {
    return db.select().from(routineRuns).where(eq(routineRuns.routineId, routineId));
  }

  async function closeIssue(companyId: string, issueId: string, svc: ReturnType<typeof routineService>) {
    const [before] = await db.select({ status: issues.status }).from(issues).where(eq(issues.id, issueId));
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, issueId));
    return svc.handleActivityEvent(statusEvent({ companyId, issueId, from: before!.status, to: "done" }));
  }

  it("one issue to done starts one run whose issue names the event", async () => {
    const { companyId, projectId, svc, issueSvc, routine } = await seed();
    const work = await issueSvc.create(companyId, { projectId, title: "Fix it", status: "todo", priority: "medium" });

    expect(await closeIssue(companyId, work.id, svc)).toEqual({ dispatched: 1, trailing: 0 });

    const runs = await runsOf(routine.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ source: "event", status: "issue_created" });
    const [runIssue] = await db.select().from(issues).where(eq(issues.id, runs[0]!.linkedIssueId!));
    expect(runIssue!.description).toContain(`Started by event: ${work.identifier} todo → done`);
  });

  it("ignores this routine's own run issues", async () => {
    const { companyId, projectId, svc, issueSvc, routine } = await seed();
    const work = await issueSvc.create(companyId, { projectId, title: "Fix it", status: "todo", priority: "medium" });
    await closeIssue(companyId, work.id, svc);
    const [run] = await runsOf(routine.id);

    expect(await closeIssue(companyId, run!.linkedIssueId!, svc)).toEqual({ dispatched: 0, trailing: 0 });
    expect(await runsOf(routine.id)).toHaveLength(1);
  });

  it("a burst of 10 gives 1 run + 9 coalesced, then 1 trailing pass, then nothing", async () => {
    const { companyId, projectId, svc, issueSvc, routine } = await seed();
    const work = [];
    for (let i = 0; i < 10; i += 1) {
      work.push(await issueSvc.create(companyId, { projectId, title: `Task ${i}`, status: "todo", priority: "medium" }));
    }
    await Promise.all(work.map((issue) => closeIssue(companyId, issue.id, svc)));

    const first = await runsOf(routine.id);
    expect(first.filter((r) => r.status === "issue_created")).toHaveLength(1);
    expect(first.filter((r) => r.status === "coalesced")).toHaveLength(9);
    const runIssueId = first.find((r) => r.status === "issue_created")!.linkedIssueId!;
    expect(first.every((r) => r.linkedIssueId === runIssueId)).toBe(true);

    expect(await closeIssue(companyId, runIssueId, svc)).toEqual({ dispatched: 0, trailing: 1 });
    const trailingRuns = (await runsOf(routine.id)).filter((r) => r.status === "issue_created" && r.linkedIssueId !== runIssueId);
    expect(trailingRuns).toHaveLength(1);
    const [trailingIssue] = await db.select().from(issues).where(eq(issues.id, trailingRuns[0]!.linkedIssueId!));
    expect(trailingIssue!.description).toContain("Started by 9 events");

    expect(await closeIssue(companyId, trailingIssue!.id, svc)).toEqual({ dispatched: 0, trailing: 0 });
    const open = await db
      .select({ id: issues.id })
      .from(issues)
      .where(and(eq(issues.originId, routine.id), eq(issues.status, "todo")));
    expect(open).toHaveLength(0);
    expect(await runsOf(routine.id)).toHaveLength(11);
  });
});
