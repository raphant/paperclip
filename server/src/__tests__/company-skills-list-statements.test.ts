import request from "supertest";
import { and, eq, like } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { expect, it } from "vitest";
import { createDb, folders } from "@paperclipai/db";
import { companySkillRoutes } from "../routes/company-skills.js";
import { folderService } from "../services/folders.js";
import { describeEmbeddedPostgres, routeApp, seedCompanyWithBoardAccess, useEmbeddedPostgres } from "./helpers/route-test-harness.js";

type Db = ReturnType<typeof createDb>;

/**
 * Fork: a second drizzle handle on the same pool that counts its statements and
 * transactions, like the recordingDb recorder in tool-gateway-listing-fixture.ts.
 * Upstream's database-statement-meter.ts wraps the client's `unsafe` and loops on
 * the fork's packages/db transient-write-retry Proxy. Code under test must use `.db`.
 */
function meterDatabaseStatements(db: Db) {
  let statements = 0;
  let transactions = 0;
  let depth = 0;
  let log: { sql: string; inTransaction: boolean }[] | null = null;
  const recorded = drizzle(db.$client, {
    schema: db._.fullSchema,
    logger: {
      logQuery: (query: string) => {
        statements += 1;
        log?.push({ sql: query, inTransaction: depth > 0 });
      },
    },
  }) as unknown as Db;
  const transaction = recorded.transaction.bind(recorded) as (...args: unknown[]) => Promise<unknown>;
  (recorded as unknown as { transaction: unknown }).transaction = (
    run: (tx: unknown) => Promise<unknown>,
    ...rest: unknown[]
  ) => {
    transactions += 1;
    return transaction(async (tx: unknown) => {
      depth += 1;
      try {
        return await run(tx);
      } finally {
        depth -= 1;
      }
    }, ...rest);
  };
  return {
    db: recorded,
    read: () => ({ statements, transactions }),
    startLog: () => {
      log = [];
    },
    stopLog: () => {
      const entries = log ?? [];
      log = null;
      return entries;
    },
  };
}

describeEmbeddedPostgres("GET /api/companies/:companyId/skills statements per request", () => {
  const ctx = useEmbeddedPostgres("company-skills-list-statements-");

  function meter() {
    return meterDatabaseStatements(ctx.db);
  }

  const bundledFolders = (companyId: string) => ctx.db.select().from(folders)
    .where(and(eq(folders.companyId, companyId), like(folders.systemKey, "bundled%")));

  it("lists skills with plain reads once the bundled folders exist", async () => {
    const statements = meter();
    {
      const company = await seedCompanyWithBoardAccess(ctx.db, "Skills list");
      const app = routeApp(statements.db, company.actor, (db) => companySkillRoutes(db));
      const first = await request(app).get(`/api/companies/${company.companyId}/skills`).expect(200);
      expect(first.body.length).toBeGreaterThan(0);
      const foldersAfterFirst = await bundledFolders(company.companyId);

      const before = statements.read();
      statements.startLog();
      const second = await request(app).get(`/api/companies/${company.companyId}/skills`).expect(200);
      const log = statements.stopLog();
      const after = statements.read();

      expect(second.body).toEqual(first.body);
      expect(after.transactions - before.transactions).toBe(0);
      expect(log.filter((entry) => /pg_advisory/.test(entry.sql))).toEqual([]);
      expect(after.statements - before.statements).toBeLessThanOrEqual(45);
      expect(await bundledFolders(company.companyId)).toEqual(foldersAfterFirst);
    }
  }, 60_000);

  it("creates exactly one folder when two first requests ensure the same category at once", async () => {
    const company = await seedCompanyWithBoardAccess(ctx.db, "Skills race");
    const [left, right] = await Promise.all([
      folderService(ctx.db).ensureBundledCategory(company.companyId, "Race Category"),
      folderService(ctx.db).ensureBundledCategory(company.companyId, "Race Category"),
    ]);
    expect(left.id).toBe(right.id);
    const rows = await bundledFolders(company.companyId);
    expect(rows.filter((row) => row.systemKey === "bundled:race-category")).toHaveLength(1);
    expect(rows.filter((row) => row.systemKey === "bundled")).toHaveLength(1);

    const app = routeApp(ctx.db, company.actor, (db) => companySkillRoutes(db));
    await Promise.all([
      request(app).get(`/api/companies/${company.companyId}/skills`).expect(200),
      request(app).get(`/api/companies/${company.companyId}/skills`).expect(200),
    ]);
    const systemKeys = (await bundledFolders(company.companyId)).map((row) => row.systemKey);
    expect(new Set(systemKeys).size).toBe(systemKeys.length);
  }, 60_000);

  it("still renames a changed category and prunes an empty one under the lock", async () => {
    const statements = meter();
    {
      const company = await seedCompanyWithBoardAccess(ctx.db, "Skills repair");
      const svc = folderService(statements.db);
      const locked = async (write: () => Promise<unknown>) => {
        const before = statements.read();
        statements.startLog();
        await write();
        const log = statements.stopLog();
        const lockIndex = log.findIndex((entry) => /pg_advisory_xact_lock/.test(entry.sql));
        const writes = log.filter((entry) => /^\s*(insert|update|delete)\b/i.test(entry.sql));
        return {
          transactions: statements.read().transactions - before.transactions,
          lockedBeforeWrite: lockIndex >= 0 && writes.every((entry) => entry.inTransaction && log.indexOf(entry) > lockIndex),
          writes: writes.length,
        };
      };

      const created = await locked(() => svc.ensureBundledCategory(company.companyId, "Repair Category"));
      expect(created).toMatchObject({ transactions: 1, lockedBeforeWrite: true });
      expect(created.writes).toBeGreaterThan(0);
      const [category] = (await bundledFolders(company.companyId)).filter((row) => row.systemKey === "bundled:repair-category");
      await ctx.db.update(folders).set({ name: "Renamed by hand" }).where(eq(folders.id, category!.id));
      const renamed = await locked(() => svc.ensureBundledCategory(company.companyId, "Repair Category"));
      expect(renamed).toMatchObject({ transactions: 1, lockedBeforeWrite: true, writes: 1 });
      expect((await bundledFolders(company.companyId)).find((row) => row.id === category!.id)?.name).toBe("Repair Category");

      expect(await locked(() => svc.pruneEmptyBundledCategories(company.companyId, ["Repair Category"])))
        .toEqual({ transactions: 0, lockedBeforeWrite: false, writes: 0 });
      expect((await bundledFolders(company.companyId)).map((row) => row.id)).toContain(category!.id);
      expect(await locked(() => svc.pruneEmptyBundledCategories(company.companyId, [])))
        .toEqual({ transactions: 1, lockedBeforeWrite: true, writes: 1 });
      expect((await bundledFolders(company.companyId)).map((row) => row.id)).not.toContain(category!.id);
    }
  }, 60_000);
});
