import { AgentIdentity } from "@/components/AgentIdentity";
import { useMemo, useState } from "react";
import { Link } from "@/lib/router";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  type DragStartEvent,
  type DragEndEvent,
} from "@dnd-kit/core";
import { useDroppable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { StatusIcon } from "./StatusIcon";
import { PriorityIcon } from "./PriorityIcon";
import { SHOW_TASK_PRIORITY_UI } from "../lib/ui-flags";
import { Identity } from "./Identity";
import type { Issue, IssueStatus } from "@paperclipai/shared";
import { AlertTriangle, ChevronDown, ChevronRight } from "lucide-react";
import { isSuccessfulRunHandoffRequired } from "../lib/successful-run-handoff";
import { collectSubtreeLiveCounts } from "../lib/liveIssueIds";
import { cn } from "../lib/utils";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export const KANBAN_BOARD_HIGH_VOLUME_THRESHOLD = 100;
export const KANBAN_COLUMN_PAGE_SIZE_OPTIONS = [10, 25, 50] as const;
export type KanbanColumnPageSize = (typeof KANBAN_COLUMN_PAGE_SIZE_OPTIONS)[number];
export const KANBAN_COLUMN_DEFAULT_PAGE_SIZE: KanbanColumnPageSize = 10;
export const KANBAN_COLUMN_INITIAL_VISIBLE_LIMIT = KANBAN_COLUMN_DEFAULT_PAGE_SIZE;
export const KANBAN_COLUMN_REVEAL_INCREMENT = KANBAN_COLUMN_DEFAULT_PAGE_SIZE;
export const KANBAN_COLD_STATUSES = ["backlog", "done", "cancelled"] as const;

export const boardStatuses = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "blocked",
  "done",
  "cancelled",
] as const satisfies readonly IssueStatus[];

const defaultKanbanColumnTone = {
  rail: "border-border bg-muted/20",
  railOver: "bg-accent/50 ring-1 ring-primary/20",
  header: "text-muted-foreground",
  count: "text-muted-foreground/60",
  body: "bg-muted/20",
  bodyOver: "bg-accent/40",
  card: "",
};

