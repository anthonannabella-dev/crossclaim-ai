# 模型 Provider 真实调用就绪度审计（DeepSeek 主 / Qwen 备用）

> 单元：`RC-20261008-LINUX-DEPLOY-PREP`
> 结论口径：**当前模型调用链 = 本地仿真（零网络、零费用、零凭据）。真实 DeepSeek / Qwen 调用尚未接通，且不会因为 `.env` 里写了 key 而自动接通。**
> 边界不变：`RSI_MODEL_NETWORK = HOLD`、`RSI_PAID_MODEL_CALLS = HOLD`、`PRODUCTION_CREDENTIALS = HOLD`。

---

## 1. 结论（TL;DR）

1. 仓库**没有任何一行生产代码读取** `DEEPSEEK_API_KEY` / `QWEN_API_KEY`（源码级 grep 命中 0，见 §2.3）。
2. 唯一的模型入口 `createSiModelGatewayPort()` 会**主动拒绝**任何非本地仿真 adapter，抛
   `SI_MODEL_GATEWAY_REAL_PROVIDER_FORBIDDEN`。这不是"还没接"，而是**设计上的运行时硬边界**。
3. 因此：**写入 key ≠ 接通模型。** 接通真实 DeepSeek / Qwen 需要一次架构变更 + 一次窄审计（§3），并需要 HOST 提供最小配置（§5）。
4. 本文件不得被解读为"真实调用已验证"。`REAL_VALIDATION_COMPLETE = NO`。

---

## 2. 现状证据：模型链是本地仿真

### 2.1 链路结构

| 层 | 文件 | 作用 |
| --- | --- | --- |
| 唯一 Model Router | `apps/api/src/services/autonomy/rsi-model-router.ts` | cheap-first / 预算 / 缓存 / 质量 / 升级（**禁止第二套**） |
| 组合根 | `apps/api/src/services/autonomy/rsi-model-provider-composition.ts` | 只组装局部仿真 adapter + append-only 台账 |
| 本地仿真 adapter | `apps/api/src/services/autonomy/rsi-local-sim-adapter.ts` | 确定性输出，零网络零费用 |
| SI 能力端口 | `apps/api/src/runtime/rsi-si-model-gateway.ts` | 把 Router 包成可注入端口；**只接受 local-sim 工厂实例** |
| 安全过滤 | `apps/api/src/services/autonomy/rsi-adapter-safety.ts` | 输入/输出敏感数据扫描（只回发现码） |
| 成本策略 | `apps/api/src/services/autonomy/rsi-cost-policy.ts`、`rsi-cost-ledger.ts`、`rsi-model-escalation-policy.ts` | 调用前最坏费用证明 + append-only 台账 |

### 2.2 运行时硬边界（fail-closed，不是注释）

`runtime/rsi-si-model-gateway.ts`：

```ts
const assertLocalSimAdapter = (adapter, role) => {
  if (isRsiLocalSimAdapter(adapter)) return;      // FACTORY provenance（WeakSet）
  throw new Error('SI_MODEL_GATEWAY_REAL_PROVIDER_FORBIDDEN:' + role + '…');
};
```

- provenance 来源是**工厂登记**（`LOCAL_SIM_FACTORY_INSTANCES = new WeakSet()`），
  调用方自报 `providerName` 或 capability **不作为依据**（关闭了 self-authorization 旁路）。
- 组合根 `RSI_MODEL_PROVIDER_COMPOSITION_BOUNDARY` 自述：
  `readsCredentials: false`、`performsNetworkCalls: false`、`productionCredentials: 'ABSENT'`。
- 本地仿真 adapter 自述：`performsNetworkCalls: false`、`holdsProviderCredentials: false`、`readEnvironmentSecrets: false`、
  `internalRetry: false`、`sdkAutoRetry: false`、`persistsRawProviderResponse: false`。

### 2.3 源码级密钥读取扫描（本次实测）

对 `apps/api/src/**/*.ts` 全量 grep：`DEEPSEEK|QWEN|MODEL_PRIMARY|MODEL_FALLBACK|API_KEY`。

