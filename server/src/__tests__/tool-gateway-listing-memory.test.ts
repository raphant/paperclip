import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createDb,
  toolProfileBindings,
  toolProfileEntries,
} from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { toolAccessPolicyService } from "../services/tool-access-policy.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

import { createListingFixture } from "./helpers/tool-gateway-listing-fixture.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;

describeEmbeddedPostgres("tool gateway listing memory", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-tool-gateway-listing-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("does not construct a condition clock for unmatched entries in a decision batch", async () => {
    const fixture = await createListingFixture(db, 6);
    const [binding] = await db.select().from(toolProfileBindings)
      .where(and(eq(toolProfileBindings.companyId, fixture.company.id), eq(toolProfileBindings.targetId, fixture.namedGateway.id)));
    expect(binding).toBeDefined();
    for (let start = 0; start < 47_930; start += 1000) {
      await db.insert(toolProfileEntries).values(Array.from({ length: Math.min(1000, 47_930 - start) }, (_, offset) => ({
        companyId: fixture.company.id, profileId: binding!.profileId,
        selectorType: "tool_name" as const, toolName: `not_selected_${start + offset}`, effect: "exclude" as const,
      })));
    }
    const policy = toolAccessPolicyService(db);
    const originalDate = Date;
    let clocks = 0;
    vi.stubGlobal("Date", new Proxy(originalDate, {
      construct(target, args, constructor) {
        if (args.length === 0) clocks++;
        return Reflect.construct(target, args, constructor);
      },
    }));
    const decisions = [];
    try {
      for (let index = 0; index < 10; index++) {
        const entry = fixture.entries[4 + index % 2]!;
        decisions.push(await policy.decide({
          companyId: fixture.company.id,
          actor: { actorType: "agent", actorId: fixture.agent.id, agentId: fixture.agent.id },
          runContext: { heartbeatRunId: fixture.run.id, issueId: fixture.issue.id, projectId: fixture.project.id, gatewayId: fixture.namedGateway.id },
          request: { toolName: entry.toolName!, applicationId: fixture.application.id, connectionId: fixture.connection.id,
            catalogEntryId: entry.id, upstreamToolName: entry.toolName!, riskLevel: entry.riskLevel, arguments: {} },
          consumeRateLimit: false,
        }));
      }
    } finally {
      vi.unstubAllGlobals();
    }
    expect(decisions).toHaveLength(10);
    expect(decisions.every(decision => decision.allowed && decision.reasonCode === "allow_profile")).toBe(true);
    expect(clocks).toBeLessThan(5000);
  }, 30_000);
});
