import { useEffect, useMemo, useState } from "react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  CornerDownRight,
  GripVertical,
  Loader2,
  MoreHorizontal,
  Pencil,
  Trash2,
} from "lucide-react";
import type {
  IssueQueuedCommentEntry,
  IssueQueuedCommentQueue,
} from "@paperclipai/shared";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

type QueueAction = "steer" | "interrupt" | "discard" | null;

export function reorderQueuedMessageEntries(
  entries: IssueQueuedCommentEntry[],
  activeId: string,
  overId: string,
) {
  if (entries.some((entry) => entry.source?.kind === "interaction")) return null;
  const from = entries.findIndex((entry) => entry.comment.id === activeId);
  const to = entries.findIndex((entry) => entry.comment.id === overId);
  if (from < 0 || to < 0 || from === to) return null;
  return arrayMove(entries, from, to).map((entry, position) => ({
    ...entry,
    position,
  }));
}

function queueActionErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const body = (error as { body?: unknown }).body;
  if (typeof body !== "object" || body === null) return null;
  const directCode = (body as { code?: unknown }).code;
  if (typeof directCode === "string") return directCode;
  const details = (body as { details?: unknown }).details;
  if (typeof details !== "object" || details === null) return null;
  const detailCode = (details as { code?: unknown }).code;
  return typeof detailCode === "string" ? detailCode : null;
}

type QueueNotice = { text: string; tone: "info" | "error" };

/**
 * Fork change (Local changes in paperclip-ops `CLAUDE.md`): the line a failed
 * Steer shows under the queue, by the steer route's error code. The usual
 * cases are not faults, so they read grey; an unknown code shows the
 * server's own message.
 */
export function steerFailureNotice(error: unknown): QueueNotice {
  switch (queueActionErrorCode(error)) {
    case "steering_rejected":
      return { tone: "info", text: "The agent is between turns. It gets this message when this run ends." };
    case "steering_temporarily_unavailable":
      return { tone: "info", text: "This run has stopped taking messages. It gets this message when the run ends." };
    case "steering_timeout":
      return {
        tone: "error",
        text: "The agent didn’t confirm within 10 seconds. It may still read it; the message stays queued in case.",
      };
    case "queued_comment_stale_target":
    case "queued_comment_not_pending":
      return { tone: "info", text: "This message already went out, or its run ended." };
    case "queued_comment_revision_conflict":
      return { tone: "error", text: "The queue changed in another session. Review it and try again." };
  }
  const body = (error as { body?: { error?: unknown } } | null)?.body;
  const serverText = typeof body?.error === "string" ? body.error : null;
  return {
    tone: "error",
    text: serverText ? `Couldn’t steer: ${serverText}` : "Couldn’t steer. Message is still queued.",
  };
}

export interface TaskChatQueuedMessagesProps {
  queue: IssueQueuedCommentQueue;
  onEdit: (commentId: string) => void;
  onReorder: (orderedCommentIds: string[], revision: string) => Promise<void>;
  onSteer: (commentId: string, revision: string) => Promise<void>;
  onInterrupt?: () => Promise<void>;
  onDiscard: (commentId: string, revision: string) => Promise<void>;
}

