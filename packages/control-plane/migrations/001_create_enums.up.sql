-- 001: Create enum types for Cortex Plane schema
-- These enums provide type-safe status columns with compact 4-byte storage.

CREATE TYPE job_status AS ENUM (
  'PENDING',
  'SCHEDULED',
  'RUNNING',
  'WAITING_FOR_APPROVAL',
  'COMPLETED',
  'FAILED',
  'TIMED_OUT',
  'RETRYING',
  'DEAD_LETTER'
);

CREATE TYPE agent_status AS ENUM (
  'ACTIVE',
  'DISABLED',
  'ARCHIVED'
);

CREATE TYPE approval_status AS ENUM (
  'PENDING',
  'APPROVED',
  'REJECTED',
  'EXPIRED'
);
