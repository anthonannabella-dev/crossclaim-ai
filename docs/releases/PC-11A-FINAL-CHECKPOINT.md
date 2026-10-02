# PC-11A FINAL — INTERNAL PROVIDER INTEGRATION CONTRACT（CHANGE A–D）CHECKPOINT

状态：**READY_FOR_REVIEW / REVISE 收口**（待架构方裁决）
前序：PC-11A 首版 IMPLEMENTATION_HEAD = 89a9505 / CI 37056295942 → **MSG-20261003-100 = REVISE-MINOR**（CHANGE A–D）。
IMPLEMENTATION_HEAD = 8ff413b
IMPLEMENTATION_HEAD_FULL = 8ff413bb95de42be620305da5e544568c7e8a360
CI = SUCCESS · RUN_ID = 37058077900 · CI_VERIFIED_HEAD = 8ff413b
边界：真实 provider 调用 / 生产凭据 = **PC-11B（HOST / EXTERNAL GATE）** · NO platform write · TRANSPORT=false · Payment HOLD · 无生产凭据。

## 1. CHANGE A — 缺 authorization code 必须 fail-closed

`handleProviderCallback()` 在**任何 exchange 之前**校验 `input.code`（undefined / 空串 / 仅空白）→ 返回稳定原因码 **`AUTHORIZATION_CODE_REQUIRED`**；
保证 **exchange 不被调用、verifier 不被调用、无 bind plan、无 credential mutation**（测试以 spy 断言 exchange 零调用）。state 仍保持「一次 callback attempt 即消费」。

## 2. CHANGE B — PKCE 契约（能力显式，verifier 只在服务端）

- `ProviderIntegrationContract.pkce = { supported, required, method }`：OAUTH provider（AMAZON / TIKTOK_SHOP / WALMART）→ `{ supported: true, required: true, method: 'S256' }`；API_KEY provider（UPS / FEDEX）→ `{ supported: false, required: false, method: null }`（**显式**，不猜）。
- `issueOAuthState()`：required 时生成 server-side `code_verifier` 并派生 `code_challenge = S256(verifier)`；**公开结果只含 challenge / method**，verifier 仅存在于服务端 state 记录（测试断言 verifier 不在公开结果中）。
- `handleProviderCallback()`：required 时 verifier 必须来自服务端 state 记录且一致 → 否则 `PKCE_VERIFIER_REQUIRED` / `PKCE_VERIFIER_MISMATCH`（且不调用 exchange）；exchange 端口接收的 verifier 是**服务端值**，不是浏览器自证值。
- sandbox harness：PKCE provider 的 `approve` 必须携带 challenge（否则 `SANDBOX_PKCE_CHALLENGE_REQUIRED`）；`exchangeCode` 缺 verifier → `SANDBOX_PKCE_VERIFIER_REQUIRED`，不匹配 → `SANDBOX_PKCE_VERIFIER_MISMATCH`（校验先于消费授权码，成功才删除）。

## 3. CHANGE C — provider 凭据生命周期 port

`ProviderCredentialLifecyclePort`：

- `refresh({ provider, organizationId, credentialRef }) → { credentialRef, expiresAt? }`
- `revoke(...) → { revoked }`
- `health(...) → { state: ACTIVE | NEEDS_AUTH | REVOKED | ERROR }`

不变量与语义：

- **refresh 只返回 credentialRef**；`assertRefreshResultTouchesOnlyCredential()` 拒绝任何身份字段（`externalAccountId` / `identityVersion` / `platform` / `accountId`）→ **credential rotation ≠ business identity rotation**（不会创建/改变 PlatformAccount identity）。
- `mapProviderRevocationToConnectionState()`：`revoked` / `REVOKED` → `REVOKED`；`INVALID_GRANT` → `NEEDS_AUTH`；其余 → `ERROR`（与 PC-06 冻结的 reconnect truth 对齐）。
- `PROVIDER_RECONNECT_CAPABILITY = { available: false, reason: 'REAL_OAUTH_EXTERNAL_GATE' }` —— **新增接口不得把 reconnect 提前翻成 available=true**。
- sandbox 实现（`createSandboxCredentialLifecyclePort`）：不发起网络请求；未知 provider → null（fail-closed）。

