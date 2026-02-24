export type JobStatus =
  | "PENDING"
  | "SCHEDULED"
  | "RUNNING"
  | "WAITING_FOR_APPROVAL"
  | "COMPLETED"
  | "FAILED"
  | "TIMED_OUT"
  | "RETRYING"
  | "DEAD_LETTER";

export type AgentStatus = "ACTIVE" | "DISABLED" | "ARCHIVED";

export type ApprovalStatus = "PENDING" | "APPROVED" | "REJECTED" | "EXPIRED";
