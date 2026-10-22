/** Where each agent stands: agent id → the task it works on or waits on, or null when idle. */
export type Spots = Record<string, string | null>;

/** The last time an agent left a task (its run ended), kept so a start soon after reads as a hand-off. */
export type RunEnd = { agentId: string; issueId: string; at: number };

export type Handoff = { at: number; fromAgentId: string; fromIssueId: string; toAgentId: string; toIssueId: string };

/** A start this long after an end still counts as the same hand-off. */
export const HANDOFF_WINDOW_MS = 60_000;

/**
 * Compares two snapshots of agent spots and returns the newest hand-off, if any.
 * A hand-off is an agent moving from one task to another, or a run that ends followed
 * (in this snapshot or within `windowMs`) by an agent starting a different task.
 * The page keeps `lastEnd` between calls; pass back what this returns.
 */
export function detectHandoff(
  prev: Spots,
  next: Spots,
  lastEnd: RunEnd | null,
  now: number,
  windowMs = HANDOFF_WINDOW_MS,
): { handoff: Handoff | null; lastEnd: RunEnd | null } {
  let handoff: Handoff | null = null;
  let end = lastEnd && now - lastEnd.at <= windowMs ? lastEnd : null;
  const starts: { agentId: string; issueId: string }[] = [];

  for (const agentId of new Set([...Object.keys(prev), ...Object.keys(next)])) {
    const from = prev[agentId] ?? null;
    const to = next[agentId] ?? null;
    if (from === to) continue;
    if (from && to) handoff = { at: now, fromAgentId: agentId, fromIssueId: from, toAgentId: agentId, toIssueId: to };
    else if (from) end = { agentId, issueId: from, at: now };
    else if (to) starts.push({ agentId, issueId: to });
  }

  const start = starts.find((s) => end && s.issueId !== end.issueId);
  if (start && end) {
    handoff = { at: now, fromAgentId: end.agentId, fromIssueId: end.issueId, toAgentId: start.agentId, toIssueId: start.issueId };
    end = null;
  }
  return { handoff, lastEnd: end };
}
