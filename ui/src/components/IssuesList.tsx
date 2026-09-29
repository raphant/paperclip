import { startTransition, useDeferredValue, useEffect, useMemo, useState, useCallback, useRef } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useVisibilityRefetchInterval } from "@/lib/polling";
import { useDialogActions } from "../context/DialogContext";
import { useCompany } from "../context/CompanyContext";
import { Link } from "@/lib/router";
import { executionWorkspacesApi } from "../api/execution-workspaces";
import { issuesApi } from "../api/issues";
import { authApi } from "../api/auth";
import { instanceSettingsApi } from "../api/instanceSettings";
import { queryKeys } from "../lib/queryKeys";
import { useIssueExternalObjectSummaries } from "../hooks/useIssueExternalObjects";
import {
  shouldBlurPageSearchOnEnter,
  shouldBlurPageSearchOnEscape,
} from "../lib/keyboardShortcuts";
import { formatAssigneeUserLabel } from "../lib/assignees";
import { createIssueDetailPath, withIssueDetailHeaderSeed } from "../lib/issueDetailBreadcrumb";
import {
  buildSubIssueProgressSummary,
  shouldRenderSubIssueProgressSummary,
  type SubIssueProgressSummary,
} from "../lib/issue-detail-subissues";
import {
  applyIssueFilters,
  countActiveIssueFilters,
  defaultIssueFilterState,
  issuePriorityOrder,
  normalizeIssueFilterState,
  shouldIncludeIssueFilterWorkspaceOption,
  issueStatusOrder,
  type IssueFilterState,
} from "../lib/issue-filters";
import {
  DEFAULT_INBOX_ISSUE_COLUMNS,
  getAvailableInboxIssueColumns,
  normalizeInboxIssueColumns,
  type InboxIssueColumn,
} from "../lib/inbox";
import { cn, formatDurationMs, formatTokens } from "../lib/utils";
import {
  IssueColumnPicker,
} from "./IssueColumns";
import { IssueFiltersPopover } from "./IssueFiltersPopover";
import { type IssueRowPresentation } from "./IssueRow";
import { CollectionToolbar, type CollectionToolbarProps } from "./CollectionToolbar";
import { IssuesList as LegacyIssuesList } from "./LegacyIssuesList";
import { useStreamlinedUiEnabled } from "../hooks/useStreamlinedUiEnabled";
import { PageSkeleton } from "./PageSkeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { Plus, Check, Search, ChevronsDownUp, PanelTopClose, RotateCcw, ListCollapse,
  Columns3, LayoutGrid,
} from "lucide-react";
import {
  KanbanBoard,
  type KanbanLaneFold,
  anyKanbanLaneOpen,
  KANBAN_BOARD_HIGH_VOLUME_THRESHOLD,
  KANBAN_COLD_STATUSES,
  KANBAN_COLUMN_DEFAULT_PAGE_SIZE,
  KANBAN_COLUMN_PAGE_SIZE_OPTIONS,
  type KanbanColumnPageSize,
} from "./KanbanBoard";
import { buildSubIssueDefaultsForViewer } from "../lib/subIssueDefaults";
import { workflowSort } from "../lib/workflow-sort";
import {
  loadTaskCollectionPreferences,
  saveTaskCollectionPreferences,
  type TaskCollectionPreferenceLocation,
} from "../lib/task-collection-preferences";
import { ISSUE_STATUSES, type Issue, type IssueStatus, type Project } from "@paperclipai/shared";
const ISSUE_SEARCH_DEBOUNCE_MS = 250;
const ISSUE_SEARCH_RESULT_LIMIT = 200;
const ISSUE_BOARD_COLUMN_RESULT_LIMIT = 200;

const boardIssueStatuses = ISSUE_STATUSES;
const issueStatusLabels: Record<IssueStatus, string> = {
  backlog: "Backlog",
  todo: "Todo",
  in_progress: "In progress",
  in_review: "In review",
  done: "Done",
  blocked: "Blocked",
  cancelled: "Cancelled",
};
const progressSegmentClasses: Record<IssueStatus, string> = {
  backlog: "bg-muted-foreground/40",
  todo: "bg-blue-500",
  in_progress: "bg-yellow-500",
  in_review: "bg-violet-500",
  done: "bg-green-500",
  blocked: "bg-red-500",
  cancelled: "bg-neutral-400",
};

/* ── View state ── */

export type IssueSortField = "status" | "priority" | "title" | "created" | "updated" | "workflow";
export type BoardCardDensity = "auto" | "compact" | "comfortable";
export type BoardColdLaneMode = "auto" | "collapsed" | "expanded";
export type BoardColumnPageSize = KanbanColumnPageSize;

export type IssueViewState = IssueFilterState & {
  sortField: IssueSortField;
  sortDir: "asc" | "desc";
  groupBy: "status" | "priority" | "assignee" | "project" | "workspace" | "parent" | "none";
  viewMode: "board" | "grid";
  nestingEnabled: boolean;
  showDateGroupSeparators: boolean;
  collapsedGroups: string[];
  collapsedParents: string[];
  boardCardDensity: BoardCardDensity;
  boardColdLaneMode: BoardColdLaneMode;
  boardColumnPageSize: BoardColumnPageSize;
};

const defaultViewState: IssueViewState = {
  ...defaultIssueFilterState,
  sortField: "updated",
  sortDir: "desc",
  groupBy: "none",
  viewMode: "board",
  nestingEnabled: true,
  showDateGroupSeparators: true,
  collapsedGroups: [],
  collapsedParents: [],
  boardCardDensity: "auto",
  boardColdLaneMode: "expanded",
  boardColumnPageSize: KANBAN_COLUMN_DEFAULT_PAGE_SIZE,
};

function normalizeBoardCardDensity(value: unknown): BoardCardDensity {
  return value === "compact" || value === "comfortable" || value === "auto" ? value : "auto";
}

function normalizeBoardColdLaneMode(value: unknown): BoardColdLaneMode {
  return value === "collapsed" || value === "expanded" || value === "auto" ? value : "auto";
}

function normalizeBoardColumnPageSize(value: unknown): BoardColumnPageSize {
  return KANBAN_COLUMN_PAGE_SIZE_OPTIONS.includes(value as BoardColumnPageSize)
    ? value as BoardColumnPageSize
    : KANBAN_COLUMN_DEFAULT_PAGE_SIZE;
}

