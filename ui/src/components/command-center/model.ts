import type { AgentAppearance } from "@paperclipai/shared";
import type { Spots } from "./handoff";

/*
 * The Command center's view model. The page builds it from the issue list, live runs, agents and
 * the attention feed; the story builds it from fake data. The map only renders it.
 */

export type CcAgent = { id: string; name: string; appearance: AgentAppearance | null };

export type CcTask = {
  id: string;
  identifier: string;
  title: string;
  status: string;
  parentId: string | null;
  /** The one direct blocker the issue list tells us about (`blockerAttention.directBlockerIssueId`). */
  blockedById: string | null;
  assigneeAgentId: string | null;
  completedAt: string | null;
};

export type CcLine = { kind: "thought" | "tool" | "out"; text: string };

/** A running run. `lines` is the transcript tail, oldest first. */
export type CcRun = { id: string; agentId: string; issueId: string | null; startedAt: string | null; lines: CcLine[] };

/** A decision card on a task, waiting on the board. */
export type CcWaiting = { issueId: string; question: string; askedAt: string };

export type CommandCenterData = { tasks: CcTask[]; agents: CcAgent[]; runs: CcRun[]; waiting: CcWaiting[] };

/** An agent's color, from its avatar palette. */
export function agentColor(agent: CcAgent | undefined): string {
  return agent?.appearance ? `var(--agent-cap-v1-${agent.appearance.paletteId}-b)` : "#a1a1aa";
}

/** Each agent stands on the task of its newest run; with no run, on a task of its that waits on the board. */
export function agentSpots(data: CommandCenterData): Spots {
  const onMap = new Set(data.tasks.map((t) => t.id));
  const spots: Spots = Object.fromEntries(data.agents.map((a) => [a.id, null]));
  const waitingIds = new Set(data.waiting.map((w) => w.issueId));
  for (const t of data.tasks) {
    if (t.assigneeAgentId && waitingIds.has(t.id) && t.assigneeAgentId in spots) spots[t.assigneeAgentId] = t.id;
  }
  const runs = [...data.runs].sort((a, b) => (a.startedAt ?? "").localeCompare(b.startedAt ?? ""));
  for (const r of runs) if (r.issueId && onMap.has(r.issueId) && r.agentId in spots) spots[r.agentId] = r.issueId;
  return spots;
}

// ---------------------------------------------------------------- auto layout

export type Rect = { x: number; y: number; w: number; h: number };
export type MapLayout = { pos: Record<string, [number, number]>; bench: Rect; seats: [number, number][]; w: number; h: number };

const RING_FIRST = 150;
const RING_STEP = 110;
const SLOT = 120;
const LABEL = 90;
const GAP = 60;
const SEAT = 48;
/** Empty world under the last row, so the zoom bar (bottom left) does not cover it at fit. */
const ZOOM_BAR_ROOM = 140;

/**
 * One cluster per top-level task: the root in the middle, every task under it on rings around it.
 * Clusters, and the Idle box with one seat per agent, are packed into rows, biggest first.
 * Order inside a cluster follows the issue number, so tasks keep their place as statuses change.
 */
export function layoutMap(tasks: CcTask[], agentCount: number): MapLayout {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const rootOf = (t: CcTask) => {
    let cur = t;
    const seen = new Set<string>();
    while (cur.parentId && byId.has(cur.parentId) && !seen.has(cur.id)) { seen.add(cur.id); cur = byId.get(cur.parentId)!; }
    return cur.id;
  };
  const byNumber = (a: CcTask, b: CcTask) => a.identifier.localeCompare(b.identifier, undefined, { numeric: true });
  const clusters = new Map<string, CcTask[]>();
  for (const t of [...tasks].sort(byNumber)) {
    const root = rootOf(t);
    if (!clusters.has(root)) clusters.set(root, []);
    if (root !== t.id) clusters.get(root)!.push(t);
  }

  // Ring k holds as many slots as fit its circumference.
  const rings = (n: number) => {
    const out: { r: number; count: number }[] = [];
    for (let k = 0; n > 0; k++) {
      const r = RING_FIRST + RING_STEP * k;
      const count = Math.min(n, Math.max(6, Math.floor((2 * Math.PI * r) / SLOT)));
      out.push({ r, count });
      n -= count;
    }
    return out;
  };

  const cols = Math.min(Math.max(agentCount, 1), 5);
  const benchW = Math.max(200, cols * SEAT + 40);
  const benchH = Math.ceil(Math.max(agentCount, 1) / cols) * SEAT + 76;
  type Item = { id: string | null; w: number; h: number; place: (cx: number, cy: number) => void };
  const pos: Record<string, [number, number]> = {};
  let bench: Rect = { x: 0, y: 0, w: benchW, h: benchH };
  const items: Item[] = [{ id: null, w: benchW, h: benchH, place: (cx, cy) => { bench = { x: cx - benchW / 2, y: cy - benchH / 2, w: benchW, h: benchH }; } }];
  for (const [root, members] of clusters) {
    const rs = rings(members.length);
    const radius = (rs.length ? rs[rs.length - 1]!.r : 0) + LABEL;
    items.push({
      id: root, w: radius * 2, h: radius * 2,
      place: (cx, cy) => {
        pos[root] = [cx, cy];
        let i = 0;
        for (const { r, count } of rs) {
          for (let j = 0; j < count; j++, i++) {
            const a = -Math.PI / 2 + (j / count) * 2 * Math.PI;
            pos[members[i]!.id] = [cx + Math.cos(a) * r, cy + Math.sin(a) * r];
          }
        }
      },
    });
  }

  // Rows about 16:9, the shape of the screen.
  const area = items.reduce((s, it) => s + (it.w + GAP) * (it.h + GAP), 0);
  const rowW = Math.max(1440, Math.sqrt(area * 1.7));
  const [benchItem, ...rest] = items;
  rest.sort((a, b) => b.w - a.w);
  let x = GAP, y = GAP, rowH = 0, w = 0;
  for (const it of [benchItem!, ...rest]) {
    if (x > GAP && x + it.w > rowW) { x = GAP; y += rowH + GAP; rowH = 0; }
    it.place(x + it.w / 2, y + it.h / 2);
    x += it.w + GAP;
    rowH = Math.max(rowH, it.h);
    w = Math.max(w, x);
  }
  const b = bench;
  const seats = Array.from({ length: agentCount }, (_, n): [number, number] => [b.x + 20 + SEAT / 2 + (n % cols) * SEAT, b.y + 56 + SEAT / 2 + Math.floor(n / cols) * SEAT]);
  return { pos, bench: b, seats, w, h: y + rowH + GAP + ZOOM_BAR_ROOM };
}

/** The tasks a task blocks, from the other tasks' `blockedById`. */
export function blocksOf(tasks: CcTask[], id: string): CcTask[] {
  return tasks.filter((t) => t.blockedById === id);
}
