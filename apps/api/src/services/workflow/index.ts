/**
 * C-0008-B1 workflow layer entry point.
 */

export {
  DEFAULT_HIGH_VALUE_THRESHOLD,
  REVIEW_ACTIONS,
  assertHighValueReviewCleared,
  getRecoveryReviewStatus,
  requiresHighValueReview,
  resolveHighValueReviewState,
  resolveHighValueThreshold,
  submitRecoveryReview,
  type HighValueReviewState,
  type RecoveryReviewStatus,
  type ReviewEvent,
  type SubmitRecoveryReviewInput,
  type SubmitRecoveryReviewResult,
} from './recovery-review';
export {
  getOpportunityInsight,
  listOpportunityInsights,
  toExportRows,
  type OpportunityExportRow,
  type OpportunityInsight,
} from './opportunity-insight';
export {
  getCase,
  getClaimDraft,
  listCaseEvidence,
  listCases,
  type CaseDetail,
  type CaseEvidenceItem,
  type CaseSummary,
  type ClaimDraftView,
} from './case-read';
export {
  BILLING_TRANSITIONS,
  advanceBillingInvoice,
  canAdvanceBilling,
  listBillingInvoices,
  type AdvanceBillingInput,
  type AdvanceBillingResult,
  type BillingInvoiceView,
} from './billing';
export {
  confirmRecoveryOutcome,
  type ConfirmRecoveryOutcomeInput,
  type ConfirmRecoveryOutcomeResult,
} from './recovery-outcome';
export {
  confirmCommercialTerms,
  createCaseForOpportunity,
  type ConfirmCommercialTermsInput,
  type ConfirmCommercialTermsResult,
  type CreateCaseInput,
  type CreateCaseResult,
} from './case-creation';
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