// Every column carries a status-hued tint (matching the app-wide status
// vocabulary: gray backlog, amber todo, blue in-progress, violet review,
// red blocked, green done) so no column reads as accidentally unstyled.
export const kanbanColumnTones: Partial<Record<IssueStatus, typeof defaultKanbanColumnTone>> = {
  backlog: {
    rail: "border-border bg-muted/30",
    railOver: "bg-muted/50 ring-1 ring-neutral-400/25",
    header: "text-muted-foreground",
    count: "text-muted-foreground/60",
    body: "bg-muted/30 ring-1 ring-inset ring-border/50",
    bodyOver: "bg-muted/50 ring-1 ring-inset ring-neutral-400/25",
    card: "",
  },
  todo: {
    rail: "border-amber-500/25 bg-amber-50/60 dark:bg-amber-950/20",
    railOver: "bg-amber-100/70 ring-1 ring-amber-500/25 dark:bg-amber-950/35",
    header: "text-amber-700 dark:text-amber-300",
    count: "text-amber-700/65 dark:text-amber-300/65",
    body: "bg-amber-50/45 ring-1 ring-inset ring-amber-500/15 dark:bg-amber-950/15",
    bodyOver: "bg-amber-100/70 ring-1 ring-inset ring-amber-500/25 dark:bg-amber-950/30",
    card: "",
  },
  in_progress: {
    rail: "border-blue-500/25 bg-blue-50/60 dark:bg-blue-950/20",
    railOver: "bg-blue-100/70 ring-1 ring-blue-500/25 dark:bg-blue-950/35",
    header: "text-blue-700 dark:text-blue-300",
    count: "text-blue-700/65 dark:text-blue-300/65",
    body: "bg-blue-50/45 ring-1 ring-inset ring-blue-500/15 dark:bg-blue-950/15",
    bodyOver: "bg-blue-100/70 ring-1 ring-inset ring-blue-500/25 dark:bg-blue-950/30",
    card: "",
  },
  blocked: {
    rail: "border-red-500/25 bg-red-50/60 dark:bg-red-950/20",
    railOver: "bg-red-100/70 ring-1 ring-red-500/25 dark:bg-red-950/35",
    header: "text-red-700 dark:text-red-300",
    count: "text-red-700/65 dark:text-red-300/65",
    body: "bg-red-50/45 ring-1 ring-inset ring-red-500/15 dark:bg-red-950/15",
    bodyOver: "bg-red-100/70 ring-1 ring-inset ring-red-500/25 dark:bg-red-950/30",
    card: "",
  },
  in_review: {
    rail: "border-violet-500/25 bg-violet-50/60 dark:bg-violet-950/20",
    railOver: "bg-violet-100/70 ring-1 ring-violet-500/25 dark:bg-violet-950/35",
    header: "text-violet-700 dark:text-violet-300",
    count: "text-violet-700/65 dark:text-violet-300/65",
    body: "bg-violet-50/45 ring-1 ring-inset ring-violet-500/15 dark:bg-violet-950/15",
    bodyOver: "bg-violet-100/70 ring-1 ring-inset ring-violet-500/25 dark:bg-violet-950/30",
    card: "",
  },
  done: {
    rail: "border-green-500/25 bg-green-50/60 dark:bg-green-950/20",
    railOver: "bg-green-100/70 ring-1 ring-green-500/25 dark:bg-green-950/35",
    header: "text-green-700 dark:text-green-300",
    count: "text-green-700/65 dark:text-green-300/65",
    body: "bg-green-50/45 ring-1 ring-inset ring-green-500/15 dark:bg-green-950/15",
    bodyOver: "bg-green-100/70 ring-1 ring-inset ring-green-500/25 dark:bg-green-950/30",
    card: "",
  },
  cancelled: {
    rail: "border-neutral-300/70 bg-muted/25 opacity-80 dark:border-neutral-700/70 dark:bg-neutral-900/20",
    railOver: "bg-muted/45 opacity-90 ring-1 ring-neutral-400/25 dark:bg-neutral-900/35",
    header: "text-muted-foreground/80",
    count: "text-muted-foreground/50",
    body: "bg-muted/25 ring-1 ring-inset ring-border/50",
    bodyOver: "bg-muted/45 ring-1 ring-inset ring-neutral-400/25",
    card: "bg-muted/35 text-muted-foreground opacity-80 hover:shadow-none",
  },
};

export function getKanbanColumnTone(status: IssueStatus) {
  return kanbanColumnTones[status] ?? defaultKanbanColumnTone;
}

