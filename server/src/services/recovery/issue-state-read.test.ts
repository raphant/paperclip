import { randomBytes, randomUUID } from "node:crypto";
import { companies, createDb, issueRecoveryActions, issues } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { recoveryService } from "./service.js";

const support = await getEmbeddedPostgresTestSupport();

describe.skipIf(!support.supported)("recovery issue state reads", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("recovery-issue-state-");
    db = createDb(database.connectionString);
  });
  afterAll(async () => {
    await db?.$client.end();
    await database?.cleanup();
  });

  it.each([false, true])("does not load unused source and child descriptions (child=%s)", async (withChild) => {
    const [company] = await db.insert(companies).values({
      name: "Recovery state reads",
      issuePrefix: `R${randomUUID().slice(0, 7).toUpperCase()}`,
    }).returning();
    const description = randomBytes(128 * 1024).toString("base64");
    const [parent] = await db.insert(issues).values({
      companyId: company.id,
      title: "Await the board decision",
      description,
      status: "blocked",
    }).returning();
    const child = withChild
      ? (await db.insert(issues).values({
          companyId: company.id,
          title: "A child that also needs a decision",
          description,
          status: "blocked",
          parentId: parent.id,
        }).returning())[0]
      : null;
    const [action] = await db.insert(issueRecoveryActions).values({
      companyId: company.id,
      sourceIssueId: parent.id,
      kind: "stranded_assigned_issue",
      cause: "stranded_assigned_issue",
      fingerprint: randomUUID(),
      status: "active",
      ownerType: "board",
      wakePolicy: { type: "board_escalation" },
      nextAction: "Choose the next disposition",
      evidence: { retainedControl: { proof: "unchanged" } },
    }).returning();
    const enqueueWakeup = vi.fn(async () => {
      throw new Error("Board-owned work must remain pending");
    });
    const service = recoveryService(db, { enqueueWakeup });
    // Fork carve: upstream measures response bytes with @paperclipai/db/response-capture,
    // which the fork lacks. This spy records each db.select read and the rows it returns.
    const reads: Array<{ bareSelect: boolean; sql: string; rows: Array<Record<string, unknown>> }> = [];
    const realSelect = db.select.bind(db);
    const selectSpy = vi
      .spyOn(db, "select")
      .mockImplementation((...args: Parameters<typeof db.select>) => {
        const builder = realSelect(...args);
        const realFrom = builder.from.bind(builder);
        (builder as { from: unknown }).from = (table: unknown) => {
          const query = realFrom(table as Parameters<typeof realFrom>[0]);
          const realExecute = query.execute;
          query.execute = (async (...executeArgs: Parameters<typeof realExecute>) => {
            const rows = await realExecute(...executeArgs);
            reads.push({ bareSelect: args[0] === undefined, sql: query.toSQL().sql, rows: rowObjects(rows) });
            return rows;
          }) as typeof realExecute;
          return query;
        };
        return builder;
      });
    try {
      await service.reconcileStrandedAssignedIssues();
    } finally {
      selectSpy.mockRestore();
    }
    const sourceIds = child ? [parent.id, child.id] : [parent.id];
    const sourceReads = reads.filter(read => read.rows.some(row => sourceIds.includes(row.id as string)));
    // The source (and child) rows were read, through a field list and without the description.
    expect(new Set(sourceReads.flatMap(read => read.rows.map(row => row.id)).filter(id => sourceIds.includes(id as string))))
      .toEqual(new Set(sourceIds));
    expect(sourceReads.filter(read => read.bareSelect).map(read => read.sql)).toEqual([]);
    expect(reads.filter(read => read.rows.some(row => row.description === description)).map(read => read.sql)).toEqual([]);
    expect(enqueueWakeup).not.toHaveBeenCalled();
    expect((await db.select().from(issues).where(eq(issues.id, parent.id)))[0]).toEqual(parent);
    if (child) {
      expect((await db.select().from(issues).where(eq(issues.id, child.id)))[0]).toEqual(child);
    }
    expect((await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action.id)))[0]).toEqual(action);
  });
});

// Each returned row plus its nested objects, so a joined `{ action, issue }` row
// exposes its issue's fields.
function rowObjects(rows: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row) => {
    if (!row || typeof row !== "object") return [];
    const nested = Object.values(row).filter(
      (value): value is Record<string, unknown> =>
        Boolean(value) && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date),
    );
    return [row as Record<string, unknown>, ...nested];
  });
}