## 4. CHANGE D — 能力矩阵表达生命周期真相

`projectProviderReadiness()` / `GET /provider-readiness` 现包含：

```text
capabilities:
  oauth:   { supported, implemented }
  pkce:    { supported, required, method }
  refresh: { supported, implemented }
  revoke:  { supported, implemented }
  webhook: { supported, verificationReady }
readOnlyScopes
productionApprovalState: NOT_REQUESTED
sandboxState: AVAILABLE
reconnect: { available: false, reason: REAL_OAUTH_EXTERNAL_GATE }
```

`implemented` 恒 `false`（真实调用属 PC-11B）；production 仍恒 `EXTERNAL_GATE` / `productionCredentials=ABSENT` / `platformWriteEnabled=false` —— **不出现假 production-ready**。

## 5. 验证证据（MSG-100 ⑲ Required targeted tests）

| 要求 | 用例 |
|---|---|
| empty code → AUTHORIZATION_CODE_REQUIRED | `provider-callback`「CHANGE A：空 code → AUTHORIZATION_CODE_REQUIRED 且 exchange 不被调用」 |
| empty code → exchange NOT called | 同上（`vi.fn()` spy 断言零调用） |
| provider PKCE capability explicit | `provider-integration-contract`「PKCE 能力显式声明（OAUTH → S256 required；API_KEY → 明确不支持）」 |
| PKCE-required provider issue → verifier generated | 「issue → consume 成功…PKCE verifier 只在服务端」（state 记录含 verifier） |
| verifier 不出现在 public result / log | 同上：`JSON.stringify(issued)` 不含 verifier；bind plan 亦不含 verifier |
| callback exchange receives server-side verifier | `provider-callback` happy path（exchange 收到服务端 verifier 并成功） |
| wrong/missing verifier fail-closed in sandbox harness | sandbox 用例（缺 verifier / verifier 不匹配分别拒绝；正确 verifier 成功且授权码一次性） |
| refresh contract only returns credentialRef | `provider-credential-lifecycle`「refresh 只返回 credentialRef」 |
| refresh does not create/change PlatformAccount identity | `assertRefreshResultTouchesOnlyCredential` 拒绝身份字段 |
| revoke maps to REVOKED / NEEDS_AUTH semantics | 「revoke → REVOKED；invalid_grant → NEEDS_AUTH；未知 → ERROR」 |
| health contract returns stable lifecycle state | 「health 返回稳定生命周期状态」 |
| reconnect remains REAL_OAUTH_EXTERNAL_GATE | 「新增接口不改变 reconnect truth」+ readiness 逐 provider 断言 |
| provider readiness exposes capability truth | readiness 用例逐 provider 断言 capabilities / readOnlyScopes / productionApprovalState / sandboxState |
| no write scopes | 契约与能力矩阵断言（readOnlyScopes 无 write；webhook verificationReady=false） |
| productionCredentials remains ABSENT | readiness 断言 |
| platformWriteEnabled remains false | 契约与 readiness 断言 |
| tsc api / web 0 | 0 error |
| full CI SUCCESS | RUN_ID = 37058077900（head 8ff413b）5 jobs 全绿 |

### 套件结果（24/24）

- `provider-integration-contract`：**11/11**
- `provider-callback`：**6/6**
- `provider-credential-lifecycle`：**6/6**
- `provider-readiness-http-db`：**1/1**
- 另：`verdict-diff` 工具修正（支持三位消息号 `MSG-YYYYMMDD-NNN`，e7d31ab）

## 6. 明确未做（遵守 PC-11A 边界）

未重做已通过的架构项（32B state / TTL / state binding / burn-on-mismatch / replay prevention / callback ordering）；未实现真实 provider 网络调用（PC-11B）；未产生 fake PRODUCTION_READY；未启用 platform write / TRANSPORT / payment；未请求 broad write scope；未获取生产凭据。

## 7. 下一执行单元（待裁决）

若 PASS：PC-11A = PASS / CLOSED → 真实接入只剩 **PC-11B（HOST / EXTERNAL GATE）**；内部侧可继续按架构方指定的下一单元推进。
边界保持：NO platform write · Payment = 0 · autopay = OFF · collection = OFF · external payment write = OFF · R13 HOLD · TRANSPORT=false · 无生产凭据。
