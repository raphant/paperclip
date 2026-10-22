import { useEffect, useRef, useState, type ReactNode } from "react";
import { Minus, Plus } from "lucide-react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { appearanceForPalette, type AgentPaletteId, type CharacterState } from "@paperclipai/shared";
import { AgentAvatar } from "../../src/components/AgentAvatar";
import { StatusIcon } from "../../src/components/StatusIcon";
import { Button } from "../../src/components/ui/button";
import { cn } from "../../src/lib/utils";

/*
 * WPO-77 picked design: "Command center", a page to leave open while agents work.
 * G3 · Players: a zoom map of every task (Overview, Tasks, Close-up) where agents are tokens that stand on
 * the task they work on, sit in Idle when they have no run, and walk when work is handed off.
 * Fake data (3 parents, 10 children, 3 live runs, one decision waiting on the board).
 * Mock only: no API calls, nothing is saved.
 */

// ---------------------------------------------------------------- fake data

type AgentKey = "lead" | "engineer" | "tester" | "researcher" | "simplifier";
type MockAgent = { key: AgentKey; name: string; palette: AgentPaletteId; color: string };

const AGENTS: Record<AgentKey, MockAgent> = {
  lead: { key: "lead", name: "Tech Lead", palette: "arctic-blue", color: "#38bdf8" },
  engineer: { key: "engineer", name: "Engineer", palette: "coral-mint", color: "#34d399" },
  tester: { key: "tester", name: "Runtime Tester", palette: "pink-lemonade", color: "#f472b6" },
  researcher: { key: "researcher", name: "Researcher", palette: "ultraviolet-tide", color: "#818cf8" },
  simplifier: { key: "simplifier", name: "Simplifier", palette: "flamingo-jade", color: "#fb923c" },
};

type MockIssue = {
  id: string;
  title: string;
  status: "todo" | "in_progress" | "blocked" | "done";
  agent: AgentKey;
  parent?: string;
  blockedBy?: string[];
  doneAt?: string;
};

const ISSUES: MockIssue[] = [
  { id: "SEL-757", title: "Runner v2: deliver graph arrangement and navigation (roadmap 19.2)", status: "in_progress", agent: "lead" },
  { id: "SEL-609", title: "FP-41034: dev loss (D20) and runbook links", status: "in_progress", agent: "lead" },
  { id: "SEL-779", title: "FP-41102: price feed retries flood the alert channel", status: "in_progress", agent: "lead" },
  { id: "SEL-766", title: "Build tasks.graph-dashboard.012 on SEL-757-graph-012", status: "in_progress", agent: "engineer", parent: "SEL-757" },
  { id: "SEL-768", title: "Criteria check tasks.graph-dashboard.012", status: "blocked", agent: "tester", parent: "SEL-757" },
  { id: "SEL-733", title: "FP-41034 part 2: D1-D19 on test once FP-40582 is merged", status: "in_progress", agent: "lead", parent: "SEL-609" },
  { id: "SEL-666", title: "Runtime check: FP-41034 dev loss (D20)", status: "done", agent: "tester", parent: "SEL-609", doneAt: "14:05" },
  { id: "SEL-664", title: "Research: FP-41034 dev loss and runbook links", status: "done", agent: "researcher", parent: "SEL-609", doneAt: "12:41" },
  { id: "SEL-615", title: "Build: FP-41034", status: "done", agent: "engineer", parent: "SEL-609", doneAt: "13:30" },
  { id: "SEL-614", title: "Review plan: FP-41034", status: "done", agent: "simplifier", parent: "SEL-609", doneAt: "11:52" },
  { id: "SEL-781", title: "Research: where the price feed retries come from", status: "in_progress", agent: "researcher", parent: "SEL-779" },
  { id: "SEL-782", title: "Review plan: FP-41102", status: "todo", agent: "simplifier", parent: "SEL-779", blockedBy: ["SEL-781"] },
  { id: "SEL-783", title: "Build: FP-41102 retry backoff", status: "todo", agent: "engineer", parent: "SEL-779", blockedBy: ["SEL-782"] },
];
const issue = (id: string) => ISSUES.find((i) => i.id === id)!;

type Line = { kind: "thought" | "tool" | "out"; text: string };
type LiveRun = { agent: AgentKey; issueId: string; startedMin: number; lines: Line[] };

