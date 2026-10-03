# Provider Adapter Readiness —— 首个样板 provider 能力档案（Amazon SP-API）

> 依据：**MSG-20261001-24 = PASS** NEXT「Provider Adapter Readiness / First Provider Design Gate」——先做**设计与能力取证**，不实现真实写 adapter。
> 分支 `gate/7-commercial-validation` · Codex · 2026-10-01 · ROUND: **R39（设计/取证轮）**
> 取证方式：只读抓取官方文档（`developer-docs.amazon.com/sp-api/`，含 `llms.txt` 索引与页面 `.md` 版本）；**未访问任何真实账号、未配置任何凭据、未发送任何写请求**。

## 0. 为什么第一个样板选 Amazon SP-API

| 维度 | 说明 |
| --- | --- |
| 业务相关性 | 平台/物流域的主链路写回对象（案件递交、申诉、发票类写操作）在 marketplace 侧最典型 |
| 文档可得性 | 官方提供结构化文档索引（`llms.txt` + 逐页 `.md`），可对能力逐项留证，不依赖转述 |
| 风险可控 | 本阶段只需**只读**接入即可产生业务价值（导入/对账/状态核对），写回可保持 NEEDS_MANUAL |
| 与现有边界一致 | 现有 `platform.write` 的 adapter 描述符只要求声明能力；本轮把该 provider 声明为**只读**即天然 fail-closed |

> 按裁决要求：**本轮只选一个 provider**（Amazon SP-API），不同时实现 Amazon / TikTok / Walmart；先把一个 adapter 的完整安全模式验证出来，再复制架构。

## 1. 10 项能力档案（官方文档取证）

| # | 项目 | 结论 | 取证要点 | 主来源 |
| --- | --- | --- | --- | --- |
| 1 | 官方 API endpoint / API version / required scopes | **PROVEN** | 按区域划分 endpoint；按版本划分 API（如 `application-management-v2023-11-30`）；LWA 有 `client_credentials`（grantless，需 `scope`）与 `refresh_token` 两条授权路径 | `docs/sp-api-endpoints.md`；`docs/connecting-to-the-selling-partner-api.md` |
| 2 | read / write scope 是否可物理分离 | **PARTIAL** | 授权以 **application role / use case** 为单位；受限数据另需 **Restricted Data Token**。未见调用级 read/write 独立授权机制 → 只能做到角色级隔离 | `docs/authorizing-selling-partner-api-applications.md`；`docs/authorization-with-the-restricted-data-token.md` |
| 3 | provider 原生 idempotency 能力 | **NOT_PROVEN** | 未检索到平台级、跨 API 的幂等写语义（无统一 `Idempotency-Key`）；个别 API 可能有调用方标识，但必须逐操作取证 | `llms.txt` 全量索引 + 各 API 参考页（逐操作） |
| 4 | request identifier / operation identifier | **PARTIAL** | 部分操作返回可轮询标识（feed/operation 类），并非所有写操作都提供稳定 operation id | `docs/sp-api-endpoints.md`（按 API 分册） |
| 5 | 写后 status-query / reconciliation | **PARTIAL** | 存在按操作的状态查询（`Check Listing Status`、`Check the invoice submission status…`、`Retrieve a List of Shipments`），但无覆盖全部写操作的统一“按 request id 查询” | `llms.txt`（上述条目） |
| 6 | timeout / 5xx / reset 的 ambiguous response 判定 | **NOT_PROVEN** | 官方文档未定义“请求已发出但结果不可判定”时的统一可复现处置语义 → 超时后**不得重发写请求** | `docs/usage-plans-and-rate-limits.md`（仅覆盖 429） |
| 7 | rate limit / retry 官方规则 | **PROVEN** | 429 为可重试状态码，需退避；响应头 `x-amzn-RateLimit-Limit` 提供限额信息；sandbox 可演练 429，但**不能复现生产限流速率** | `docs/usage-plans-and-rate-limits.md` |
| 8 | credential 生命周期 / rotation / revocation | **PROVEN** | LWA `refresh_token` 为长期凭据（换取 access token，无需卖家重复授权）；credential rotation = 生成新 client secret 并作废旧 secret；提供 Revoke / Reactivate Authorizations 文档 | `docs/connecting-to-the-selling-partner-api.md`；`docs/revoke-authorizations.md`；`docs/application-management-api.md` |
| 9 | sandbox / test-mode | **PROVEN** | 提供 sandbox 应用注册（onboarding step 4）与首次调用（step 5）指引 | `docs/sp-api-sandbox.md`；`docs/onboarding-step-5-make-your-first-call-to-the-sp-api-sandbox.md` |
| 10 | 是否满足自动写入最低能力矩阵 | **NOT_PROVEN** | 最低矩阵要求「原生幂等写 + 不确定响应可复现处置 + 写后按标识对账」同时成立；③与⑥未取证 → **不满足** | 本表 §3/§5/§6 综合（fail-closed 口径） |

