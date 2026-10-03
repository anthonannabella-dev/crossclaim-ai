# PC-07 ENTITLEMENT + PACKAGE UNLOCK CHECKPOINT

状态：**READY_FOR_REVIEW / IMPLEMENTATION CHECKPOINT**（待架构方裁决）
IMPLEMENTATION_HEAD = 2c17d57
IMPLEMENTATION_HEAD_FULL = 2c17d57201d9eccb1f4c486a7378606e6bd61594
CI = SUCCESS · RUN_ID = 37040837928 · CI_HEAD = 2c17d57
授权：MSG-20261003-92 ⑨（PC-07 ENTITLEMENT + PACKAGE UNLOCK；ACCESS / ENTITLEMENT VISIBILITY + UNLOCK LOGIC，**不是** PAYMENT ACTIVATION）。
边界：NO platform write · **Payment = 0 · collection = OFF 保持** · 无 checkout / 无扣款 / 无订阅计费引擎 · TRANSPORT=false · 无生产凭据。

## 1. 范围逐项落地（MSG-92 PC-07 SCOPE 1–10）

| 项 | 要求 | 实现 |
|---|---|---|
| 1 Entitlement projection | tenant-scoped 只读；plan / entitlement key / allowed·denied / limit / used / remaining / reason / source；不得把规则散在前端 | `getEntitlementProjection()` 返回 `entitlements[]`（key / allowed / limit / used / remaining / usageState / reason / source + capability surface）；key 覆盖 opportunities.read、claim.package.view、claim.package.download、claim.prepare、appeal.package、account.count、connection.count |
| 2 Package unlock state | LOCKED / ELIGIBLE / UNLOCKED / EXHAUSTED / NOT_AVAILABLE，由服务端事实派生，不新建第二套 package state machine | `packageUnlock.state` 由 entitlement（view / download 的 available、upgradeRequired、remaining）与既有 plan 事实推导；无新状态机、未改 Claim/Package 模型 |
| 3 Unlock prerequisite | 必须区分「功能资格」与「付款完成」；付款未启用时不得写「已付款解锁」 | 返回 `eligibility`（ELIGIBLE / NOT_ELIGIBLE）与 `paymentCompleted: false`、`paymentState: ZERO`、`collectionState: OFF` 分离；TRIAL 下状态为 LOCKED + label「已锁定（需要升级套餐）」，绝不出现「已付款解锁」文案 |
| 4 Entitlement source of truth | 复用 `Organization.plan` 与既有 plan/commercial 配置；不复制第三份 plan matrix | 新增**唯一** plan 矩阵 `services/entitlements/plan-entitlements.ts`（TRIAL / STANDARD）；`Organization.plan` 为唯一租户侧事实来源 |
| 5 Usage counters | 有真实 usage facts 才展示 used/limit/remaining；否则 `usageState = NOT_TRACKED`（不猜） | account.count / connection.count 由真实计数事实给出（TRACKED + used/limit/remaining）；其余能力返回 `usageState: NOT_TRACKED`、`used: null`、`remaining: null` |
| 6 Customer capability surface | 每个 entitlement 返回 available / reason / upgradeRequired / paymentRequired / entry；paymentRequired ≠ payment executable | 六个字段齐备；`paymentRequired: true` 仅表示「需要付费能力」，而 `upgrade.available = false`（付款不可执行） |
| 7 Package download gating | 下载必须由 server-side entitlement / package readiness 决定；若缺 enforcement 需补 guard | 新增 `assertPackageDownloadEntitled(prisma, actor)`：套餐不含 `claim.package.download` → `FORBIDDEN` fail-closed（TRIAL 拒绝 / STANDARD 放行）；已在验收中覆盖「UI 隐藏 ≠ 服务端允许」 |
| 8 Plan upgrade entry | 可提供 upgrade guidance；真实购买 capability `available=false` + `PAYMENT_NOT_ENABLED`；**不做假 checkout** | `upgrade = { available:false, reason:'PAYMENT_NOT_ENABLED', guidance:'…不会发起任何扣款' }`；仓库无 checkout / 扣款路径 |
| 9 UI | 至少在 claim package / account·plan settings 展示当前套餐 / 已解锁能力 / 剩余额度 / 锁定原因 / 升级说明；不做复杂 pricing site | 新增 `/plan`（套餐与解锁）：当前套餐、package unlock 状态与「资格 vs 付款完成」分离展示、能力与额度表（含 NOT_TRACKED 显示为「未跟踪」）、升级说明区 |
| 10 Fail-closed | 缺 config → DENIED；未知 plan → fail-closed；不 allow-by-default | `rulesForPlan()` 对未知 plan 返回 `DENY_ALL_RULES`（`UNKNOWN_PLAN_FAIL_CLOSED`），`planKnown=false`；验收断言全部 allowed=false |

