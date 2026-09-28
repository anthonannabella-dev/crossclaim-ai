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
