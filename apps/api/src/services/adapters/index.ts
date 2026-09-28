/**
 * 外部适配器层出口（Gate 1 · Checkpoint 2 · 第 2 项 Adapter interface）
 */

export * from './types';
export {
  CANONICAL_COLUMNS,
  CANONICAL_MAPPING,
  canonicalAmount,
  canonicalCurrency,
  canonicalDate,
  canonicalText,
  toCanonicalRows,
  withSourceEvidence,
  type CanonicalRows,
} from './canonical';
export {
  createAdapterRegistry,
  assertAdapterCapabilities,
  type AdapterRegistry,
} from './registry';
export { assertSafeSource, MAX_SOURCE_BYTES, type SourceGuardContext } from './source-guard';
export {
  runAdapterImport,
  submitClaimThroughAdapter,
  type AdapterImportInput,
  type AdapterImportResult,
  type AdapterPullFailure,
} from './ingest-bridge';
