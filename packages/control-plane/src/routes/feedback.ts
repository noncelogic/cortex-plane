import type {
  FeedbackActionStatus,
  FeedbackActionType,
  FeedbackCategory,
  FeedbackSeverity,
  FeedbackSource,
  FeedbackStatus,
  RemediationStatus,
} from "@cortex/shared"
import type { FastifyInstance } from "fastify"

import type { FeedbackService } from "../feedback/service.js"

interface CreateFeedbackBody {
  runId?: string
  taskId?: string
  agentId?: string
  source: FeedbackSource
  category: FeedbackCategory
  severity: FeedbackSeverity
  summary: string
  details?: Record<string, unknown>
  recurrenceKey?: string
}

interface ListFeedbackQuery {
  status?: FeedbackStatus
  remediationStatus?: RemediationStatus
  severity?: FeedbackSeverity
  limit?: number
  offset?: number
}

interface UpdateFeedbackBody {
  status?: FeedbackStatus
  remediationStatus?: RemediationStatus
  remediationNotes?: string | null
  resolvedAt?: string | null
}

interface AddActionBody {
  actionType: FeedbackActionType
  actionRef?: string
  description?: string
  status?: FeedbackActionStatus
}

export interface FeedbackRouteDeps {
  feedbackService: FeedbackService
}

export function feedbackRoutes(deps: FeedbackRouteDeps) {
  const { feedbackService } = deps

  return function register(app: FastifyInstance): void {
    app.get<{ Querystring: ListFeedbackQuery }>("/api/feedback", async (request, reply) => {
      const items = await feedbackService.listFeedback(request.query)
      return reply.status(200).send({ feedback: items })
    })

    app.post<{ Body: CreateFeedbackBody }>("/api/feedback", async (request, reply) => {
      const created = await feedbackService.createFeedback(request.body)
      return reply.status(201).send(created)
    })

    app.get<{ Params: { id: string } }>("/api/feedback/:id", async (request, reply) => {
      const item = await feedbackService.getFeedback(request.params.id)
      if (!item) return reply.status(404).send({ error: "not_found" })
      const actions = await feedbackService.getActions(request.params.id)
      return reply.status(200).send({ ...item, actions })
    })

    app.patch<{ Params: { id: string }; Body: UpdateFeedbackBody }>(
      "/api/feedback/:id",
      async (request, reply) => {
        const resolvedAt =
          request.body.resolvedAt === undefined
            ? undefined
            : request.body.resolvedAt === null
              ? null
              : new Date(request.body.resolvedAt)

        const updated = await feedbackService.updateRemediation(request.params.id, {
          status: request.body.status,
          remediationStatus: request.body.remediationStatus,
          remediationNotes: request.body.remediationNotes,
          resolvedAt,
        })
        if (!updated) return reply.status(404).send({ error: "not_found" })
        return reply.status(200).send(updated)
      },
    )

    app.post<{ Params: { id: string }; Body: AddActionBody }>(
      "/api/feedback/:id/actions",
      async (request, reply) => {
        const parent = await feedbackService.getFeedback(request.params.id)
        if (!parent) return reply.status(404).send({ error: "not_found" })

        const action = await feedbackService.addAction({
          feedbackId: request.params.id,
          actionType: request.body.actionType,
          actionRef: request.body.actionRef,
          description: request.body.description,
          status: request.body.status,
        })
        return reply.status(201).send(action)
      },
    )
  }
}
