import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { assets, companies, createDb, issueAttachments, issueComments, issues } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const stored = new Map<string, Buffer>();
vi.mock("../storage/index.js", () => ({
  getStorageService: () => ({
    provider: "local_disk",
    putFile: async (input: { namespace: string; contentType: string; originalFilename: string | null; body: Buffer }) => {
      const objectKey = `${input.namespace}/${randomUUID()}`;
      stored.set(objectKey, input.body);
      return { provider: "local_disk", objectKey, contentType: input.contentType, byteSize: input.body.length, sha256: "x", originalFilename: input.originalFilename };
    },
  }),
}));

const { issueService } = await import("../services/issues.js");

describe("comment save turns inline images into attachments", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => { temporary = await startEmbeddedPostgresTestDatabase("inline-images-"); db = createDb(temporary.connectionString); }, 20_000);
  afterAll(async () => { await db?.$client.end({ timeout: 0 }); await temporary?.cleanup(); });

  it("stores the pasted PNG as an attachment of the comment and saves its URL in the body", async () => {
    const companyId = randomUUID(), issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Inline fixture", issuePrefix: `I${companyId.slice(0, 6)}`, defaultResponsibleUserId: "local-board" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Pasted screenshot", status: "todo", responsibleUserId: "local-board" });
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
    const body = `Look:\n\n![shot](data:image/png;base64,${png.toString("base64")})\n\nand ![svg](data:image/svg+xml;base64,PHN2Zz4=)`;

    const comment = await issueService(db).addComment(issueId, body, { userId: "local-board" });

    const [row] = await db.select().from(issueComments).where(eq(issueComments.id, comment.id));
    const [attachment] = await db.select().from(issueAttachments).where(eq(issueAttachments.issueCommentId, comment.id));
    expect(row.body).toBe(`Look:\n\n![shot](/api/attachments/${attachment.id}/content)\n\nand ![svg](data:image/svg+xml;base64,PHN2Zz4=)`);
    const [asset] = await db.select().from(assets).where(eq(assets.id, attachment.assetId));
    expect(asset).toMatchObject({ contentType: "image/png", byteSize: png.length, originalFilename: "pasted-image.png", createdByUserId: "local-board" });
    expect(stored.get(asset.objectKey)).toEqual(png);
  });
});
