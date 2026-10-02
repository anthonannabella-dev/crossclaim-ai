# PC-05 RECOVERED MONEY VISIBILITY CHECKPOINT

状态：**READY_FOR_REVIEW / IMPLEMENTATION CHECKPOINT**（待架构方裁决）
IMPLEMENTATION_HEAD = 3cef009
IMPLEMENTATION_HEAD_FULL = 3cef00995402ceaef5168ffe2ad8e27573aafff5
CI = SUCCESS · RUN_ID = 37030847155 · CI_HEAD = 3cef009
授权：MSG-20261003-86 ⑥⑦⑧（PC-05 RECOVERED MONEY VISIBILITY）。
边界：MONEY VISIBILITY（非 MONEY MOVEMENT）· NO platform write · Payment = 0 · autopay = OFF · collection = OFF · external payment write = OFF · R13 HOLD · TRANSPORT=false · 无生产凭据。

## 1. 范围逐项落地（MSG-86 ⑥ 1–11）

| 项 | 要求 | 实现 |
|---|---|---|
| 1 Customer recovery money summary | tenant-scoped 只读；discovered / expected / claimed / approved / recovered / outstanding / currency；按币种分组；不做 FX | `getRecoveryMoneyView()` 返回 `organization.byCurrency[]` + 每个 case 的 `bucket`；全部金额按 `currency` 分组，无跨币种相加、无换算 |
| 2 Settlement visibility | 从 Settlement / Payout / ReimbursementFact / Projection / Ledger 只展示到账事实；状态区分 EXPECTED / RECEIVED / PARTIAL / DISPUTED / VOID；EXPECTED 不得当作已到账 | 仅 `status=RECEIVED/PARTIAL`（且未被 reversal、未被 review 拒绝）计入 `recovered`；`EXPECTED` 单独进 `expected`；`DISPUTED` / `reconciliationStatus=DISPUTED` 计入 `disputed`；`VOID` 完全排除 |
| 3 Recovery timeline | discovered → claimed·submitted → approved·reconciled → recovered·received；只用真实持久化事实 | `timeline.discoveredAt` 取 claim item `occurredAt`；`submittedAt` 取 **RecoveryManualSubmission.submittedAt**（真实人工提交事实）；`approvedAt` 取 claim item 终态时间；`receivedAt` 取 Settlement.receivedAt |
| 4 Case-level money view | recoverable / claimed / approved / received / remaining；adjustment·reversal 反映净额 | 每个 case 返回 bucket（含 `adjustments` / `netRecovered` / `outstanding`）与 lineage 计数；`netRecovered = recovered − adjustments(REVERSAL)`，`outstanding = max(approved − netRecovered, 0)` |
| 5 Organization-level money overview | 一页 summary projection（total recoverable / in progress / recovered / outstanding），按币种；不做 mega dashboard | `organization.byCurrency[]` 聚合所有 case 的 bucket；UI `/money` 展示「已发现 / 追回中 / 已追回 / 冲减 / 净追回 / 未追回 / 已计算费用 / 已收取」 |
| 6 Fee visibility | fee rate·basis / calculated fee / billing draft·status；区分 fee calculated 与 actually charged·collected；collection 显示 NOT_COLLECTED / NOT_ENABLED | `feeCalculated` = 非 VOID 的 BillingInvoice.total 之和；`feeCollected` = paidAmount 之和（当前恒 0）；`organization.collection = 'NOT_ENABLED'`、`payment = 'ZERO'`；`feeNote` 明示「不等于已扣款」 |
| 7 Settlement lineage | 可追溯 Claim → Settlement → Ledger；不得只看 Case.recoveredAmount | 每个 case 返回 `lineage { claimItems, settlements, ledgerEntries, adjustments }`；金额全部来自 settlement / adjustment / invoice 事实，未读取 `Case.recoveredAmount` 作为真相 |
| 8 Multi-currency safety | 禁止跨币种相加；按币种聚合；不做 FX | 全部 bucket 以 currency 为键（`Map<currency, Bucket>`）；集成测试断言 USD / EUR 各自分组且不合并 |
| 9 Reversal / adjustment visibility | reversal / correction / adjustment / void 必须反映；展示 gross / adjustments / net | `recovered`（gross）、`adjustments`（仅 REVERSAL 冲减）、`netRecovered` 三者同时暴露；`VOID` settlement 排除；验收用例断言 100 recovered − 100 reversal = 0 net 且状态 REVERSED |
| 10 Customer status semantics | 稳定 money status（DISCOVERED / IN_PROGRESS / APPROVED / PARTIALLY_RECOVERED / RECOVERED / DISPUTED / REVERSED），由既有事实推导 | `deriveMoneyStatus()` + `MONEY_STATUS_LABEL` 中文标签；未新建持久化 money state machine |
| 11 UI | 至少 case page 与 organization-level overview | 新增 `/money` 组织汇总 + 案件明细表（可点进案件）；每行展示状态、可追回 / 已追回 / 净追回 / 未追回、时间线、lineage，并显式标注 collection NOT_ENABLED |

