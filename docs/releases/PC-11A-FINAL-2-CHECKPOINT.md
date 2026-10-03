# PC-11A FINAL-2 — SERVER-SIDE PKCE VERIFIER OWNERSHIP CHECKPOINT

状态：**READY_FOR_REVIEW / REVISE 收口**（待架构方裁决）
前序：PC-11A FINAL IMPLEMENTATION_HEAD = 8ff413b / CI 37058077900 → **MSG-20261003-101 = REVISE-MINOR**（唯一剩余：server-side PKCE verifier ownership）。
IMPLEMENTATION_HEAD = 24e27c8
IMPLEMENTATION_HEAD_FULL = 24e27c8490f5480fe3b584bacbeb825de1930c97
CI = SUCCESS · RUN_ID = 37059665748 · CI_VERIFIED_HEAD = 24e27c8
边界：真实 provider 调用 / 生产凭据 = **PC-11B（HOLD_EXTERNAL / HOST_ACTION_REQUIRED）** · NO platform write · TRANSPORT=false · Payment HOLD · 无生产凭据。

## 1. 唯一改动：PKCE verifier 归服务端所有

架构方诊断（MSG-101 ㉒）：「PKCE verifier 已经生成并保存在服务端，却又要求客户端回传一次。」本批按此收口：

- `ProviderCallbackInput` **删除** `codeVerifier` 字段 —— callback 不再接受任何 client-supplied verifier（类型层面即不可表达）。
- `handleProviderCallback()`：PKCE required 时直接取 `consumed.record.codeVerifier`（服务端 state 记录）作为 `serverCodeVerifier`；缺失 → 稳定原因码 **`PKCE_VERIFIER_MISSING`**（服务端 invariant 失败，而非客户端参数错误）。
- exchange 端口只接收**服务端**推导出的 `codeVerifier`；客户端即使注入同名字段也会被忽略（测试断言 exchange 收到的是 state 内的 verifier，且伪造值不出现在结果里）。
- 旧的 `PKCE_VERIFIER_REQUIRED` / `PKCE_VERIFIER_MISMATCH` 原因码已移除（不再有客户端 verifier 可比较）。
- sandbox harness 行为不变：`approve` 必须携带 challenge；`exchangeCode` 校验 verifier 与 challenge 的 S256 关系（校验先于消费授权码，成功才删除）。

未改动（MSG-101 ㉒ 明确「不要重改」）：OAuth state lifecycle（32B state / TTL / 绑定 / burn-on-mismatch）、missing-code fail-closed、生命周期 port、readiness 能力矩阵、reconnect truth、scope 边界、identity verifier。

## 2. 验证证据

| 项 | 证据 |
|---|---|
| callback 不接受客户端 verifier | `provider-callback`「FINAL-2：PKCE verifier 归服务端所有 —— exchange 收到 state 里的 verifier，客户端自报值被忽略」：`received = [VERIFIER]`，且 outcome 中不含 `attacker-supplied` |
| exchange 使用服务端 verifier | 同用例（spy 捕获 exchange 收到的 `codeVerifier` 等于 `issueOAuthState` 写入 state 的 verifier） |
| PKCE-required provider issue → verifier generated（保持） | `provider-integration-contract`「issue → consume 成功…PKCE verifier 只在服务端」 |
| verifier 不出现在 public result / log（保持） | 同用例：`JSON.stringify(issued)` 不含 verifier；plan 亦不含 |
| sandbox challenge/verifier 校验（保持） | 「PKCE-required provider 必须 challenge + verifier 匹配」（缺 challenge / 缺 verifier / 不匹配 fail-closed；正确 verifier 成功且授权码一次性） |
| 缺 code fail-closed（保持） | 「空 code → AUTHORIZATION_CODE_REQUIRED 且 exchange 不被调用」 |
| 其余能力矩阵 / 生命周期 port（保持） | `provider-integration-contract` 11/11、`provider-credential-lifecycle` 6/6、`provider-readiness-http-db` 1/1 |
| tsc api / web | 0 error |
| full CI | RUN_ID = 37059665748（head 24e27c8）5 jobs 全绿 |

### 套件结果（24/24）

- `provider-callback`：**6/6**（PKCE ownership 用例替代旧的 REQUIRED/MISMATCH 用例）
- `provider-integration-contract`：**11/11**
- `provider-credential-lifecycle`：**6/6**
- `provider-readiness-http-db`：**1/1**

## 3. 明确未做

未重改 MSG-101 ㉒ 列出的已通过项；未实现真实 provider 网络调用；未产生 fake PRODUCTION_READY；未启用 platform write / TRANSPORT / payment；未请求 broad write scope；未获取生产凭据。

## 4. PC-11B — HOLD_EXTERNAL / HOST_ACTION_REQUIRED（不阻塞 FINAL-2）

provider developer approval · production client id / client secret · callback registration（DNS/域名）· webhook secret · real seller authorization。

## 5. 下一执行单元（待裁决）

若 PASS：PC-11A = PASS / CLOSED → 内部侧可继续按架构方指定的下一单元推进；真实接入只剩 PC-11B（HOST）。
边界保持：NO platform write · Payment = 0 · autopay = OFF · collection = OFF · external payment write = OFF · R13 HOLD · TRANSPORT=false · 无生产凭据。