function statusLabel(status: string): string {
  return status.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// The Grid's columns: open statuses, then Done as a short list. Board shows every status (`boardStatuses`).
const gridOpenStatuses = ["todo", "in_progress", "in_review", "blocked"] as const satisfies readonly IssueStatus[];
const gridStatuses: readonly IssueStatus[] = [...gridOpenStatuses, "done"];
const GRID_DONE_PREVIEW = 3;

// A drop target is a lane cell (`<laneKey>:<status>`), a bare status, or a card id.
export function resolveKanbanTargetStatus(overId: string, issues: Issue[]): IssueStatus | null {
  const status = overId.slice(overId.lastIndexOf(":") + 1);
  if ((boardStatuses as readonly string[]).includes(status)) {
    return status as IssueStatus;
  }
  return issues.find((issue) => issue.id === overId)?.status ?? null;
}

type LaneParent = Pick<Issue, "id" | "identifier" | "title" | "assigneeAgentId"> & { status: string };

export interface KanbanLane {
  key: string;
  parentId: string | null;
  // Null for the "No Parent" lane, or when the parent is not loaded and no child carries it.
  parent: LaneParent | null;
  issues: Issue[];
}

export const KANBAN_NO_PARENT_LANE = "no-parent";

function laneIsOpen(lane: KanbanLane) {
  return lane.issues.some((issue) => issue.status !== "done" && issue.status !== "cancelled");
}

/**
 * Which lanes are open. A lane's own toggle sets `lanes[key]`; the Collapse
 * all / Expand all toggle sets `all` and clears `lanes`. With neither set,
 * Board folds lanes with no open work and Grid shows every lane open.
 */
export interface KanbanLaneFold {
  all: boolean | null;
  lanes: Record<string, boolean>;
}

function isKanbanLaneOpen(lane: KanbanLane, fold: KanbanLaneFold, layout: "board" | "grid") {
  return fold.lanes[lane.key] ?? fold.all ?? (layout === "grid" || laneIsOpen(lane));
}

// Whether any lane shows open; IssuesList uses it to label its Collapse all / Expand all toggle.
export function anyKanbanLaneOpen(issues: Issue[], fold: KanbanLaneFold, layout: "board" | "grid") {
  const lanes = groupKanbanLanes(issues, layout === "grid" ? gridStatuses : boardStatuses);
  return lanes.some((lane) => isKanbanLaneOpen(lane, fold, layout));
}

/**
 * Groups issues into one lane per parent task, for the Board and Grid views.
 * Only tasks in `statuses` are shown. A parent heads its lane and is not a
 * card in it; tasks with no parent (that are not a parent here) go to the
 * "No Parent" lane, last. Lanes with open work come before lanes where every
 * task is done or cancelled. Keeps the given order.
 */
export function groupKanbanLanes(issues: Issue[], statuses: readonly IssueStatus[] = boardStatuses): KanbanLane[] {
  const shown = issues.filter((issue) => statuses.includes(issue.status));
  const byId = new Map(issues.map((issue) => [issue.id, issue]));
  const parentIds = new Set(shown.map((issue) => issue.parentId).filter((id): id is string => !!id));
  const lanes = new Map<string, KanbanLane>();
  const loose: Issue[] = [];
  for (const issue of shown) {
    if (!issue.parentId) {
      if (!parentIds.has(issue.id)) loose.push(issue);
      continue;
    }
    let lane = lanes.get(issue.parentId);
    if (!lane) {
      const parent = byId.get(issue.parentId)
        ?? issue.ancestors?.find((ancestor) => ancestor.id === issue.parentId)
        ?? null;
      lane = { key: issue.parentId, parentId: issue.parentId, parent, issues: [] };
      lanes.set(issue.parentId, lane);
    }
    lane.issues.push(issue);
  }
  const parentLanes = [...lanes.values()];
  return [
    ...parentLanes.filter(laneIsOpen),
    ...parentLanes.filter((lane) => !laneIsOpen(lane)),
    ...(loose.length > 0 ? [{ key: KANBAN_NO_PARENT_LANE, parentId: null, parent: null, issues: loose }] : []),
  ];
}

interface Agent {
  id: string;
  name: string;
}

interface KanbanBoardProps {
  issues: Issue[];
  agents?: Agent[];
  liveIssueIds?: Set<string>;
  compactCards?: boolean;
  collapsedStatuses?: string[];
  initialVisibleCount?: number;
  revealIncrement?: number;
  // "board": status columns, lanes fold when all done. "grid": parent card on the left, Done as a short list.
  layout?: "board" | "grid";
  laneFold?: KanbanLaneFold;
  onLaneFoldChange?: (fold: KanbanLaneFold) => void;
  onUpdateIssue: (id: string, data: Record<string, unknown>) => void;
}

/* ── Lane cell: one status inside one lane, a drop target ── */

function LaneCell({
  laneKey,
  status,
  issues,
  agents,
  liveIssueIds,
  subtreeLiveCounts,
  compactCards = false,
  collapsed = false,
  visibleCount,
  revealIncrement,
  laneTotal,
  onShowMore,
}: {
  laneKey: string;
  status: IssueStatus;
  issues: Issue[];
  agents?: Agent[];
  liveIssueIds?: Set<string>;
  subtreeLiveCounts?: ReadonlyMap<string, number>;
  compactCards?: boolean;
  collapsed?: boolean;
  visibleCount: number;
  revealIncrement: number;
  // Board only: tasks in the whole lane, for the cell's own `DONE 6/6` header.
  laneTotal?: number;
  onShowMore: () => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `${laneKey}:${status}` });
  const visibleIssues = collapsed ? [] : issues.slice(0, visibleCount);
  const hiddenCount = collapsed ? 0 : Math.max(issues.length - visibleIssues.length, 0);
  const tone = getKanbanColumnTone(status);

  return (
    <div
      ref={setNodeRef}
      className={cn(
        "min-h-16 min-w-0 space-y-1.5 rounded-md p-1.5 transition-colors",
        isOver ? tone.bodyOver : laneTotal === undefined ? "bg-muted/20" : "bg-muted/50",
      )}
    >
      {laneTotal !== undefined ? (
        <p className={cn("flex items-center gap-1.5 px-1 pt-0.5 text-xs font-semibold uppercase tracking-wide", tone.header)}>
          <StatusIcon status={status} />
          <span className="truncate">{statusLabel(status)}</span>
          <span className="font-normal tabular-nums text-muted-foreground">{issues.length}/{laneTotal}</span>
        </p>
      ) : null}
      {collapsed ? (
        <p className={cn("px-1 py-1 text-xs tabular-nums", tone.count)} title={`${statusLabel(status)}: ${issues.length}`}>
          {issues.length > 0 ? `${issues.length} hidden` : null}
        </p>
      ) : null}
      {/* Hidden cards are intentionally excluded from sort targets until revealed. */}
      <SortableContext items={visibleIssues.map((i) => i.id)} strategy={verticalListSortingStrategy}>
        {visibleIssues.map((issue) => (
          <KanbanCard
            key={issue.id}
            issue={issue}
            agents={agents}
            isLive={liveIssueIds?.has(issue.id)}
            subtreeLiveCount={subtreeLiveCounts?.get(issue.id) ?? 0}
            compact={compactCards || status === "done"}
            className={tone.card}
          />
        ))}
      </SortableContext>
      {hiddenCount > 0 ? (
        <button
          type="button"
          className="flex w-full items-center justify-center rounded-md border border-dashed border-border bg-background/70 px-2 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground"
          onClick={onShowMore}
        >
          Show {Math.min(revealIncrement, hiddenCount)} more
        </button>
      ) : null}
      {hiddenCount > 0 ? (
        <p className="px-1 text-(length:--text-micro) text-muted-foreground">
          Showing {visibleIssues.length} of {issues.length}
        </p>
      ) : null}
    </div>
  );
}

