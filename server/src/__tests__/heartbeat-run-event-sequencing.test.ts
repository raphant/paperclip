import { describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  allocateHeartbeatRunEventSeq,
  appendHeartbeatRunEvent,
  HeartbeatRunEventConflictError,
} from "../services/heartbeat-run-events.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

describe("P6-11..13 / P6-17 canonical event allocator", () => {
  it.each([false, true])("deduplicates concurrent retry exhaustion (historical receipt: %s)", async (historical) => {
    const temporary = await startEmbeddedPostgresTestDatabase("paperclip-exhaustion-events-");
    const db = createDb(temporary.connectionString);
    const otherDb = createDb(temporary.connectionString);
    const companyId = "20000000-0000-4000-8000-000000000001";
    const agentId = "20000000-0000-4000-8000-000000000002";
    const runId = "20000000-0000-4000-8000-000000000003";
    const otherRunId = "20000000-0000-4000-8000-000000000004";
    const exhaustion = { retryReason: "transient_failure", scheduledRetryAttempt: 2, maxAttempts: 2 };
    const event = {
      companyId, agentId, runId, eventType: "lifecycle",
      message: "Bounded retry exhausted after 2 scheduled attempts; no further automatic retry will be queued",
      payload: exhaustion,
    };
    try {
      await db.insert(companies).values({ id: companyId, name: "Exhaustion fixture", issuePrefix: "EXH" });
      await db.insert(agents).values({ id: agentId, companyId, name: "Exhaustion agent" });
      await db.insert(heartbeatRuns).values([runId, otherRunId].map((id) => ({
        id, companyId, agentId, status: "failed",
      })));
      if (historical) {
        // Old builds wrote ordinary lifecycle rows with no new idempotency field.
        await appendHeartbeatRunEvent(db, event);
      }
      const receipts = await Promise.all(Array.from({ length: 16 }, (_, index) =>
        appendHeartbeatRunEvent(index % 2 ? db : otherDb, {
          ...event, retryExhaustion: exhaustion,
        })));
      expect(receipts.filter((receipt) => receipt.disposition === "committed"))
        .toHaveLength(historical ? 0 : 1);
      expect(new Set(receipts.map((receipt) => receipt.row.id)).size).toBe(1);
      expect(await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, runId)))
        .toHaveLength(1);
      expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0]?.nextEventSeq)
        .toBe(2);

      // The key is per run, reason, attempt, and budget. Distinct exhaustion
      // decisions still get their own receipt and an ordinary sequence number.
      for (const changed of [
        { ...exhaustion, retryReason: "bootstrap_failure" },
        { ...exhaustion, scheduledRetryAttempt: 3 },
        { ...exhaustion, maxAttempts: 3 },
      ]) {
        expect((await appendHeartbeatRunEvent(db, {
          ...event, payload: changed, retryExhaustion: changed,
        })).disposition).toBe("committed");
      }
      expect((await appendHeartbeatRunEvent(db, {
        ...event, runId: otherRunId, retryExhaustion: exhaustion,
      })).disposition).toBe("committed");
      const rows = await db.select().from(heartbeatRunEvents)
        .where(eq(heartbeatRunEvents.runId, runId)).orderBy(heartbeatRunEvents.seq);
      expect(rows.map((row) => row.seq)).toEqual([1, 2, 3, 4]);
      await expect(appendHeartbeatRunEvent(db, {
        ...event, companyId: "20000000-0000-4000-8000-000000000099", retryExhaustion: exhaustion,
      })).rejects.toThrow("heartbeat_run_event_binding_mismatch");
    } finally {
      await temporary.cleanup();
    }
  }, 60_000);

  it("serializes concurrent writers and rejects conflicting replay without cursor drift", async () => {
    const temporary = await startEmbeddedPostgresTestDatabase("paperclip-native-events-");
    const db = createDb(temporary.connectionString);
    const companyId = "20000000-0000-4000-8000-000000000001";
    const agentId = "20000000-0000-4000-8000-000000000002";
    const runId = "20000000-0000-4000-8000-000000000003";
    try {
      await db.insert(companies).values({ id: companyId, name: "Allocator fixture", issuePrefix: "SEQ" });
      await db.insert(agents).values({ id: agentId, companyId, name: "Allocator agent" });
      await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running" });
      const eventTypes = ["heartbeat.started", "run.cancel.requested", "item.completed", "stdout"];
      const writes = Array.from({ length: 32 }, (_, index) => appendHeartbeatRunEvent(db, {
        companyId,
        runId,
        agentId,
        eventType: eventTypes[index % eventTypes.length]!,
        message: `event-${index + 1}`,
        payload: { ordinal: index + 1 },
        nativeSource: {
          sourceInstanceId: `writer-${index % 4}`,
          sourceEventId: `source-event-${index + 1}`,
          sourceSeq: Math.floor(index / 4) + 1,
          protocolSchemaVersion: 1,
          canonicalPayload: { ordinal: index + 1 },
        },
      }));
      const receipts = await Promise.all(writes);
      expect(receipts.every((entry) => entry.disposition === "committed")).toBe(true);

      const rows = await db.select().from(heartbeatRunEvents)
        .where(eq(heartbeatRunEvents.runId, runId)).orderBy(heartbeatRunEvents.seq);
      expect(rows.map((row) => row.seq)).toEqual(Array.from({ length: 32 }, (_, index) => index + 1));
      expect(new Set(rows.map((row) => row.sourceEventId)).size).toBe(32);
      expect((await db.select({ nextEventSeq: heartbeatRuns.nextEventSeq }).from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId)))[0]?.nextEventSeq).toBe(33);

      const legacyWrites = Array.from({ length: 16 }, (_, index) => (async () => {
        const seq = await allocateHeartbeatRunEventSeq(db, runId);
        await db.insert(heartbeatRunEvents).values({
          companyId,
          runId,
          agentId,
          seq,
          eventType: "stdout",
          message: `legacy-event-${index + 1}`,
        });
        return seq;
      })());
      const legacySequences = await Promise.all(legacyWrites);
      expect([...legacySequences].sort((a, b) => a - b)).toEqual(
        Array.from({ length: 16 }, (_, index) => index + 33),
      );
      expect((await db.select({ nextEventSeq: heartbeatRuns.nextEventSeq }).from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId)))[0]?.nextEventSeq).toBe(49);

      const original = rows.find((row) => row.sourceEventId === "source-event-1")!;
      await expect(appendHeartbeatRunEvent(db, {
        companyId,
        runId,
        agentId,
        eventType: original.eventType,
        message: original.message,
        payload: original.payload,
        nativeSource: {
          sourceInstanceId: original.sourceInstanceId!,
          sourceEventId: original.sourceEventId!,
          sourceSeq: original.sourceSeq!,
          protocolSchemaVersion: 1,
          canonicalPayload: { ordinal: 1 },
        },
      })).resolves.toEqual(expect.objectContaining({ disposition: "duplicate" }));
      await expect(appendHeartbeatRunEvent(db, {
        companyId,
        runId,
        agentId,
        eventType: "item.failed",
        nativeSource: {
          sourceInstanceId: original.sourceInstanceId!,
          sourceEventId: original.sourceEventId!,
          sourceSeq: original.sourceSeq!,
          protocolSchemaVersion: 1,
          canonicalPayload: { ordinal: 999 },
        },
      })).rejects.toBeInstanceOf(HeartbeatRunEventConflictError);
      expect(await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, runId))).toHaveLength(48);
    } finally {
      await temporary.cleanup();
    }
  }, 60_000);

  // Carved from upstream c444da7d0 (#20670): upstream proves it with a native-runner
  // checkpoint row, a table the fork does not have; an activity_log row references
  // the run by foreign key the same way.
  it("serializes appenders without blocking child foreign key checks on the run", async () => {
    const temporary = await startEmbeddedPostgresTestDatabase("paperclip-event-lock-");
    const db = createDb(temporary.connectionString);
    const otherDb = createDb(temporary.connectionString);
    const companyId = "20000000-0000-4000-8000-000000000001";
    const agentId = "20000000-0000-4000-8000-000000000002";
    const runId = "20000000-0000-4000-8000-000000000003";
    try {
      await db.insert(companies).values({ id: companyId, name: "Lock fixture", issuePrefix: "LCK" });
      await db.insert(agents).values({ id: agentId, companyId, name: "Lock agent" });
      await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running" });
      const native = (ordinal: number) => ({
        companyId, agentId, runId, eventType: "item.completed",
        nativeSource: { sourceInstanceId: "native-writer", sourceEventId: `held-${ordinal}`,
          sourceSeq: ordinal, protocolSchemaVersion: 1, canonicalPayload: { ordinal } },
      });
      let releaseHolder!: () => void;
      const held = new Promise<void>((resolve) => { releaseHolder = resolve; });
      let holderLocked!: () => void;
      const locked = new Promise<void>((resolve) => { holderLocked = resolve; });
      // An append whose transaction is still open holds the run lock.
      const holder = otherDb.transaction(async (tx) => {
        await appendHeartbeatRunEvent(tx as unknown as typeof db, native(1));
        holderLocked();
        await held;
      });
      await locked;
      let secondSettled = false;
      const second = appendHeartbeatRunEvent(db, native(2)).finally(() => { secondSettled = true; });
      try {
        // A child row that references the run by foreign key must not wait for the open append.
        await db.transaction(async (tx) => {
          await tx.execute(sql`set local lock_timeout = '2s'`);
          await tx.insert(activityLog).values({ companyId, actorId: "fixture", action: "fixture.logged",
            entityType: "heartbeat_run", entityId: runId, runId });
        });
        // Another appender still waits for the open append.
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(secondSettled).toBe(false);
      } finally {
        releaseHolder();
        await holder;
      }
      expect((await second).row.seq).toBe(2);
      const rows = await db.select().from(heartbeatRunEvents)
        .where(eq(heartbeatRunEvents.runId, runId)).orderBy(heartbeatRunEvents.seq);
      expect(rows.map((row) => [row.seq, row.sourceSeq])).toEqual([[1, 1], [2, 2]]);
      expect((await db.select({ nextEventSeq: heartbeatRuns.nextEventSeq }).from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId)))[0]?.nextEventSeq).toBe(3);
      expect(await db.select({ action: activityLog.action }).from(activityLog)
        .where(eq(activityLog.runId, runId))).toEqual([{ action: "fixture.logged" }]);
    } finally {
      await temporary.cleanup();
    }
  }, 60_000);
});