/** "Now" is 14:32 CST. startedMin = minutes ago the run started. */
const LIVE_RUNS: LiveRun[] = [
  {
    agent: "engineer", issueId: "SEL-766", startedMin: 23,
    lines: [
      { kind: "thought", text: "Start from the criteria in tasks.graph-dashboard.012." },
      { kind: "tool", text: "Read docs/tasks/graph-dashboard.012.md" },
      { kind: "thought", text: "Three criteria: arranged by depth, arrow-key navigation, a focus ring on the active node." },
      { kind: "tool", text: "Bash git checkout -b SEL-757-graph-012" },
      { kind: "out", text: "Switched to a new branch 'SEL-757-graph-012'" },
      { kind: "tool", text: "Grep \"layoutGraph\" ui/src" },
      { kind: "out", text: "3 matches in 2 files" },
      { kind: "tool", text: "Read ui/src/graph/GraphDashboard011.tsx" },
      { kind: "thought", text: "011 already sorts by depth; 012 can reuse layoutGraph() and add focus." },
      { kind: "tool", text: "Edit ui/src/graph/layout.ts  +12 −3" },
      { kind: "tool", text: "Bash cd ui && npx tsc --noEmit" },
      { kind: "out", text: "no errors" },
      { kind: "thought", text: "The dashboard needs the node order from layout.ts before it can render." },
      { kind: "tool", text: "Read ui/src/graph/layout.ts" },
      { kind: "tool", text: "Bash cd ui && npx vitest run src/graph/layout.test.ts" },
      { kind: "out", text: "✓ 14 passed (1.9 s)" },
      { kind: "tool", text: "Edit ui/src/graph/GraphDashboard012.tsx  +48 −6" },
      { kind: "thought", text: "Now keyboard navigation: arrow keys move focus between sibling nodes." },
      { kind: "tool", text: "Edit ui/src/graph/useGraphFocus.ts  +31" },
      { kind: "tool", text: "Bash cd ui && npx vitest run src/graph" },
      { kind: "out", text: "✓ 22 passed (3.4 s)" },
    ],
  },
  {
    agent: "lead", issueId: "SEL-733", startedMin: 8,
    lines: [
      { kind: "thought", text: "SEL-733 waits on FP-40582. Check whether it reached test." },
      { kind: "tool", text: "GET /api/issues/SEL-733/comments" },
      { kind: "out", text: "3 comments · last from Runtime Tester at 13:58 CST" },
      { kind: "thought", text: "The tester wants D1-D19 as one check, not nineteen." },
      { kind: "tool", text: "jira get FP-40582" },
      { kind: "out", text: "Status: Deployed to test · 14:10 CST" },
      { kind: "thought", text: "FP-40582 is on test. D1-D19 can run now." },
      { kind: "tool", text: "Read docs-okf/fuels/fp-41034/criteria.md" },
      { kind: "thought", text: "Split D1-D19 into one child for the Runtime Tester." },
      { kind: "tool", text: "POST /api/companies/…/issues  \"Runtime check: FP-41034 D1-D19\"" },
    ],
  },
  {
    agent: "researcher", issueId: "SEL-781", startedMin: 4,
    lines: [
      { kind: "tool", text: "Grep \"retry\" services/price-feed" },
      { kind: "out", text: "14 matches in 5 files" },
      { kind: "tool", text: "Read services/price-feed/src/RetryPolicy.java" },
      { kind: "thought", text: "RetryPolicy has no jitter: every pod retries on the same second." },
      { kind: "tool", text: "newrelic query  FACET host SINCE 3 hours ago" },
    ],
  },
];

const WAITING = {
  agent: "tester" as AgentKey,
  issueId: "SEL-768",
  askedMin: 12,
  question: "Run the criteria check on test now, or wait for tonight's deploy of SEL-757-graph-012?",
  options: ["Run on test now", "Wait for the deploy"],
};

const DONE_TODAY = ISSUES.filter((i) => i.status === "done").sort((a, b) => (b.doneAt! > a.doneAt! ? 1 : -1));

/** Totals per issue across all its runs: what a card can show without opening the issue. */
const STATS: Record<string, { runs: number; cost: number; comments: number }> = {
  "SEL-757": { runs: 4, cost: 3.12, comments: 9 }, "SEL-609": { runs: 6, cost: 2.4, comments: 14 }, "SEL-779": { runs: 2, cost: 0.61, comments: 3 },
  "SEL-766": { runs: 2, cost: 1.84, comments: 4 }, "SEL-768": { runs: 1, cost: 0.22, comments: 2 },
  "SEL-733": { runs: 1, cost: 0.31, comments: 1 }, "SEL-666": { runs: 1, cost: 0.58, comments: 3 }, "SEL-664": { runs: 1, cost: 0.92, comments: 2 },
  "SEL-615": { runs: 2, cost: 2.05, comments: 5 }, "SEL-614": { runs: 1, cost: 0.27, comments: 2 },
  "SEL-781": { runs: 1, cost: 0.14, comments: 0 }, "SEL-782": { runs: 0, cost: 0, comments: 0 }, "SEL-783": { runs: 0, cost: 0, comments: 0 },
};
const statLine = (id: string) => { const s = STATS[id]; return `${s.runs} run${s.runs === 1 ? "" : "s"} · $${s.cost.toFixed(2)} · ${s.comments} comment${s.comments === 1 ? "" : "s"}`; };
const children = (id: string) => ISSUES.filter((i) => i.parent === id);

/** The live events bus as a log, newest first. Times are CST. */
type FeedEvent = { at: string; agent: AgentKey; issueId: string; text: string; kind: "start" | "done" | "comment" | "ask" | "create" | "blocked" };
const EVENTS: FeedEvent[] = [
  { at: "14:31", agent: "lead", issueId: "SEL-609", kind: "create", text: "created SEL-784 Runtime check: FP-41034 D1-D19" },
  { at: "14:28", agent: "researcher", issueId: "SEL-781", kind: "start", text: "started a run" },
  { at: "14:24", agent: "lead", issueId: "SEL-733", kind: "start", text: "started a run" },
  { at: "14:20", agent: "tester", issueId: "SEL-768", kind: "ask", text: "asks you: run on test now, or wait for the deploy?" },
  { at: "14:19", agent: "tester", issueId: "SEL-768", kind: "blocked", text: "blocked by SEL-766" },
  { at: "14:09", agent: "engineer", issueId: "SEL-766", kind: "start", text: "started a run" },
  { at: "14:05", agent: "tester", issueId: "SEL-666", kind: "done", text: "done · 6 of 6 criteria pass" },
  { at: "14:02", agent: "lead", issueId: "SEL-779", kind: "comment", text: "commented: \"Split into research, review, build.\"" },
  { at: "13:30", agent: "engineer", issueId: "SEL-615", kind: "done", text: "done · PR #412 merged" },
  { at: "12:41", agent: "researcher", issueId: "SEL-664", kind: "done", text: "done · root cause in DevLossJob" },
  { at: "11:52", agent: "simplifier", issueId: "SEL-614", kind: "done", text: "done · plan approved" },
];
const EVENT_COLOR: Record<FeedEvent["kind"], string> = { start: "#3b82f6", done: "#34d399", comment: "#a1a1aa", ask: "#fbbf24", create: "#38bdf8", blocked: "#f87171" };