## 2. 验证证据（对照 MSG-86 ⑦）

| # | 验收项 | 证据 |
|---|---|---|
| 1 | same tenant money visible | `recovery-money-view-http-db`「same tenant visible / foreign invisible / 无 secret 字段」 |
| 2 | foreign tenant money invisible | 同上（ORG_B 的 settlement 不出现在本租户汇总） |
| 3 | multi-currency separated | 「multi-currency 分组」：USD 50 / EUR 70 各自成组，`byCurrency.length = 2` |
| 4 | EXPECTED != RECEIVED | 「EXPECTED ≠ RECEIVED…」：expected=30、recovered=40（EXPECTED 不计入 recovered） |
| 5 | PARTIAL reflected correctly | 同上（PARTIAL 40 计入 recovered） |
| 6 | reversal reduces net recovered | 「reversal 冲减 netRecovered」：recovered=100、adjustments=100、netRecovered=0 |
| 7 | VOID excluded from net | 「EXPECTED ≠ RECEIVED…」中 VOID 10 未进入任何金额 |
| 8 | disputed money not counted as safely recovered | 同上：disputed=20 单独计数且 case 状态 = DISPUTED |
| 9 | organization summary matches case·settlement facts | 「multi-currency 分组」断言 org byCurrency 与 case 明细同币种一致 |
| 10 | fee calculated != fee collected | 「fee calculated ≠ fee collected」：feeCalculated=20（VOID 账单排除）、feeCollected=0 |
| 11 | Payment=0 / collection OFF accurately exposed | 同上：`payment='ZERO'`、`collection='NOT_ENABLED'`、feeNote 含 NOT_ENABLED |
| 12 | no cross-account settlement leakage | 跨租户 case 用 `?caseId=` 查询 → 404（「caseId 过滤」用例）+ 外租户 settlement 不进本租户汇总 |
| 13 | legacy NULL lineage not guessed | 投影只用 settlement / claim item 事实，不读取 connection 推断 account（PC-03 / Track B 冻结语义保持） |
| 14 | no secret/payment credential fields | 响应文本断言不含 externalRef / credentialRef / passwordHash / secret / token / storageKey |
| 15 | FINANCE read semantics consistent | 「unauthorized → 401；VIEWER → 403；FINANCE（viewBilling）→ 200」 |
| 16 | unauthorized → 401 | 同上 |
| 17 | existing R45/R46 settlement·reconciliation regressions green | CI 全量（settlement-record / settlement-reversal / financial-chain-consistency 等套件） |
| 18 | tsc api·web 0 | 本地 `tsc --noEmit`（api / web）0 error |
| 19 | full CI SUCCESS | RUN_ID = 37030847155 · head = 3cef00995402ceaef5168ffe2ad8e27573aafff5 · 5 jobs 全绿 |

补充：本地 API contract `API_CONTRACT_OK`（新增 `GET /recovery-money` 已登记）。

## 3. 明确未做（遵守 MSG-86 ⑧）

未 activate payment；未 collect success fee；未 create payout；未 write provider settlement；未 connect PSP；未 add FX engine；未 redesign R46 finance chain；未 modify account lineage；未 build accounting system。未改 Schema、未加 migration、未新增写端点。

## 4. 下一执行单元（待裁决）

若 PASS：按 PC 队列进入 **PC-06 Account management**（profile / members / 连接自助管理）。
边界保持：NO platform write · Payment = 0 · autopay = OFF · collection = OFF · external payment write = OFF · R13 HOLD · TRANSPORT=false · 无生产凭据。
