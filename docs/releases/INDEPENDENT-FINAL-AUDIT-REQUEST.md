# INDEPENDENT FINAL AUDIT REQUEST（协议八）

- 时间：2026-10-03T15:40:33.504Z；REVIEWED_HEAD：`b0fffe5`
- 触发条件：`INTERNAL_CODE_COMPLETE = TRUE`（12/12 检查通过；HEAD CI run **37133358856** success）且 `SAFE_CONTINUATION_QUEUE = 0`。
- 按协议：Codex **不得**把 INTERNAL_CODE_COMPLETE 等价为「项目完成」；必须由 ChatGPT 独立反查。

## 1. 请独立核验的材料

| 材料 | 位置 |
|---|---|
| 验收报告 | `docs/releases/FINAL-ACCEPTANCE-REPORT.md` |
| 验收协议 | `docs/releases/FINAL-ACCEPTANCE-PROTOCOL.md` |
| 差集登记表 | `docs/releases/MASTER-GAP-CLOSURE-REGISTER.md`（含 BUSINESS SURVIVAL GATES 段） |
| 裁决归档 | `AI-ARCHITECT-INBOX.md`（MSG-20261003-126 → MSG-20261003-134，均 FULL_COPY_OK） |
| AUTOPILOT | `docs/releases/AUTOPILOT-CONTINUOUS-MODE.md`、`tools/autopilot/{continuous-runner,dispatcher,watchdog,final-status,final-report,record-ci-status}.mjs` |
| Git | 分支 `gate/7-commercial-validation`，HEAD `b0fffe5`，工作树干净 |
| 迁移 | `apps/api/prisma/migrations/**`（含 20261003100000–20261003200000 与 PS04 D1–D3 枚举） |
| Schema / 约束 | `apps/api/prisma/schema.prisma` + `db-constraint-coverage` 26 断言 + 运行库触发器清单 92 baseline |
| 测试 | 全量 API 套件 263 文件 / 2637 用例（本地）；customs/carrier/settlement 等专项套件 |
| CI | 各提交 run success（最近：9e84737 → 37133358856） |

## 2. 请反查的具体问题

1. Layer 1（INTERNAL CODE COMPLETE）是否成立：14 项条件是否有任何一项被 Codex 自证而非实证？
2. Layer 2（Golden Path）：Platform / Logistics / Customs / Independent-site（PS04 Phase 1）四域的核心链是否有「service 有 HTTP 未接」「contract-only 无 persistence」「Schema 字段无 DB invariant」等缺口？
3. Layer 3（真实集成）是否被正确标记为 HOST/API/REAL_DATA/LEGAL 依赖，而未被假装 CLOSED？
4. 是否存在 Codex 遗漏的内部可执行缺口（应回到 SAFE_CONTINUATION_QUEUE 而不是停止）？
5. 若确认内部完成，请给出正式 `INDEPENDENT FINAL AUDIT = PASS`（并注明任何条件）或 `REVISE`（列出 CHANGE）。

## 3. 边界（不变）

Production Enablement=HOLD · External Write=HOLD · Real Money=HOLD · Customer Submission=HOLD · Production Credentials=HOST_ONLY。
