import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Minus, Plus } from "lucide-react";
import type { CharacterState } from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { AgentAvatar } from "../AgentAvatar";
import { StatusIcon } from "../StatusIcon";
import { Button } from "../ui/button";
import { cn } from "../../lib/utils";
import type { Handoff } from "./handoff";
import { agentColor, agentSpots, blocksOf, layoutMap, type CcAgent, type CcLine, type CcRun, type CcTask, type CcWaiting, type CommandCenterData } from "./model";

/*
 * Command center, G3 · Players (WPO-77): a zoom map of every task (Overview, Tasks, Close-up).
 * Agents are tokens that stand on the task they run, sit in Idle with no run, and walk on a hand-off.
 * Live and Needs-you tasks outside the view get a marker at the screen edge; a click pans there.
 * Renders a CommandCenterData; `now` (ms) comes from the caller's one-second tick, so timers count.
 * Used by pages/CommandCenter.tsx (real data) and the WPO-77 story (fake data).
 */

export type Cam = { x: number; y: number; s: number };

const LEVELS = [{ name: "Overview", s: 1 }, { name: "Tasks", s: 2 }, { name: "Close-up", s: 3.6 }];
const levelOf = (s: number) => (s < 1.6 ? 0 : s < 3 ? 1 : 2);
const HANDOFF_SHOW_MS = 10_000;
const WALK_MS = 2400;
const AMBER = "#fbbf24";

const cst = (iso: string | number) =>
  new Date(iso).toLocaleTimeString("en-US", { timeZone: "America/Chicago", hour: "2-digit", minute: "2-digit", hour12: false });