/* ── Grid Done list: the last few done tasks, then "+N more" ── */

function DoneList({ laneKey, issues }: { laneKey: string; issues: Issue[] }) {
  const { setNodeRef, isOver } = useDroppable({ id: `${laneKey}:done` });
  const recent = [...issues].sort((a, b) => timeOf(b) - timeOf(a));
  return (
    <div
      ref={setNodeRef}
      className={cn("min-w-0 space-y-1 rounded-md p-1.5 text-xs transition-colors", isOver && getKanbanColumnTone("done").bodyOver)}
    >
      {recent.slice(0, GRID_DONE_PREVIEW).map((issue) => (
        <Link
          key={issue.id}
          to={`/issues/${issue.identifier ?? issue.id}`}
          disableIssueQuicklook
          className="flex items-center gap-1.5 text-muted-foreground no-underline hover:text-foreground"
        >
          <StatusIcon status="done" />
          <span className="truncate">{issue.title}</span>
        </Link>
      ))}
      {recent.length > GRID_DONE_PREVIEW ? (
        <p className="pl-5 text-(length:--text-micro) text-muted-foreground">+{recent.length - GRID_DONE_PREVIEW} more</p>
      ) : null}
    </div>
  );
}

function timeOf(issue: Issue) {
  return new Date(issue.completedAt ?? issue.updatedAt).getTime();
}

/* ── Lane parts ── */

function LaneProgress({ issues }: { issues: Issue[] }) {
  const done = issues.filter((issue) => issue.status === "done").length;
  return (
    <span className="flex shrink-0 items-center gap-2 text-(length:--text-micro) text-muted-foreground tabular-nums">
      <span className="flex h-1.5 w-24 overflow-hidden rounded-full bg-muted">
        <span className="bg-green-500" style={{ width: `${(done / issues.length) * 100}%` }} />
      </span>
      {done}/{issues.length} done
    </span>
  );
}

function LaneAssignee({ agentId, agents }: { agentId: string | null; agents?: Agent[] }) {
  const agent = agentId ? agents?.find((a) => a.id === agentId) : undefined;
  return agent ? <AgentIdentity agent={agent} size="xs" /> : null;
}