function normalizeIssueViewState(value: unknown): IssueViewState {
  const parsed = value && typeof value === "object" ? value as Partial<IssueViewState> : {};
  return {
    ...defaultViewState,
    ...parsed,
    ...normalizeIssueFilterState(parsed),
    sortField: ["status", "priority", "title", "created", "updated", "workflow"].includes(parsed.sortField ?? "")
      ? parsed.sortField as IssueSortField
      : defaultViewState.sortField,
    sortDir: parsed.sortDir === "asc" ? "asc" : "desc",
    groupBy: ["status", "priority", "assignee", "project", "workspace", "parent", "none"].includes(parsed.groupBy ?? "")
      ? parsed.groupBy as IssueViewState["groupBy"]
      : defaultViewState.groupBy,
    // A saved "list" (the removed List view) reads as "board".
    viewMode: parsed.viewMode === "grid" ? "grid" : "board",
    nestingEnabled: parsed.nestingEnabled !== false,
    showDateGroupSeparators: parsed.showDateGroupSeparators !== false,
    collapsedGroups: Array.isArray(parsed.collapsedGroups)
      ? parsed.collapsedGroups.filter((entry): entry is string => typeof entry === "string")
      : [],
    collapsedParents: Array.isArray(parsed.collapsedParents)
      ? parsed.collapsedParents.filter((entry): entry is string => typeof entry === "string")
      : [],
    boardCardDensity: normalizeBoardCardDensity(parsed.boardCardDensity),
    boardColdLaneMode: normalizeBoardColdLaneMode(parsed.boardColdLaneMode),
    boardColumnPageSize: normalizeBoardColumnPageSize(parsed.boardColumnPageSize),
  };
}

function getInitialViewState(
  stored: { viewState: IssueViewState; source: "current" | "legacy" | "default" },
  initialAssignees?: string[],
  defaultSortField?: IssueSortField,
): IssueViewState {
  const base = stored.source === "default" && defaultSortField
    ? { ...stored.viewState, sortField: defaultSortField, sortDir: "asc" as const }
    : stored.viewState;
  if (!initialAssignees) return base;
  return {
    ...base,
    assignees: initialAssignees,
    statuses: [],
  };
}

function getInitialWorkspaceViewState(
  stored: { viewState: IssueViewState; source: "current" | "legacy" | "default" },
  initialAssignees?: string[],
  initialWorkspaces?: string[],
  defaultSortField?: IssueSortField,
): IssueViewState {
  const initial = getInitialViewState(stored, initialAssignees, defaultSortField);
  if (!initialWorkspaces) return initial;
  return {
    ...initial,
    workspaces: initialWorkspaces,
    statuses: [],
  };
}

function getIssueColumnsStorageKey(key: string): string {
  return `${key}:issue-columns`;
}

function loadIssueCollectionPreferences(
  location: TaskCollectionPreferenceLocation,
) {
  return loadTaskCollectionPreferences<IssueViewState, InboxIssueColumn>({
    ...location,
    defaultViewState: defaultViewState,
    defaultColumns: DEFAULT_INBOX_ISSUE_COLUMNS,
    normalizeViewState: normalizeIssueViewState,
    normalizeColumns: (value) => normalizeInboxIssueColumns(Array.isArray(value) ? value : []),
  });
}

