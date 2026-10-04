import { useEffect, useState } from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { Maximize2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * CSP added to every HTML artifact. Scripts, styles, fonts, images and
 * `fetch` may come from `https:` CDNs only, so the page cannot call the
 * Paperclip API (same host over `http:`), post forms, or change its base URL.
 */
export const HTML_ARTIFACT_CSP =
  "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' https:; style-src 'unsafe-inline' https:; img-src data: blob: https:; font-src data: https:; media-src data: blob: https:; connect-src https:; form-action 'none'; base-uri 'none'";

const DOCTYPE = /^\s*<!doctype[^>]*>/i;

/** Puts the CSP `<meta>` first, after the doctype if there is one (keeps standards mode). */
function withCsp(html: string) {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${HTML_ARTIFACT_CSP}">`;
  const doctype = DOCTYPE.exec(html)?.[0];
  return doctype ? `${doctype}${meta}${html.slice(doctype.length)}` : `${meta}${html}`;
}

/** Fetches the page from `contentPath` (same origin; the download header does not matter to `fetch`). */
function useHtmlArtifactDocument(contentPath: string) {
  const [loaded, setLoaded] = useState<{ contentPath: string; document: string | null } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(contentPath, { credentials: "same-origin", signal: controller.signal });
        const document = response.ok ? withCsp(await response.text()) : null;
        if (!controller.signal.aborted) setLoaded({ contentPath, document });
      } catch {
        if (!controller.signal.aborted) setLoaded({ contentPath, document: null });
      }
    })();
    return () => controller.abort();
  }, [contentPath]);
  if (loaded?.contentPath !== contentPath) return undefined;
  return loaded.document;
}

/**
 * The live page in a sandbox: `allow-scripts` only, so it runs in an opaque
 * origin with no cookies, no parent access, no forms, no popups and no top
 * navigation. srcdoc does not get the content route's headers, hence the CSP.
 */
function SandboxedHtml({ contentPath, title, className }: { contentPath: string; title: string; className?: string }) {
  const data = useHtmlArtifactDocument(contentPath);
  if (data === null) {
    return <div className={cn("flex items-center justify-center bg-muted/30 text-xs text-muted-foreground", className)}>Could not load HTML preview.</div>;
  }
  if (data === undefined) {
    return <div className={cn("flex items-center justify-center bg-muted/30 text-xs text-muted-foreground", className)}>Loading preview...</div>;
  }
  return (
    <iframe
      title={title}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      srcDoc={data}
      className={cn("block w-full border-0 bg-white", className)}
    />
  );
}

function FullSizeModal({ contentPath, title, onClose }: { contentPath: string; title: string; onClose: () => void }) {
  return (
    <DialogPrimitive.Root open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/90" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className="fixed inset-0 z-50 flex flex-col gap-2 p-3 outline-none md:p-6"
        >
          <div className="flex items-center justify-between gap-4 text-sm text-white/80">
            <DialogPrimitive.Title className="truncate font-medium" title={title}>{title}</DialogPrimitive.Title>
            <DialogPrimitive.Close className="text-white/50 transition-colors hover:text-white" title="Close" aria-label="Close">
              <X className="h-5 w-5" />
            </DialogPrimitive.Close>
          </div>
          <SandboxedHtml contentPath={contentPath} title={title} className="min-h-0 flex-1 rounded-lg" />
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/**
 * Shows an `.html` artifact rendered and live (see `isHtmlLikeOutput`).
 * Inline surfaces get a fixed-height frame plus a **Full size** button.
 * `thumbnail` (Artifacts page cards) drops the button and lets clicks pass
 * through to the card; size it with `className`.
 */
export function HtmlArtifactFrame({
  contentPath,
  title,
  className,
  thumbnail = false,
}: {
  contentPath: string;
  title: string;
  className?: string;
  thumbnail?: boolean;
}) {
  const [fullSize, setFullSize] = useState(false);
  if (thumbnail) {
    return (
      <div className={cn("pointer-events-none overflow-hidden", className)} data-testid="html-artifact-thumbnail">
        <SandboxedHtml contentPath={contentPath} title={title} className="h-full" />
      </div>
    );
  }
  return (
    <div className={cn("relative overflow-hidden rounded-md border border-border", className)} data-testid="html-artifact-frame">
      <SandboxedHtml contentPath={contentPath} title={title} className="h-80" />
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className="absolute right-2 top-2 shadow-sm"
        onClick={(event) => { event.stopPropagation(); setFullSize(true); }}
      >
        <Maximize2 className="h-3.5 w-3.5" />
        Full size
      </Button>
      {fullSize ? <FullSizeModal contentPath={contentPath} title={title} onClose={() => setFullSize(false)} /> : null}
    </div>
  );
}
