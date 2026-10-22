import { useEffect, useMemo, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { appearanceForPalette, type AgentPaletteId } from "@paperclipai/shared";
import { CommandCenterView, type Cam } from "../../src/components/command-center/CommandCenterView";
import type { Handoff } from "../../src/components/command-center/handoff";
import type { CcLine, CcTask, CommandCenterData } from "../../src/components/command-center/model";

/*
 * WPO-77 picked design: "Command center", G3 · Players, built in WPO-84.
 * The real page (pages/CommandCenter.tsx) and this story render the same CommandCenterView;
 * here it gets fake data (3 parents, 10 children, 3 live runs, one decision waiting on the board).
 * The hand-off plays once, 6 s after load: the Researcher finishes SEL-781 and the Simplifier starts SEL-782.
 */

const agent = (id: string, name: string, palette: AgentPaletteId) => ({ id, name, appearance: appearanceForPalette(palette) });
const AGENTS = [
  agent("lead", "Tech Lead", "arctic-blue"),
  agent("engineer", "Engineer", "coral-mint"),
  agent("tester", "Runtime Tester", "pink-lemonade"),
  agent("researcher", "Researcher", "ultraviolet-tide"),
  agent("simplifier", "Simplifier", "flamingo-jade"),
];

const T0 = Date.now();
const ago = (min: number) => new Date(T0 - min * 60_000).toISOString();
const task = (id: string, title: string, status: string, assignee: string, parentId: string | null = null, extra: Partial<CcTask> = {}): CcTask =>
  ({ id, identifier: id, title, status, parentId, blockedById: null, assigneeAgentId: assignee, completedAt: null, ...extra });

const TASKS: CcTask[] = [
  task("SEL-757", "Runner v2: deliver graph arrangement and navigation (roadmap 19.2)", "in_progress", "lead"),
  task("SEL-609", "FP-41034: dev loss (D20) and runbook links", "in_progress", "lead"),
  task("SEL-779", "FP-41102: price feed retries flood the alert channel", "in_progress", "lead"),
  task("SEL-766", "Build tasks.graph-dashboard.012 on SEL-757-graph-012", "in_progress", "engineer", "SEL-757"),
  task("SEL-768", "Criteria check tasks.graph-dashboard.012", "blocked", "tester", "SEL-757", { blockedById: "SEL-766" }),
  task("SEL-733", "FP-41034 part 2: D1-D19 on test once FP-40582 is merged", "in_progress", "lead", "SEL-609"),
  task("SEL-666", "Runtime check: FP-41034 dev loss (D20)", "done", "tester", "SEL-609", { completedAt: ago(27) }),
  task("SEL-664", "Research: FP-41034 dev loss and runbook links", "done", "researcher", "SEL-609", { completedAt: ago(111) }),
  task("SEL-615", "Build: FP-41034", "done", "engineer", "SEL-609", { completedAt: ago(62) }),
  task("SEL-614", "Review plan: FP-41034", "done", "simplifier", "SEL-609", { completedAt: ago(160) }),
  task("SEL-781", "Research: where the price feed retries come from", "in_progress", "researcher", "SEL-779"),
  task("SEL-782", "Review plan: FP-41102", "todo", "simplifier", "SEL-779", { blockedById: "SEL-781" }),
  task("SEL-783", "Build: FP-41102 retry backoff", "todo", "engineer", "SEL-779", { blockedById: "SEL-782" }),
];

const lines = (...l: [CcLine["kind"], string][]): CcLine[] => l.map(([kind, text]) => ({ kind, text }));
const RUNS = [
  { id: "r1", agentId: "engineer", issueId: "SEL-766", startedAt: ago(23), lines: lines(
    ["thought", "Start from the criteria in tasks.graph-dashboard.012."], ["tool", "Read docs/tasks/graph-dashboard.012.md"],
    ["tool", "Bash git checkout -b SEL-757-graph-012"], ["out", "Switched to a new branch 'SEL-757-graph-012'"],
    ["thought", "011 already sorts by depth; 012 can reuse layoutGraph() and add focus."], ["tool", "Edit ui/src/graph/layout.ts  +12 −3"],
    ["tool", "Bash cd ui && npx vitest run src/graph"], ["out", "✓ 22 passed (3.4 s)"]) },
  { id: "r2", agentId: "lead", issueId: "SEL-733", startedAt: ago(8), lines: lines(
    ["thought", "SEL-733 waits on FP-40582. Check whether it reached test."], ["tool", "jira get FP-40582"],
    ["out", "Status: Deployed to test · 14:10 CST"], ["thought", "Split D1-D19 into one child for the Runtime Tester."]) },
  { id: "r3", agentId: "researcher", issueId: "SEL-781", startedAt: ago(4), lines: lines(
    ["tool", "Grep \"retry\" services/price-feed"], ["out", "14 matches in 5 files"],
    ["thought", "RetryPolicy has no jitter: every pod retries on the same second."]) },
];
const WAITING = [{ issueId: "SEL-768", askedAt: ago(12), question: "Run the criteria check on test now, or wait for tonight's deploy of SEL-757-graph-012?" }];

const BEFORE: CommandCenterData = { tasks: TASKS, agents: AGENTS, runs: RUNS, waiting: WAITING };
const AFTER: CommandCenterData = {
  ...BEFORE,
  tasks: TASKS.map((t) => (t.id === "SEL-781" ? { ...t, status: "done", completedAt: new Date(T0 + 6000).toISOString() } : t.id === "SEL-782" ? { ...t, status: "in_progress" } : t)),
  runs: [...RUNS.filter((r) => r.id !== "r3"), { id: "r4", agentId: "simplifier", issueId: "SEL-782", startedAt: new Date(T0 + 6000).toISOString(), lines: lines(["tool", "GET /api/issues/SEL-781/comments"]) }],
};
const HANDOFF_AT = 6000;

function Demo({ start }: { start?: Cam }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const handedOff = now - T0 >= HANDOFF_AT;
  const handoff = useMemo<Handoff | null>(() => (handedOff ? { at: T0 + HANDOFF_AT, fromAgentId: "researcher", fromIssueId: "SEL-781", toAgentId: "simplifier", toIssueId: "SEL-782" } : null), [handedOff]);
  return <div className="h-screen"><CommandCenterView data={handedOff ? AFTER : BEFORE} now={now} handoff={handoff} start={start} /></div>;
}

const meta = {
  title: "Design/WPO-77 Command center",
  parameters: {
    layout: "fullscreen",
    docs: { description: { component: "The Command center page (G3 · Players) with fake data. Same component as /command-center." } },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const PlayersMock: Story = { name: "G3 · Players", render: () => <Demo /> };
export const PlayersTasks: Story = { name: "G3 · Players · tasks", render: () => <Demo start={{ x: 700, y: 400, s: 2 }} /> };
export const PlayersEmpty: Story = { name: "G3 · Players · empty", render: () => <div className="h-screen"><CommandCenterView data={{ tasks: [], agents: AGENTS, runs: [], waiting: [] }} now={Date.now()} handoff={null} /></div> };
