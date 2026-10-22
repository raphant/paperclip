import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Radar } from "lucide-react";
import type { AttentionItem, CompactIssue } from "@paperclipai/shared";
import type { TranscriptEntry } from "../adapters";
import { agentsApi } from "../api/agents";
import { attentionApi } from "../api/attention";
import { heartbeatsApi } from "../api/heartbeats";
import { issuesApi } from "../api/issues";
import { CommandCenterView } from "../components/command-center/CommandCenterView";
import { detectHandoff, type Handoff, type RunEnd, type Spots } from "../components/command-center/handoff";
import { agentSpots, type CcLine, type CommandCenterData } from "../components/command-center/model";
import { EmptyState } from "../components/EmptyState";
import { useLiveRunTranscripts } from "../components/transcript/useLiveRunTranscripts";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { queryKeys } from "../lib/queryKeys";

/*
 * /command-center: the live map of tasks and agents (WPO-84). Reads only what the UI already fetches:
 * the company issue list, live runs, agents, and the attention feed (board decision cards = "Needs you").
 * Issue and run events refresh it through LiveUpdatesProvider; the attention feed polls.
 */

const ISSUE_LIMIT = 500;
const TRANSCRIPT_POLL_MS = 15_000;
const TRANSCRIPT_READ_BYTES = 64_000;
const TRANSCRIPT_CHUNKS = 40;
const WAITING_SOURCES = new Set(["issue_thread_interaction", "approval", "decision"]);

const centralDay = (d: string | number | Date) => new Date(d).toLocaleDateString("en-CA", { timeZone: "America/Chicago" });

/** Open tasks, tasks done today, and the parents they hang under. */
function pickTasks(issues: CompactIssue[], now: number): CompactIssue[] {
  const today = centralDay(now);
  const byId = new Map(issues.map((i) => [i.id, i]));
  const keep = new Map<string, CompactIssue>();
  for (const i of issues) {
    const open = i.status !== "done" && i.status !== "cancelled";
    const doneToday = i.status === "done" && i.completedAt && centralDay(i.completedAt) === today;
    if (!open && !doneToday) continue;
    for (let cur: CompactIssue | undefined = i; cur && !keep.has(cur.id); cur = cur.parentId ? byId.get(cur.parentId) : undefined) keep.set(cur.id, cur);
  }
  return [...keep.values()];
}

function shortInput(input: unknown): string {
  if (input && typeof input === "object") {
    const o = input as Record<string, unknown>;
    for (const key of ["command", "file_path", "path", "pattern", "url", "query", "description"]) if (typeof o[key] === "string") return o[key] as string;
  }
  return typeof input === "string" ? input : "";
}

/** A transcript as the short lines the map shows: thoughts, tool calls, and the first line of each output. */
function toLines(entries: TranscriptEntry[]): CcLine[] {
  const lines: CcLine[] = [];
  for (const e of entries) {
    if ((e.kind === "assistant" || e.kind === "thinking") && e.text.trim()) lines.push({ kind: "thought", text: e.text.trim().split("\n")[0]! });
    else if (e.kind === "tool_call") lines.push({ kind: "tool", text: `${e.name} ${shortInput(e.input)}`.trim() });
    else if (e.kind === "tool_result" && e.content.trim()) lines.push({ kind: "out", text: e.content.trim().split("\n")[0]! });
    else if (e.kind === "stdout" && e.text.trim()) lines.push({ kind: "out", text: e.text.trim().split("\n")[0]! });
  }
  return lines;
}

function questionOf(item: AttentionItem): string {
  const d = item.detail;
  const text = d && ("promptExcerpt" in d ? d.promptExcerpt : "firstQuestionText" in d ? d.firstQuestionText : "summaryExcerpt" in d ? d.summaryExcerpt : null);
  return text || item.subject.title || item.whyNow;
}

