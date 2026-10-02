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

## 6. CHANGE C2-FINAL-2-A —— dual-context consistency（源码与测试证明，MSG-20261002-69）

冻结要求不是“连接优先”，而是**多上下文各自解析后必须指向同一 PlatformAccount**。实现与证明如下：

- 源码：`apps/api/src/services/evidence/account-scope.ts` → `resolveEvidenceAccountId()`：对 `connectionId` 与 `caseId` **分别解析**（`resolveAccountIdFromConnection` / `resolveAccountIdFromCase`），再要求解析结果集合大小为 1；否则抛 `PLATFORM_ACCOUNT_REQUIRED`（不写任何事实）。
- 专项测试：`apps/api/src/__tests__/c2-dual-context-resolver-db.test.ts`（真实 PostgreSQL，4 项）：
  1. `connection=A + case=A` → PASS（返回该 account）；
  2. `connection=A + case=B` → **stable fail-closed**，且断言零 `EvidenceArtifact` / 零 `CaseEvidence` 副作用；
  3. connection-only 与 case-only → 均可独立解析 PASS；
  4. case lineage：多账户 / NULL 与非 NULL 混杂 / 全 NULL / 无 lineage → 全部 fail-closed。
- 既有解析器测试：`apps/api/src/__tests__/evidence-account-scope-db.test.ts`（连接派生成功 / 缺连接 / 连接未绑定 / case 唯一主张成功 / 无主张·多账户·含 NULL fail-closed）。
- 本地结果：上述两套件 **7/7 PASS**（HEAD `55383f3`）。

## 7. 待架构方裁决的阻塞点（Ask，Issue #2 comment 5949608255）

CHANGE A 落地后 CI 暴露的产品契约缺口：`POST /opportunities/:id/case` → `services/workflow/case-creation.ts:158 runRecoveryClosure(...)` → closure-service 新建 Evidence 现在按 MSG-68 fail-closed；而这条 HTTP 路径的机会来自「HTTP 建连接 + 导入/检测」，**连接创建 API 没有 account 绑定入口**（无法把 `SourceConnection` 关联到 `PlatformAccount`）→ 机会/事实必然 account 为空 → 500（探针取证：`{"error":"WORKFLOW_ERROR"}`）。

选项：A) 连接创建 API 增加 server-derived account 绑定（新 API 契约）；B) closure-service 的 `fixture-derived` / `synthetic … (test/demo only)` 占位证据豁免，仅真实 ingest 强制 fail-closed；C) 架构方指定其它窄修。

## 8. CHANGE C2-FINAL-2-B —— 最终 CI 状态（MSG-20261002-70 裁决 C 执行后）

| 项 | 值 |
|---|---|
| final REVIEWED_HEAD | `55921f3` |
| CI | **SUCCESS** |
| CI run id | **36993735092**（CI · gate/7-commercial-validation） |
| C2 专项（8 套件） | **36/36 PASS** |
| tsc --noEmit | 0 error |

### 8.1 CHANGE C（account-aware fixture repair，MSG-20261002-70 授权）

- `workflow-http-db`：seed `PlatformAccount` 并在 opportunity 创建处写服务端可信 `accountId` → 7/7（`4e1405a`）。
- `workflow-case-db`：按租户绑定 fixture account（跨租户用例用 ORG_B 的 account）→ 7/7（`0381e3b` + 负路径 `55921f3`）。
- `workflow-hitl-db`：`seedReadyCase` 增 account-scoped `ClaimItem`（case 主张链派生）→ 5/5（`eb5119d`）。
- 早前已修：`action-guard-hitl-*` 4 套（`0f900e1`，23/23）、`workflow-outcome-db`（`c612d83`，7/7）。

### 8.2 永久 fail-closed 负路径（MSG-70 §4）

`workflow-case-db` 新增并永久保留：`QUALIFIED opportunity(accountId=NULL)` → `createCaseForOpportunity` → **rejects `PLATFORM_ACCOUNT_REQUIRED`**，且断言 **0 Case / 0 Evidence / 0 Claim / 0 Settlement** —— 证明 C2 的安全边界不依赖“夹具刚好都有 account”。

### 8.3 转入 PHASE X1 的 finding（MSG-70 §5）

Connection API 当前无 account 绑定入口（`SourceConnection.platformAccountId` 可为 NULL 并继续被 ingest 使用）—— 记录为 **PHASE X1 Architecture Audit finding / TRACK B 输入项**，本轮不实现；X1 需裁决后续产品契约（account-scoped ingest 拒绝 unbound connection，或 onboarding 先绑定/创建 PlatformAccount）。

未采纳：Option A（扩张连接创建 API 契约）REJECT；Option B（test/demo NULL provenance 豁免）REJECT（closure-service 的 fixture-derived Evidence 在非模拟建案路径同样落库）。
