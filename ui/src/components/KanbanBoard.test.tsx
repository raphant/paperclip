// @vitest-environment jsdom

import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import type { Issue, IssueStatus } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getKanbanColumnTone, groupKanbanLanes, KanbanBoard, resolveKanbanTargetStatus } from "./KanbanBoard";

vi.mock("@/lib/router", () => ({
  Link: ({
    children,
    to,
    disableIssueQuicklook: _disableIssueQuicklook,
    ...props
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & {
    to: string;
    disableIssueQuicklook?: boolean;
  }) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const mountedRoots: Root[] = [];

function act(callback: () => void): void {
  flushSync(callback);
}

function createIssue(index: number, status: IssueStatus): Issue {
  return {
    id: `issue-${status}-${index}`,
    identifier: `PAP-${index}`,
    companyId: "company-1",
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title: `Issue ${index}`,
    description: null,
    status,
    workMode: "standard",
    priority: "medium",
    reviewPolicy: null,
    assigneeAgentId: index === 1 ? "agent-1" : null,
    assigneeUserId: null,
    responsibleUserId: null,
    createdByAgentId: null,
    createdByUserId: null,
    issueNumber: index,
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
    createdAt: new Date("2026-05-05T00:00:00.000Z"),
    updatedAt: new Date("2026-05-05T00:00:00.000Z"),
    labels: [],
    labelIds: [],
    myLastTouchAt: null,
    lastExternalCommentAt: null,
    lastActivityAt: null,
    isUnreadForMe: false,
  };
}

function createIssues(count: number, status: IssueStatus): Issue[] {
  return Array.from({ length: count }, (_, index) => createIssue(index + 1, status));
}

function renderBoard(
  props: Partial<React.ComponentProps<typeof KanbanBoard>> & { issues: Issue[] },
) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push(root);

  const render = (nextProps: Partial<React.ComponentProps<typeof KanbanBoard>> & { issues: Issue[] }) => {
    act(() => {
      root.render(
        <KanbanBoard
          agents={[{ id: "agent-1", name: "Codex" }]}
          liveIssueIds={new Set(["issue-todo-1"])}
          onUpdateIssue={vi.fn()}
          {...nextProps}
        />,
      );
    });
  };

  render(props);

  return { container, root, render };
}

describe("KanbanBoard", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  afterEach(() => {
    while (mountedRoots.length > 0) {
      const root = mountedRoots.pop();
      if (root) {
        act(() => root.unmount());
      }
    }
    document.body.innerHTML = "";
  });

  it("limits visible cards and reveals more cards per column", () => {
    const { container } = renderBoard({
      issues: createIssues(60, "todo"),
      compactCards: true,
      initialVisibleCount: 50,
      revealIncrement: 50,
    });

    expect(container.textContent).toContain("Showing 50 of 60");
    expect(container.textContent).toContain("Show 10 more");
    expect(container.textContent).toContain("Issue 50");
    expect(container.textContent).not.toContain("Issue 51");

    const showMoreButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Show 10 more"),
    );
    expect(showMoreButton).toBeTruthy();

    act(() => {
      showMoreButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.textContent).toContain("Issue 60");
    expect(container.textContent).not.toContain("Show 10 more");
  });

  it("resets visible counts when the column page size changes", () => {
    const issues = createIssues(60, "todo");
    const { container, render } = renderBoard({
      issues,
      initialVisibleCount: 50,
      revealIncrement: 50,
    });

    const showMoreButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Show 10 more"),
    );
    expect(showMoreButton).toBeTruthy();

    act(() => {
      showMoreButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.textContent).toContain("Issue 60");

    render({
      issues,
      initialVisibleCount: 10,
      revealIncrement: 10,
    });

    expect(container.textContent).toContain("Showing 10 of 60");
    expect(container.textContent).toContain("Show 10 more");
    expect(container.textContent).toContain("Issue 10");
    expect(container.textContent).not.toContain("Issue 11");
  });

  it("renders collapsed statuses as rails without cards", () => {
    const { container } = renderBoard({
      issues: createIssues(3, "done"),
      collapsedStatuses: ["done"],
      laneFold: { all: true, lanes: {} },
    });

    expect(container.textContent).toContain("Done3/3");
    expect(container.textContent).toContain("3 hidden");
    expect(container.textContent).not.toContain("Issue 1");
  });

  it("gives every column a status-hued tone", () => {
    expect(getKanbanColumnTone("backlog").body).toContain("bg-muted/30");
    expect(getKanbanColumnTone("todo").body).toContain("amber");
    expect(getKanbanColumnTone("in_progress").body).toContain("blue");
    expect(getKanbanColumnTone("in_review").body).toContain("violet");
    expect(getKanbanColumnTone("blocked").body).toContain("red");
    expect(getKanbanColumnTone("done").body).toContain("green");
    expect(getKanbanColumnTone("cancelled").body).toContain("bg-muted/25");
    expect(getKanbanColumnTone("cancelled").card).toContain("opacity-80");
  });

  it("keeps core issue signals in compact cards", () => {
    const { container } = renderBoard({
      issues: createIssues(1, "todo"),
      compactCards: true,
    });

    expect(container.textContent).toContain("PAP-1");
    expect(container.textContent).toContain("Issue 1");
    expect(container.textContent).toContain("Codex");
    expect(container.textContent).toContain("Live");
  });

  it("resolves drop targets from status rails and cards", () => {
    const issues = [
      createIssue(1, "todo"),
      createIssue(2, "blocked"),
    ];

    expect(resolveKanbanTargetStatus("done", issues)).toBe("done");
    expect(resolveKanbanTargetStatus("issue-blocked-2", issues)).toBe("blocked");
    expect(resolveKanbanTargetStatus("missing", issues)).toBeNull();
  });

  it("gives each open Board lane its own status headers with lane counts", () => {
    const parent = { ...createIssue(1, "in_progress"), title: "Parent task" };
    const child = (index: number, status: IssueStatus, parentId: string | null) =>
      ({ ...createIssue(index, status), parentId });
    const finished = { ...createIssue(9, "done"), title: "Finished parent" };
    const issues = [
      child(2, "todo", parent.id),
      child(3, "done", parent.id),
      child(4, "done", finished.id),
      parent,
      child(5, "blocked", null),
      finished,
    ];

    const { container } = renderBoard({ issues });
    const lane = (title: string) =>
      Array.from(container.querySelectorAll("section")).find((s) => s.textContent?.includes(title))!;
    expect(lane("Parent task").textContent).toContain("Backlog0/2");
    expect(lane("Parent task").textContent).toContain("Todo1/2");
    expect(lane("Parent task").textContent).toContain("Done1/2");
    expect(lane("No Parent").textContent).toContain("Blocked1/1");
    // The all-done lane is folded to one line, with no headers.
    expect(lane("Finished parent").textContent).not.toContain("Done1/1");
  });

  it("groups tasks into one lane per parent, then No Parent, and drops by lane cell", () => {
    const parent = { ...createIssue(1, "in_progress"), title: "Parent task" };
    const child = (index: number, status: IssueStatus, parentId: string | null) =>
      ({ ...createIssue(index, status), parentId });
    const finished = { ...createIssue(9, "done"), title: "Finished parent" };
    const issues = [
      child(2, "todo", parent.id),
      child(3, "done", parent.id),
      child(4, "done", finished.id),
      parent,
      child(5, "blocked", null),
      child(6, "backlog", null),
      finished,
    ];

    const lanes = groupKanbanLanes(issues);
    expect(lanes.map((lane) => [lane.parent?.title ?? "No Parent", lane.issues.map((i) => i.id)])).toEqual([
      ["Parent task", ["issue-todo-2", "issue-done-3"]],
      ["Finished parent", ["issue-done-4"]],
      ["No Parent", ["issue-blocked-5", "issue-backlog-6"]],
    ]);
    // Grid leaves out Backlog and Cancelled.
    expect(groupKanbanLanes(issues, ["todo", "in_progress", "in_review", "blocked", "done"]).at(-1)?.issues.map((i) => i.id))
      .toEqual(["issue-blocked-5"]);

    const { container } = renderBoard({ issues });
    expect(container.textContent).toContain("1/2 done");
    expect(container.textContent).toContain("No Parent");
    // The all-done lane folds to its header; its card is hidden.
    expect(container.textContent).toContain("Finished parent");
    expect(container.textContent).not.toContain("Issue 4");
    // Collapse all folds every lane; Expand all opens the all-done lane too.
    const { container: folded } = renderBoard({ issues, laneFold: { all: false, lanes: {} } });
    expect(folded.textContent).not.toContain("Issue 2");
    const { container: opened } = renderBoard({ issues, laneFold: { all: true, lanes: {} } });
    expect(opened.textContent).toContain("Issue 4");
    // Dropping a card on another lane's cell changes only its status.
    expect(resolveKanbanTargetStatus(`${parent.id}:in_review`, issues)).toBe("in_review");
    expect(resolveKanbanTargetStatus("no-parent:done", issues)).toBe("done");
  });
});