命中全部为**测试夹具、日志脱敏名单、契约枚举、示例串**，例如：

- `src/config/logger.ts` 把 `api_key` 列入**脱敏字段名**；
- `src/services/connectors/types.ts` 的 `CONNECTOR_AUTH_KINDS` 枚举；
- `src/__tests__/*` 的负向用例（`api_key=xyz` 必须被拒收）。

**没有任何一处读取 `DEEPSEEK_API_KEY` / `QWEN_API_KEY` 或向其发起网络请求。**

### 2.4 测试证据（本次发布候选实测）

| 套件 | 结果 |
| --- | --- |
| `rsi-si-model-gateway.test.ts` | 3/3 PASS（含"真实/付费 adapter 必须抛错"） |
| `rsi-local-sim-adapter.test.ts` | 10/10 PASS |
| `rsi-model-router.test.ts` | PASS |
| `rsi-adapter-safety.test.ts` | 8/8 PASS |
| `rsi-cost-*`（policy / ledger / c1 / e2e） | PASS |

---

## 3. 接通真实 DeepSeek / Qwen 所需的配置与改动

权威依据：`docs/releases/RSI-MODEL-PROVIDER-ADAPTER-IMPLEMENTATION.md` §6 / §7。

### 3.1 架构前提（不可绕过）

```
REAL_PROVIDER_ADAPTER = OUT_OF_PROCESS_REQUIRED   # sidecar / 本地代理，当前未实现
```

设计上**禁止 in-process 真实 adapter**。真实调用必须满足：

1. provider 凭据只存在于 **sidecar 进程**，RSI runtime env **不得**出现 `DEEPSEEK_API_KEY` / `QWEN_API_KEY`；
2. sidecar 必须有 **host allowlist**（只允许 `api.deepseek.com`、`dashscope.aliyuncs.com/compatible-mode`），不得成为任意 HTTP 代理；
3. sidecar 必须硬性封顶 `maxOutputTokens` / 等价 provider 参数；
4. **SDK retry = 0**（一次 invoke = 恰好一次 attempt，重试策略留在 Router 层）；
5. 输入 / 输出敏感数据过滤必须在真实链路上生效。

### 3.2 代码改动清单（在既有唯一 Router 内，不新增第二套）

| # | 文件 | 改动 |
| --- | --- | --- |
| C1 | 新增 `apps/api/src/services/autonomy/rsi-sidecar-model-adapter.ts` | 实现 `RsiModelProviderAdapter`，`invoke()` 只向**本地 sidecar**（如 `127.0.0.1:4320`）发请求；必须声明 `pricing`（缺失即 `BUDGET_GUARD_UNENFORCEABLE`） |
| C2 | `apps/api/src/services/autonomy/rsi-local-sim-adapter.ts` | 扩展 provenance：新增 `isRsiSidecarProxiedAdapter()`（仍是**工厂登记**，不引入 caller 自报） |
| C3 | `apps/api/src/runtime/rsi-si-model-gateway.ts` | 把 `assertLocalSimAdapter` 改为"local-sim **或** 已登记 sidecar-proxy"，并保留 `REAL_PROVIDER_FORBIDDEN` 默认关闭开关 |
| C4 | 新增 `apps/api/src/services/autonomy/rsi-model-provider-selection.ts` | 依 `MODEL_PRIMARY` / `MODEL_FALLBACK` 选择 adapter；切换由显式 env gate 控制，默认 `local-sim` |
| C5 | 新增 `apps/api/src/__tests__/rsi-sidecar-adapter.test.ts` 等 | 负向：无 allowlist / 有 in-process key / 超预算 / 超 maxOutputTokens → 全部 fail-closed |
| C6 | 新增 sidecar 程序（独立目录，如 `apps/model-sidecar/`） | 唯一持有凭据；提供 `/invoke`；只做协议转换，不做路由/预算/质量决策 |

> ⚠️ C2/C3 是**架构级边界变更**（放宽 `REAL_PROVIDER_FORBIDDEN`），按 `AGENTS.md` §三·五属于"真实外部写 / 安全边界"，
> **必须**通过 §3.4 的窄审计后才能合入。