function elapsed(startedAt: string | null, now: number) {
  const s = Math.max(0, Math.floor((now - (startedAt ? Date.parse(startedAt) : now)) / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

const isDone = (t: CcTask) => t.status === "done" || t.status === "cancelled";
const shortTitle = (t: string) => (t.length > 44 ? t.slice(0, 42) + "…" : t);
const glow = (color: string, pct: number) => `color-mix(in srgb, ${color} ${pct}%, transparent)`;

function useSize(ref: React.RefObject<HTMLDivElement | null>) {
  const [size, setSize] = useState({ w: 1440, h: 844 });
  useEffect(() => {
    const ro = new ResizeObserver(([e]) => e && setSize({ w: e.contentRect.width, h: e.contentRect.height }));
    if (ref.current) ro.observe(ref.current);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

/** Everything the parts below need about the data, looked up once per render. */
function useLookups(data: CommandCenterData) {
  return useMemo(() => {
    const task = new Map(data.tasks.map((t) => [t.id, t]));
    const agent = new Map(data.agents.map((a) => [a.id, a]));
    const runOn = new Map<string, CcRun>();
    for (const r of data.runs) if (r.issueId) runOn.set(r.issueId, r);
    const waitingOn = new Map<string, CcWaiting>(data.waiting.map((w) => [w.issueId, w]));
    const children = (id: string) => data.tasks.filter((t) => t.parentId === id);
    return { task, agent, runOn, waitingOn, children };
  }, [data]);
}
type Lookups = ReturnType<typeof useLookups>;

function LiveDot({ color = "#3b82f6" }: { color?: string }) {
  return (
    <span className="relative inline-flex size-2">
      <span className="absolute inline-flex size-full animate-ping rounded-full opacity-75" style={{ background: color }} />
      <span className="relative inline-flex size-2 rounded-full" style={{ background: color }} />
    </span>
  );
}

function Avatar({ agent, size = 24, pose = "rest", muted }: { agent?: CcAgent; size?: 16 | 20 | 24 | 32 | 64 | 96; pose?: CharacterState; muted?: boolean }) {
  return <AgentAvatar agent={agent} appearance={agent?.appearance} name={agent?.name} size={size} pose={pose} muted={muted} />;
}

function TranscriptLine({ line, last }: { line: CcLine; last?: boolean }) {
  return (
    <div className={cn("flex gap-2 font-mono text-[12px] leading-5", line.kind === "thought" ? "text-foreground/80 italic" : line.kind === "out" ? "text-emerald-400/90" : "text-sky-300/90")}>
      <span className="w-3 shrink-0 text-muted-foreground">{line.kind === "tool" ? "›" : line.kind === "out" ? "←" : "…"}</span>
      <span className="truncate">{line.text}{last && <span className="ml-0.5 inline-block h-3.5 w-1.5 translate-y-0.5 animate-pulse bg-foreground/70" />}</span>
    </div>
  );
}

/** Done children / all children, as a thin bar. */
function Progress({ kids }: { kids: CcTask[] }) {
  const done = kids.filter(isDone).length;
  return (
    <span className="flex items-center gap-2 text-[11px] text-muted-foreground">
      <span className="h-1 flex-1 overflow-hidden rounded-full bg-muted"><span className="block h-full rounded-full bg-emerald-400/80" style={{ width: `${kids.length ? (done / kids.length) * 100 : 0}%` }} /></span>
      <span className="font-mono">{done}/{kids.length}</span>
    </span>
  );
}

function PageHeader({ data, now }: { data: CommandCenterData; now: number }) {
  const doneToday = data.tasks.filter((t) => t.status === "done").length;
  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b border-border px-6">
      <div className="flex items-center gap-4">
        <h1 className="text-sm font-semibold uppercase tracking-wider">Command center</h1>
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5">{data.runs.length > 0 && <LiveDot />} {data.runs.length} live</span>
          {data.waiting.length > 0 && <span className="flex items-center gap-1.5 text-amber-400"><span className="size-2 rounded-full bg-amber-400" /> {data.waiting.length} needs you</span>}
          <span>{doneToday} done today</span>
        </div>
      </div>
      <span className="font-mono text-xs text-muted-foreground">{cst(now)} CST</span>
    </header>
  );
}

/** Close-up: who works on a task, for how long, and what it does now. */
function TaskDetail({ t, k, now }: { t: CcTask; k: Lookups; now: number }) {
  const run = k.runOn.get(t.id);
  const waiting = k.waitingOn.get(t.id);
  const kids = k.children(t.id);
  const agent = k.agent.get(run?.agentId ?? t.assigneeAgentId ?? "");
  const parent = t.parentId ? k.task.get(t.parentId) : undefined;
  const blocker = t.blockedById ? k.task.get(t.blockedById) : undefined;
  const blocks = blocksOf([...k.task.values()], t.id);
  const color = agentColor(agent);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-start gap-4 border-b border-border p-4">
        {kids.length > 0
          ? <span className="flex size-16 shrink-0 items-center justify-center rounded-full border-2 border-zinc-400 font-mono text-sm font-semibold">{t.identifier.split("-").pop()}</span>
          : <Avatar agent={agent} size={64} pose={run ? "working" : waiting ? "listening" : isDone(t) ? "rest" : "sleepy"} muted={isDone(t)} />}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="flex shrink-0 items-center gap-2 whitespace-nowrap"><StatusIcon status={t.status} showLabel /><Link to={`/issues/${t.identifier}`} className="font-mono hover:underline">{t.identifier}</Link></span>
            {parent && <span className="truncate">· in <span className="font-mono">{parent.identifier}</span> {parent.title}</span>}
          </div>
          <div className="mt-1 text-base font-semibold leading-snug">{t.title}</div>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            {agent && <span className="flex items-center gap-1.5 text-foreground">{agent.name}{run && <LiveDot color={color} />}</span>}
            {t.completedAt && <span className="font-mono">done {cst(t.completedAt)} CST</span>}
            {blocks.length > 0 && <span className="text-red-400">blocks {blocks.map((b) => b.identifier).join(", ")}</span>}
            {blocker && <span className="text-red-400">blocked by {blocker.identifier}</span>}
          </div>
        </div>
        {run && (
          <div className="shrink-0 text-right">
            <div className="text-[11px] uppercase tracking-wider text-muted-foreground">Live</div>
            <div className="font-mono text-2xl tabular-nums" style={{ color }}>{elapsed(run.startedAt, now)}</div>
          </div>
        )}
      </div>
      {run ? (
        <div className="flex min-h-0 flex-1 flex-col justify-end gap-0.5 overflow-hidden bg-black/30 px-4 py-3">
          {run.lines.length ? run.lines.slice(-16).map((l, n, arr) => <TranscriptLine key={n} line={l} last={n === arr.length - 1} />)
            : <div className="text-sm text-muted-foreground">Waiting for the first output…</div>}
        </div>
      ) : waiting ? (
        <div className="flex min-h-0 flex-1 flex-col gap-4 p-4">
          <div className="rounded-lg border border-amber-400/70 bg-amber-400/10 p-4 shadow-[0_0_32px_rgba(251,191,36,0.25)]">
            <div className="flex items-center gap-2 text-xs"><span className="font-semibold uppercase tracking-wider text-amber-400">Needs you</span><span className="text-muted-foreground">since {cst(waiting.askedAt)} CST</span></div>
            <div className="mt-1.5 text-sm">{waiting.question}</div>
            <div className="mt-3"><Button asChild><Link to={`/issues/${t.identifier}`}>Answer in {t.identifier}</Link></Button></div>
          </div>
        </div>
      ) : kids.length > 0 ? (
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden p-4">
          <Progress kids={kids} />
          <div className="divide-y divide-border overflow-y-auto rounded-md border border-border">
            {kids.map((c) => {
              const cr = k.runOn.get(c.id);
              const ca = k.agent.get(cr?.agentId ?? c.assigneeAgentId ?? "");
              return (
                <div key={c.id} className={cn("flex items-center gap-2 px-3 py-1.5 text-[12px]", isDone(c) && "text-muted-foreground")}>
                  <StatusIcon status={c.status} /><span className="font-mono">{c.identifier}</span><span className="truncate">{c.title}</span>
                  <span className="ml-auto flex shrink-0 items-center gap-1.5">{ca && <Avatar agent={ca} size={16} muted={isDone(c)} />}{cr && <LiveDot color={agentColor(ca)} />}{k.waitingOn.has(c.id) && <span className="text-amber-400">Needs you</span>}</span>
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-2 p-4 text-sm text-muted-foreground">
          {isDone(t) ? "Done today." : blocker ? `Waits on ${blocker.identifier}.` : "No live run."}
          <Link to={`/issues/${t.identifier}`} className="text-foreground hover:underline">Open {t.identifier}</Link>
        </div>
      )}
    </div>
  );
}

/** Overview: a ring per task. A parent shows its number; live tasks pulse in their agent's color. */
function DotNode({ t, k, dim }: { t: CcTask; k: Lookups; dim?: boolean }) {
  const run = k.runOn.get(t.id);
  const waiting = k.waitingOn.has(t.id);
  const parent = k.children(t.id).length > 0;
  const color = agentColor(k.agent.get(run?.agentId ?? ""));
  const size = parent ? 64 : run || waiting ? 52 : 36;
  return (
    <span className={cn("relative flex flex-col items-center", dim && "opacity-50")}>
      <span className={cn("relative flex items-center justify-center rounded-full border-2 bg-card", isDone(t) && "opacity-35")}
        style={{ width: size, height: size, borderColor: waiting ? AMBER : run ? color : parent ? "#a1a1aa" : "#3f3f46", boxShadow: run ? `0 0 28px ${glow(color, 40)}` : waiting ? "0 0 36px rgba(251,191,36,0.55)" : undefined }}>
        {(run || waiting) && <span className="absolute inset-[-8px] animate-ping rounded-full border-2" style={{ borderColor: waiting ? AMBER : color, animationDuration: waiting ? "1.2s" : "2.4s" }} />}
        {parent ? <span className="font-mono text-[11px] font-semibold">{t.identifier.split("-").pop()}</span> : <StatusIcon status={t.status} />}
      </span>
      {/* The label hangs below the dot, so the dot sits on the task's point and lines meet its middle. */}
      <span className="absolute top-full left-1/2 flex w-[180px] -translate-x-1/2 flex-col items-center">
        <span className={cn("mt-1.5 text-center text-[11px] leading-tight", isDone(t) ? "text-muted-foreground/50" : parent ? "font-semibold" : "text-foreground/85")}>
          <span className="font-mono">{t.identifier}</span>{parent || run ? <><br />{shortTitle(t.title)}</> : null}
        </span>
        {waiting && <span className="mt-1 rounded-full bg-amber-400 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-black">Needs you</span>}
      </span>
    </span>
  );
}

/** Tasks zoom: a small card with the one line that matters most. */
function MidCard({ t, k, now }: { t: CcTask; k: Lookups; now: number }) {
  const run = k.runOn.get(t.id);
  const waiting = k.waitingOn.get(t.id);
  const kids = k.children(t.id);
  const blocker = t.blockedById ? k.task.get(t.blockedById) : undefined;
  if (kids.length > 0) return (
    <span className={cn("block w-[270px] rounded-lg border bg-card px-3 py-2 text-left", waiting ? "border-amber-400/70" : "border-zinc-500/60")}>
      <span className="flex items-center gap-2 text-[11px] text-muted-foreground"><StatusIcon status={t.status} /><span className="font-mono">{t.identifier}</span>{waiting && <span className="ml-auto font-semibold uppercase tracking-wider text-amber-400">Needs you</span>}</span>
      <span className="mt-0.5 line-clamp-2 text-sm font-semibold">{t.title}</span>
      <span className="mt-1.5 block"><Progress kids={kids} /></span>
    </span>
  );
  if (run) {
    const a = k.agent.get(run.agentId);
    const color = agentColor(a);
    const last = run.lines[run.lines.length - 1];
    return (
      <span className="block w-[290px] overflow-hidden rounded-lg border bg-card text-left" style={{ borderColor: color, boxShadow: `0 0 28px ${glow(color, 25)}` }}>
        <span className="flex items-center gap-2 px-3 pt-2"><span className="text-xs font-medium">{a?.name}</span><LiveDot color={color} /><span className="ml-auto font-mono text-sm tabular-nums" style={{ color }}>{elapsed(run.startedAt, now)}</span></span>
        <span className="block truncate px-3 text-[12px]"><span className="font-mono text-muted-foreground">{t.identifier}</span> {t.title}</span>
        <span className="mt-1.5 block bg-black/30 px-3 py-1">{last ? <TranscriptLine line={last} last /> : <span className="text-[12px] text-muted-foreground">starting…</span>}</span>
      </span>
    );
  }
  if (waiting) return (
    <span className="block w-[290px] rounded-lg border border-amber-400/70 bg-card px-3 py-2 text-left shadow-[0_0_32px_rgba(251,191,36,0.35)]">
      <span className="flex items-center gap-2 text-[11px]"><span className="font-semibold uppercase tracking-wider text-amber-400">Needs you</span><span className="text-muted-foreground">{t.identifier} · {cst(waiting.askedAt)}</span></span>
      <span className="mt-1 line-clamp-2 text-[12px]">{waiting.question}</span>
    </span>
  );
  return (
    <span className={cn("block w-[230px] rounded-md border border-border bg-card px-3 py-1.5 text-left", isDone(t) && "opacity-60")}>
      <span className="flex items-center gap-2 text-[11px] text-muted-foreground"><StatusIcon status={t.status} /><span className="font-mono">{t.identifier}</span>{t.completedAt && isDone(t) && <span className="ml-auto font-mono">{cst(t.completedAt)}</span>}</span>
      <span className="mt-0.5 line-clamp-2 text-[12px]">{t.title}</span>
      {blocker && !isDone(t) && <span className="block text-[11px] text-red-400">blocked by {blocker.identifier}</span>}
    </span>
  );
}

/** An agent as a token. Its ring is its color; amber when it waits on you; zinc when idle. */
function Token({ agent, waiting, working, onClick }: { agent: CcAgent; waiting?: boolean; working?: boolean; onClick: () => void }) {
  return (
    <button data-testid={`zoom-map-agent-${agent.id}`} aria-label={`${agent.name}: zoom to its task`} onClick={onClick}
      className="flex items-center rounded-full bg-card p-0.5 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      style={{ boxShadow: `0 0 0 2px ${waiting ? AMBER : working ? agentColor(agent) : "#52525b"}, 0 6px 18px rgba(0,0,0,0.5)` }}>
      <Avatar agent={agent} size={32} pose={waiting ? "listening" : working ? "working" : "sleepy"} muted={!working && !waiting} />
    </button>
  );
}

function HandoffBanner({ h, k }: { h: Handoff; k: Lookups }) {
  const from = k.agent.get(h.fromAgentId), to = k.agent.get(h.toAgentId);
  return (
    <div data-testid="zoom-map-handoff" className="absolute top-4 left-1/2 z-20 flex -translate-x-1/2 items-center gap-2 rounded-full border border-border bg-card px-3 py-1.5 text-xs whitespace-nowrap shadow-lg">
      <span className="font-mono text-muted-foreground">{cst(h.at)}</span><Avatar agent={from} size={16} />{from?.name} is done with <span className="font-mono">{k.task.get(h.fromIssueId)?.identifier}</span>
      <span className="text-muted-foreground">→</span><Avatar agent={to} size={16} />{to?.name} starts <span className="font-mono">{k.task.get(h.toIssueId)?.identifier}</span>
    </div>
  );
}

const Kbd = ({ children }: { children: ReactNode }) => <kbd className="rounded border border-border bg-muted px-1 font-mono text-[10px] text-muted-foreground">{children}</kbd>;

export function CommandCenterView({ data, now, handoff, start }: { data: CommandCenterData; now: number; handoff: Handoff | null; start?: Cam }) {
  const k = useLookups(data);
  const layout = useMemo(() => layoutMap(data.tasks, data.agents.length), [data.tasks, data.agents.length]);
  const world = layout.pos;
  const spots = useMemo(() => agentSpots(data), [data]);
  const ref = useRef<HTMLDivElement>(null);
  const view = useSize(ref);
  const fitS = Math.min(1, view.w / layout.w, view.h / layout.h);
  const fit: Cam = { x: layout.w / 2, y: layout.h / 2, s: fitS };
  const minS = Math.min(0.6, fitS * 0.8);
  const clampCam = (c: Cam): Cam => ({ s: Math.min(4.5, Math.max(minS, c.s)), x: Math.min(layout.w, Math.max(0, c.x)), y: Math.min(layout.h, Math.max(0, c.y)) });
  const [camSet, setCam] = useState<Cam | null>(start ?? null);
  const cam = camSet ?? fit;
  const [glide, setGlide] = useState(false);
  const drag = useRef<{ x: number; y: number } | null>(null);
  const level = levelOf(cam.s);
  const fly = (c: Cam) => { setGlide(true); setCam(clampCam(c)); };
  const flyTo = (id: string) => { const [x, y] = world[id]!; fly({ x, y, s: Math.max(cam.s, LEVELS[Math.min(2, level + 1)]!.s) }); };
  const toScreen = ([x, y]: [number, number]) => [(x - cam.x) * cam.s + view.w / 2, (y - cam.y) * cam.s + view.h / 2] as const;
  const focus = data.tasks.map((t) => t.id).sort((p, q) => Math.hypot(world[p]![0] - cam.x, world[p]![1] - cam.y) - Math.hypot(world[q]![0] - cam.x, world[q]![1] - cam.y))[0];
  const ease = "700ms var(--motion-ease-out-expo)";

  // A token walks (2.4 s) when its agent's spot changes; otherwise it follows the camera at once.
  const spotsKey = JSON.stringify(spots);
  const lastSpots = useRef(spots);
  const [walking, setWalking] = useState<Set<string>>(new Set());
  useEffect(() => {
    const moved = Object.keys(spots).filter((id) => (lastSpots.current[id] ?? null) !== (spots[id] ?? null));
    lastSpots.current = spots;
    if (!moved.length) return;
    setWalking(new Set(moved));
    const t = setTimeout(() => setWalking(new Set()), WALK_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spotsKey]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLElement && e.target.closest("input, textarea, [contenteditable]")) return;
      if (e.key === "Escape" || e.key === "0") fly(fit);
      if (e.key === "+" || e.key === "=") fly({ ...cam, s: cam.s * 1.6 });
      if (e.key === "-") fly({ ...cam, s: cam.s / 1.6 });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  const onWheel = (e: React.WheelEvent) => {
    const r = ref.current!.getBoundingClientRect();
    const px = e.clientX - r.left - view.w / 2, py = e.clientY - r.top - view.h / 2;
    const s = Math.min(4.5, Math.max(minS, cam.s * Math.exp(-e.deltaY * 0.0015)));
    setGlide(false);
    setCam(clampCam({ s, x: cam.x + px / cam.s - px / s, y: cam.y + py / cam.s - py / s }));
  };

  // Lines between tasks: parent to child, and red dashes for "blocked by".
  const links = [
    ...data.tasks.filter((t) => t.parentId && world[t.parentId]).map((t) => ({ f: t.parentId!, t: t.id, faint: isDone(t), blocked: false })),
    ...data.tasks.filter((t) => t.blockedById && world[t.blockedById] && t.blockedById !== t.parentId).map((t) => ({ f: t.blockedById!, t: t.id, faint: false, blocked: true })),
  ];
  const move = glide ? `left ${ease}, top ${ease}` : "none";
  const showHandoff = handoff && now - handoff.at < HANDOFF_SHOW_MS && k.task.has(handoff.fromIssueId) && k.task.has(handoff.toIssueId);

  return (
    <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <PageHeader data={data} now={now} />
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
            <rect x={layout.bench.x} y={layout.bench.y} width={layout.bench.w} height={layout.bench.h} rx={16} fill="#ffffff" fillOpacity={0.025} stroke="#3f3f46" strokeDasharray="4 4" vectorEffect="non-scaling-stroke" />
            {links.map(({ f, t, blocked, faint }) => {
              const [x1, y1] = world[f]!, [x2, y2] = world[t]!;
              return <line key={f + t + blocked} x1={x1} y1={y1} x2={x2} y2={y2}
                stroke={blocked ? "#f87171" : "#71717a"} strokeOpacity={faint ? 0.4 : 0.85} strokeWidth={blocked ? 1.5 : 1} strokeDasharray={blocked ? "5 4" : undefined} vectorEffect="non-scaling-stroke" />;
            })}
          </g>
        </svg>
        {level < 2 && (() => { const [sx, sy] = toScreen([layout.bench.x, layout.bench.y]); return (
          <span data-testid="zoom-map-idle" className="pointer-events-none absolute text-[11px] font-semibold uppercase tracking-wider text-muted-foreground" style={{ left: sx + 12, top: sy + 8, transition: move }}>Idle</span>
        ); })()}
        {data.tasks.map((t) => {
          const [sx, sy] = toScreen(world[t.id]!);
          const close = level === 2 && t.id === focus;
          const run = k.runOn.get(t.id);
          const form = level === 0 || (level === 2 && !close) ? <DotNode t={t} k={k} dim={level === 2} /> : level === 1 ? <MidCard t={t} k={k} now={now} /> : null;
          return (
            <div key={t.id} className={cn("absolute", close && "z-30")} style={{ left: sx, top: sy, transform: "translate(-50%, -50%)", transition: move }}>
              {close
                ? <div className={cn("w-[760px] max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border bg-card shadow-2xl", run ? "h-[520px]" : "h-[400px]")} style={{ borderColor: k.waitingOn.has(t.id) ? AMBER : run ? agentColor(k.agent.get(run.agentId)) : undefined }}><TaskDetail t={t} k={k} now={now} /></div>
                : <button data-testid={`zoom-map-task-${t.identifier}`} aria-label={`Zoom into ${t.identifier}`} onClick={() => flyTo(t.id)} className="rounded-lg focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">{form}</button>}
            </div>
          );
        })}
        {/* Agents stand above their task, or sit in Idle. */}
        {level < 2 && data.agents.map((a, n) => {
          const at = spots[a.id] ?? null;
          const [sx, sy] = toScreen(at ? world[at]! : layout.seats[n]!);
          const off = at ? (level === 0 ? -58 : -64) : 0;
          const waiting = !!at && !k.runOn.has(at) && k.waitingOn.has(at);
          return (
            <div key={a.id} className="absolute z-10" style={{ left: sx, top: sy + off, transform: "translate(-50%, -50%)", transition: walking.has(a.id) ? `left ${WALK_MS}ms ease-in-out, top ${WALK_MS}ms ease-in-out` : move }}>
              <Token agent={a} waiting={waiting} working={!!at && !waiting} onClick={() => (at ? flyTo(at) : fly({ x: layout.bench.x + layout.bench.w / 2, y: layout.bench.y + layout.bench.h / 2, s: LEVELS[1]!.s }))} />
            </div>
          );
        })}
        {showHandoff && <HandoffBanner h={handoff} k={k} />}
        {/* Off-screen markers: live work and decisions waiting on you are never lost, whatever the zoom. */}
        {(() => { const placed: [number, number][] = []; return [...new Set([...data.waiting.map((w) => w.issueId), ...data.runs.flatMap((r) => (r.issueId ? [r.issueId] : []))])].map((id) => {
          const t = k.task.get(id);
          if (!t || !world[id]) return null;
          const [sx, sy] = toScreen(world[id]);
          const pad = 36;
          if (sx > 0 && sx < view.w && sy > 0 && sy < view.h) return null;
          const x = Math.min(view.w - pad - 60, Math.max(pad + 60, sx));
          // Keep clear of the zoom bar, bottom left.
          const floor = x < 640 ? view.h - 130 : view.h - pad;
          let y = Math.min(floor, Math.max(pad, sy));
          while (placed.some(([px, py]) => Math.abs(px - x) < 220 && Math.abs(py - y) < 40)) y -= 40;
          placed.push([x, y]);
          const angle = Math.atan2(sy - y, sx - x);
          const run = k.runOn.get(id);
          const waiting = !run && k.waitingOn.has(id);
          const a = k.agent.get(run?.agentId ?? t.assigneeAgentId ?? "");
          return (
            <button key={id} data-testid={`zoom-map-marker-${t.identifier}`} onClick={() => fly({ x: world[id]![0], y: world[id]![1], s: cam.s })}
              className={cn("absolute z-20 flex h-8 items-center gap-1.5 rounded-full border bg-card px-2 text-[11px] whitespace-nowrap shadow-lg focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none", waiting && "border-amber-400 text-amber-300")}
              style={{ left: x, top: y, transform: "translate(-50%, -50%)", borderColor: waiting ? undefined : agentColor(a) }}>
              <span className="inline-block text-xs" style={{ transform: `rotate(${angle}rad)` }} aria-hidden>➜</span>
              {a && <Avatar agent={a} size={20} pose={waiting ? "listening" : "working"} />}
              <span className="font-mono">{t.identifier}</span>{waiting && <span className="font-semibold uppercase tracking-wider">Needs you</span>}
            </button>
          );
        }); })()}
        {data.tasks.length === 0 && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 pointer-events-none">
            <div className="text-sm text-muted-foreground">No tasks yet</div>
            <Link to="/issues" className="pointer-events-auto text-sm text-foreground hover:underline">Go to Tasks</Link>
          </div>
        )}
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
      </div>
    </div>
  );
}
