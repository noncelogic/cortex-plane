import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"

import type { ExecutionPlanService } from "../execution-plan/service.js"

interface PlanRunParams {
  runId: string
}

export interface PlanRouteDeps {
  planService: ExecutionPlanService
}

export function planRoutes(deps: PlanRouteDeps) {
  const { planService } = deps

  return function register(app: FastifyInstance): void {
    app.get<{ Params: PlanRunParams }>(
      "/plans/runs/:runId/timeline",
      {
        schema: {
          params: {
            type: "object",
            properties: {
              runId: { type: "string", format: "uuid" },
            },
            required: ["runId"],
          },
        },
      },
      async (request: FastifyRequest<{ Params: PlanRunParams }>, reply: FastifyReply) => {
        const timeline = await planService.timeline(request.params.runId)
        if (!timeline) {
          return reply.status(404).send({ error: "not_found", message: "Plan run not found" })
        }

        return reply.status(200).send({
          plan: {
            id: timeline.run.planId,
            key: timeline.run.planKey,
            title: timeline.run.planTitle,
          },
          version: {
            id: timeline.run.planVersionId,
            number: timeline.run.versionNumber,
            issueNumber: timeline.run.sourceIssueNumber,
            prNumber: timeline.run.sourcePrNumber,
            agentRunId: timeline.run.sourceAgentRunId,
            jobId: timeline.run.sourceJobId,
            sessionId: timeline.run.sourceSessionId,
          },
          run: {
            id: timeline.run.runId,
            state: timeline.run.runState,
            currentStepId: timeline.run.currentStepId,
            lastCheckpointKey: timeline.run.lastCheckpointKey,
            approvalGateStepId: timeline.run.approvalGateStepId,
            approvalGateStatus: timeline.run.approvalGateStatus,
            blockedReason: timeline.run.blockedReason,
            createdAt: timeline.run.runCreatedAt,
            updatedAt: timeline.run.runUpdatedAt,
          },
          resume: timeline.resumePoint,
          canonicalPlan: timeline.run.planDocument,
          timeline: timeline.events.map((event) => ({
            id: event.id,
            fromState: event.from_state,
            toState: event.to_state,
            stepId: event.step_id,
            checkpointKey: event.checkpoint_key,
            eventType: event.event_type,
            payload: event.event_payload,
            actor: event.actor,
            occurredAt: event.occurred_at,
          })),
        })
      },
    )
  }
}
