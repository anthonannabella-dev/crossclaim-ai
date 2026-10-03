# PC-11A — INTERNAL PROVIDER INTEGRATION CONTRACT CHECKPOINT

状态：**READY_FOR_REVIEW**（待架构方裁决）
IMPLEMENTATION_HEAD = 89a9505
IMPLEMENTATION_HEAD_FULL = 89a9505c3c53532a6bd09110c6962dc4d1623455
CI = SUCCESS · RUN_ID = 37056295942 · CI_VERIFIED_HEAD = 89a9505
授权：MSG-20261003-99 ⑲（PC-11A INTERNAL PROVIDER INTEGRATION CONTRACT）。
边界：**真实 provider 凭据 / 审批 = PC-11B（HOST / EXTERNAL GATE）** · NO platform write · TRANSPORT=false · Payment HOLD · 无生产凭据。

## 1. 范围逐项落地（MSG-99 ⑲ PC-11A 清单）

| 项 | 落地 |
|---|---|
| interfaces | `CodeExchangePort`（code → 凭据引用/scope）、`OAuthStateStore`（issue/take）、复用既有 `PlatformIdentityVerifier` 端口 |
| OAuth state lifecycle | `services/connect/oauth-state.ts`：32B 随机 state（不含 PII/secret）；绑定 provider + organization + user + callbackPath；TTL 默认 600s；**一次性原子消费**；provider/租户/用户/回调不匹配 → 各自原因码且烧掉 state；未知 provider / 未登记回调 → issue 阶段 fail-closed |
| callback boundary | `services/connect/provider-callback.ts`：consume state → resolve contract → exchange code → scope 边界校验 → **身份必须经 verifier 服务端验证** → 返回绑定计划（`bindExecuted=false`，本批不写库、不绑定）；失败面为稳定原因码 |
| credential reference boundary | 全链路只传递 `credentialRef`；明文永不入库 / 永不入日志 / 永不回显；`productionCredentials` 恒 `ABSENT` |
| identity verification port | 回调边界强制调用 `PlatformIdentityVerifier`；未登记身份 → `IDENTITY_NOT_VERIFIED`（不产出绑定计划） |
| adapter capability registry | 复用既有 `services/adapters/registry.ts` + `services/platform-write/adapter-capability.ts`（本批未改） |
| account bind integration | 回调产出**绑定计划**（provider / organization / user / credentialRef / 已验证身份 / scopes）；真实绑定执行保持 HOLD（PC-11B 放行后接线） |
| status lifecycle | 复用既有 `SourceConnection` 状态生命周期与 `POST /connections/:id/status`（本批未改） |
| provider-readiness | `projectProviderReadiness()` + 只读 `GET /provider-readiness`：`contractReady=true` / `productionCredentials=ABSENT` / `readiness=EXTERNAL_GATE` / `platformWriteEnabled=false` + `requiredHostActions` |
| tests | 见 §2（新增 17 项永久回归） |
| sandbox / fake provider harness | `services/connect/sandbox-provider.ts`：approve → code → exchangeCode，产物 `sandbox:true`、`credentialRef` 前缀 `SANDBOX:`、授权码一次性；**不产生 PRODUCTION_READY** |

## 2. 验证证据

| 套件 | 结果 |
|---|---|
| `provider-integration-contract`（纯内存） | **10/10 PASS**（state 一次性/TTL/四类绑定不匹配/未知 provider 与非法回调 fail-closed；契约无 write scope、platformWrite=false；readiness 恒 EXTERNAL_GATE 且伪造 PRODUCTION_READY 被 `assertProviderNotProductionReady` 拒绝；sandbox 产物无生产形 secret） |
| `provider-readiness-http-db`（真实 HTTP + PostgreSQL） | **1/1 PASS**（未认证 401；成员 200；逐 provider 恒 EXTERNAL_GATE / ABSENT / platformWrite=false；响应无泄漏标记） |
| `provider-callback`（纯内存） | **6/6 PASS**（sandbox happy path → 绑定计划 `bindExecuted=false`；state 重放；provider/租户/用户/回调不匹配；exchange 失败；broad write scope → `SCOPE_ESCALATION_REJECTED`；身份不可验证 fail-closed） |
| 本地 API contract | `API_CONTRACT_OK`（implemented=83 / documented=70；新增 `/provider-readiness` 已登记） |
| tsc api / web | 0 error |
| full CI | RUN_ID = 37056295942（head 89a9505）5 jobs 全绿 |

## 3. 明确未做（遵守 PC-11A 边界）

未产生 fake `PRODUCTION_READY`；未硬编码生产 token；未启用 platform write / TRANSPORT / payment；未请求 broad write scope；未合并 `PlatformAccount` 与 `SourceConnection`；未用浏览器自动化替代 OAuth；未发起任何真实 provider 请求；未获取生产凭据。

## 4. PC-11B — HOST / EXTERNAL GATE（必须由宿主/外部完成，不能由内部代码凭空产生）

- provider developer account approval（Amazon / TikTok Shop / Walmart / 承运商）
- production client IDs / secrets 由 HOST 写入安全配置；production webhook secrets
- callback-domain registration（DNS / 域名）
- real seller authorization（真实卖家授权）

在这些完成之前，`/provider-readiness` 对每个 provider 恒返回 `EXTERNAL_GATE`，且 `platformWriteEnabled=false`。

## 5. 下一执行单元（待裁决）

若 PASS：PC-11A = PASS / CLOSED → 真实接入只剩 PC-11B（HOST / EXTERNAL GATE），或按架构方指定的下一内部单元推进。
边界保持：NO platform write · Payment = 0 · autopay = OFF · collection = OFF · external payment write = OFF · R13 HOLD · TRANSPORT=false · 无生产凭据。
