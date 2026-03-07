/**
 * Agent-user API functions — re-exported from the main api-client for convenience.
 */
export {
  createAgentUserGrant,
  generatePairingCode,
  getPendingCounts,
  listAccessRequests,
  listAgentUsers,
  listPairingCodes,
  resolveAccessRequest,
  revokePairingCode,
  revokeUserGrant,
} from "../api-client"
export type {
  AccessRequest,
  ChannelMapping,
  PairingCode,
  UserAccount,
  UserGrant,
} from "../schemas/users"
export type {
  AccessRequestListResponse,
  CreateGrantResponse,
  GeneratePairingCodeResponse,
  GrantListResponse,
  PairingCodeListResponse,
  PendingCountResponse,
} from "../schemas/users"