## 2. 验证证据（MSG-92 PC-07 REQUIRED TESTS）

| 验收项 | 结果 |
|---|---|
| same tenant entitlement visible | PASS |
| foreign tenant invisible（各自只看自己的 plan） | PASS |
| known plan → correct entitlement | PASS（TRIAL：opportunities.read / claim.package.view allowed；header reason = ALLOWED_BY_PLAN） |
| unknown plan → fail-closed | PASS（planKnown=false，全部 DENIED + UNKNOWN_PLAN_FAIL_CLOSED，packageUnlock=NOT_AVAILABLE） |
| unlocked package available | PASS（STANDARD：download available=true → packageUnlock=UNLOCKED） |
| locked package unavailable | PASS（TRIAL：download available=false → packageUnlock=LOCKED） |
| exhausted limit denied | PASS（3 个账户 / limit 3 → allowed=false + LIMIT_EXHAUSTED + remaining 0） |
| used/remaining arithmetic correct when tracked | PASS（used=2 / limit=3 / remaining=1） |
| usage unavailable → NOT_TRACKED, not guessed | PASS（opportunities.read：NOT_TRACKED + null） |
| package readiness + entitlement both required | PASS（download guard 独立于 package readiness 生效） |
| UI hidden action also server-side denied | PASS（`assertPackageDownloadEntitled` 直接拒绝 TRIAL） |
| paymentRequired does not imply payment executable | PASS（paymentRequired=true 且 upgrade.available=false） |
| upgrade action unavailable while Payment=0 | PASS（reason=PAYMENT_NOT_ENABLED） |
| no fake checkout | PASS（无 checkout 路由 / 无扣款路径；guidance 明示不会扣款） |
| FINANCE / VIEWER permission consistent | PASS（FINANCE 200 / VIEWER 403 / 未认证 401） |
| unauthorized → 401 | PASS |
| existing claim-package / billing·commercial-term regressions green | CI 全量（API job） |
| tsc api·web 0 | PASS |
| full CI SUCCESS | RUN_ID = 37040837928 · 5 jobs 全绿 |

套件：`entitlements-http-db` **9/9 PASS**（真实 HTTP + PostgreSQL）；本地 API contract `API_CONTRACT_OK`（新增 `GET /entitlements` 已登记）。

## 3. 明确未做（MSG-92 PC-07 不要做）

未 activate Stripe/PayPal；未 collect money；未 create checkout；未 charge card；未 auto-upgrade plan after payment；未 change R13；未 enable external payment writes；未 implement subscription billing engine；未 build pricing experimentation system。未改 Schema、未加 migration、未新增写端点。

## 4. 下一执行单元（待裁决）

若 PASS：PC-07 = PASS / CLOSED → 按队列进入 **PC-08 Ops readiness（monitoring + rate limit + unified failed-job recovery）**。
边界保持：NO platform write · Payment = 0 · autopay = OFF · collection = OFF · external payment write = OFF · R13 HOLD · TRANSPORT=false · 无生产凭据。
