# SEO-3 公开只读入口接线计划（模块层已落地，server 接线待做）

依据：**MSG-20261005-05**（`PUBLIC_ROUTE_IMPLEMENTATION = AUTHORIZED`、`SEO_8_PUBLIC_SURFACE_CONTRACT = AUTHORIZED`；
代码接线批准、**不是生产解禁**）。当前状态：模块层已落地并通过 8 例合同测试，`server.ts` **尚未接线**。

## 1. 已完成（HEAD 164667b）

- `apps/api/src/services/seo/seo-public-route.ts`：
  - 默认关闭：`PUBLIC_SEO_CHECKER_ENABLED === 'true'` 才服务；关闭时 **404 NOT_ENABLED**；
  - 顺序：开关 → 路径匹配 → **原始字节 ≤8 KiB（在 JSON.parse 之前）** → JSON.parse（失败 400 INVALID_JSON）
    → 委托 handler（形状闸门 → 限流 → **必传进程级闸门** → 真实 timeout → engine 输出校验）；
  - `SEO_PUBLIC_ROUTE_BOUNDARY`：`routeRegistered:false` / `defaultEnabled:false` / `productionPublicChecker:'HOLD'`。
- `apps/api/src/__tests__/seo-public-route.test.ts`：8 例（默认关闭、超长非法 JSON 得 413 而非 400、非法 JSON 400、
  GET 405 且无 `Access-Control-Allow-Origin`、非受信代理 400、限流 429 + `no-store`、慢 engine 504、缺闸门 503）。

## 2. 接线点（`apps/api/src/server.ts`）

- 位置：`http.createServer((req, res) => { ... })` 回调内，`const send = ...` 定义之后、`/auth/*` 处理之前
  （该入口是**匿名只读**，不能落到需要 session 的分支）。
- 形状：
  1. `const path = (req.url ?? '/').split('?')[0]`；
  2. 仅当 `path === SEO_PUBLIC_ROUTE_PATH` 时进入；
  3. 在读取前先看 `content-length`；再累积原始字节并**在超过 8 KiB 时立即停止读取**（不把超长 body 读进内存）；
  4. 调用 `handleSeoPublicRoute({ method, url, contentType, rawBody, trustedProxy, clientIp }, deps)`，
     把 `status` / `headers` / `body` 原样写出（`no-store` 已由模块提供）。
- `trustedProxy` / `clientIp` 只能来自**受信反向代理**配置；未配置受信代理时必须传 `false`（模块会 400 fail-closed），
  不得直接采用可伪造的 `X-Forwarded-For`。

## 3. 唯一真实缺口：`SeoPublicCheckerPorts` 的组合（**尚未存在**）

模块复用的 handler 需要以下端口：

```
resolveActiveRule / listRegisteredBasisKeys / getPublicInputSchema / runEligibility / runCalculation / now
```

- **规则行来源已存在**：`prisma.ruleVersion.findMany(...)`（参考 `services/seo/seo-recover-static-cli.ts`
  与 `services/canonical/shadow.ts`）；再经 `toExportRules()` / codec 得到生效且通过 gate 的规则。
- **`basisKey → 真实 engine` 的映射尚不存在**：`engine:customs-drawback-eligibility` /
  `engine:customs-duty-difference` 这类 basisKey 目前没有 server 级注册表把它接到真实引擎实现。
  因此在补齐之前：
  - `listRegisteredBasisKeys` 应为**空**（gate 会 fail-closed，不会误判可索引）；
  - `runEligibility` / `runCalculation` 必须返回不可用信号，让 checker 走 **ENGINE_OUTPUT_INVALID** 而不是编造结果。
- 结论：**没有引擎组合就不接线**（默认 `PUBLIC_SEO_CHECKER_ENABLED=false` 已保证不暴露不完整能力）。

## 4. 接线时必须同时补的集成验收（SEO-8 定稿）

| 用例 | 期望 |
| --- | --- |
| 开关关闭 | 404 `NOT_ENABLED`（且不进入任何 SEO 逻辑） |
| 非 POST | 405 |
| `content-length` / 实际字节 > 8 KiB | 413，**在读满之前**拒绝 |
| 非法 JSON | 400 `INVALID_JSON` |
| 未配置受信代理 | 400 `UNTRUSTED_CLIENT_IP`（不信任 `X-Forwarded-For`） |
| 超限 | 429；200 响应必带 `Cache-Control: no-store` 且**无** `Access-Control-Allow-Origin: *` |
| 慢 engine | 504 `ENGINE_TIMEOUT`，且槽位直到 engine 结束才释放 |
| 并发饱和 | 闸门=2 时 N+1 → 恰有 1 个 503 |

## 5. 边界（不变）

`PUBLIC_SEO_CHECKER_ENABLED=false` 默认关闭；`EXTERNAL_WRITE / PAYMENT / TRANSPORT /
PRODUCTION_CREDENTIALS / PRODUCTION_PUBLIC_CHECKER = HOLD`；`FINAL_ACCEPTANCE_HEAD` 未动。
