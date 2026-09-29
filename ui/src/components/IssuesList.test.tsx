// @vitest-environment jsdom

import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Issue, Project } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  IssuesList,
  issueAgeBucket,
  issueAgeBucketsCrossed,
  issueAgeSeparatorLabel,
} from "./IssuesList";
import { TooltipProvider } from "@/components/ui/tooltip";
import { taskCollectionPreferencesStorageKey } from "../lib/task-collection-preferences";

const companyState = vi.hoisted(() => ({
  selectedCompanyId: "company-1",
}));

const dialogState = vi.hoisted(() => ({
  openNewIssue: vi.fn(),
}));

const mockIssuesApi = vi.hoisted(() => ({
  list: vi.fn(),
  listLabels: vi.fn(),
}));

const mockKanbanBoard = vi.hoisted(() => vi.fn());
const mockNavigate = vi.hoisted(() => vi.fn());

const mockAuthApi = vi.hoisted(() => ({
  getSession: vi.fn(),
}));

const mockAccessApi = vi.hoisted(() => ({
  listMembers: vi.fn(),
  listUserDirectory: vi.fn(),
}));

const mockExecutionWorkspacesApi = vi.hoisted(() => ({
  list: vi.fn(),
  listSummaries: vi.fn(),
}));

const mockInstanceSettingsApi = vi.hoisted(() => ({
  getExperimental: vi.fn(),
}));

const mockExternalObjectsApi = vi.hoisted(() => ({
  getIssueSummaries: vi.fn(),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => companyState,
}));

vi.mock("../context/DialogContext", () => ({
  useDialog: () => dialogState,
  useDialogActions: () => dialogState,
}));