// ---------------------------------------------------------------- shared bits

/** Ticks once a second, so timers count and transcripts grow while you watch. */
function useTick() {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);
  return tick;
}

function elapsed(startedMin: number, tick: number) {
  const s = startedMin * 60 + 17 + tick;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Shows all lines but the last two at first, then reveals one more every 3 s. */
function visibleLines(lines: Line[], tick: number) {
  return lines.slice(0, Math.min(lines.length, lines.length - 2 + Math.floor(tick / 3)));
}

function Avatar({ agent, size = 24, pose = "rest", muted }: { agent: AgentKey; size?: 16 | 20 | 24 | 32 | 40 | 48 | 64 | 96; pose?: CharacterState; muted?: boolean }) {
  const a = AGENTS[agent];
  return <AgentAvatar appearance={appearanceForPalette(a.palette)} name={a.name} size={size} pose={pose} muted={muted} />;
}

function LiveDot({ color = "#3b82f6" }: { color?: string }) {
  return (
    <span className="relative inline-flex size-2">
      <span className="absolute inline-flex size-full animate-ping rounded-full opacity-75" style={{ background: color }} />
      <span className="relative inline-flex size-2 rounded-full" style={{ background: color }} />
    </span>
  );
}

function TranscriptLine({ line, last }: { line: Line; last?: boolean }) {
  return (
    <div className={cn("flex gap-2 font-mono text-[12px] leading-5", line.kind === "thought" ? "text-foreground/80 italic" : line.kind === "out" ? "text-emerald-400/90" : "text-sky-300/90")}>
      <span className="w-3 shrink-0 text-muted-foreground">{line.kind === "tool" ? "›" : line.kind === "out" ? "←" : "…"}</span>
      <span className="truncate">{line.text}{last && <span className="ml-0.5 inline-block h-3.5 w-1.5 translate-y-0.5 animate-pulse bg-foreground/70" />}</span>
    </div>
  );
}

function PageHeader({ right }: { right?: ReactNode }) {
  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b border-border px-6">
      <div className="flex items-center gap-4">
        <h1 className="text-sm font-semibold uppercase tracking-wider">Command center</h1>
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5"><LiveDot /> 3 live</span>
          <span className="flex items-center gap-1.5 text-amber-400"><span className="size-2 rounded-full bg-amber-400" /> 1 needs you</span>
          <span>{DONE_TODAY.length} done today</span>
        </div>
      </div>
      <div className="flex items-center gap-3">
        {right}
        <span className="font-mono text-xs text-muted-foreground">14:32 CST</span>
      </div>
    </header>
  );
}

function EventRow({ e }: { e: FeedEvent }) {
  return (
    <div className="flex items-center gap-2 text-[12px] leading-6">
      <span className="w-10 shrink-0 font-mono text-muted-foreground">{e.at}</span>
      <span className="size-1.5 shrink-0 rounded-full" style={{ background: EVENT_COLOR[e.kind] }} />
      <Avatar agent={e.agent} size={16} />
      <span className="shrink-0 font-mono text-foreground/80">{e.issueId}</span>
      <span className={cn("truncate", e.kind === "ask" ? "text-amber-400" : "text-muted-foreground")}>{e.text}</span>
    </div>
  );
}

/** Done children / all children, as a thin bar. */
function Progress({ id }: { id: string }) {
  const kids = children(id);
  const done = kids.filter((k) => k.status === "done").length;
  return (
    <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
      <div className="h-1 flex-1 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-emerald-400/80" style={{ width: `${(done / kids.length) * 100}%` }} /></div>
      <span className="font-mono">{done}/{kids.length}</span>
    </div>
  );
}

// ---------------------------------------------------------------- close-up and mini map

