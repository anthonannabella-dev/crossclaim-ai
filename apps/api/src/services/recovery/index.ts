/**
 * 追回闭环层出口（C-0004 Checkpoint 2）
 */

export {
  CLOSURE_SCOPE,
  ClosureError,
  assertCommercialTerms,
  assertClosableOpportunity,
  assertSyntheticSettlementAllowed,
  billingInvoiceNoFor,
  buildClosureAuditRow,
  caseNoFor,
  isOpportunityClosable,
  renderClaimDraft,
  resolveRuntimeMode,
  runRecoveryClosure,
  type ClosureAuditEvent,
  type ClosureRunResult,
  type ClosureScope,
  type CommercialTerms,
  type RunClosureInput,
  type RuntimeMode,
} from './closure-service';
