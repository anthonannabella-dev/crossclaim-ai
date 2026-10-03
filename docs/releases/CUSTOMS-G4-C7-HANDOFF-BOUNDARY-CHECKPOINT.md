# CUSTOMS G4 / C7 — Handoff-Only 边界 CHECKPOINT（Q3 = PASS）

- 时间：2026-10-03T10:00:19.035Z（HEAD ed004ca）
- 单元：G4 内部链第七环 **C7 = 只交接**（无提交、无外写、无 recovered truth）

## 交付物

| 产物 | 路径 | 证据 |
|---|---|---|
| 交接契约 | `apps/api/src/services/customs/customs-handoff-boundary.ts` | `buildCustomsHandoffArtifact` / `normalizeCustomsHandoffAcknowledgement` |
| 回归测试 | `apps/api/src/__tests__/customs-handoff-boundary.test.ts` | 6/6 PASS（C1–C7 = 85/85） |

## 语义（架构方 Q3 边界）

- 允许：handoff artifact（target = CUSTOMER_SELF / BROKER / PORTAL_DEEPLINK）+ 支持文件 manifest + checklist + 说明 + 人工 acknowledgement 归一化。
- 禁止清单（进 artifact，可审计）：`AUTO_FILING` / `AUTO_PORTAL_SUBMIT` / `BROKER_API_WRITE` / `ABI_EDI_WRITE` / `GOVERNMENT_FEE_PAYMENT` / `TREAT_PACKAGE_AS_FILING` / `TREAT_HANDOFF_AS_RECOVERED_TRUTH`。
- 未就绪 package 不得交接（`HANDOFF_PACKAGE_NOT_READY`）；BROKER 必须带 safe reference；acknowledgement 显式 `filingPerformed=false` / `recoveredTruthDerived=false` / `externalWritePerformed=false`。
- 确定性：handoffId / acknowledgementId 由规范化 JSON 的 sha256 派生；clock 由调用方注入。