// `wrap` puts the title under the key, up to two lines (Grid parent card).
function LaneTitle({ lane, wrap = false }: { lane: KanbanLane; wrap?: boolean }) {
  if (!lane.parentId) return <span className="font-medium">No Parent</span>;
  const p = lane.parent;
  return (
    <Link
      to={`/issues/${p?.identifier ?? lane.parentId}`}
      disableIssueQuicklook
      className={cn("flex min-w-0 gap-x-2 text-inherit no-underline hover:underline", wrap ? "flex-wrap items-center" : "items-center")}
    >
      {p ? <StatusIcon status={p.status} /> : null}
      <span className="shrink-0 font-mono text-xs text-muted-foreground">{p?.identifier ?? lane.parentId.slice(0, 8)}</span>
      {p ? <span className={cn("font-medium", wrap ? "mt-1 line-clamp-2 basis-full leading-snug" : "truncate")}>{p.title}</span> : null}
    </Link>
  );
}

function LaneToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <button
      type="button"
      className="shrink-0 text-muted-foreground hover:text-foreground"
      onClick={onToggle}
      aria-expanded={open}
      aria-label={open ? "Fold lane" : "Open lane"}
    >
      <Chevron className="h-4 w-4" />
    </button>
  );
}

// Board lane header: chevron, parent, sub-task count, owner, and progress.
function LaneHeader({
  lane,
  open,
  agents,
  onToggle,
}: {
  lane: KanbanLane;
  open: boolean;
  agents?: Agent[];
  onToggle: () => void;
}) {
  return (
    <div className="flex items-center gap-2 py-2 text-sm">
      <LaneToggle open={open} onToggle={onToggle} />
      <LaneTitle lane={lane} />
      <span className="shrink-0 text-xs text-muted-foreground">
        ({lane.issues.length} {lane.parentId ? "sub-task" : "task"}{lane.issues.length === 1 ? "" : "s"})
      </span>
      <LaneAssignee agentId={lane.parent?.assigneeAgentId ?? null} agents={agents} />
      <span className="ml-auto">
        <LaneProgress issues={lane.issues} />
      </span>
    </div>
  );
}

// Grid parent card: fold toggle, the parent task and its progress, left of its row.
function ParentCard({
  lane,
  open,
  agents,
  onToggle,
}: {
  lane: KanbanLane;
  open: boolean;
  agents?: Agent[];
  onToggle: () => void;
}) {
  return (
    <div className="min-w-0 space-y-1.5 rounded-md border border-border bg-card p-2.5 text-sm">
      <div className="flex items-start gap-1.5">
        <LaneToggle open={open} onToggle={onToggle} />
        <LaneTitle lane={lane} wrap />
      </div>
      <div className="flex items-center gap-2">
        <LaneAssignee agentId={lane.parent?.assigneeAgentId ?? null} agents={agents} />
      </div>
      <LaneProgress issues={lane.issues} />
    </div>
  );
}

/* ── Draggable Card ── */

