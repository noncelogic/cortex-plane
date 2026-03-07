/**
 * Tool-binding API functions — re-exported from the main api-client for convenience.
 */
export {
  bulkBindTools,
  createToolBinding,
  deleteToolBinding,
  getCapabilityAudit,
  getEffectiveTools,
  listToolBindings,
  updateToolBinding,
} from "../api-client"
export type {
  CapabilityAuditEntry,
  EffectiveTool,
  ToolApprovalPolicy,
  ToolBinding,
} from "../schemas/tool-bindings"