## 2. 自动写入最低能力矩阵判定

| 最低要求 | 本 provider 现状 | 判定 |
| --- | --- | --- |
| 原生幂等写（同 key 不重复产生外部副作用） | 未取证（③） | ✗ |
| 不确定响应（超时/5xx/reset）具备可复现处置语义 | 未取证（⑥） | ✗ |
| 写后可依据稳定标识只读对账 | 仅部分操作（⑤） | △ |
| 只读 scope 可用且与写权限隔离 | 角色级隔离（②） | △ |

**结论：`platform.write` 对该 provider 保持 NEEDS_MANUAL；本阶段接入姿态为 READ-ONLY。**

代码侧已固化该结论（不是文档承诺，而是可回归的判定）：

- `services/platform-write/amazon-sp-api-readiness.ts`：平台级描述符声明 `idempotentWrite=false` / `statusQuery=false` / `ambiguousResponseSemantics=false`（**只读**，非遗漏）；
- `evaluateAdapterEligibility('amazon-sp').reason === 'IDEMPOTENT_WRITE_MISSING'`、`eligibleForAutomaticWrite === false`；
- 即使把 global transport gate 打开，`evaluateTransportGate(...).reason === 'ADAPTER_NOT_ELIGIBLE'`、`transportAllowed === false`（双重门控 fail-closed）；
- 回归：`apps/api/src/__tests__/platform-write-provider-readiness.test.ts`（6 项，含「能力档案不得被静默放宽」）。

## 3. 本阶段安全接入形态（只读）

```text
Provider（Amazon SP-API）
  └─ READ-ONLY adapter（本轮不实现，仅定义边界）
       · 只使用只读操作（如订单/发票/货件状态类读取）
       · 不申请任何写 role；不配置任何生产凭据
       · 输出 → Canonical Fact / 对账证据（复用既有 ingest 通道）
  └─ platform.write（保持不变）
       · adapter 能力不合格 → 门控拒绝 → NEEDS_MANUAL
       · 零投递、零账本、零审批消费（Golden Path D1 同口径）
```

只读接入的落点（后续批次，不在本轮）：把 provider 读取结果作为 **Source Data → Canonical Fact** 的又一种来源，复用既有 import/canonical 管线与对账证据链，不改动资金链路。

## 4. 若要将来开启该 provider 的自动写入，必须先补齐什么

1. **逐操作取证**（对目标写操作各出一份）：请求级幂等或调用方可提供的去重标识；
2. **不确定响应处置**：官方是否定义“同标识重试不产生第二次副作用”的语义；
3. **写后对账**：是否存在按该标识只读查询最终状态的端点；
4. **角色/scope 最小化**：确认写 role 与只读 role 可分离且可撤销；
5. **sandbox 覆盖**：该写操作在 sandbox 可复现；
6. 以上全部 PROVEN 后，再单独提 **transport=true 响应契约**（MSG-20261001-23 CHANGE C：本轮不定义）。

在上述任一项为 PARTIAL / NOT_PROVEN 时，结论保持 **READ-ONLY / NEEDS_MANUAL**，不降低现有安全门槛。

## 5. 凭据与合规边界（本轮不引入任何凭据）

- 仓库内不出现任何 provider 凭据、client secret、refresh token（继续 HOST_ONLY）；
- 未来凭据托管遵循既有 Secret 轮换流程（`secret.rotate` 受保护动作，需 hostApproval）；
- 只读接入同样适用租户隔离：provider 数据按 `organizationId` 归属，跨租户不可见；
- 本 provider 的客户数据（真实卖家账号数据）导入仍需宿主明确授权后执行（HOST APPROVAL REQUIRED）。

## 6. 待架构方裁决

1. 首个样板 provider 选 **Amazon SP-API** 是否认可？
2. 结论口径（READ-ONLY 先行；写回保持 NEEDS_MANUAL 至最低能力矩阵逐操作证明）是否认可？
3. 下一批次是否按本档 §3 实现**只读 adapter 边界**（不接真实凭据、不接真实账号、仅定义接口与能力声明 + 单测）？还是先补逐操作取证？
4. §4 的六项补齐清单是否作为后续开启 transport 的前置门槛？

## 7. 未越界声明

未实现真实 adapter、未申请任何 provider 应用或角色、未配置任何凭据、未访问真实账号数据、`PLATFORM_WRITE_TRANSPORT_ENABLED=false` 保持、未合并 main、未绕过分支保护。