export function CommandCenter() {
  const { selectedCompanyId: companyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => setBreadcrumbs([{ label: "Command center" }]), [setBreadcrumbs]);

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const issues = useQuery({
    queryKey: [...queryKeys.issues.list(companyId!), "command-center"],
    queryFn: () => issuesApi.listCompact(companyId!, { limit: ISSUE_LIMIT }),
    enabled: !!companyId,
  });
  const liveRuns = useQuery({
    queryKey: queryKeys.liveRuns(companyId!),
    queryFn: () => heartbeatsApi.liveRunsForCompany(companyId!),
    enabled: !!companyId,
  });
  const agents = useQuery({
    queryKey: queryKeys.agents.list(companyId!),
    queryFn: () => agentsApi.list(companyId!),
    enabled: !!companyId,
  });
  const attention = useQuery({
    queryKey: queryKeys.attention(companyId!),
    queryFn: () => attentionApi.list(companyId!),
    enabled: !!companyId,
    refetchInterval: 30_000,
  });

  const running = useMemo(() => (liveRuns.data ?? []).filter((r) => r.status === "running"), [liveRuns.data]);
  const { transcriptByRun } = useLiveRunTranscripts({
    runs: running,
    companyId,
    maxChunksPerRun: TRANSCRIPT_CHUNKS,
    logPollIntervalMs: TRANSCRIPT_POLL_MS,
    logReadLimitBytes: TRANSCRIPT_READ_BYTES,
  });

  // The day only matters for "done today", so the task set rebuilds once a day, not every tick.
  const today = centralDay(now);
  const data = useMemo<CommandCenterData>(() => {
    const tasks = pickTasks(issues.data ?? [], Date.now()).map((i) => ({
      id: i.id,
      identifier: i.identifier ?? i.id.slice(0, 8),
      title: i.title,
      status: i.status,
      parentId: i.parentId,
      blockedById: i.blockedBy?.[0]?.id ?? i.blockerAttention?.directBlockerIssueId ?? null,
      assigneeAgentId: i.assigneeAgentId,
      completedAt: i.completedAt ? new Date(i.completedAt).toISOString() : null,
    }));
    const onMap = new Set(tasks.map((t) => t.id));
    const waiting = (attention.data?.items ?? []).flatMap((item) => {
      const issueId = item.relatedIssue?.id ?? (item.subject.kind === "issue" ? item.subject.id : null);
      return WAITING_SOURCES.has(item.sourceKind) && issueId && onMap.has(issueId) ? [{ issueId, question: questionOf(item), askedAt: item.createdAt }] : [];
    });
    return {
      tasks,
      agents: (agents.data ?? []).filter((a) => a.status !== "terminated").map((a) => ({ id: a.id, name: a.name, appearance: a.appearance ?? null })),
      runs: running.map((r) => ({ id: r.id, agentId: r.agentId, issueId: r.issueId ?? null, startedAt: r.startedAt, lines: toLines(transcriptByRun.get(r.id) ?? []) })),
      waiting: waiting.filter((w, n) => waiting.findIndex((x) => x.issueId === w.issueId) === n),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [issues.data, agents.data, attention.data, running, transcriptByRun, today]);

  // Hand-off: compare where agents stand now with the last snapshot. Newest banner only.
  const ready = issues.isSuccess && liveRuns.isSuccess && agents.isSuccess;
  const spots = useMemo(() => agentSpots(data), [data]);
  const spotsKey = JSON.stringify(spots);
  const prevSpots = useRef<Spots | null>(null);
  const lastEnd = useRef<RunEnd | null>(null);
  const [handoff, setHandoff] = useState<Handoff | null>(null);
  useEffect(() => {
    if (!ready) return;
    if (prevSpots.current) {
      const r = detectHandoff(prevSpots.current, spots, lastEnd.current, Date.now());
      lastEnd.current = r.lastEnd;
      if (r.handoff) setHandoff(r.handoff);
    }
    prevSpots.current = spots;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, spotsKey]);

  if (!companyId) return <EmptyState icon={Radar} message="Select an organization to open the Command center." />;
  return (
    <div className="-m-4 h-[calc(100%+2rem)] md:-m-6 md:h-[calc(100%+3rem)]">
      <CommandCenterView data={data} now={now} handoff={handoff} />
    </div>
  );
}
