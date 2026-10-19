import { randomUUID } from "node:crypto";

// Raster types only: an inline SVG stays inline rather than become a served file.
const INLINE_IMAGE_PATTERN = /data:image\/(png|jpe?g|gif|webp);base64,([A-Za-z0-9+/]+={0,2})/g;
const ATTACHMENT_URL_PATTERN = /\/api\/attachments\/[0-9a-f-]{36}\/content/g;

export type InlineImage = { attachmentId: string; contentType: string; body: Buffer };

/**
 * Swap each inline base64 image in markdown for `/api/attachments/<id>/content`,
 * with ids made here. `addComment` stores the images as attachments under those
 * ids, so a pasted image never sits in a comment body.
 */
export function extractInlineImages(markdown: string): { markdown: string; images: InlineImage[] } {
  const images: InlineImage[] = [];
  const replaced = markdown.replace(INLINE_IMAGE_PATTERN, (match, type: string, data: string) => {
    const body = Buffer.from(data, "base64");
    if (body.length === 0) return match;
    const attachmentId = randomUUID();
    images.push({ attachmentId, contentType: `image/${type === "jpg" ? "jpeg" : type}`, body });
    return `/api/attachments/${attachmentId}/content`;
  });
  return { markdown: replaced, images };
}

/** Compare a retried post with its stored copy, ignoring the attachment ids each extraction makes. */
export function sameBodyIgnoringAttachmentIds(a: string, b: string): boolean {
  return a.replace(ATTACHMENT_URL_PATTERN, "") === b.replace(ATTACHMENT_URL_PATTERN, "");
}
