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
  WorkflowError,
  reviewOpportunity,
  type RejectReason,
  type ReviewOpportunityInput,
  type ReviewOpportunityResult,
  type WorkflowErrorCode,
} from './opportunity-review';