### 3.3 配置层（当前已就位，但未被读取）

`apps/api/.env.example`（**只有引用名，无取值**，可安全提交）：

```
DEEPSEEK_API_KEY_REF=""
DEEPSEEK_BASE_URL="https://api.deepseek.com"
QWEN_API_KEY_REF=""
QWEN_BASE_URL="https://dashscope.aliyuncs.com/compatible-mode/v1"
MODEL_PRIMARY="deepseek"
MODEL_FALLBACK="qwen"
```

`apps/api/.env`（**已 gitignore，绝不提交**）：本地开发放置真实取值。

接入真实调用时，sidecar 侧需要的变量名（**放密钥管理，不放仓库**）：

| 变量 | 说明 |
| --- | --- |
| `DEEPSEEK_API_KEY` | 主模型凭据（sidecar 进程内） |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` |
| `QWEN_API_KEY` | 备用模型凭据（sidecar 进程内） |
| `QWEN_BASE_URL` | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| `MODEL_SIDECAR_HOST_ALLOWLIST` | 允许的 provider 主机（最小集合） |
| `MODEL_SIDECAR_MAX_OUTPUT_TOKENS` | 硬上限 |

### 3.4 闸门（接通前必须通过）

`RSI REAL PROVIDER ADAPTER AUDIT` 最小材料（§7 原文六项）：

1. sidecar 凭据隔离证据（RSI runtime env **不含** provider key）；
2. sidecar host allowlist 证据；
3. 预算硬上限说明 + 证据；
4. `SDK retry = 0` 证据；
5. 输入/输出过滤在真实链路上的证据；
6. **一次受控的非生产小额调用**证据（只有 usage + outputDigest，不含任何原始响应）。

未通过上述审计前：`REAL_PROVIDER_ADAPTER = NOT IMPLEMENTED`，`REAL_VALIDATION_COMPLETE = NO`。

---

## 4. 不得宣称的内容（防伪声明）

- 不得写"已接入 DeepSeek/Qwen"——目前**零真实调用**；
- 不得把本地仿真输出当作模型产出报告给客户或写进证据；
- 不得因为 `.env` 存在 key 就认为 `MODEL_PROVIDER_READY = YES`；
- 不得在 RSI runtime 进程内注入明文生产凭据。

---

## 5. 需要 HOST 提供的最小配置清单（接通真实模型时）

| # | 项 | 说明 | 现状 |
| --- | --- | --- | --- |
| H1 | DeepSeek API Key（有效、有余额） | 放 sidecar 的密钥管理，不入仓库 | 用户已提供一串；**建议轮换**（见下） |
| H2 | Qwen / DashScope API Key（OpenAI 兼容模式） | 同上 | 用户已提供一串，**形态可疑，需确认** |
| H3 | 月度/单次调用费用上限 | 供预算熔断配置 | 待定 |
| H4 | sidecar 宿主与端口 | 非生产先跑 staging | 待定 |
| H5 | 一次非生产小额调用的授权 | §3.4 第 6 项 | 待授权 |

> **凭据卫生提示**：两个 key 已在聊天中以明文出现过。按 `AGENTS.md` §九，建议**轮换后**再走 H1/H2。
> 其中 `QWEN_API_KEY` 的前缀形态不符合 DashScope 常见的 `sk-` 形态（具体取值不在此复述），
> 接入前必须先确认它到底是哪一种凭据（DashScope / 百炼 / 自建网关），否则会产生"看似接通、实则 401"的假象。

---

## 6. 状态登记

```
MODEL_CHAIN_IS_LOCAL_SIMULATION        = YES（证据 §2）
PRODUCTION_CODE_READS_PROVIDER_KEYS    = NO
REAL_PROVIDER_ADAPTER                  = NOT_IMPLEMENTED（OUT_OF_PROCESS_REQUIRED）
REAL_MODEL_NETWORK                     = HOLD
PAID_MODEL_CALLS                       = HOLD
PRODUCTION_CREDENTIALS                 = HOLD
REAL_VALIDATION_COMPLETE               = NO
SECOND_MODEL_GATEWAY                   = 0（唯一 Router，未新增第二套）
```
