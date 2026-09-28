/**
 * 规则评估层出口（C-0004）
 */

export {
  MONEY_SCALE,
  RULE_TIER_PRECEDENCE,
  RuleDataError,
  RuleDefinitionError,
  definitionHash,
  evaluateFreightRate,
  parseFreightRateDefinition,
  selectRuleVersion,
  type FreightRateDefinition,
  type FreightRateEvaluation,
  type RuleCandidate,
  type RuleTierName,
} from './freight-rate';
export {
  DETECTION_SCOPE,
  DETECTION_ENGINE_VERSION,
  FREIGHT_RATE_OVERCHARGE,
  detectionDedupeKey,
  runFreightRateDetection,
  toRuleCandidate,
  type DetectionPersistenceInput,
  type DetectionPersistenceResult,
  type DetectionRepository,
  type DetectionRowOutcome,
  type DetectionRunResult,
  type DetectionScope,
  type InvoiceRow,
  type OpportunityDraft,
  type RunDetectionInput,
  type TrackingRow,
} from './detection-service';
export { createPrismaDetectionRepository } from './prisma-detection-repository';
