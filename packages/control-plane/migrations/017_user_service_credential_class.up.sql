-- Add 'user_service' to the credential_class enum for user service OAuth credentials
-- (Google Workspace, GitHub user, Slack user, etc.)
ALTER TYPE credential_class ADD VALUE IF NOT EXISTS 'user_service';