function KanbanCard({
  issue,
  agents,
  isLive,
  subtreeLiveCount = 0,
  isOverlay,
  compact = false,
  className,
}: {
  issue: Issue;
  agents?: Agent[];
  isLive?: boolean;
  subtreeLiveCount?: number;
  isOverlay?: boolean;
  compact?: boolean;
  className?: string;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: issue.id, data: { issue } });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  const agentName = (id: string | null) => {
    if (!id || !agents) return null;
    return agents.find((a) => a.id === id)?.name ?? null;
  };

  return (
    <Card
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className={cn(
        "block cursor-grab active:cursor-grabbing transition-shadow",
        isDragging && !isOverlay ? "opacity-30" : "",
        isOverlay ? "shadow-lg ring-1 ring-primary/20" : "hover:shadow-sm",
        compact ? "p-2" : "p-2.5",
        className,
      )}
    >
      <Link
        to={`/issues/${issue.identifier ?? issue.id}`}
        disableIssueQuicklook
        className="block no-underline text-inherit"
        onClick={(e) => {
          // Prevent navigation during drag
          if (isDragging) e.preventDefault();
        }}
      >
        <div className={`flex items-start gap-1.5 ${compact ? "mb-1" : "mb-1.5"}`}>
          <span className="text-xs text-muted-foreground font-mono shrink-0">
            {issue.identifier ?? issue.id.slice(0, 8)}
          </span>
          {isSuccessfulRunHandoffRequired(issue) ? (
            <Badge variant="outline"
              className="border-amber-400/45 bg-amber-50/60 px-1.5 text-(length:--text-nano) text-amber-700 dark:border-amber-300/35 dark:bg-amber-400/10 dark:text-amber-300"
              title="This task needs a next step"
              aria-label="Needs next step"
            >
              <AlertTriangle className="h-3 w-3" />
              Next step
            </Badge>
          ) : null}
          {isLive && (
            <span className="inline-flex shrink-0 items-center gap-1 text-(length:--text-nano) font-medium text-blue-600 dark:text-blue-400">
              <span className="relative flex h-2 w-2">
                <span className="animate-pulse absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500" />
              </span>
              {compact ? "Live" : null}
            </span>
          )}
          {!isLive && subtreeLiveCount > 0 && (
            <Badge variant="outline"
              className="border-border px-1.5 text-(length:--text-nano) text-muted-foreground"
              title={`${subtreeLiveCount} sub-task${subtreeLiveCount === 1 ? "" : "s"} running below`}
            >
              <span className="h-2 w-2 shrink-0 rounded-full border border-muted-foreground/60" aria-hidden="true" />
              {subtreeLiveCount} live below
            </Badge>
          )}
        </div>
        <p className={`${compact ? "mb-1.5 text-xs" : "mb-2 text-sm"} leading-snug line-clamp-2`}>{issue.title}</p>
        <div className="flex items-center gap-2 min-w-0">
          {/* PAP-411: priority UI hidden behind SHOW_TASK_PRIORITY_UI. */}
          {SHOW_TASK_PRIORITY_UI && <PriorityIcon priority={issue.priority} />}
          {issue.assigneeAgentId && (() => {
            const name = agentName(issue.assigneeAgentId);
            return name ? (
              <AgentIdentity agent={agents?.find((agent) => agent.id === issue.assigneeAgentId) ?? { id: issue.assigneeAgentId, name }} size="xs" />
            ) : (
              <span className="text-xs text-muted-foreground font-mono">
                {issue.assigneeAgentId.slice(0, 8)}
              </span>
            );
          })()}
        </div>
      </Link>
    </Card>
  );
}

/* ── Main Board ── */

/**
 * Task board: one lane per parent task, one column per status, drag a card to
 * change its status. `layout="board"` shows every status and folds lanes with
 * no open work; `layout="grid"` shows open statuses, the parent card on the
 * left, and Done as a short list. Each open Board lane shows its own status
 * headers with lane counts (`DONE 6/6`); Grid has one header row at the top.
 * Fold state is `laneFold` when the caller owns it (IssuesList, for its
 * Collapse all / Expand all toggle), else local.
 * Used by the Board and Grid views in IssuesList.
 */