function SortableQueuedMessage({
  entry,
  queue,
  busy,
  queueMutationDisabled,
  action,
  steerFailed,
  onEdit,
  onSteer,
  onInterrupt,
  onDiscard,
}: {
  entry: IssueQueuedCommentEntry;
  queue: IssueQueuedCommentQueue;
  busy: boolean;
  queueMutationDisabled: boolean;
  action: QueueAction;
  /** A Steer of this row just failed, so Interrupt is offered next to it. */
  steerFailed: boolean;
  onEdit: () => void;
  onSteer: () => void;
  onInterrupt?: () => void;
  onDiscard: () => void;
}) {
  const immutableResponse = entry.source?.kind === "interaction";
  const label = immutableResponse ? entry.comment.body.split("\n")[0] : entry.comment.body;
  const sortable = useSortable({
    id: entry.comment.id,
    disabled: queueMutationDisabled || immutableResponse,
  });
  const style = {
    transform: CSS.Transform.toString(sortable.transform),
    transition: sortable.transition,
  };
  const steerDisabled =
    queueMutationDisabled || queue.steeringDisposition !== "available";
  const steerTitle =
    queue.steeringDisposition === "unsupported"
      ? "This runner does not support steering"
      : queue.steeringDisposition === "temporarily_unavailable"
        ? "Steering is temporarily unavailable"
        : "Steer this message into the active turn";
  const interruptButton = (
    <button
      type="button"
      onClick={onInterrupt}
      disabled={busy || !queue.queueId || !onInterrupt}
      title={queue.targetRunId ? "Interrupt the active turn and send queued messages" : "Send queued messages now"}
      className="flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
      data-testid={`task-chat-queued-interrupt-${entry.comment.id}`}
    >
      {action === "interrupt" ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
      ) : (
        <CornerDownRight className="h-3.5 w-3.5" aria-hidden />
      )}
      Interrupt
    </button>
  );

  return (
    <div
      ref={sortable.setNodeRef}
      style={style}
      className={cn(
        "group flex h-11 min-w-0 items-center gap-1 border-b border-border/55 bg-card/95 px-2.5 text-sm last:border-b-0",
        sortable.isDragging &&
          "relative z-20 rounded-lg border border-border shadow-lg",
      )}
      data-testid={`task-chat-queued-message-${entry.comment.id}`}
    >
      <button
        type="button"
        ref={sortable.setActivatorNodeRef}
        {...sortable.attributes}
        {...sortable.listeners}
        disabled={queueMutationDisabled || immutableResponse}
        aria-label={`Reorder queued message: ${entry.comment.body}`}
        className="flex h-7 w-7 shrink-0 cursor-grab items-center justify-center rounded-md text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground active:cursor-grabbing disabled:cursor-default disabled:opacity-40"
      >
        <GripVertical className="h-3.5 w-3.5" aria-hidden />
      </button>

      <CornerDownRight
        className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
        aria-hidden
      />
      <span className="min-w-0 flex-1 truncate px-1" title={entry.comment.body}>
        {label}
      </span>

      {/* A legacy run offers Steer only while its adapter takes messages. */}
      {(queue.protocol === "legacy" && queue.steeringDisposition !== "available") ||
      entry.source?.requiresFreshSession ? (
        interruptButton
      ) : (
        <>
          <button
            type="button"
            onClick={onSteer}
            disabled={steerDisabled}
            title={steerTitle}
            className="flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
            data-testid={`task-chat-queued-steer-${entry.comment.id}`}
          >
            {action === "steer" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            ) : (
              <CornerDownRight className="h-3.5 w-3.5" aria-hidden />
            )}
            Steer
          </button>
          {steerFailed && onInterrupt ? interruptButton : null}
        </>
      )}

      <button
        type="button"
        onClick={onDiscard}
        disabled={
          busy ||
          (!queue.queueId && !entry.comment.id.startsWith("optimistic-")) ||
          !entry.canDiscard
        }
        title="Discard queued message"
        aria-label={`Discard queued message: ${entry.comment.body}`}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-40"
        data-testid={`task-chat-queued-discard-${entry.comment.id}`}
      >
        {action === "discard" ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
        ) : (
          <Trash2 className="h-3.5 w-3.5" aria-hidden />
        )}
      </button>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            disabled={queueMutationDisabled || immutableResponse}
            title="Queued message actions"
            aria-label={`Queued message actions: ${entry.comment.body}`}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
          >
            <MoreHorizontal className="h-4 w-4" aria-hidden />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          <DropdownMenuItem disabled={!entry.canEdit} onSelect={onEdit}>
            <Pencil className="h-4 w-4" aria-hidden />
            Edit message
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/** Compact production queue shown immediately above the default task composer. */
export function TaskChatQueuedMessages({
  queue,
  onEdit,
  onReorder,
  onSteer,
  onInterrupt,
  onDiscard,
}: TaskChatQueuedMessagesProps) {
  const [entries, setEntries] = useState(queue.entries);
  const [pending, setPending] = useState<{
    commentId: string;
    action: Exclude<QueueAction, null>;
  } | null>(null);
  const [reordering, setReordering] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const [notice, setNotice] = useState<QueueNotice | null>(null);
  const [steerFailedId, setSteerFailedId] = useState<string | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  useEffect(() => {
    setEntries(queue.entries);
  }, [queue.entries, queue.revision]);

  const ids = useMemo(
    () => entries.map((entry) => entry.comment.id),
    [entries],
  );

  async function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (
      !queue.queueId ||
      !over ||
      active.id === over.id ||
      reordering ||
      pending
    )
      return;
    const previous = entries;
    const next = reorderQueuedMessageEntries(
      entries,
      String(active.id),
      String(over.id),
    );
    if (!next) return;
    const orderedIds = next.map((entry) => entry.comment.id);
    const activeCommentId = String(active.id);
    const to = next.findIndex((entry) => entry.comment.id === activeCommentId);
    setEntries(next);
    setReordering(true);
    setNotice(null);
    setAnnouncement(
      `Moved queued message to position ${to + 1} of ${next.length}.`,
    );
    try {
      await onReorder(orderedIds, queue.revision);
    } catch (error) {
      setEntries(previous);
      setAnnouncement("");
      setNotice({
        tone: "error",
        text:
          queueActionErrorCode(error) === "queued_comment_revision_conflict"
            ? "The queue changed in another session. Its latest order has been restored."
            : "Couldn’t reorder. Previous order restored.",
      });
    } finally {
      setReordering(false);
    }
  }

  async function runRowAction(
    commentId: string,
    action: Exclude<QueueAction, null>,
  ) {
    const locallyDiscardable =
      action === "discard" && commentId.startsWith("optimistic-");
    if (
      pending ||
      reordering ||
      (!queue.queueId && action !== "interrupt" && !locallyDiscardable)
    ) {
      return;
    }
    const previous = entries;
    setPending({ commentId, action });
    setNotice(null);
    setSteerFailedId(null);
    setAnnouncement(
      action === "steer"
        ? "Steering queued message."
        : action === "interrupt"
          ? "Sending queued messages."
          : "Discarding queued message.",
    );
    if (action === "steer") {
      setEntries((current) =>
        current.filter((entry) => entry.comment.id !== commentId),
      );
    }
    try {
      if (action === "steer") await onSteer(commentId, queue.revision);
      else if (action === "interrupt") await onInterrupt?.();
      else await onDiscard(commentId, queue.revision);
      if (action === "discard") {
        setEntries((current) =>
          current.filter((entry) => entry.comment.id !== commentId),
        );
      }
      setAnnouncement(
        action === "steer"
          ? "Message steered into the active turn."
          : action === "interrupt"
            ? "Queued messages will be sent when the previous run has stopped."
            : "Queued message discarded.",
      );
    } catch (error) {
      if (action === "steer") setEntries(previous);
      setAnnouncement("");
      const code = queueActionErrorCode(error);
      if (action === "steer") {
        setNotice(steerFailureNotice(error));
        setSteerFailedId(commentId);
      } else {
        setNotice({
          tone: "error",
          text:
            code === "queued_comment_already_dispatching"
              ? "Too late to discard: this message is already being sent."
              : action === "interrupt"
                ? "Couldn’t interrupt. Message is still queued."
                : code === "queued_comment_revision_conflict"
                  ? "The queue changed in another session. Review it and try again."
                  : "Couldn’t discard. Message is still queued.",
        });
      }
    } finally {
      setPending(null);
    }
  }

  if (entries.length === 0) return null;

  return (
    <div
      className="relative z-0 mx-3 -mb-px overflow-hidden rounded-t-xl rounded-b-none border border-b-0 border-border/75 bg-card shadow-sm"
      data-testid="task-chat-queued-messages"
      aria-label="Queued messages"
    >
      {queue.executionWait && (
        <div role="status" aria-live="polite" className="px-3 py-1.5 text-xs text-muted-foreground">
          {queue.executionWait.message}
        </div>
      )}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={(event) => void handleDragEnd(event)}
      >
        <SortableContext items={ids} strategy={verticalListSortingStrategy}>
          {entries.map((entry) => {
            const action =
              pending?.commentId === entry.comment.id ? pending.action : null;
            const busy = Boolean(pending || reordering);
            const queueMutationDisabled = Boolean(
              !queue.queueId || pending || reordering,
            );
            return (
              <SortableQueuedMessage
                key={entry.comment.id}
                entry={entry}
                queue={queue}
                busy={busy}
                queueMutationDisabled={queueMutationDisabled}
                action={action}
                steerFailed={steerFailedId === entry.comment.id}
                onEdit={() => onEdit(entry.comment.id)}
                onSteer={() => void runRowAction(entry.comment.id, "steer")}
                onInterrupt={
                  onInterrupt
                    ? () => void runRowAction(entry.comment.id, "interrupt")
                    : undefined
                }
                onDiscard={() => void runRowAction(entry.comment.id, "discard")}
              />
            );
          })}
        </SortableContext>
      </DndContext>
      {notice ? (
        <div
          role="status"
          aria-live="polite"
          className={cn(
            "border-t px-3 py-1.5 text-xs",
            notice.tone === "error"
              ? "border-destructive/20 bg-destructive/5 text-destructive"
              : "border-border/60 bg-muted/30 text-muted-foreground",
          )}
          data-testid="task-chat-queued-notice"
        >
          {notice.text}
        </div>
      ) : null}
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>
    </div>
  );
}