vi.mock("@/lib/router", () => ({
  useNavigate: () => mockNavigate,
  Link: ({
    children,
    to,
    state: _state,
    issuePrefetch: _issuePrefetch,
    ...props
  }: AnchorHTMLAttributes<HTMLAnchorElement> & {
    to: string;
    state?: unknown;
    issuePrefetch?: unknown;
  }) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

vi.mock("../api/issues", () => ({
  issuesApi: {
    ...mockIssuesApi,
    listCompact: mockIssuesApi.list,
  },
}));

vi.mock("../api/auth", () => ({
  authApi: mockAuthApi,
}));

vi.mock("../api/access", () => ({
  accessApi: mockAccessApi,
}));

vi.mock("@/api/access", () => ({
  accessApi: mockAccessApi,
}));

vi.mock("../api/execution-workspaces", () => ({
  executionWorkspacesApi: mockExecutionWorkspacesApi,
}));

vi.mock("../api/instanceSettings", () => ({
  instanceSettingsApi: mockInstanceSettingsApi,
}));

vi.mock("../api/externalObjects", () => ({
  externalObjectsApi: mockExternalObjectsApi,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

vi.mock("./IssueRow", () => ({
  IssueRow: ({
    issue,
    desktopMetaLeading,
    desktopTrailing,
    titleClassName,
    checklistStepNumber,
    checklistCurrentStep,
    checklistDependencyChips,
    checklistRowId,
    externalObjectSummary,
    presentation,
    leadingControl,
    treeGuides,
    showIdentifier,
    trailingMeta,
  }: {
    issue: Issue;
    desktopMetaLeading?: ReactNode;
    desktopTrailing?: ReactNode;
    titleClassName?: string;
    checklistStepNumber?: number | string | null;
    checklistCurrentStep?: boolean;
    checklistDependencyChips?: ReactNode;
    checklistRowId?: string;
    externalObjectSummary?: { total: number } | null;
    presentation?: "legacy" | "task";
    leadingControl?: ReactNode;
    treeGuides?: number;
    showIdentifier?: boolean;
    trailingMeta?: ReactNode;
  }) => (
    <div
      data-testid="issue-row"
      data-presentation={presentation}
      data-tree-guides={treeGuides ?? 0}
      data-show-identifier={showIdentifier ? "true" : "false"}
      data-trailing-meta={typeof trailingMeta === "string" ? trailingMeta : undefined}
      data-has-desktop-trailing={desktopTrailing ? "true" : "false"}
      id={checklistRowId}
      data-step={checklistStepNumber ?? undefined}
      data-current-step={checklistCurrentStep ? "true" : undefined}
      data-title-class={titleClassName ?? undefined}
    >
      <span>{issue.title}</span>
      {leadingControl}
      {externalObjectSummary ? (
        <span data-testid="external-object-summary">{externalObjectSummary.total}</span>
      ) : null}
      {desktopMetaLeading}
      {desktopTrailing}
      {trailingMeta}
      {checklistDependencyChips}
    </div>
  ),
}));

vi.mock("./KanbanBoard", async (importActual) => ({
  anyKanbanLaneOpen: (await importActual<typeof import("./KanbanBoard")>()).anyKanbanLaneOpen,
  KANBAN_BOARD_HIGH_VOLUME_THRESHOLD: 100,
  KANBAN_COLD_STATUSES: ["backlog", "done", "cancelled"],
  KANBAN_COLUMN_DEFAULT_PAGE_SIZE: 10,
  KANBAN_COLUMN_PAGE_SIZE_OPTIONS: [10, 25, 50],
  KanbanBoard: (props: {
    issues: Issue[];
    compactCards?: boolean;
    collapsedStatuses?: string[];
    initialVisibleCount?: number;
    revealIncrement?: number;
  }) => {
    mockKanbanBoard(props);
    return (
      <div data-testid="kanban-board">
        {props.issues.map((issue) => (
          <span key={issue.id}>{issue.title}</span>
        ))}
      </div>
    );
  },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function createIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    identifier: "PAP-1",
    companyId: "company-1",
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title: "Issue title",
    description: null,
    status: "todo",
    priority: "medium",
    reviewPolicy: null,
    assigneeAgentId: null,
    assigneeUserId: null,
    responsibleUserId: null,
    createdByAgentId: null,
    createdByUserId: null,
    issueNumber: 1,
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    createdAt: new Date("2026-04-07T00:00:00.000Z"),
    updatedAt: new Date("2026-04-07T00:00:00.000Z"),
    labels: [],
    labelIds: [],
    myLastTouchAt: null,
    lastExternalCommentAt: null,
    lastActivityAt: null,
    isUnreadForMe: false,
    ...overrides,
    workMode: overrides.workMode ?? "standard",
  };
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function flushAnimationFrame() {
  await act(async () => {
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    await Promise.resolve();
  });
}

async function waitForAssertion(assertion: () => void, attempts = 20) {
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await flush();
    }
  }

  throw lastError;
}

async function waitForMicrotaskAssertion(assertion: () => void, attempts = 20) {
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await act(async () => {
        await Promise.resolve();
      });
    }
  }

  throw lastError;
}

function setDocumentScrollMetrics({
  innerHeight,
  scrollY,
  scrollHeight,
}: {
  innerHeight: number;
  scrollY: number;
  scrollHeight: number;
}) {
  Object.defineProperty(window, "innerHeight", { configurable: true, value: innerHeight });
  Object.defineProperty(window, "scrollY", { configurable: true, value: scrollY });
  Object.defineProperty(document.documentElement, "scrollHeight", { configurable: true, value: scrollHeight });
}

function renderWithQueryClient(node: ReactNode, container: HTMLDivElement) {
  const root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          {node}
        </TooltipProvider>
      </QueryClientProvider>,
    );
  });

  return { root, queryClient };
}

describe("IssuesList", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    dialogState.openNewIssue.mockReset();
    mockKanbanBoard.mockReset();
    mockNavigate.mockReset();
    mockIssuesApi.list.mockReset();
    mockIssuesApi.listLabels.mockReset();
    mockAuthApi.getSession.mockReset();
    mockAccessApi.listMembers.mockReset();
    mockAccessApi.listUserDirectory.mockReset();
    mockExecutionWorkspacesApi.list.mockReset();
    mockExecutionWorkspacesApi.listSummaries.mockReset();
    mockInstanceSettingsApi.getExperimental.mockReset();
    mockExternalObjectsApi.getIssueSummaries.mockReset();
    mockIssuesApi.list.mockResolvedValue([]);
    mockIssuesApi.listLabels.mockResolvedValue([]);
    mockAuthApi.getSession.mockResolvedValue({ user: null, session: null });
    mockAccessApi.listMembers.mockResolvedValue({ members: [], access: {} });
    mockAccessApi.listUserDirectory.mockResolvedValue({ users: [] });
    mockExecutionWorkspacesApi.list.mockResolvedValue([]);
    mockExecutionWorkspacesApi.listSummaries.mockResolvedValue([]);
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({
      enableIsolatedWorkspaces: false,
      enableExternalObjects: false,
      enableStreamlinedUi: true,
    });
    setDocumentScrollMetrics({ innerHeight: 600, scrollY: 0, scrollHeight: 2400 });
    mockExternalObjectsApi.getIssueSummaries.mockResolvedValue({ summaries: {} });
    localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    container.remove();
  });

  it("uses the master list and legacy persistence when Streamlined UI is off", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({
      enableIsolatedWorkspaces: false,
      enableExternalObjects: false,
      enableStreamlinedUi: false,
    });
    localStorage.setItem(
      taskCollectionPreferencesStorageKey({
        companyId: "company-1",
        collectionKey: "paperclip:test-issues",
      }),
      JSON.stringify({
        version: 1,
        companyId: "company-1",
        collectionKey: "paperclip:test-issues",
        viewState: { viewMode: "board" },
        columns: [],
      }),
    );

    const { root } = renderWithQueryClient(
      <IssuesList
        issues={[createIssue({ id: "legacy-issue", title: "Master task row" })]}
        isLoading={false}
        agents={[]}
        projects={[]}
        viewStateKey="paperclip:test-issues"
        rowPresentation="task"
        toolbarPresentation="collection"
        onUpdateIssue={() => undefined}
      />,
      container,
    );

    await waitForAssertion(() => {
      const row = container.querySelector("[data-testid='issue-row']");
      expect(row).not.toBeNull();
      expect(row?.getAttribute("data-presentation")).toBeNull();
      expect(container.querySelector("[data-testid='kanban-board']")).toBeNull();
    });

    act(() => root.unmount());
  });

  it("keeps the shared collection toolbar opt in per surface", async () => {
    const { root } = renderWithQueryClient(
      <IssuesList
        issues={[createIssue()]}
        agents={[]}
        projects={[]}
        viewStateKey="paperclip:test-issues"
        toolbarPresentation="collection"
        onUpdateIssue={() => undefined}
      />,
      container,
    );

    await waitForAssertion(() => {
      expect(container.querySelector("[role='toolbar'][aria-label='Task controls']")).not.toBeNull();
    });

    act(() => root.unmount());
  });

  it("renders server search results instead of filtering the full issue list locally", async () => {
    const localIssue = createIssue({ id: "issue-local", identifier: "PAP-1", title: "Local issue" });
    const serverIssue = createIssue({ id: "issue-server", identifier: "PAP-2", title: "Server result" });

    mockIssuesApi.list.mockResolvedValue([serverIssue]);

    const { root } = renderWithQueryClient(
      <IssuesList
        issues={[localIssue]}
        agents={[]}
        projects={[]}
        viewStateKey="paperclip:test-issues"
        initialSearch="server"
        onUpdateIssue={() => undefined}
      />,
      container,
    );

    await waitForAssertion(() => {
      expect(mockIssuesApi.list).toHaveBeenCalledWith("company-1", {
        q: "server",
        projectId: undefined,
        limit: 200,
      }, { signal: expect.any(AbortSignal) });
      expect(container.textContent).toContain("Server result");
      expect(container.textContent).not.toContain("Local issue");
    });

    act(() => {
      root.unmount();
    });
  });

  it("keeps server-side search scoped to the provided parent issue filters", async () => {
    const localIssue = createIssue({ id: "issue-local", identifier: "PAP-1", title: "Local issue" });
    const serverIssue = createIssue({ id: "issue-server", identifier: "PAP-2", title: "Server result" });

    mockIssuesApi.list.mockResolvedValue([serverIssue]);

    const { root } = renderWithQueryClient(
      <IssuesList
        issues={[localIssue]}
        agents={[]}
        projects={[]}
        viewStateKey="paperclip:test-issues"
        initialSearch="server"
        searchFilters={{ parentId: "parent-1" }}
        onUpdateIssue={() => undefined}
      />,
      container,
    );

    await waitForAssertion(() => {
      expect(mockIssuesApi.list).toHaveBeenCalledWith("company-1", {
        q: "server",
        projectId: undefined,
        parentId: "parent-1",
        limit: 200,
      }, { signal: expect.any(AbortSignal) });
      expect(container.textContent).toContain("Server result");
      expect(container.textContent).not.toContain("Local issue");
    });

    act(() => {
      root.unmount();
    });
  });

  it("uses the supplied create defaults and label for sub-issue lists", async () => {
    const { root } = renderWithQueryClient(
      <IssuesList
        issues={[createIssue()]}
        agents={[]}
        projects={[]}
        viewStateKey="paperclip:test-issues"
        baseCreateIssueDefaults={{ parentId: "parent-1", projectId: "project-1" }}
        createIssueLabel="Sub-issue"
        onUpdateIssue={() => undefined}
      />,
      container,
    );

    await waitForAssertion(() => {
      const button = Array.from(container.querySelectorAll("button")).find(
        (candidate) => candidate.textContent?.includes("New Sub-issue"),
      );
      expect(button).not.toBeUndefined();
    });

    await act(async () => {
      const button = Array.from(container.querySelectorAll("button")).find(
        (candidate) => candidate.textContent?.includes("New Sub-issue"),
      );
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    expect(dialogState.openNewIssue).toHaveBeenCalledWith({
      parentId: "parent-1",
      projectId: "project-1",
    });

    act(() => {
      root.unmount();
    });
  });

  it("renders the opt-in sub-issue progress summary with workflow next-up linking", async () => {
    const doneIssue = createIssue({
      id: "issue-done",
      identifier: "PAP-1",
      title: "Completed setup",
      status: "done",
      createdAt: new Date("2026-04-01T00:00:00.000Z"),
    });
    const nextIssue = createIssue({
      id: "issue-next",
      identifier: "PAP-2",
      title: "Implement next slice",
      status: "todo",
      createdAt: new Date("2026-04-02T00:00:00.000Z"),
      blockedBy: [{
        id: "issue-done",
        identifier: "PAP-1",
        title: "Completed setup",
        status: "done",
        priority: "medium",
        assigneeAgentId: null,
        assigneeUserId: null,
      }],
    });
    const blockedIssue = createIssue({
      id: "issue-blocked",
      identifier: "PAP-3",
      title: "Blocked follow-up",
      status: "blocked",
      createdAt: new Date("2026-04-03T00:00:00.000Z"),
    });
    const cancelledIssue = createIssue({
      id: "issue-cancelled",
      identifier: "PAP-4",
      title: "Cancelled follow-up",
      status: "cancelled",
      createdAt: new Date("2026-04-04T00:00:00.000Z"),
    });

    const { root } = renderWithQueryClient(
      <IssuesList
        issues={[cancelledIssue, blockedIssue, nextIssue, doneIssue]}
        agents={[]}
        projects={[]}
        viewStateKey="paperclip:test-issues"
        showProgressSummary
        onUpdateIssue={() => undefined}
      />,
      container,
    );

    await waitForAssertion(() => {
      const progress = container.querySelector('[role="progressbar"]');
      expect(progress).not.toBeNull();
      expect(progress?.getAttribute("aria-valuenow")).toBe("1");
      expect(progress?.getAttribute("aria-valuemax")).toBe("3");
      expect(container.textContent).toContain("1/3 done");
      expect(container.textContent).toContain("0 in progress");
      expect(container.textContent).toContain("1 blocked");
      expect(container.textContent).not.toContain("Done 1");
      expect(container.textContent).toContain("Next up");
      const link = container.querySelector('a[href="/issues/PAP-2"]');
      expect(link?.textContent).toContain("Implement next slice");
      expect(container.querySelector('[title="Cancelled: 1"]')).toBeNull();
    });

    act(() => {
      root.unmount();
    });
  });

  it("hides the sub-issue progress summary unless it is enabled with multiple sub-issues", async () => {
    const { root } = renderWithQueryClient(
      <IssuesList
        issues={[createIssue()]}
        agents={[]}
        projects={[]}
        viewStateKey="paperclip:test-issues"
        showProgressSummary
        onUpdateIssue={() => undefined}
      />,
      container,
    );

    await waitForAssertion(() => {
      expect(container.querySelector('[role="progressbar"]')).toBeNull();
    });

    act(() => {
      root.unmount();
    });
  });

  it("shows waiting on blockers when every remaining sub-issue is blocked", async () => {
    const { root } = renderWithQueryClient(
      <IssuesList
        issues={[
          createIssue({
            id: "issue-done",
            identifier: "PAP-1",
            title: "Completed setup",
            status: "done",
            createdAt: new Date("2026-04-01T00:00:00.000Z"),
          }),
          createIssue({
            id: "issue-blocked",
            identifier: "PAP-2",
            title: "Blocked follow-up",
            status: "blocked",
            createdAt: new Date("2026-04-02T00:00:00.000Z"),
          }),
        ]}
        agents={[]}
        projects={[]}
        viewStateKey="paperclip:test-issues"
        showProgressSummary
        onUpdateIssue={() => undefined}
      />,
      container,
    );

    await waitForAssertion(() => {
      expect(container.textContent).toContain("Waiting on blockers");
      const link = container.querySelector('a[href="/issues/PAP-2"]');
      expect(link?.textContent).toContain("Blocked follow-up");
    });

    act(() => {
      root.unmount();
    });
  });

  it("debounces search updates so typing does not notify the page on every keystroke", async () => {
    vi.useFakeTimers();

    const onSearchChange = vi.fn();
    const localIssue = createIssue({ id: "issue-local", identifier: "PAP-1", title: "Local issue" });

    const { root } = renderWithQueryClient(
      <IssuesList
        issues={[localIssue]}
        agents={[]}
        projects={[]}
        viewStateKey="paperclip:test-issues"
        onSearchChange={onSearchChange}
        onUpdateIssue={() => undefined}
      />,
      container,
    );

    const input = container.querySelector('input[aria-label="Search tasks"]') as HTMLInputElement | null;
    expect(input).not.toBeNull();
    const valueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    expect(valueSetter).toBeTypeOf("function");

    act(() => {
      if (!input || !valueSetter) return;
      valueSetter.call(input, "a");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      valueSetter.call(input, "ab");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

    expect(onSearchChange).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(249);
    });

    expect(onSearchChange).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
    });

    expect(onSearchChange).toHaveBeenCalledTimes(1);
    expect(onSearchChange).toHaveBeenCalledWith("ab");

    act(() => {
      root.unmount();
    });
  });

  it("shows a refinement hint when search results hit the live search cap", async () => {
    const serverIssues = Array.from({ length: 200 }, (_, index) =>
      createIssue({
        id: `issue-${index + 1}`,
        identifier: `PAP-${index + 1}`,
        title: `Server result ${index + 1}`,
      }),
    );

    localStorage.setItem(
      "paperclip:test-issues:company-1",
      JSON.stringify({ statuses: ["done"] }),
    );
    mockIssuesApi.list.mockResolvedValue(serverIssues);

    const { root } = renderWithQueryClient(
      <IssuesList
        issues={[]}
        agents={[]}
        projects={[]}
        viewStateKey="paperclip:test-issues"
        initialSearch="server"
        onUpdateIssue={() => undefined}
      />,
      container,
    );

    await waitForAssertion(() => {
      expect(container.textContent).toContain("Showing up to 200 matches. Refine the search to narrow further.");
    });

    act(() => {
      root.unmount();
    });
  }, 10_000);

  it("loads board issues with a separate result limit for each status column", async () => {
    localStorage.setItem(
      "paperclip:test-issues:company-1",
      JSON.stringify({ viewMode: "board" }),
    );

    const parentIssue = createIssue({
      id: "issue-parent-total-limit",
      title: "Parent total-limited issue",
      status: "todo",
    });
    const backlogIssue = createIssue({
      id: "issue-backlog",
      title: "Backlog column issue",
      status: "backlog",
    });
    const doneIssue = createIssue({
      id: "issue-done",
      title: "Done column issue",
      status: "done",
    });

    mockIssuesApi.list.mockImplementation((_companyId, filters) => {
      if (filters?.status === "backlog") return Promise.resolve([backlogIssue]);
      if (filters?.status === "done") return Promise.resolve([doneIssue]);
      return Promise.resolve([]);
    });

    const { root } = renderWithQueryClient(
      <IssuesList
        issues={[parentIssue]}
        agents={[]}
        projects={[]}
        viewStateKey="paperclip:test-issues"
        enableRoutineVisibilityFilter
        onUpdateIssue={() => undefined}
      />,
      container,
    );

    await waitForAssertion(() => {
      expect(mockIssuesApi.list).toHaveBeenCalledWith("company-1", expect.objectContaining({
        status: "backlog",
        limit: 200,
        includeRoutineExecutions: true,
      }), { signal: expect.any(AbortSignal) });
      expect(mockIssuesApi.list).toHaveBeenCalledWith("company-1", expect.objectContaining({
        status: "done",
        limit: 200,
        includeRoutineExecutions: true,
      }), { signal: expect.any(AbortSignal) });
      expect(mockKanbanBoard).toHaveBeenLastCalledWith(expect.objectContaining({
        issues: expect.arrayContaining([
          expect.objectContaining({ id: "issue-backlog" }),
          expect.objectContaining({ id: "issue-done" }),
        ]),
      }));
      expect(container.textContent).toContain("Backlog column issue");
      expect(container.textContent).toContain("Done column issue");
      expect(container.textContent).not.toContain("Parent total-limited issue");
    });

    act(() => {
      root.unmount();
    });
  });

  it("keeps the grid view mode and loads it like the board", async () => {
    localStorage.setItem(
      "paperclip:test-issues:company-1",
      JSON.stringify({ viewMode: "grid" }),
    );
    mockIssuesApi.list.mockResolvedValue([]);

    const { root } = renderWithQueryClient(
      <IssuesList
        issues={[createIssue({ id: "issue-grid", title: "Grid issue", status: "todo" })]}
        agents={[]}
        projects={[]}
        viewStateKey="paperclip:test-issues"
        onUpdateIssue={() => undefined}
      />,
      container,
    );

    await waitForAssertion(() => {
      expect(mockIssuesApi.list).toHaveBeenCalledWith("company-1", expect.objectContaining({
        status: "done",
        limit: 200,
      }), { signal: expect.any(AbortSignal) });
      expect(mockKanbanBoard).toHaveBeenLastCalledWith(expect.objectContaining({ layout: "grid" }));
      const pressed = container.querySelector('[aria-label="View mode"] [aria-pressed="true"]');
      expect(pressed?.textContent).toBe("Grid");
    });

    act(() => {
      root.unmount();
    });
  });

  it("defaults to Board and reads a saved List view as Board", async () => {
    for (const saved of [null, JSON.stringify({ viewMode: "list" })]) {
      localStorage.clear();
      if (saved) localStorage.setItem("paperclip:test-issues:company-1", saved);
      mockKanbanBoard.mockReset();

      const { root } = renderWithQueryClient(
        <IssuesList
          issues={[createIssue({ id: "issue-default", title: "Default issue", status: "todo" })]}
          agents={[]}
          projects={[]}
          viewStateKey="paperclip:test-issues"
          onUpdateIssue={() => undefined}
        />,
        container,
      );

      await waitForAssertion(() => {
        expect(mockKanbanBoard).toHaveBeenLastCalledWith(expect.objectContaining({ layout: "board" }));
        const modes = Array.from(container.querySelectorAll('[aria-label="View mode"] button')).map((b) => b.textContent);
        expect(modes).toEqual(["Board", "Grid"]);
        const pressed = container.querySelector('[aria-label="View mode"] [aria-pressed="true"]');
        expect(pressed?.textContent).toBe("Board");
      });

      act(() => {
        root.unmount();
      });
    }
  });

  it("folds and opens every lane with one Collapse all / Expand all toggle", async () => {
    const foldIssue = createIssue({ id: "issue-fold", title: "Fold issue", status: "todo" });
    mockIssuesApi.list.mockImplementation((_companyId, filters) =>
      Promise.resolve(filters?.status === "todo" ? [foldIssue] : []));

    const { root } = renderWithQueryClient(
      <IssuesList
        issues={[foldIssue]}
        agents={[]}
        projects={[]}
        viewStateKey="paperclip:test-issues"
        onUpdateIssue={() => undefined}
      />,
      container,
    );

    const clickButton = async (label: string) => {
      const button = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === label);
      expect(button).toBeTruthy();
      await act(() => {
        button!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
    };

    await waitForAssertion(() => {
      expect(mockKanbanBoard).toHaveBeenLastCalledWith(expect.objectContaining({ laneFold: { all: null, lanes: {} } }));
    });
    expect(Array.from(container.querySelectorAll("button")).some((b) => b.textContent === "Expand all")).toBe(false);
    await clickButton("Collapse all");
    await waitForAssertion(() => {
      expect(mockKanbanBoard).toHaveBeenLastCalledWith(expect.objectContaining({ laneFold: { all: false, lanes: {} } }));
    });
    expect(Array.from(container.querySelectorAll("button")).some((b) => b.textContent === "Collapse all")).toBe(false);
    await clickButton("Expand all");
    await waitForAssertion(() => {
      expect(mockKanbanBoard).toHaveBeenLastCalledWith(expect.objectContaining({ laneFold: { all: true, lanes: {} } }));
    });
    await clickButton("Collapse all");

    act(() => {
      root.unmount();
    });
  });

  it("uses compact cards and collapsed cold lanes for high-volume boards", async () => {
    localStorage.setItem(
      "paperclip:test-issues:company-1",
      JSON.stringify({ viewMode: "board" }),
    );

    const backlogIssues = Array.from({ length: 101 }, (_, index) =>
      createIssue({
        id: `issue-backlog-${index + 1}`,
        identifier: `PAP-${index + 1}`,
        title: `Backlog issue ${index + 1}`,
        status: "backlog",
      }),
    );

    mockIssuesApi.list.mockImplementation((_companyId, filters) => {
      if (filters?.status === "backlog") return Promise.resolve(backlogIssues);
      return Promise.resolve([]);
    });

    const { root } = renderWithQueryClient(
      <IssuesList
        issues={[]}
        agents={[]}
        projects={[]}
        viewStateKey="paperclip:test-issues"
        onUpdateIssue={() => undefined}
      />,
      container,
    );

    await waitForAssertion(() => {
      expect(mockKanbanBoard).toHaveBeenLastCalledWith(expect.objectContaining({
        compactCards: true,
        collapsedStatuses: expect.arrayContaining(["backlog", "done", "cancelled"]),
        initialVisibleCount: 10,
        revealIncrement: 10,
      }));
    });

    act(() => {
      root.unmount();
    });
  });

  it("lets board users choose the per-column page size", async () => {
    localStorage.setItem(
      "paperclip:test-issues:company-1",
      JSON.stringify({ viewMode: "board" }),
    );

    const { root } = renderWithQueryClient(
      <IssuesList
        issues={[createIssue({ id: "issue-page-size", title: "Page size issue" })]}
        agents={[]}
        projects={[]}
        viewStateKey="paperclip:test-issues"
        onUpdateIssue={() => undefined}
      />,
      container,
    );

    await waitForAssertion(() => {
      expect(mockKanbanBoard).toHaveBeenLastCalledWith(expect.objectContaining({
        initialVisibleCount: 10,
        revealIncrement: 10,
      }));
    });

    const pageSizeButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.getAttribute("title") === "Cards per column",
    );
    expect(pageSizeButton).toBeTruthy();

    act(() => {
      pageSizeButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    let option25: HTMLButtonElement | undefined;
    await waitForAssertion(() => {
      option25 = Array.from(document.body.querySelectorAll("button")).find((button) =>
        button.textContent?.includes("25 per column"),
      );
      expect(option25).toBeTruthy();
    });

    act(() => {
      option25?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await waitForAssertion(() => {
      expect(mockKanbanBoard).toHaveBeenLastCalledWith(expect.objectContaining({
        initialVisibleCount: 25,
        revealIncrement: 25,
      }));
    });

    expect(localStorage.getItem("paperclip:test-issues:company-1")).toContain("\"boardColumnPageSize\":25");

    act(() => {
      root.unmount();
    });
  });

  it("shows a refinement hint when a board column hits its server cap", async () => {
    localStorage.setItem(
      "paperclip:test-issues:company-1",
      JSON.stringify({ viewMode: "board" }),
    );

    const cappedBacklogIssues = Array.from({ length: 200 }, (_, index) =>
      createIssue({
        id: `issue-backlog-${index + 1}`,
        identifier: `PAP-${index + 1}`,
        title: `Backlog issue ${index + 1}`,
        status: "backlog",
      }),
    );

    mockIssuesApi.list.mockImplementation((_companyId, filters) => {
      if (filters?.status === "backlog") return Promise.resolve(cappedBacklogIssues);
      return Promise.resolve([]);
    });

    const { root } = renderWithQueryClient(
      <IssuesList
        issues={[]}
        agents={[]}
        projects={[]}
        viewStateKey="paperclip:test-issues"
        onUpdateIssue={() => undefined}
      />,
      container,
    );

    await waitForAssertion(() => {
      expect(container.textContent).toContain("Some board columns are showing up to 200 tasks. Refine filters or search to reveal the rest.");
    });

    act(() => {
      root.unmount();
    });
  });

  it("applies an initial workspace filter from the issues URL state", async () => {
    const alphaIssue = createIssue({
      id: "issue-alpha",
      identifier: "PAP-30",
      title: "Alpha issue",
      executionWorkspaceId: "workspace-alpha",
    });
    const betaIssue = createIssue({
      id: "issue-beta",
      identifier: "PAP-31",
      title: "Beta issue",
      executionWorkspaceId: "workspace-beta",
    });

    const { root } = renderWithQueryClient(
      <IssuesList
        issues={[alphaIssue, betaIssue]}
        agents={[]}
        projects={[]}
        viewStateKey="paperclip:test-issues"
        initialWorkspaces={["workspace-alpha"]}
        onUpdateIssue={() => undefined}
      />,
      container,
    );

    await waitForAssertion(() => {
      expect(container.textContent).toContain("Alpha issue");
      expect(container.textContent).not.toContain("Beta issue");
    });

    act(() => {
      root.unmount();
    });
  });

  it("shows routine-backed issues by default and hides them when the routine filter is toggled off", async () => {
    const manualIssue = createIssue({
      id: "issue-manual",
      identifier: "PAP-10",
      title: "Manual issue",
      originKind: "manual",
    });
    const routineIssue = createIssue({
      id: "issue-routine",
      identifier: "PAP-11",
      title: "Routine issue",
      originKind: "routine_execution",
    });

    const { root } = renderWithQueryClient(
      <IssuesList
        issues={[manualIssue, routineIssue]}
        agents={[]}
        projects={[]}
        viewStateKey="paperclip:test-issues"
        enableRoutineVisibilityFilter
        onUpdateIssue={() => undefined}
      />,
      container,
    );

    await waitForAssertion(() => {
      expect(container.textContent).toContain("Manual issue");
      expect(container.textContent).toContain("Routine issue");
    });

    await act(async () => {
      const filterButton = Array.from(document.body.querySelectorAll("button")).find(
        (button) => button.getAttribute("title") === "Filter",
      );
      filterButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    await waitForAssertion(() => {
      const toggle = Array.from(document.body.querySelectorAll("label")).find(
        (label) => label.textContent?.includes("Hide routine runs"),
      );
      expect(toggle).not.toBeUndefined();
    });

    await act(async () => {
      const toggle = Array.from(document.body.querySelectorAll("label")).find(
        (label) => label.textContent?.includes("Hide routine runs"),
      );
      toggle?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    await waitForAssertion(() => {
      expect(container.textContent).not.toContain("Routine issue");
    });

    act(() => {
      root.unmount();
    });
  });

  it("blurs the search input on Enter without clearing the query", async () => {
    const { root } = renderWithQueryClient(
      <IssuesList
        issues={[createIssue()]}
        agents={[]}
        projects={[]}
        viewStateKey="paperclip:test-issues"
        initialSearch="bug"
        onUpdateIssue={() => undefined}
      />,
      container,
    );

    await waitForAssertion(() => {
      const input = container.querySelector('input[aria-label="Search tasks"]') as HTMLInputElement | null;
      expect(input).not.toBeNull();
      input?.focus();
      expect(document.activeElement).toBe(input);
    });

    const input = container.querySelector('input[aria-label="Search tasks"]') as HTMLInputElement;
    act(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
      }));
    });

    expect(document.activeElement).not.toBe(input);
    expect(input.value).toBe("bug");

    act(() => {
      root.unmount();
    });
  });

  it("blurs the search input on Escape once the field is empty", async () => {
    const { root } = renderWithQueryClient(
      <IssuesList
        issues={[createIssue()]}
        agents={[]}
        projects={[]}
        viewStateKey="paperclip:test-issues"
        initialSearch=""
        onUpdateIssue={() => undefined}
      />,
      container,
    );

    await waitForAssertion(() => {
      const input = container.querySelector('input[aria-label="Search tasks"]') as HTMLInputElement | null;
      expect(input).not.toBeNull();
      input?.focus();
      expect(document.activeElement).toBe(input);
    });

    const input = container.querySelector('input[aria-label="Search tasks"]') as HTMLInputElement;
    act(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
      }));
    });

    expect(document.activeElement).not.toBe(input);

    act(() => {
      root.unmount();
    });
  });

  it("uses workspace summaries instead of the full workspace list on the issues page", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableIsolatedWorkspaces: true });
    mockExecutionWorkspacesApi.listSummaries.mockResolvedValue([]);

    const { root } = renderWithQueryClient(
      <IssuesList
        issues={[createIssue()]}
        agents={[]}
        projects={[]}
        viewStateKey="paperclip:test-issues"
        onUpdateIssue={() => undefined}
      />,
      container,
    );

    await waitForAssertion(() => {
      expect(mockExecutionWorkspacesApi.listSummaries).toHaveBeenCalledWith("company-1");
      expect(mockExecutionWorkspacesApi.list).not.toHaveBeenCalled();
    });

    act(() => {
      root.unmount();
    });
  });

  // Run 3 review (Jul 8) reversed PAP-243's lg enlargement: task rows in the
  // list and inbox standardize on md (16px). The live list always supplies its
  // own `statusSlot` (the PAP-246 slot-override gotcha), so assert the real
  // slot size here.
  it("can hide date group separators from the persisted Columns option", async () => {
    const collectionKey = "paperclip:test-issues";
    localStorage.setItem(
      taskCollectionPreferencesStorageKey({
        companyId: "company-1",
        collectionKey,
      }),
      JSON.stringify({
        version: 1,
        companyId: "company-1",
        collectionKey,
        viewState: { showDateGroupSeparators: false },
        columns: ["status", "id", "updated"],
      }),
    );
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12);
    const threeDaysAgo = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 3, 12);

    const { root } = renderWithQueryClient(
      <IssuesList
        issues={[
          createIssue({ id: "issue-recent", title: "Just updated", updatedAt: today }),
          createIssue({ id: "issue-old", title: "Earlier task", updatedAt: threeDaysAgo }),
        ]}
        agents={[]}
        projects={[]}
        viewStateKey={collectionKey}
        rowPresentation="task"
        onUpdateIssue={() => undefined}
      />,
      container,
    );

    await waitForAssertion(() => {
      expect(container.textContent).toContain("Earlier task");
      expect(container.querySelector("[data-issues-date-separator]")).toBeNull();
    });

    act(() => {
      root.unmount();
    });
  });

});

describe("legacy issue age separators", () => {
  const now = new Date("2026-04-10T12:00:00.000Z").getTime();

  it("retains the rolling day and week boundaries used by the legacy list", () => {
    expect(issueAgeBucket(new Date(now - 60 * 60 * 1000), now)).toBe(0);
    expect(issueAgeBucket(new Date(now - 3 * 24 * 60 * 60 * 1000), now)).toBe(1);
    expect(issueAgeBucket(new Date(now - 10 * 24 * 60 * 60 * 1000), now)).toBe(2);
    expect(issueAgeSeparatorLabel(1)).toBe("Older than a day");
    expect(issueAgeSeparatorLabel(2)).toBe("Older than a week");
    expect(issueAgeBucketsCrossed(0, 2)).toEqual([1, 2]);
  });
});