export function KanbanBoard({
  issues,
  agents,
  liveIssueIds,
  compactCards = false,
  collapsedStatuses = [],
  initialVisibleCount = KANBAN_COLUMN_INITIAL_VISIBLE_LIMIT,
  revealIncrement = KANBAN_COLUMN_REVEAL_INCREMENT,
  layout = "board",
  laneFold: controlledLaneFold,
  onLaneFoldChange,
  onUpdateIssue,
}: KanbanBoardProps) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [localLaneFold, setLocalLaneFold] = useState<KanbanLaneFold>({ all: null, lanes: {} });
  const laneFold = controlledLaneFold ?? localLaneFold;
  const setLaneFold = onLaneFoldChange ?? setLocalLaneFold;
  const paginationKey = `${initialVisibleCount}:${revealIncrement}`;
  const [visibleState, setVisibleState] = useState<{
    paginationKey: string;
    counts: Record<string, number>;
  }>({ paginationKey, counts: {} });
  const visibleCountByCell = visibleState.paginationKey === paginationKey ? visibleState.counts : {};
  const collapsedStatusSet = useMemo(() => new Set(collapsedStatuses), [collapsedStatuses]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
  );

  const isGrid = layout === "grid";
  const columnStatuses = isGrid ? gridStatuses : boardStatuses;
  const lanes = useMemo(() => groupKanbanLanes(issues, columnStatuses), [issues, columnStatuses]);
  const statusTotals = useMemo(() => {
    const totals: Record<string, number> = {};
    for (const issue of issues) totals[issue.status] = (totals[issue.status] ?? 0) + 1;
    return totals;
  }, [issues]);

  const activeIssue = useMemo(
    () => (activeId ? issues.find((i) => i.id === activeId) : null),
    [activeId, issues]
  );

  const subtreeLiveCounts = useMemo(
    () => collectSubtreeLiveCounts(issues, liveIssueIds ?? new Set<string>()),
    [issues, liveIssueIds],
  );

  function handleDragStart(event: DragStartEvent) {
    setActiveId(event.active.id as string);
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveId(null);
    const { active, over } = event;
    if (!over) return;

    const issueId = active.id as string;
    const issue = issues.find((i) => i.id === issueId);
    if (!issue) return;

    // "over" is a lane cell, or a card in one. Dropping in another lane changes only the status.
    const targetStatus = resolveKanbanTargetStatus(over.id as string, issues);

    if (targetStatus && targetStatus !== issue.status) {
      onUpdateIssue(issueId, { status: targetStatus });
    }
  }

  function renderCell(lane: KanbanLane, status: IssueStatus) {
    const cellKey = `${lane.key}:${status}`;
    return (
      <LaneCell
        key={status}
        laneKey={lane.key}
        status={status}
        issues={lane.issues.filter((issue) => issue.status === status)}
        agents={agents}
        liveIssueIds={liveIssueIds}
        subtreeLiveCounts={subtreeLiveCounts}
        compactCards={compactCards}
        collapsed={collapsedStatusSet.has(status)}
        visibleCount={visibleCountByCell[cellKey] ?? initialVisibleCount}
        revealIncrement={revealIncrement}
        laneTotal={isGrid ? undefined : lane.issues.length}
        onShowMore={() => {
          setVisibleState((current) => {
            const counts = current.paginationKey === paginationKey ? current.counts : {};
            return {
              paginationKey,
              counts: { ...counts, [cellKey]: (counts[cellKey] ?? initialVisibleCount) + revealIncrement },
            };
          });
        }}
      />
    );
  }

  const columns = isGrid ? "grid-cols-(--gtc-kanban-grid)" : "grid-cols-(--gtc-kanban-board)";

  return (
    <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
      <div className="pb-4">
        {/* Grid only; each Board lane carries its own headers. Negative top matches the page's padding, so the header pins at the scroll edge. */}
        {isGrid ? (
          <div className={cn("sticky -top-4 z-10 grid gap-2 border-b border-border bg-background py-2 md:-top-6", columns)}>
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Parent Task</span>
            {columnStatuses.map((status) => (
              <span
                key={status}
                className={cn("flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide", getKanbanColumnTone(status).header)}
              >
                <StatusIcon status={status} />
                {statusLabel(status)}
                <span className="font-normal tabular-nums text-muted-foreground">{statusTotals[status] ?? 0}</span>
              </span>
            ))}
          </div>
        ) : null}
        {lanes.map((lane) => {
          const open = isKanbanLaneOpen(lane, laneFold, layout);
          const onToggle = () => setLaneFold({ ...laneFold, lanes: { ...laneFold.lanes, [lane.key]: !open } });
          if (isGrid) {
            return (
              <div key={lane.key} className={cn("grid gap-2 border-b border-border/60 py-2.5", columns)}>
                <ParentCard lane={lane} open={open} agents={agents} onToggle={onToggle} />
                {open ? (
                  <>
                    {gridOpenStatuses.map((status) => renderCell(lane, status))}
                    <DoneList laneKey={lane.key} issues={lane.issues.filter((issue) => issue.status === "done")} />
                  </>
                ) : null}
              </div>
            );
          }
          return (
            <section key={lane.key} className="border-b border-border/60">
              <LaneHeader lane={lane} open={open} agents={agents} onToggle={onToggle} />
              {open ? (
                <div className={cn("grid gap-2 pb-3", columns)}>
                  {boardStatuses.map((status) => renderCell(lane, status))}
                </div>
              ) : null}
            </section>
          );
        })}
      </div>
      <DragOverlay>
        {activeIssue ? (
          <KanbanCard issue={activeIssue} agents={agents} isOverlay compact={compactCards} />
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