function sortIssues(issues: Issue[], state: IssueViewState): Issue[] {
  if (state.sortField === "workflow") {
    const ordered = workflowSort(issues);
    return state.sortDir === "desc" ? [...ordered].reverse() : ordered;
  }
  const sorted = [...issues];
  const dir = state.sortDir === "asc" ? 1 : -1;
  sorted.sort((a, b) => {
    switch (state.sortField) {
      case "status":
        return dir * (issueStatusOrder.indexOf(a.status) - issueStatusOrder.indexOf(b.status));
      case "priority":
        return dir * (issuePriorityOrder.indexOf(a.priority) - issuePriorityOrder.indexOf(b.priority));
      case "title":
        return dir * a.title.localeCompare(b.title);
      case "created":
        return dir * (new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
      case "updated":
        return dir * (new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime());
      default:
        return 0;
    }
  });
  return sorted;
}

const AGE_BUCKET_DAY_MS = 24 * 60 * 60 * 1000;
const AGE_BUCKET_WEEK_MS = 7 * AGE_BUCKET_DAY_MS;

export function issueAgeBucket(date: Date | string, now: number = Date.now()): 0 | 1 | 2 {
  const age = now - new Date(date).getTime();
  if (age < AGE_BUCKET_DAY_MS) return 0;
  if (age < AGE_BUCKET_WEEK_MS) return 1;
  return 2;
}

export function issueAgeSeparatorLabel(bucket: 1 | 2): string {
  return bucket === 1 ? "Older than a day" : "Older than a week";
}

export function issueAgeBucketsCrossed(
  previousBucket: 0 | 1 | 2,
  currentBucket: 0 | 1 | 2,
): Array<1 | 2> {
  const crossedBuckets: Array<1 | 2> = [];
  if (previousBucket < 1 && currentBucket >= 1) crossedBuckets.push(1);
  if (previousBucket < 2 && currentBucket >= 2) crossedBuckets.push(2);
  return crossedBuckets;
}

function issueMatchesLocalSearch(issue: Issue, normalizedSearch: string): boolean {
  if (!normalizedSearch) return true;
  return [
    issue.identifier,
    issue.title,
    issue.description,
  ].some((value) => value?.toLowerCase().includes(normalizedSearch));
}

/* ── Component ── */

interface Agent {
  id: string;
  name: string;
}

type CreatorOption = {
  id: string;
  label: string;
  kind: "agent" | "user";
  searchText?: string;
};

type ProjectOption = Pick<Project, "id" | "name"> & Partial<Pick<Project, "color" | "workspaces" | "executionWorkspacePolicy" | "primaryWorkspace">>;
type IssueListRequestFilters = NonNullable<Parameters<typeof issuesApi.list>[1]>;

interface IssuesListProps {
  issues: Issue[];
  isLoading?: boolean;
  error?: Error | null;
  agents?: Agent[];
  projects?: ProjectOption[];
  liveIssueIds?: Set<string>;
  projectId?: string;
  viewStateKey: string;
  issueLinkState?: unknown;
  initialAssignees?: string[];
  initialWorkspaces?: string[];
  initialSearch?: string;
  searchFilters?: Omit<IssueListRequestFilters, "q" | "projectId" | "limit" | "includeRoutineExecutions">;
  searchWithinLoadedIssues?: boolean;
  baseCreateIssueDefaults?: Record<string, unknown>;
  createIssueLabel?: string;
  defaultSortField?: IssueSortField;
  showProgressSummary?: boolean;
  /**
   * When set together with `showProgressSummary`, the progress strip fetches
   * the recursive cost-summary for this parent issue and renders aggregate
   * tokens + wall-clock runtime for every run in the tree.
   */
  parentIssueIdForCostSummary?: string;
  enableRoutineVisibilityFilter?: boolean;
  hasMoreIssues?: boolean;
  isLoadingMoreIssues?: boolean;
  mutedIssueIds?: Set<string>;
  issueBadgeById?: Map<string, string>;
  onLoadMoreIssues?: () => void;
  onSearchChange?: (search: string) => void;
  /** Opt in per surface while the canonical task row rolls out across collections. */
  rowPresentation?: IssueRowPresentation;
  /** Opt in per surface while the shared collection toolbar rolls out. */
  toolbarPresentation?: "legacy" | "collection";
  onUpdateIssue: (id: string, data: Record<string, unknown>) => void;
}

function LegacyIssuesToolbar({ context, search, controls }: CollectionToolbarProps) {
  return (
    <div className="flex items-center justify-between gap-2 sm:gap-3">
      <div className="flex min-w-0 items-center gap-2 sm:gap-3">
        {context}
        {search}
      </div>
      <div className="flex shrink-0 items-center gap-0.5 sm:gap-1">
        {controls}
      </div>
    </div>
  );
}

function IssueSearchInput({
  value,
  onDebouncedChange,
}: {
  value: string;
  onDebouncedChange?: (search: string) => void;
}) {
  const [draftValue, setDraftValue] = useState(value);
  const lastCommittedValueRef = useRef(value);

  useEffect(() => {
    setDraftValue(value);
    lastCommittedValueRef.current = value;
  }, [value]);

  useEffect(() => {
    if (!onDebouncedChange || draftValue === lastCommittedValueRef.current) return;

    const timeoutId = window.setTimeout(() => {
      lastCommittedValueRef.current = draftValue;
      startTransition(() => {
        onDebouncedChange(draftValue);
      });
    }, ISSUE_SEARCH_DEBOUNCE_MS);

    return () => window.clearTimeout(timeoutId);
  }, [draftValue, onDebouncedChange]);

  return (
    <div className="relative w-full sm:w-64 md:w-80">
      <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input
        value={draftValue}
        onChange={(e) => {
          setDraftValue(e.target.value);
        }}
        onKeyDown={(e) => {
          if (shouldBlurPageSearchOnEnter({
            key: e.key,
            isComposing: e.nativeEvent.isComposing,
          })) {
            e.currentTarget.blur();
            return;
          }

          if (shouldBlurPageSearchOnEscape({
            key: e.key,
            isComposing: e.nativeEvent.isComposing,
            currentValue: e.currentTarget.value,
          })) {
            e.currentTarget.blur();
          }
        }}
        placeholder="Search tasks..."
        className="pl-7 text-xs sm:text-sm"
        aria-label="Search tasks"
        data-page-search-target="true"
      />
    </div>
  );
}

function SubIssueProgressSummaryStrip({
  summary,
  issueLinkState,
  parentIssueIdForCostSummary,
}: {
  summary: SubIssueProgressSummary;
  issueLinkState?: unknown;
  parentIssueIdForCostSummary?: string;
}) {
  const target = summary.target;
  const targetIssue = target?.issue ?? null;
  const targetPathId = targetIssue?.identifier ?? targetIssue?.id ?? "";
  const targetState = targetIssue ? withIssueDetailHeaderSeed(issueLinkState, targetIssue) : undefined;
  const statusEntries = ISSUE_STATUSES
    .map((status) => ({ status, count: summary.countsByStatus[status] ?? 0 }))
    .filter((entry) => entry.count > 0);

  // Refresh fast enough that the runtime ticks up while a sub-issue is still
  // running, but slow enough not to hammer the recursive CTE on idle trees.
  const hasInProgress = summary.inProgressCount > 0;
  const costRefetchInterval = useVisibilityRefetchInterval({ visibleMs: 5_000 });
  const { data: costSummary } = useQuery({
    queryKey: queryKeys.issues.costSummary(parentIssueIdForCostSummary ?? "pending", { excludeRoot: true }),
    queryFn: () => issuesApi.getCostSummary(parentIssueIdForCostSummary!, { excludeRoot: true }),
    enabled: !!parentIssueIdForCostSummary,
    refetchInterval: hasInProgress ? costRefetchInterval : false,
  });

  const totalTokens = costSummary
    ? costSummary.inputTokens + costSummary.cachedInputTokens + costSummary.outputTokens
    : 0;
  const showCostSummary = !!costSummary && (costSummary.runCount > 0 || totalTokens > 0);

  return (
    <div className="border border-border bg-background p-3">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
            <span className="font-medium text-foreground">
              {summary.doneCount}/{summary.totalCount} done
            </span>
            <span className="text-muted-foreground">
              {summary.inProgressCount} in progress
            </span>
            <span className="text-muted-foreground">
              {summary.blockedCount} blocked
            </span>
            {showCostSummary && (
              <>
                <span
                  className="text-muted-foreground tabular-nums"
                  title={`${costSummary.runCount.toLocaleString()} run${
                    costSummary.runCount === 1 ? "" : "s"
                  } across ${costSummary.issueCount} sub-task${
                    costSummary.issueCount === 1 ? "" : "s"
                  }`}
                >
                  {formatTokens(totalTokens)} tokens
                </span>
                <span className="text-muted-foreground tabular-nums">
                  {formatDurationMs(costSummary.runtimeMs)} runtime
                </span>
              </>
            )}
          </div>
          <div
            role="progressbar"
            aria-label="Sub-tasks completion progress"
            aria-valuemin={0}
            aria-valuenow={summary.doneCount}
            aria-valuemax={summary.totalCount}
            className="flex h-2 w-full overflow-hidden rounded-full bg-muted"
          >
            {statusEntries.map(({ status, count }) => (
              <span
                key={status}
                className={cn("h-full", progressSegmentClasses[status])}
                style={{ width: `${(count / summary.totalCount) * 100}%` }}
                title={`${issueStatusLabels[status]}: ${count}`}
                aria-hidden="true"
              />
            ))}
          </div>
        </div>

        <div className="min-w-0 border border-border bg-background px-3 py-2 text-sm lg:w-72">
          {target && targetIssue ? (
            <>
              <div className="text-xs font-medium text-muted-foreground">
                {target.kind === "next" ? "Next up" : "Waiting on blockers"}
              </div>
              <Link
                to={createIssueDetailPath(targetPathId)}
                state={targetState}
                issuePrefetch={targetIssue}
                className="mt-1 block min-w-0 text-foreground underline-offset-2 hover:underline"
              >
                <span className="font-mono text-xs text-muted-foreground">
                  {targetIssue.identifier ?? targetIssue.id.slice(0, 8)}
                </span>{" "}
                <span>{targetIssue.title}</span>
              </Link>
            </>
          ) : summary.totalCount === 0 ? (
            <div className="text-sm font-medium text-foreground">No active sub-tasks</div>
          ) : summary.doneCount === summary.totalCount ? (
            <div className="text-sm font-medium text-foreground">All sub-tasks done</div>
          ) : (
            <div className="text-sm font-medium text-foreground">No actionable sub-tasks</div>
          )}
        </div>
      </div>
    </div>
  );
}

export function IssuesList(props: IssuesListProps) {
  const { enabled: streamlinedUiEnabled } = useStreamlinedUiEnabled();
  return streamlinedUiEnabled ? <StreamlinedIssuesList {...props} /> : <LegacyIssuesList {...props} />;
}

function StreamlinedIssuesList({
  issues,
  isLoading,
  error,
  agents,
  projects,
  liveIssueIds,
  projectId,
  viewStateKey,
  issueLinkState,
  initialAssignees,
  initialWorkspaces,
  initialSearch,
  searchFilters,
  searchWithinLoadedIssues = false,
  baseCreateIssueDefaults,
  createIssueLabel,
  defaultSortField,
  showProgressSummary = false,
  parentIssueIdForCostSummary,
  enableRoutineVisibilityFilter = false,
  hasMoreIssues = false,
  isLoadingMoreIssues = false,
  mutedIssueIds,
  issueBadgeById,
  onLoadMoreIssues,
  onSearchChange,
  rowPresentation = "legacy",
  toolbarPresentation = "legacy",
  onUpdateIssue,
}: IssuesListProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const pointerMovedSinceKeyNavRef = useRef(true);
  useEffect(() => {
    const handlePointerMove = () => {
      pointerMovedSinceKeyNavRef.current = true;
    };
    window.addEventListener("mousemove", handlePointerMove, { passive: true });
    return () => window.removeEventListener("mousemove", handlePointerMove);
  }, []);
  const { selectedCompanyId } = useCompany();
  const { openNewIssue } = useDialogActions();
  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });
  const { data: experimentalSettings } = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
    retry: false,
  });
  const currentUserId = session?.user?.id ?? session?.session?.userId ?? null;
  const experimentalSettingsLoaded = experimentalSettings !== undefined;
  const isolatedWorkspacesEnabled = experimentalSettings?.enableIsolatedWorkspaces === true;
  const externalObjectsEnabled = experimentalSettings?.enableExternalObjects === true;

  // Scope the storage key per company so folding/view state is independent across companies.
  const scopedKey = selectedCompanyId ? `${viewStateKey}:${selectedCompanyId}` : viewStateKey;
  const preferenceLocation: TaskCollectionPreferenceLocation = {
    companyId: selectedCompanyId ?? "__unscoped__",
    collectionKey: viewStateKey,
    legacyViewStorageKey: scopedKey,
    legacyColumnsStorageKey: getIssueColumnsStorageKey(scopedKey),
  };
  const initialAssigneesKey = initialAssignees?.join("|") ?? "";
  const initialWorkspacesKey = initialWorkspaces?.join("|") ?? "";
  const initialPreferencesRef = useRef<ReturnType<typeof loadIssueCollectionPreferences> | null>(null);
  if (initialPreferencesRef.current === null) {
    initialPreferencesRef.current = loadIssueCollectionPreferences(preferenceLocation);
  }
  const initialPreferences = initialPreferencesRef.current;

  const [viewState, setViewState] = useState<IssueViewState>(() =>
    getInitialWorkspaceViewState(initialPreferences, initialAssignees, initialWorkspaces, defaultSortField),
  );
  const [laneFold, setLaneFold] = useState<KanbanLaneFold>({ all: null, lanes: {} });
  const [issueSearch, setIssueSearch] = useState(initialSearch ?? "");
  const [visibleIssueColumns, setVisibleIssueColumns] = useState<InboxIssueColumn[]>(initialPreferences.columns);
  const deferredIssueSearch = useDeferredValue(issueSearch);
  const normalizedIssueSearch = deferredIssueSearch.trim().toLowerCase();

  useEffect(() => {
    setIssueSearch(initialSearch ?? "");
  }, [initialSearch]);

  // Reload view state whenever the persisted context changes.
  const prevViewStateContextKey = useRef(`${scopedKey}::${initialAssigneesKey}::${initialWorkspacesKey}`);
  useEffect(() => {
    const nextContextKey = `${scopedKey}::${initialAssigneesKey}::${initialWorkspacesKey}`;
    if (prevViewStateContextKey.current !== nextContextKey) {
      prevViewStateContextKey.current = nextContextKey;
      const preferences = loadIssueCollectionPreferences(preferenceLocation);
      setViewState(getInitialWorkspaceViewState(preferences, initialAssignees, initialWorkspaces, defaultSortField));
      setVisibleIssueColumns(preferences.columns);
    }
  }, [
    scopedKey,
    initialAssignees,
    initialAssigneesKey,
    initialWorkspaces,
    initialWorkspacesKey,
    defaultSortField,
    preferenceLocation.companyId,
    preferenceLocation.collectionKey,
    preferenceLocation.legacyViewStorageKey,
    preferenceLocation.legacyColumnsStorageKey,
  ]);

  const updateView = useCallback((patch: Partial<IssueViewState>) => {
    setViewState((prev) => {
      const next = { ...prev, ...patch };
      saveTaskCollectionPreferences(preferenceLocation, {
        viewState: next,
        columns: visibleIssueColumns,
      });
      return next;
    });
  }, [
    preferenceLocation.companyId,
    preferenceLocation.collectionKey,
    preferenceLocation.legacyColumnsStorageKey,
    preferenceLocation.legacyViewStorageKey,
    visibleIssueColumns,
  ]);

  useEffect(() => {
    if (!experimentalSettingsLoaded || externalObjectsEnabled || viewState.externalObjectStatuses.length === 0) return;
    updateView({ externalObjectStatuses: [] });
  }, [experimentalSettingsLoaded, externalObjectsEnabled, updateView, viewState.externalObjectStatuses.length]);

  // Prune stale IDs from collapsedParents whenever the issue list changes.
  // Deleted or reassigned issues leave orphan IDs in localStorage; this keeps
  // the stored array bounded to only current parent IDs.
  useEffect(() => {
    const parentIds = new Set(issues.map((i) => i.parentId).filter(Boolean) as string[]);
    const pruned = viewState.collapsedParents.filter((id) => parentIds.has(id));
    if (pruned.length !== viewState.collapsedParents.length) {
      updateView({ collapsedParents: pruned });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [issues]);

  const { data: searchedIssues = [] } = useQuery({
    queryKey: [
      ...queryKeys.issues.search(selectedCompanyId!, normalizedIssueSearch, projectId),
      searchFilters ?? {},
      "compact",
      ISSUE_SEARCH_RESULT_LIMIT,
      enableRoutineVisibilityFilter ? "with-routine-executions" : "without-routine-executions",
    ],
    queryFn: ({ signal }) =>
      issuesApi.listCompact(selectedCompanyId!, {
        q: normalizedIssueSearch,
        projectId,
        limit: ISSUE_SEARCH_RESULT_LIMIT,
        ...searchFilters,
        ...(enableRoutineVisibilityFilter ? { includeRoutineExecutions: true } : {}),
      }, { signal }).then((rows) => rows as Issue[]),
    enabled: !!selectedCompanyId && normalizedIssueSearch.length > 0 && !searchWithinLoadedIssues,
    placeholderData: (previousData) => previousData,
  });
  const boardIssueQueries = useQueries({
    queries: boardIssueStatuses.map((status) => ({
      queryKey: [
        ...queryKeys.issues.list(selectedCompanyId ?? "__no-company__"),
        "board-column",
        status,
        normalizedIssueSearch,
        projectId ?? "__all-projects__",
        searchFilters ?? {},
        "compact",
        ISSUE_BOARD_COLUMN_RESULT_LIMIT,
        enableRoutineVisibilityFilter ? "with-routine-executions" : "without-routine-executions",
      ],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        issuesApi.listCompact(selectedCompanyId!, {
          ...searchFilters,
          ...(normalizedIssueSearch.length > 0 ? { q: normalizedIssueSearch } : {}),
          projectId,
          status,
          limit: ISSUE_BOARD_COLUMN_RESULT_LIMIT,
          ...(enableRoutineVisibilityFilter ? { includeRoutineExecutions: true } : {}),
        }, { signal }).then((rows) => rows as Issue[]),
      enabled: !!selectedCompanyId && !searchWithinLoadedIssues,
      placeholderData: (previousData: Issue[] | undefined) => previousData,
    })),
  });
  const { data: executionWorkspaces = [] } = useQuery({
    queryKey: selectedCompanyId
      ? queryKeys.executionWorkspaces.summaryList(selectedCompanyId)
      : ["execution-workspaces", "__disabled__"],
    queryFn: () => executionWorkspacesApi.listSummaries(selectedCompanyId!),
    enabled: !!selectedCompanyId && isolatedWorkspacesEnabled,
  });

  const projectWorkspaceById = useMemo(() => {
    const map = new Map<string, { name: string; projectId: string }>();
    for (const project of projects ?? []) {
      for (const workspace of project.workspaces ?? []) {
        map.set(workspace.id, { name: workspace.name || project.name, projectId: project.id });
      }
    }
    return map;
  }, [projects]);

  const defaultProjectWorkspaceIdByProjectId = useMemo(() => {
    const map = new Map<string, string>();
    for (const project of projects ?? []) {
      const defaultWorkspaceId =
        project.executionWorkspacePolicy?.defaultProjectWorkspaceId
        ?? project.primaryWorkspace?.id
        ?? null;
      if (defaultWorkspaceId) map.set(project.id, defaultWorkspaceId);
    }
    return map;
  }, [projects]);
  const defaultProjectWorkspaceIds = useMemo(
    () => new Set(defaultProjectWorkspaceIdByProjectId.values()),
    [defaultProjectWorkspaceIdByProjectId],
  );

  const executionWorkspaceById = useMemo(() => {
    const map = new Map<string, {
      name: string;
      mode: "shared_workspace" | "isolated_workspace" | "operator_branch" | "adapter_managed" | "cloud_sandbox";
      projectWorkspaceId: string | null;
      projectId: string | null;
    }>();
    for (const workspace of executionWorkspaces) {
      const projectWorkspace = workspace.projectWorkspaceId
        ? projectWorkspaceById.get(workspace.projectWorkspaceId) ?? null
        : null;
      map.set(workspace.id, {
        name: workspace.name,
        mode: workspace.mode,
        projectWorkspaceId: workspace.projectWorkspaceId ?? null,
        projectId: projectWorkspace?.projectId ?? null,
      });
    }
    return map;
  }, [executionWorkspaces, projectWorkspaceById]);
  const issueFilterWorkspaceContext = useMemo(() => ({
    executionWorkspaceById,
    defaultProjectWorkspaceIdByProjectId,
  }), [defaultProjectWorkspaceIdByProjectId, executionWorkspaceById]);

  const workspaceNameMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const [workspaceId, workspace] of projectWorkspaceById) {
      if (!shouldIncludeIssueFilterWorkspaceOption({ id: workspaceId }, defaultProjectWorkspaceIds)) continue;
      map.set(workspaceId, workspace.name);
    }
    for (const [workspaceId, workspace] of executionWorkspaceById) {
      if (!shouldIncludeIssueFilterWorkspaceOption({
        id: workspaceId,
        mode: workspace.mode,
        projectWorkspaceId: workspace.projectWorkspaceId,
      }, defaultProjectWorkspaceIds)) continue;
      map.set(workspaceId, workspace.name);
    }
    return map;
  }, [defaultProjectWorkspaceIds, executionWorkspaceById, projectWorkspaceById]);

  const workspaceOptions = useMemo(() => {
    const options = new Map<string, string>();
    for (const [workspaceId, workspaceName] of workspaceNameMap) {
      options.set(workspaceId, workspaceName);
    }
    return [...options.entries()]
      .sort((a, b) => a[1].localeCompare(b[1]))
      .map(([id, name]) => ({ id, name }));
  }, [workspaceNameMap]);

  const creatorOptions = useMemo<CreatorOption[]>(() => {
    const options = new Map<string, CreatorOption>();
    const knownAgentIds = new Set<string>();

    if (currentUserId) {
      options.set(`user:${currentUserId}`, {
        id: `user:${currentUserId}`,
        label: currentUserId === "local-board" ? "Board" : "Me",
        kind: "user",
        searchText: currentUserId === "local-board" ? "board me human local-board" : `me board human ${currentUserId}`,
      });
    }

    for (const issue of issues) {
      if (issue.createdByUserId) {
        const id = `user:${issue.createdByUserId}`;
        if (!options.has(id)) {
          options.set(id, {
            id,
            label: formatAssigneeUserLabel(issue.createdByUserId, currentUserId) ?? issue.createdByUserId.slice(0, 5),
            kind: "user",
            searchText: `${issue.createdByUserId} board user human`,
          });
        }
      }
    }

    for (const agent of agents ?? []) {
      knownAgentIds.add(agent.id);
      const id = `agent:${agent.id}`;
      if (!options.has(id)) {
        options.set(id, {
          id,
          label: agent.name,
          kind: "agent",
          searchText: `${agent.name} ${agent.id} agent`,
        });
      }
    }

    for (const issue of issues) {
      if (issue.createdByAgentId && !knownAgentIds.has(issue.createdByAgentId)) {
        const id = `agent:${issue.createdByAgentId}`;
        if (!options.has(id)) {
          options.set(id, {
            id,
            label: issue.createdByAgentId.slice(0, 8),
            kind: "agent",
            searchText: `${issue.createdByAgentId} agent`,
          });
        }
      }
    }

    return [...options.values()].sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "user" ? -1 : 1;
      return a.label.localeCompare(b.label);
    });
  }, [agents, currentUserId, issues]);

  const visibleIssueColumnSet = useMemo(() => new Set(visibleIssueColumns), [visibleIssueColumns]);
  const availableIssueColumns = useMemo(
    () => getAvailableInboxIssueColumns(isolatedWorkspacesEnabled),
    [isolatedWorkspacesEnabled],
  );

  const issueById = useMemo(() => {
    const map = new Map<string, Issue>();
    for (const issue of issues) {
      map.set(issue.id, issue);
    }
    return map;
  }, [issues]);

  const boardIssues = useMemo(() => {
    if (searchWithinLoadedIssues) return null;
    const merged = new Map<string, Issue>();
    let isPending = false;
    for (const query of boardIssueQueries) {
      isPending ||= query.isPending;
      for (const issue of query.data ?? []) {
        merged.set(issue.id, issue);
      }
    }
    if (merged.size > 0) return [...merged.values()];
    return isPending ? issues : [];
  }, [boardIssueQueries, issues, searchWithinLoadedIssues]);
  const boardColumnLimitReached = useMemo(
    () =>
      !searchWithinLoadedIssues &&
      boardIssueQueries.some((query) => (query.data?.length ?? 0) === ISSUE_BOARD_COLUMN_RESULT_LIMIT),
    [boardIssueQueries, searchWithinLoadedIssues],
  );

  const sourceIssues = useMemo(() => {
    const useRemoteSearch = normalizedIssueSearch.length > 0 && !searchWithinLoadedIssues;
    return boardIssues ?? (useRemoteSearch ? searchedIssues : issues);
  }, [boardIssues, issues, normalizedIssueSearch, searchedIssues, searchWithinLoadedIssues]);

  const searchScopedIssues = useMemo(
    () => normalizedIssueSearch.length > 0 && searchWithinLoadedIssues
      ? sourceIssues.filter((issue) => issueMatchesLocalSearch(issue, normalizedIssueSearch))
      : sourceIssues,
    [normalizedIssueSearch, searchWithinLoadedIssues, sourceIssues],
  );
  const hasExternalObjectStatusFilters = viewState.externalObjectStatuses.length > 0;
  const issueIdsForExternalObjectSummaries = useMemo(
    () => (hasExternalObjectStatusFilters
      ? searchScopedIssues.map((issue) => issue.id)
      : []),
    [hasExternalObjectStatusFilters, searchScopedIssues],
  );
  const {
    summaries: externalObjectSummaryByIssueId,
    isLoading: externalObjectSummariesLoading,
    isReady: externalObjectSummariesReady,
  } = useIssueExternalObjectSummaries(
    selectedCompanyId,
    issueIdsForExternalObjectSummaries,
  );
  const issueFilterContext = useMemo(() => ({
    ...issueFilterWorkspaceContext,
    externalObjectSummaryByIssueId,
    externalObjectSummariesReady: externalObjectSummariesReady && !externalObjectSummariesLoading,
  }), [externalObjectSummariesLoading, externalObjectSummariesReady, externalObjectSummaryByIssueId, issueFilterWorkspaceContext]);
  const externalObjectFilterLoading = hasExternalObjectStatusFilters
    && externalObjectSummariesLoading
    && !externalObjectSummariesReady;

  const filtered = useMemo(() => {
    const filteredByControls = applyIssueFilters(
      searchScopedIssues,
      viewState,
      currentUserId,
      enableRoutineVisibilityFilter,
      liveIssueIds,
      issueFilterContext,
    );
    return sortIssues(filteredByControls, viewState);
  }, [
    searchScopedIssues,
    viewState,
    currentUserId,
    enableRoutineVisibilityFilter,
    liveIssueIds,
    issueFilterContext,
  ]);

  const progressSummary = useMemo(
    () => shouldRenderSubIssueProgressSummary(showProgressSummary, issues.length)
      ? buildSubIssueProgressSummary(issues)
      : null,
    [issues, showProgressSummary],
  );

  const { data: labels } = useQuery({
    queryKey: queryKeys.issues.labels(selectedCompanyId!),
    queryFn: () => issuesApi.listLabels(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const activeFilterCount = countActiveIssueFilters(viewState, enableRoutineVisibilityFilter);
  const boardHighVolume = filtered.length > KANBAN_BOARD_HIGH_VOLUME_THRESHOLD;
  const boardLayout = viewState.viewMode === "grid" ? "grid" : "board";
  const anyLaneOpen = useMemo(
    () => anyKanbanLaneOpen(filtered, laneFold, boardLayout),
    [filtered, laneFold, boardLayout],
  );
  const boardCompactCards =
    viewState.boardCardDensity === "compact"
    || (viewState.boardCardDensity === "auto" && boardHighVolume);
  const boardCollapsedStatuses = useMemo(
    () =>
      viewState.boardColdLaneMode === "collapsed"
      || (viewState.boardColdLaneMode === "auto" && boardHighVolume)
        ? [...KANBAN_COLD_STATUSES]
        : [],
    [boardHighVolume, viewState.boardColdLaneMode],
  );
  const boardDensityCustomized =
    viewState.boardCardDensity !== "auto"
    || viewState.boardColdLaneMode !== "auto"
    || viewState.boardColumnPageSize !== KANBAN_COLUMN_DEFAULT_PAGE_SIZE;

  const newIssueDefaults = useCallback((group?: { key: string; items: Issue[] }) => {
    const groupKey = group?.key;
    const defaults: Record<string, unknown> = { ...(baseCreateIssueDefaults ?? {}) };
    if (projectId && defaults.projectId === undefined) defaults.projectId = projectId;
    if (groupKey) {
      if (viewState.groupBy === "status") defaults.status = groupKey;
      else if (viewState.groupBy === "priority") defaults.priority = groupKey;
      else if (viewState.groupBy === "assignee" && groupKey !== "__unassigned") {
        if (groupKey.startsWith("__user:")) defaults.assigneeUserId = groupKey.slice("__user:".length);
        else defaults.assigneeAgentId = groupKey;
      }
      else if (viewState.groupBy === "project" && groupKey !== "__no_project") defaults.projectId = groupKey;
      else if (viewState.groupBy === "workspace" && groupKey !== "__no_workspace") {
        const representativeIssue = group?.items.find((issue) =>
          issue.executionWorkspaceId === groupKey || issue.projectWorkspaceId === groupKey,
        ) ?? null;
        const executionWorkspace = executionWorkspaceById.get(groupKey);
        if (executionWorkspace) {
          defaults.executionWorkspaceId = groupKey;
          defaults.executionWorkspaceMode = "reuse_existing";
          if (executionWorkspace.projectWorkspaceId) defaults.projectWorkspaceId = executionWorkspace.projectWorkspaceId;
          const groupedProjectId = executionWorkspace.projectId
            ?? (executionWorkspace.projectWorkspaceId
              ? projectWorkspaceById.get(executionWorkspace.projectWorkspaceId)?.projectId
              : null)
            ?? (representativeIssue?.executionWorkspaceId === groupKey ? representativeIssue.projectId : null);
          if (groupedProjectId) defaults.projectId = groupedProjectId;
        } else {
          const projectWorkspace = projectWorkspaceById.get(groupKey);
          if (projectWorkspace) {
            defaults.projectWorkspaceId = groupKey;
            defaults.projectId = projectWorkspace.projectId;
          }
        }
      }
      else if (viewState.groupBy === "parent" && groupKey !== "__no_parent") {
        const parentIssue = issueById.get(groupKey);
        if (parentIssue) Object.assign(defaults, buildSubIssueDefaultsForViewer(parentIssue, currentUserId));
        else defaults.parentId = groupKey;
      }
    }
    return defaults;
  }, [
    baseCreateIssueDefaults,
    currentUserId,
    executionWorkspaceById,
    issueById,
    projectId,
    projectWorkspaceById,
    viewState.groupBy,
  ]);

  const createButtonLabel = createIssueLabel ? `New ${createIssueLabel}` : "New Task";
  const openCreateIssueDialog = useCallback((group?: { key: string; items: Issue[] }) => {
    openNewIssue(newIssueDefaults(group));
  }, [newIssueDefaults, openNewIssue]);

  const setIssueColumns = useCallback((next: InboxIssueColumn[]) => {
    const normalized = normalizeInboxIssueColumns(next);
    setVisibleIssueColumns(normalized);
    saveTaskCollectionPreferences(preferenceLocation, {
      viewState,
      columns: normalized,
    });
  }, [
    preferenceLocation.companyId,
    preferenceLocation.collectionKey,
    preferenceLocation.legacyColumnsStorageKey,
    preferenceLocation.legacyViewStorageKey,
    viewState,
  ]);

  const toggleIssueColumn = useCallback((column: InboxIssueColumn, enabled: boolean) => {
    if (enabled) {
      setIssueColumns([...visibleIssueColumns, column]);
      return;
    }
    setIssueColumns(visibleIssueColumns.filter((value) => value !== column));
  }, [setIssueColumns, visibleIssueColumns]);

  const IssuesToolbar = toolbarPresentation === "collection" ? CollectionToolbar : LegacyIssuesToolbar;

  return (
    <div ref={rootRef} className="space-y-4">
      {progressSummary ? (
        <SubIssueProgressSummaryStrip
          summary={progressSummary}
          issueLinkState={issueLinkState}
          parentIssueIdForCostSummary={parentIssueIdForCostSummary}
        />
      ) : null}

      {/* Toolbar */}
      <IssuesToolbar
        className="paperclip-task-list-toolbar"
        ariaLabel={toolbarPresentation === "collection" ? "Task controls" : undefined}
        context={(
          <Button size="sm" variant="outline" aria-label={createButtonLabel} onClick={() => openCreateIssueDialog()}>
            <Plus className="h-4 w-4 sm:mr-1" />
            <span className="hidden sm:inline">{createButtonLabel}</span>
          </Button>
        )}
        search={(
          <IssueSearchInput
            value={issueSearch}
            onDebouncedChange={(nextSearch) => {
              setIssueSearch(nextSearch);
              onSearchChange?.(nextSearch);
            }}
          />
        )}
        controls={(
          <>
          {/* View mode toggle */}
          <div className="flex items-center border border-border rounded-md overflow-hidden mr-1" role="group" aria-label="View mode">
            {([
              ["board", "Board", Columns3],
              ["grid", "Grid", LayoutGrid],
            ] as const).map(([mode, label, Icon]) => (
              <button
                key={mode}
                className={`flex h-8 items-center gap-1.5 px-2.5 text-xs transition-colors ${viewState.viewMode === mode ? "bg-accent font-medium text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                onClick={() => updateView({ viewMode: mode })}
                title={`${label} view`}
                aria-pressed={viewState.viewMode === mode}
              >
                <Icon className="h-3.5 w-3.5" />
                {label}
              </button>
            ))}
          </div>

          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 shrink-0 px-2 text-xs"
            onClick={() => setLaneFold({ all: !anyLaneOpen, lanes: {} })}
          >
            {anyLaneOpen ? "Collapse all" : "Expand all"}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="icon"
            className={cn("h-8 w-8 shrink-0", boardCompactCards && "bg-accent")}
            onClick={() => updateView({ boardCardDensity: boardCompactCards ? "comfortable" : "compact" })}
            title={boardCompactCards ? "Use comfortable cards" : "Use compact cards"}
          >
            <ChevronsDownUp className="h-3.5 w-3.5" />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="icon"
            className={cn("h-8 w-8 shrink-0", boardCollapsedStatuses.length > 0 && "bg-accent")}
            onClick={() => updateView({ boardColdLaneMode: boardCollapsedStatuses.length > 0 ? "expanded" : "collapsed" })}
            title={boardCollapsedStatuses.length > 0 ? "Expand cold lanes" : "Collapse cold lanes"}
          >
            <PanelTopClose className="h-3.5 w-3.5" />
          </Button>
          <Popover>
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className={cn(
                  "h-8 shrink-0 gap-1.5 px-2",
                  viewState.boardColumnPageSize !== KANBAN_COLUMN_DEFAULT_PAGE_SIZE && "bg-accent",
                )}
                title="Cards per column"
              >
                <ListCollapse className="h-3.5 w-3.5" />
                <span className="min-w-4 text-xs tabular-nums">{viewState.boardColumnPageSize}</span>
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-40 p-0">
              <div className="p-2 space-y-0.5">
                {KANBAN_COLUMN_PAGE_SIZE_OPTIONS.map((pageSize) => (
                  <button
                    key={pageSize}
                    type="button"
                    className={cn(
                      "flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-sm",
                      viewState.boardColumnPageSize === pageSize
                        ? "bg-accent/50 text-foreground"
                        : "text-muted-foreground hover:bg-accent/50",
                    )}
                    onClick={() => updateView({ boardColumnPageSize: pageSize })}
                  >
                    <span>{pageSize} per column</span>
                    {viewState.boardColumnPageSize === pageSize && <Check className="h-3.5 w-3.5" />}
                  </button>
                ))}
              </div>
            </PopoverContent>
          </Popover>
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="h-8 w-8 shrink-0"
            onClick={() => updateView({
              boardCardDensity: "auto",
              boardColdLaneMode: "expanded",
              boardColumnPageSize: KANBAN_COLUMN_DEFAULT_PAGE_SIZE,
            })}
            disabled={!boardDensityCustomized}
            title="Reset board density"
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </Button>

          <IssueColumnPicker
            availableColumns={availableIssueColumns}
            visibleColumnSet={visibleIssueColumnSet}
            onToggleColumn={toggleIssueColumn}
            showDateGroupSeparators={viewState.showDateGroupSeparators}
            onToggleDateGroupSeparators={(enabled) => updateView({ showDateGroupSeparators: enabled })}
            onResetColumns={() => setIssueColumns(DEFAULT_INBOX_ISSUE_COLUMNS)}
            title="Choose which task columns stay visible"
            iconOnly
            rowPresentation={rowPresentation}
          />

          <IssueFiltersPopover
            state={viewState}
            onChange={updateView}
            buttonVariant="outline"
            activeFilterCount={activeFilterCount}
            agents={agents}
            creators={creatorOptions}
            projects={projects?.map((project) => ({ id: project.id, name: project.name }))}
            labels={labels?.map((label) => ({ id: label.id, name: label.name, color: label.color }))}
            currentUserId={currentUserId}
            enableExternalObjectFilters={externalObjectsEnabled}
            enableRoutineVisibilityFilter={enableRoutineVisibilityFilter}
            iconOnly
            workspaces={isolatedWorkspacesEnabled ? workspaceOptions : undefined}
            presentation={rowPresentation === "task" ? "streamlined" : "legacy"}
          />

          </>
        )}
      />

      {(isLoading || externalObjectFilterLoading) && <PageSkeleton variant="issues-list" />}
      {error && <p className="text-sm text-destructive">{error.message}</p>}
      {!searchWithinLoadedIssues && normalizedIssueSearch.length > 0 && searchedIssues.length === ISSUE_SEARCH_RESULT_LIMIT && (
        <p className="text-xs text-muted-foreground">
          Showing up to {ISSUE_SEARCH_RESULT_LIMIT} matches. Refine the search to narrow further.
        </p>
      )}
      {boardColumnLimitReached && (
        <p className="text-xs text-muted-foreground">
          Some board columns are showing up to {ISSUE_BOARD_COLUMN_RESULT_LIMIT} tasks. Refine filters or search to reveal the rest.
        </p>
      )}
      <KanbanBoard
        layout={boardLayout}
        issues={filtered}
        agents={agents}
        liveIssueIds={liveIssueIds}
        compactCards={boardCompactCards}
        collapsedStatuses={boardCollapsedStatuses}
        initialVisibleCount={viewState.boardColumnPageSize}
        revealIncrement={viewState.boardColumnPageSize}
        laneFold={laneFold}
        onLaneFoldChange={setLaneFold}
        onUpdateIssue={onUpdateIssue}
      />
    </div>
  );
}
