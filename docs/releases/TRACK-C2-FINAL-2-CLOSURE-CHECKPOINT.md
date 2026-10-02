# TRACK C2 FINAL-2 — Closure Checkpoint（MSG-20261002-68 CHANGE A/B 收口）

状态：**READY_FOR_REVIEW（本地全绿；等待架构方裁决）**
依据：MSG-20261002-68（REVISE：C2 主体 PASS，但 active new-write paths 不得继续产生 NULL account provenance；须补 Settlement 端到端 lineage 证明）
边界：NO platform write · Payment = 0 · collection / autopay / external payment write OFF · R13 HOLD · `TRANSPORT=false` · 无生产凭据。

## 1. CHANGE A —— 三条 active Evidence write path 收口（4/4）

| 写路径 | 收口方式 | 提交 |
|---|---|---|
| `services/evidence/prisma-ports.ts` | 统一走 `resolveAccountIdFromConnection`（无可信连接 → `PLATFORM_ACCOUNT_REQUIRED`） | `b8b730a` |
| `services/evidence/pod-upload.ts` | 输入契约新增可信 `connectionId`；FileAsset 记录连接上下文；证据写入前派生 account；无连接/无 case 主张链 → fail-closed。夹具 account-aware 化并断言 `evidence.accountId` | `5c06d7e` |
| `services/workflow/recovery-outcome.ts`（人工确认凭证） | 由 `case → ClaimItem.accountId` 派生；无法唯一确定 → fail-closed | `522a12f` |
| `services/recovery/closure-service.ts`（2 处合成/演示证据） | 由 `case → ClaimItem.accountId`，无主张时回退 `case → CaseOpportunity → RecoveryOpportunity.accountId`；detection 在没有 canonical 身份时从被评估的 `SourceTransaction.accountId` 派生 opportunity 归属；夹具 account-aware 化 | `a18c22d` |

统一解析入口：`services/evidence/account-scope.ts`（连接优先 → case 主张链 → opportunity 链；缺失/多账户/含 NULL 一律 fail-closed，客户端传入 account 不参与判定）。

## 2. CHANGE B —— Settlement 端到端 account lineage（3/3）

不新增 `Settlement.platformAccountId`；以现有 lineage `Settlement → ClaimItem / EvidenceArtifact → PlatformAccount` 反查，永久验收见 `apps/api/src/__tests__/c2-settlement-lineage-db.test.ts`：

1. account-scoped evidence + claim → Settlement 唯一反查同一 PlatformAccount；
2. Account A 的 Evidence 不能绑定 Account B 的 Settlement → DB 触发 `CROSS_ACCOUNT_SETTLEMENT_LINKAGE` 拒绝且零落库；
3. legacy（两端 NULL）仍可读，lineage 结果为 `null`——不被解释为任意 account。

## 3. MSG-68 TEST 清单映射

| MSG-68 要求 | 证明 |
|---|---|
| pod-upload 新 Evidence → server-derived account | `pod-evidence` 5/5（含 `evidence.accountId === accountId` 断言） |
| closure-service 新 Evidence → server-derived account | `closure-db` + `detection-db` 23/23 |
| recovery-outcome 新 Evidence → server-derived account | `recovery-confirmation-db` 23/23（与 closure-db 同批） |
| ambiguous / missing account → fail-closed，不写 NULL new fact | `evidence-account-scope-db` 3/3（缺连接 / 连接未绑定 / case 无主张 / 多账户 / 含 NULL） |
| client account spoof → rejected/ignored | `c2-account-scope-db`（`CLIENT_ACCOUNT_FIELD_NOT_TRUSTED`）+ 解析器只接受服务端上下文 |
| Account A evidence → Account B claim/settlement → reject | `c2-cross-account-guards-db` 4/4 · `c2-settlement-lineage-db` 3/3 |
| account-scoped Evidence → Settlement lineage → same account | `c2-settlement-lineage-db` 3/3 |
| legacy NULL 可读且不获得伪造身份 | `c2-settlement-lineage-db` 第 3 例 · `c2-account-scope-db` legacy 用例 |
| reconnect / credential rotation 不改历史 provenance | `c2-platform-account-identity-db` 4/4 · `c2-account-boundary-baseline` 7/7 |
| existing C2 suite remains green | 本轮 C2 专项 7 套件 **32/32 PASS** |
| R46 S1–S6 regression remains green | CI 全量套件（API · migration + typecheck + tests） |
| CI / fresh / upgrade gates remain green | CI + `20261002040000`…`20261002090500` 迁移链（fresh deploy 已在前批验证，本次未新增迁移） |

## 4. 证据汇总

| 项 | 结果 |
|---|---|
| C2 专项（7 套件） | **32/32 PASS** |
| 相关域套件 | pod-evidence 5/5 · closure-db + detection-db 23/23 · recovery-confirmation-db + closure-db 23/23 |
| `tsc --noEmit` | 0 error |
| 迁移 | 本次未新增迁移（沿用至 `20261002090500`） |

## 5. KEEP（未违反）

未强行回填 legacy NULL；未按 label 猜 account；未任选第一个 PlatformAccount；未新增全局 `UNIQUE(provider, externalAccountId)`；未把 credential rotation 当作 identityVersion 更新；未重构 R46 财务链。
