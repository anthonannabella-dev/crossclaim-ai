# PHASE1-RESULT

> 模板（P2-4）。建议由工具生成：`renderPhase1Result(...)`（`tools/validation/phase1-runbook.mjs`）。
> 八个章节固定顺序，缺一节即视为报告不完整。

## Dataset Summary

## Import Result

## Data Quality

## Candidate Findings

> **Candidate ≠ Claim**：候选仅为潜在线索，不代表已确认可追回金额或已主张。

## Human Verification

> ≥5 例；分类只能 TRUE_POSITIVE / FALSE_POSITIVE / NEEDS_DATA。

## False Positive Analysis

## Missing Data

## Decision Gate

> 只能三选一：`PASS_TO_MVP` / `CONTINUE_DATA_COLLECTION` / `STOP_REWORK`

---

## 阶段一禁止事项

- ❌ auto-submit-claim / auto-appeal
- ❌ auto-commission / auto-charge
- ❌ auto-amount-promise / auto-platform-action
- ❌ 判断回收金额 / 成功率 / ARR / 收费能力（属商业验证阶段）
