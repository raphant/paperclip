import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentWakeupRequests, agents } from "@paperclipai/db";
import { logActivity } from "./activity-log.js";
import { queuedCommentIdsFromWakePayload } from "./issue-queued-comment-queue.js";
import { legacyRunCanSteer, steerLegacyRun } from "./legacy-run-steering.js";
import { NativeSessionSteeringError } from "./native-runtime/native-session-executor.js";
import {
  reconcileSteeredIdentity,
  rejectSteeredIdentity,
  reserveSteeredIdentity,
} from "./run-identity.js";
import { logger } from "../middleware/logger.js";

/**
 * The text a steer sends for a comment. An agent's comment gets a header line,
 * so the receiving agent knows who wrote it and a body that starts with `/` is
 * not read as a command. A person's comment goes as written. The steer route
 * and `autoSteerIssueComment` both use it.
 */
export function steeringMessageText(input: {
  body: string;
  authorAgentName: string | null;
  issueIdentifier: string | null;
}): string {
  if (!input.authorAgentName) return input.body;
  const where = input.issueIdentifier ? ` on ${input.issueIdentifier}` : "";
  return `Comment from ${input.authorAgentName}${where}:\n\n${input.body}`;
}

/** Name of the agent that wrote a comment, or null for a person's comment. */
export async function commentAuthorAgentName(
  db: Db,
  comment: { companyId: string; authorAgentId: string | null; authorUserId: string | null },
): Promise<string | null> {
  if (!comment.authorAgentId || comment.authorUserId) return null;
  const [agent] = await db
    .select({ name: agents.name })
    .from(agents)
    .where(and(eq(agents.id, comment.authorAgentId), eq(agents.companyId, comment.companyId)));
  return agent?.name ?? "another agent";
}

type ActivityActor = {
  actorType: "agent" | "user";
  actorId: string;
  agentId: string | null;
  runId: string | null;
  agentApiKeyId: string | null;
};

/**
 * Fork change (Local changes in paperclip-ops `CLAUDE.md`): steers a new issue
 * comment, from a person or another agent, straight into the assignee's live
 * legacy run, so nobody has to press Steer. The comment routes call it where
 * they would otherwise queue the comment's wake behind that run. Returns false
 * when the run cannot take it now (between turns, not steerable, messages
 * already waiting ahead of it, or the steer fails); the route then queues the
 * comment as before. A person's comment gets the same identity steps as the
 * steer route; an agent's keeps the run's identity (`reserveSteeredIdentity`).
 * On success it logs `issue.queued_comment_steered`, which the chat uses to
 * place the message inside the run.
 */
export async function autoSteerIssueComment(
  db: Db,
  input: {
    issue: {
      id: string;
      companyId: string;
      identifier: string | null;
      assigneeAgentId: string | null;
      conversationAgentId?: string | null;
      externalConversationState?: unknown;
    };
    comment: {
      id: string;
      body: string;
      authorAgentId: string | null;
      authorUserId: string | null;
    };
    run: {
      id: string;
      agentId: string;
      status: string;
      runtimeMode?: string | null;
      contextSnapshot?: unknown;
    } | null;
    actor: ActivityActor;
  },
): Promise<boolean> {
  const { issue, comment, run } = input;
  if (
    !run ||
    run.status !== "running" ||
    run.agentId !== issue.assigneeAgentId ||
    run.runtimeMode === "native" ||
    comment.authorAgentId === issue.assigneeAgentId ||
    issue.conversationAgentId ||
    issue.externalConversationState ||
    !legacyRunCanSteer(run.id)
  ) {
    return false;
  }
  const context = (run.contextSnapshot ?? {}) as Record<string, unknown>;
  if (context.issueId !== issue.id && context.taskId !== issue.id) return false;
  if (await commentsWaiting(db, issue.companyId, run.agentId, issue.id)) return false;

  let identity: Awaited<ReturnType<typeof reserveSteeredIdentity>>;
  try {
    identity = await reserveSteeredIdentity(db, {
      companyId: issue.companyId,
      runId: run.id,
      issueId: issue.id,
      messageId: comment.id,
      source: "comment",
    });
  } catch (err) {
    logger.info(
      { err, issueId: issue.id, commentId: comment.id, runId: run.id },
      "auto-steer skipped: steering identity unavailable; queuing the comment",
    );
    return false;
  }

  const message = steeringMessageText({
    body: comment.body,
    authorAgentName: await commentAuthorAgentName(db, {
      companyId: issue.companyId,
      authorAgentId: comment.authorAgentId,
      authorUserId: comment.authorUserId,
    }),
    issueIdentifier: issue.identifier,
  });
  let turnId: string;
  try {
    ({ turnId } = await steerLegacyRun({
      runId: run.id,
      message,
      onAcknowledged: identity ? () => reconcileSteeredIdentity(db, identity!) : undefined,
    }));
  } catch (err) {
    // A timeout is uncertain: the run may still take the message, and
    // `onAcknowledged` then settles the identity. Queue it anyway; a late
    // second copy is better than a lost message.
    const uncertain = err instanceof NativeSessionSteeringError && err.code === "steering_timeout";
    if (identity && !uncertain) await rejectSteeredIdentity(db, identity);
    logger.info(
      { err, issueId: issue.id, commentId: comment.id, runId: run.id },
      "auto-steer failed; queuing the comment",
    );
    return false;
  }
  if (identity) await reconcileSteeredIdentity(db, identity);
  await logActivity(db, {
    companyId: issue.companyId,
    actorType: input.actor.actorType,
    actorId: input.actor.actorId,
    agentId: input.actor.agentId,
    runId: input.actor.runId,
    agentApiKeyId: input.actor.agentApiKeyId,
    action: "issue.queued_comment_steered",
    entityType: "issue",
    entityId: issue.id,
    details: {
      commentId: comment.id,
      targetRunId: run.id,
      turnId,
      duplicate: false,
      auto: true,
    },
  });
  return true;
}

/** True when earlier comments already wait for this agent's next turn on the issue, so a new one keeps its place behind them. */
async function commentsWaiting(db: Db, companyId: string, agentId: string, issueId: string) {
  const wakes = await db
    .select({ payload: agentWakeupRequests.payload })
    .from(agentWakeupRequests)
    .where(
      and(
        eq(agentWakeupRequests.companyId, companyId),
        eq(agentWakeupRequests.agentId, agentId),
        eq(agentWakeupRequests.status, "deferred_issue_execution"),
        sql`(
          ${agentWakeupRequests.payload} ->> 'issueId' = ${issueId}
          or ${agentWakeupRequests.payload} -> '_paperclipWakeContext' ->> 'issueId' = ${issueId}
        )`,
      ),
    );
  return wakes.some((wake) => {
    const payload = (wake.payload ?? {}) as Record<string, unknown>;
    return typeof payload.commentId === "string" || queuedCommentIdsFromWakePayload(payload).length > 0;
  });
}