/** Everything one task shows up close: who works on it, for how long, and what it does now. */
function TaskDetail({ id, tick, big }: { id: string; tick: number; big?: boolean }) {
  const i = issue(id);
  const a = AGENTS[i.agent];
  const run = LIVE_RUNS.find((r) => r.issueId === id);
  const waiting = id === WAITING.issueId;
  const kids = children(id);
  const blocks = ISSUES.filter((x) => x.blockedBy?.includes(id) || (id === "SEL-766" && x.id === "SEL-768"));
  const events = EVENTS.filter((e) => e.issueId === id || issue(e.issueId).parent === id);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className={cn("flex items-start gap-4 border-b border-border", big ? "p-6" : "p-4")}>
        {kids.length > 0
          ? <span className="flex size-16 shrink-0 items-center justify-center rounded-full border-2 border-zinc-400 font-mono text-sm font-semibold">{i.id.slice(4)}</span>
          : <Avatar agent={i.agent} size={big ? 96 : 64} pose={run ? "working" : waiting ? "listening" : i.status === "done" ? "rest" : "sleepy"} muted={i.status === "done"} />}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="flex shrink-0 items-center gap-2 whitespace-nowrap"><StatusIcon status={i.status} size="sm" showLabel /><span className="font-mono">{i.id}</span></span>
            {i.parent && <span className="truncate">· in <span className="font-mono">{i.parent}</span> {issue(i.parent).title}</span>}
          </div>
          <div className={cn("mt-1 font-semibold leading-snug", big ? "text-xl" : "text-base")}>{i.title}</div>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5 text-foreground">{a.name}{run && <LiveDot color={a.color} />}</span>
            <span className="tabular-nums">{statLine(id)}</span>
            {blocks.length > 0 && <span className="text-red-400">blocks {blocks.map((b) => b.id).join(", ")}</span>}
            {i.blockedBy && <span className="text-red-400">blocked by {i.blockedBy.join(", ")}</span>}
          </div>
        </div>
        {run && (
          <div className="shrink-0 text-right">
            <div className="text-[11px] uppercase tracking-wider text-muted-foreground">Live</div>
            <div className={cn("font-mono tabular-nums", big ? "text-4xl" : "text-2xl")} style={{ color: a.color }}>{elapsed(run.startedMin, tick)}</div>
          </div>
        )}
      </div>
      {run ? (
        <div className={cn("flex min-h-0 flex-1 flex-col justify-end gap-0.5 overflow-hidden bg-black/30", big ? "px-6 py-4" : "px-4 py-3")}>
          {visibleLines(run.lines, tick).map((l, n, arr) => <TranscriptLine key={n} line={l} last={n === arr.length - 1} />)}
        </div>
      ) : waiting ? (
        <div className={cn("flex min-h-0 flex-1 flex-col gap-4", big ? "p-6" : "p-4")}>
          <div className="rounded-lg border border-amber-400/70 bg-amber-400/10 p-4 shadow-[0_0_32px_rgba(251,191,36,0.25)]">
            <div className="flex items-center gap-2 text-xs"><span className="font-semibold uppercase tracking-wider text-amber-400">Needs you</span><span className="text-muted-foreground">waiting {WAITING.askedMin}m</span></div>
            <div className={cn("mt-1.5", big ? "text-lg" : "text-sm")}>{WAITING.question}</div>
            <div className="mt-3 flex gap-2">{WAITING.options.map((o, n) => <Button key={o} variant={n === 0 ? "default" : "outline"}>{o}</Button>)}</div>
          </div>
          <div>{events.map((e) => <EventRow key={e.at + e.issueId} e={e} />)}</div>
        </div>
      ) : kids.length > 0 ? (
        <div className={cn("flex min-h-0 flex-1 flex-col gap-3 overflow-hidden", big ? "p-6" : "p-4")}>
          <Progress id={id} />
          <div className="divide-y divide-border rounded-md border border-border">
            {kids.map((k) => {
              const kr = LIVE_RUNS.find((r) => r.issueId === k.id);
              return (
                <div key={k.id} className={cn("flex items-center gap-2 px-3 py-1.5 text-[12px]", k.status === "done" && "text-muted-foreground")}>
                  <StatusIcon status={k.status} size="sm" /><span className="font-mono">{k.id}</span><span className="truncate">{k.title}</span>
                  <span className="ml-auto flex shrink-0 items-center gap-1.5"><Avatar agent={k.agent} size={16} muted={k.status === "done"} />{kr && <LiveDot color={AGENTS[k.agent].color} />}{k.id === WAITING.issueId && <span className="text-amber-400">Needs you</span>}</span>
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <div className={cn("flex min-h-0 flex-1 flex-col gap-2", big ? "p-6" : "p-4")}>
          {events.length ? events.map((e) => <EventRow key={e.at + e.issueId} e={e} />)
            : <div className="text-sm text-muted-foreground">No activity yet. It starts when {i.blockedBy?.join(", ")} is done.</div>}
        </div>
      )}
    </div>
  );
}

/** Every task as a dot; the current one ringed. `view` draws the camera's frame. Click to go there. */
function MiniMap({ pos, w, h, current, view, onPick, label }: {
  pos: Record<string, [number, number]>; w: number; h: number; current?: string;
  view?: { x: number; y: number; w: number; h: number }; onPick: (x: number, y: number) => void; label: string;
}) {
  const live = new Set(LIVE_RUNS.map((r) => r.issueId));
  return (
    <button aria-label={label} className="block rounded-md border border-border bg-background/80 p-1 backdrop-blur focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); onPick(((e.clientX - r.left - 4) / (r.width - 8)) * w, ((e.clientY - r.top - 4) / (r.height - 8)) * h); }}>
      <svg viewBox={`0 0 ${w} ${h}`} className="block h-[120px] w-[204px]">
        {ISSUES.filter((i) => i.parent).map((i) => <line key={i.id} x1={pos[i.parent!][0]} y1={pos[i.parent!][1]} x2={pos[i.id][0]} y2={pos[i.id][1]} stroke="#52525b" strokeWidth={w / 300} />)}
        {ISSUES.map((i) => {
          const [x, y] = pos[i.id];
          const c = i.id === WAITING.issueId ? "#fbbf24" : live.has(i.id) ? AGENTS[i.agent].color : i.status === "done" ? "#3f3f46" : "#a1a1aa";
          return <circle key={i.id} cx={x} cy={y} r={(i.parent ? 14 : 22) * (w / 1440)} fill={c} stroke={current === i.id ? "#fafafa" : "none"} strokeWidth={w / 240} />;
        })}
        {view && <rect x={view.x} y={view.y} width={view.w} height={view.h} fill="#fafafa10" stroke="#fafafa" strokeWidth={w / 360} rx={w / 150} />}
      </svg>
    </button>
  );
}

function useKeys(onKey: (e: KeyboardEvent) => void) {
  useEffect(() => {
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
}

const Kbd = ({ children: k }: { children: ReactNode }) => <kbd className="rounded border border-border bg-muted px-1 font-mono text-[10px] text-muted-foreground">{k}</kbd>;

// ---------------------------------------------------------------- G3: Zoom map with players
//
// A free camera over every task; detail grows as you zoom. Agents are tokens that stand on the task they
// work on and walk when work is handed off.

/** Where each task sits in the world. At zoom 1 the whole world fits a 1440 x 844 view. */
const WORLD: Record<string, [number, number]> = {
  "SEL-757": [250, 190], "SEL-766": [170, 420], "SEL-768": [390, 580],
  "SEL-609": [730, 190], "SEL-733": [730, 420], "SEL-614": [560, 70], "SEL-615": [900, 70], "SEL-664": [540, 310], "SEL-666": [920, 310],
  "SEL-779": [1180, 300], "SEL-781": [1050, 500], "SEL-782": [1220, 540], "SEL-783": [1360, 640],
};
type Cam = { x: number; y: number; s: number };
const FIT: Cam = { x: 720, y: 422, s: 1 };
const LEVELS = [{ name: "Overview", s: 1 }, { name: "Tasks", s: 2 }, { name: "Close-up", s: 3.6 }];
const levelOf = (s: number) => (s < 1.6 ? 0 : s < 3 ? 1 : 2);
const clampCam = (c: Cam): Cam => ({ s: Math.min(4.5, Math.max(0.6, c.s)), x: Math.min(1440, Math.max(0, c.x)), y: Math.min(844, Math.max(0, c.y)) });
const WATCHED = [WAITING.issueId, ...LIVE_RUNS.map((r) => r.issueId)];

/** The Idle bench, a place on the map where agents with no run sit. */
const BENCH = { x: 1250, y: 24, w: 160, h: 110 };
const BENCH_SEAT: [number, number] = [BENCH.x + BENCH.w / 2, BENCH.y + 70];
/** Where each agent stands, before and after the mock's one hand-off (Researcher done, Simplifier starts). */
const spotOf = (agent: AgentKey, handedOff: boolean): string | null => ({
  engineer: "SEL-766", lead: "SEL-733", tester: "SEL-768",
  researcher: handedOff ? null : "SEL-781",
  simplifier: handedOff ? "SEL-782" : null,
})[agent];
const HANDOFF_AT = 6;

function useSize(ref: React.RefObject<HTMLDivElement | null>) {
  const [size, setSize] = useState({ w: 1440, h: 844 });
  useEffect(() => {
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }));
    if (ref.current) ro.observe(ref.current);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

/** The bird's-eye form of a task. No avatar: agents are drawn as their own tokens. */
function DotNode({ id, dim, status, live: liveAs }: { id: string; dim?: boolean; status?: MockIssue["status"]; live?: boolean }) {
  const i = issue(id);
  const st = status ?? i.status;
  const live = liveAs ?? LIVE_RUNS.some((r) => r.issueId === id);
  const waiting = id === WAITING.issueId;
  const done = st === "done";
  const color = AGENTS[spotAgent(id) ?? i.agent].color;
  const size = !i.parent ? 64 : live || waiting ? 52 : 36;
  return (
    <span className={cn("relative flex flex-col items-center", dim && "opacity-50")}>
      <span className={cn("relative flex items-center justify-center rounded-full border-2 bg-card", done && "opacity-35")}
        style={{ width: size, height: size, borderColor: waiting ? "#fbbf24" : live ? color : !i.parent ? "#a1a1aa" : "#3f3f46", boxShadow: live ? `0 0 28px ${color}66` : waiting ? "0 0 36px rgba(251,191,36,0.55)" : undefined }}>
        {(live || waiting) && <span className="absolute inset-[-8px] animate-ping rounded-full border-2" style={{ borderColor: waiting ? "#fbbf24" : color, animationDuration: waiting ? "1.2s" : "2.4s" }} />}
        {!i.parent ? <span className="font-mono text-[11px] font-semibold">{i.id.slice(4)}</span>
          : <StatusIcon status={st} />}
      </span>
      {/* The label hangs below the dot, so the dot itself sits on the task's point and lines meet its middle. */}
      <span className="absolute top-full left-1/2 flex w-[180px] -translate-x-1/2 flex-col items-center">
        <span className={cn("mt-1.5 text-center text-[11px] leading-tight", done ? "text-muted-foreground/50" : !i.parent ? "font-semibold" : "text-foreground/85")}>
          <span className="font-mono">{i.id}</span>{!i.parent || live ? <><br />{i.title.length > 44 ? i.title.slice(0, 42) + "…" : i.title}</> : null}
        </span>
        {waiting && <span className="mt-1 rounded-full bg-amber-400 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-black">Needs you</span>}
      </span>
    </span>
  );
}
/** The hand-off moves the Simplifier onto SEL-782. */
const spotAgent = (id: string): AgentKey | undefined => (id === "SEL-782" ? "simplifier" : undefined);

/** The middle zoom: a small card with the one line that matters most. No avatar, as in DotNode. */
function MidCard({ id, tick }: { id: string; tick: number }) {
  const i = issue(id);
  const a = AGENTS[i.agent];
  const run = LIVE_RUNS.find((r) => r.issueId === id);
  if (!i.parent) return (
    <span className="block w-[270px] rounded-lg border border-zinc-500/60 bg-card px-3 py-2 text-left">
      <span className="flex items-center gap-2 text-[11px] text-muted-foreground"><StatusIcon status={i.status} size="sm" /><span className="font-mono">{i.id}</span><span className="ml-auto tabular-nums">{statLine(id)}</span></span>
      <span className="mt-0.5 line-clamp-2 text-sm font-semibold">{i.title}</span>
      <span className="mt-1.5 block"><Progress id={id} /></span>
    </span>
  );
  if (run) {
    const lines = visibleLines(run.lines, tick);
    return (
      <span className="block w-[290px] overflow-hidden rounded-lg border bg-card text-left" style={{ borderColor: a.color, boxShadow: `0 0 28px ${a.color}40` }}>
        <span className="flex items-center gap-2 px-3 pt-2"><span className="text-xs font-medium">{a.name}</span><LiveDot color={a.color} /><span className="ml-auto font-mono text-sm tabular-nums" style={{ color: a.color }}>{elapsed(run.startedMin, tick)}</span></span>
        <span className="block truncate px-3 text-[12px]"><span className="font-mono text-muted-foreground">{i.id}</span> {i.title}</span>
        <span className="mt-1.5 block bg-black/30 px-3 py-1"><TranscriptLine line={lines[lines.length - 1]} last /></span>
      </span>
    );
  }
  if (id === WAITING.issueId) return (
    <span className="block w-[290px] rounded-lg border border-amber-400/70 bg-[#2a2210] px-3 py-2 text-left shadow-[0_0_32px_rgba(251,191,36,0.35)]">
      <span className="flex items-center gap-2 text-[11px]"><span className="font-semibold uppercase tracking-wider text-amber-400">Needs you</span><span className="text-muted-foreground">{i.id} · {WAITING.askedMin}m</span></span>
      <span className="mt-1 line-clamp-2 text-[12px]">{WAITING.question}</span>
    </span>
  );
  return (
    <span className={cn("block w-[230px] rounded-md border border-border bg-card px-3 py-1.5 text-left", i.status === "done" && "opacity-60")}>
      <span className="flex items-center gap-2 text-[11px] text-muted-foreground"><StatusIcon status={i.status} size="sm" /><span className="font-mono">{i.id}</span>{i.doneAt && <span className="ml-auto font-mono">{i.doneAt}</span>}</span>
      <span className="mt-0.5 line-clamp-2 text-[12px]">{i.title}</span>
      {i.blockedBy && <span className="block text-[11px] text-red-400">blocked by {i.blockedBy.join(", ")}</span>}
    </span>
  );
}

/** The middle zoom for the two tasks the hand-off changes. */
function HandoffCard({ id, tick }: { id: string; tick: number }) {
  const i = issue(id);
  if (id === "SEL-781") return (
    <span className="block w-[230px] rounded-md border border-border bg-card px-3 py-1.5 text-left opacity-60">
      <span className="flex items-center gap-2 text-[11px] text-muted-foreground"><StatusIcon status="done" size="sm" /><span className="font-mono">{i.id}</span><span className="ml-auto font-mono">14:33</span></span>
      <span className="mt-0.5 line-clamp-2 text-[12px]">{i.title}</span>
    </span>
  );
  const a = AGENTS.simplifier;
  return (
    <span className="block w-[290px] overflow-hidden rounded-lg border bg-card text-left" style={{ borderColor: a.color, boxShadow: `0 0 28px ${a.color}40` }}>
      <span className="flex items-center gap-2 px-3 pt-2"><span className="text-xs font-medium">{a.name}</span><LiveDot color={a.color} /><span className="ml-auto font-mono text-sm tabular-nums" style={{ color: a.color }}>0:{String(Math.max(0, tick - HANDOFF_AT)).padStart(2, "0")}</span></span>
      <span className="block truncate px-3 text-[12px]"><span className="font-mono text-muted-foreground">{i.id}</span> {i.title}</span>
      <span className="mt-1.5 block bg-black/30 px-3 py-1"><TranscriptLine line={{ kind: "tool", text: "GET /api/issues/SEL-781/comments" }} last /></span>
    </span>
  );
}

/** An agent as a token. Its ring is its color; amber when it waits on you. */
function Token({ agent, waiting, working, onClick }: { agent: AgentKey; waiting?: boolean; working?: boolean; onClick: () => void }) {
  const a = AGENTS[agent];
  return (
    <button data-testid={`zoom-map-agent-${agent}`} aria-label={`${a.name}: zoom to its task`} onClick={onClick}
      className="flex items-center rounded-full bg-card p-0.5 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      style={{ boxShadow: `0 0 0 2px ${waiting ? "#fbbf24" : working ? a.color : "#52525b"}, 0 6px 18px rgba(0,0,0,0.5)` }}>
      <Avatar agent={agent} size={32} pose={waiting ? "listening" : working ? "working" : "sleepy"} muted={!working && !waiting} />
    </button>
  );
}

function ZoomMap({ start }: { start?: Cam }) {
  const tick = useTick();
  const ref = useRef<HTMLDivElement>(null);
  const view = useSize(ref);
  const world = WORLD;
  const fit: Cam = { ...FIT, s: Math.min(1, view.w / 1440, view.h / 844) };
  const [camSet, setCam] = useState<Cam | null>(start ?? null);
  const cam = camSet ?? fit;
  const [glide, setGlide] = useState(false);
  const drag = useRef<{ x: number; y: number } | null>(null);
  const level = levelOf(cam.s);
  const handedOff = tick >= HANDOFF_AT;
  const walking = handedOff && tick < HANDOFF_AT + 3;
  const fly = (c: Cam) => { setGlide(true); setCam(clampCam(c)); };
  const flyTo = (id: string) => { const [x, y] = world[id]; fly({ x, y, s: Math.max(cam.s, LEVELS[Math.min(2, level + 1)].s) }); };
  const toScreen = ([x, y]: [number, number]) => [(x - cam.x) * cam.s + view.w / 2, (y - cam.y) * cam.s + view.h / 2];
  // In close-up only the task nearest the middle opens; the rest stay dots so nothing overlaps.
  const focus = ISSUES.map((i) => i.id).sort((p, q) => Math.hypot(world[p][0] - cam.x, world[p][1] - cam.y) - Math.hypot(world[q][0] - cam.x, world[q][1] - cam.y))[0];
  const ease = "700ms var(--motion-ease-out-expo)";
  const move = glide ? `left ${ease}, top ${ease}, transform ${ease}` : walking ? "left 2.4s ease-in-out, top 2.4s ease-in-out" : "none";
  const watched = handedOff ? WATCHED.map((id) => (id === "SEL-781" ? "SEL-782" : id)) : WATCHED;

  useKeys((e) => {
    if (e.key === "Escape" || e.key === "0") fly(fit);
    if (e.key === "+" || e.key === "=") fly({ ...cam, s: cam.s * 1.6 });
    if (e.key === "-") fly({ ...cam, s: cam.s / 1.6 });
  });
  const onWheel = (e: React.WheelEvent) => {
    const r = ref.current!.getBoundingClientRect();
    const px = e.clientX - r.left - view.w / 2, py = e.clientY - r.top - view.h / 2;
    const s = Math.min(4.5, Math.max(0.6, cam.s * Math.exp(-e.deltaY * 0.0015)));
    setGlide(false);
    setCam(clampCam({ s, x: cam.x + px / cam.s - px / s, y: cam.y + py / cam.s - py / s }));
  };

  // Lines between tasks: parent to child, and red dashes for "blocked by".
  const links: { f: string; t: string; blocked?: boolean; faint?: boolean }[] = [
    ...ISSUES.filter((i) => i.parent).map((i) => ({ f: i.parent!, t: i.id, faint: i.status === "done" })),
    ...[...ISSUES.flatMap((i) => (i.blockedBy ?? []).map((b) => [b, i.id] as const)), ["SEL-766", "SEL-768"] as const].map(([f, t]) => ({ f, t, blocked: true })),
  ];

  const map = (
    <div ref={ref} className="relative min-h-0 flex-1 overflow-hidden select-none" onWheel={onWheel}
      style={{ background: "radial-gradient(ellipse at 50% 45%, rgba(56,189,248,0.06), transparent 65%)" }}>
      <div className="absolute inset-0 cursor-grab active:cursor-grabbing"
        onPointerDown={(e) => { drag.current = { x: e.clientX, y: e.clientY }; e.currentTarget.setPointerCapture(e.pointerId); }}
        onPointerMove={(e) => {
          if (!drag.current) return;
          const dx = e.clientX - drag.current.x, dy = e.clientY - drag.current.y;
          drag.current = { x: e.clientX, y: e.clientY };
          setGlide(false);
          setCam(clampCam({ ...cam, x: cam.x - dx / cam.s, y: cam.y - dy / cam.s }));
        }}
        onPointerUp={() => (drag.current = null)}
        onDoubleClick={() => fly(fit)} />
      <svg className="pointer-events-none absolute inset-0 h-full w-full">
        <g style={{ transform: `translate(${view.w / 2 - cam.x * cam.s}px, ${view.h / 2 - cam.y * cam.s}px) scale(${cam.s})`, transition: glide ? `transform ${ease}` : "none" }}>
          <rect x={BENCH.x} y={BENCH.y} width={BENCH.w} height={BENCH.h} rx={16} fill="#ffffff" fillOpacity={0.025} stroke="#3f3f46" strokeDasharray="4 4" vectorEffect="non-scaling-stroke" />
          {links.map(({ f, t, blocked, faint }) => {
            const [x1, y1] = world[f], [x2, y2] = world[t];
            return <line key={f + t} x1={x1} y1={y1} x2={x2} y2={y2}
              stroke={blocked ? "#f87171" : "#71717a"} strokeOpacity={faint ? 0.4 : 0.85} strokeWidth={blocked ? 1.5 : 1} strokeDasharray={blocked ? "5 4" : undefined} vectorEffect="non-scaling-stroke" />;
          })}
        </g>
      </svg>
      {level < 2 && (() => { const [sx, sy] = toScreen([BENCH.x, BENCH.y]); return (
        <span className="pointer-events-none absolute text-[11px] font-semibold uppercase tracking-wider text-muted-foreground" style={{ left: sx + 12, top: sy + 8, transition: move }}>Idle</span>
      ); })()}
      {ISSUES.map((i) => {
        const [sx, sy] = toScreen(world[i.id]);
        const close = level === 2 && i.id === focus;
        const swapped = handedOff && (i.id === "SEL-781" || i.id === "SEL-782");
        const dot = <DotNode id={i.id} dim={level === 2} status={swapped ? (i.id === "SEL-781" ? "done" : "in_progress") : undefined} live={swapped ? i.id === "SEL-782" : undefined} />;
        const form = level === 0 || (level === 2 && !close) ? dot : level === 1 ? (swapped ? <HandoffCard id={i.id} tick={tick} /> : <MidCard id={i.id} tick={tick} />) : null;
        return (
          <div key={i.id} className="absolute" style={{ left: sx, top: sy, transform: "translate(-50%, -50%)", transition: move }}>
            {close
              ? <div className={cn("w-[760px] overflow-hidden rounded-xl border bg-card shadow-2xl", LIVE_RUNS.some((r) => r.issueId === i.id) ? "h-[520px]" : "h-[400px]")} style={{ borderColor: i.id === WAITING.issueId ? "#fbbf24" : LIVE_RUNS.some((r) => r.issueId === i.id) ? AGENTS[i.agent].color : undefined }}><TaskDetail id={i.id} tick={tick} /></div>
              : <button data-testid={`zoom-map-task-${i.id}`} aria-label={`Zoom into ${i.id}`} onClick={() => flyTo(i.id)} className="rounded-lg focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">{form}</button>}
          </div>
        );
      })}
      {/* Agents stand above their task, or sit on the Idle bench. */}
      {level < 2 && (Object.keys(AGENTS) as AgentKey[]).map((k) => {
        const at = spotOf(k, handedOff);
        const [sx, sy] = toScreen(at ? world[at] : BENCH_SEAT);
        const off = at ? (level === 0 ? -58 : -64) : 0;
        return (
          <div key={k} className="absolute z-10" style={{ left: sx, top: sy + off, transform: "translate(-50%, -50%)", transition: move }}>
            <Token agent={k} waiting={at === WAITING.issueId} working={!!at && at !== WAITING.issueId} onClick={() => (at ? flyTo(at) : fly({ x: BENCH_SEAT[0], y: BENCH_SEAT[1], s: LEVELS[1].s }))} />
          </div>
        );
      })}
      {handedOff && tick < HANDOFF_AT + 10 && (
        <div className="absolute top-4 left-1/2 z-20 flex -translate-x-1/2 items-center gap-2 rounded-full border border-border bg-card px-3 py-1.5 text-xs shadow-lg">
          <span className="font-mono text-muted-foreground">14:33</span><Avatar agent="researcher" size={16} />Researcher is done with <span className="font-mono">SEL-781</span>
          <span className="text-muted-foreground">→</span><Avatar agent="simplifier" size={16} />Simplifier starts <span className="font-mono">SEL-782</span>
        </div>
      )}
      {/* Off-screen markers: live work and the waiting decision are never lost, whatever the zoom. */}
      {(() => { const placed: [number, number][] = []; return watched.map((id) => {
        const [sx, sy] = toScreen(world[id]);
        const pad = 36;
        if (sx > 0 && sx < view.w && sy > 0 && sy < view.h) return null;
        const x = Math.min(view.w - pad - 60, Math.max(pad + 60, sx));
        // Keep clear of the zoom controls (bottom left) and the map (bottom right).
        const floor = x > view.w - 300 ? view.h - 180 : x < 470 ? view.h - 130 : view.h - pad;
        let y = Math.min(floor, Math.max(pad, sy));
        while (placed.some(([px, py]) => Math.abs(px - x) < 220 && Math.abs(py - y) < 40)) y -= 40;
        placed.push([x, y]);
        const angle = Math.atan2(sy - y, sx - x);
        const waiting = id === WAITING.issueId;
        const agent = spotAgent(id) ?? issue(id).agent;
        return (
          <button key={id} data-testid={`zoom-map-marker-${id}`} onClick={() => fly({ x: world[id][0], y: world[id][1], s: cam.s })}
            className={cn("absolute z-20 flex h-8 items-center gap-1.5 rounded-full border px-2 text-[11px] whitespace-nowrap shadow-lg focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none", waiting ? "border-amber-400 bg-[#2a2210] text-amber-300" : "border-border bg-card")}
            style={{ left: x, top: y, transform: "translate(-50%, -50%)", borderColor: waiting ? undefined : AGENTS[agent].color }}>
            <span className="inline-block text-xs" style={{ transform: `rotate(${angle}rad)` }} aria-hidden>➜</span>
            <Avatar agent={agent} size={20} pose={waiting ? "listening" : "working"} />
            <span className="font-mono">{id}</span>{waiting && <span className="font-semibold uppercase tracking-wider">Needs you</span>}
          </button>
        );
      }); })()}
      <div className="absolute bottom-4 left-4 flex flex-col gap-2">
        <div className="flex w-fit items-center gap-1 rounded-lg border border-border bg-card/90 p-1 backdrop-blur">
          <Button data-testid="zoom-map-zoom-out" size="icon" variant="ghost" aria-label="Zoom out" onClick={() => fly({ ...cam, s: cam.s / 1.6 })}><Minus /></Button>
          {LEVELS.map((l, n) => (
            <Button key={l.name} data-testid={`zoom-map-level-${l.name.toLowerCase()}`} size="sm" variant={level === n ? "secondary" : "ghost"} onClick={() => fly(n === 0 ? fit : { ...cam, s: l.s })}>{l.name}</Button>
          ))}
          <Button data-testid="zoom-map-zoom-in" size="icon" variant="ghost" aria-label="Zoom in" onClick={() => fly({ ...cam, s: cam.s * 1.6 })}><Plus /></Button>
        </div>
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">Scroll to zoom · drag to move · click an agent to zoom to its task · <Kbd>Esc</Kbd> to see all</div>
      </div>
      <div className="absolute right-4 bottom-4">
        <MiniMap pos={world} w={1440} h={844} label="Map: click to move there" onPick={(x, y) => fly({ x, y, s: cam.s })}
          view={{ x: cam.x - view.w / 2 / cam.s, y: cam.y - view.h / 2 / cam.s, w: view.w / cam.s, h: view.h / cam.s }} />
      </div>
    </div>
  );

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <PageHeader />
      {map}
    </div>
  );
}

// ---------------------------------------------------------------- stories

const meta = {
  title: "Design/WPO-77 Command center",
  parameters: {
    layout: "fullscreen",
    docs: { description: { component: "The picked design for a page to watch agents work (G3 · Players). Fake data, no API calls." } },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const PlayersMock: Story = { name: "G3 · Players", render: () => <ZoomMap /> };
export const PlayersTasks: Story = { name: "G3 · Players · tasks", render: () => <ZoomMap start={{ x: 1130, y: 480, s: 2 }} /> };
export const PlayersCloseUp: Story = { name: "G3 · Players · close-up", render: () => <ZoomMap start={{ x: 170, y: 420, s: 3.6 }} /> };
