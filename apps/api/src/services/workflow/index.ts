/**
 * C-0008-B1 workflow layer entry point.
 */

export {
  APP_ROLES,
  ForbiddenError,
  PERMISSIONS,
  assertPermission,
  permissionsFor,
  type AppRole,
  type PermissionMatrix,
} from './permissions';
export {
  REJECT_REASONS,
  REVIEWABLE_STATUS,
  WorkflowError,
  reviewOpportunity,
  type RejectReason,
  type ReviewOpportunityInput,
  type ReviewOpportunityResult,
  type WorkflowErrorCode,
} from './opportunity-review';
export {
  handleWorkflowRequest,
  type WorkflowRouteDeps,
} from './http-routes';
export {
  createManagedConnection,
  listConnections,
  rotateConnectionCredentialRef,
  setConnectionStatus,
  type ConnectionActor,
  type ConnectionManagementDeps,
  type ConnectionView,
  type CreateManagedConnectionInput,
  type RotateCredentialRefInput,
  type SetConnectionStatusInput,
} from './connection-management';
