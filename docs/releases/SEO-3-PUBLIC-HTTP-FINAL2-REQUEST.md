# [SEO-3 → ARCHITECT] PUBLIC HTTP FINAL-2 送审（CHANGE C/D/E 已落地）

## 0. 耐久记录

- 本文件即耐久记录：`docs/releases/SEO-3-PUBLIC-HTTP-FINAL2-REQUEST.md`（随本批 commit 推送到 `gate/7-commercial-validation`）。
- **代码送审 HEAD = `e7365ea`**（CHANGE C/D/E 落地提交）；上一轮 `08a822c` 的 REVISE 裁决 = `MSG-20261005-04`，已逐字归档（FNV `5bf3757e` / 258 行 / `FULL_COPY_OK`）。
- 通道说明：本机 `gh` token 仍失效，耐久记录继续用仓库文件。

## 1. 声明（硬边界，全部未变）

- **仍未注册任何公开 HTTP 入口**（无 route/server 文件引用 handler/checker）。
- 无租户数据、无 PII、匿名只读、零外写、不扣费、不创建 submission、不绕过 Action Guard；`estimate` 标注为估算。
- `EXTERNAL_WRITE / PAYMENT / TRANSPORT / PRODUCTION_CREDENTIALS / PRODUCTION_PUBLIC_CHECKER` 全 HOLD；`TRANSPORT=false`。

## 2. 本轮修的三点（你要求的最小集合）

### CHANGE C — timeout 从「声明」变成「真执行」

- 新增 `createSeoTimeout(ms)`（`seo-public-http-guard.ts`）：resolve 而非 reject，`unref()` 不拖住进程，`cancel()` 清理定时器。
- `handlePublicSeoRequest` 改为 `Promise.race([engine, timeout.expired])`：
  - 超时 → **504 `ENGINE_TIMEOUT`**；
  - **并发槽只在引擎 promise 真正 settle 时释放**（`engine.then(releaseOnce, releaseOnce)`），
    因此慢任务超时后仍在跑时**不会**错误释放槽位、不会突破并发上限；
  - engine 抛错 → **502 `ENGINE_FAILED`**。

### CHANGE D — 闸门不再 fail-open

- `SeoPublicHandlerDeps.concurrencyGate` 由可选改为**必传**；运行时缺失 → **503 `CONCURRENCY_GATE_MISSING`**（fail-closed）。
- 新增 `getSeoPublicConcurrencyGate()`：**进程级 singleton**，组合根共享同一计数器（避免「每请求一个计数器」使 `MAX_CONCURRENCY` 失效）。
- `SEO_PUBLIC_HANDLER_BOUNDARY` 增加 `concurrencyGateRequired: true` / `timeoutEnforced: true`。

### CHANGE E — in-memory limiter 有界

- `SeoRateLimiterOptions` 新增 `ttlMs`（空闲桶淘汰，默认 10 分钟）与 `maxBuckets`（硬上限，默认 5000，超出按最久未使用 LRU 淘汰）。
- 暴露 `maxSize()` 便于断言；`size() <= maxBuckets` 恒成立。

## 3. 新增测试（4 例，全部真实行为而非常量断言）

1. `CHANGE_C`：engine 超过 deadline → 504 `ENGINE_TIMEOUT`，且**请求返回后槽位仍为 1**，引擎结束 60ms 后归 0。
2. `CHANGE_D-1`：闸门缺失 → 503 `CONCURRENCY_GATE_MISSING`。
3. `CHANGE_D-2`：同一 `deps`、闸门 = 2、并发 3 个慢请求 → 结果集合恰为 `[200, 200, 503]`，结束后 `inFlight() = 0`。
4. `CHANGE_E`：`ttlMs` / `maxBuckets` 生效，`maxSize() = 2` 且 `size() <= 2`。

## 4. 证据

- `npx tsc --noEmit`（apps/api）= **exit 0**。
- `npx vitest run src/__tests__/seo-` = **15 文件 / 109 例全过**（较上轮 96 → 109；含上述 4 例新用例）。
- 上一轮已 PASS 的项保持不变：`CHANGE_A`、`CHANGE_B`、`UNKNOWN_KEY_REJECT`、`FINITE_NUMBER_CHECK`、
  `INTEGER_DECIMAL_MIN_MAX`、`ENGINE_OUTPUT_VALIDATION`、`RATE_LIMIT_BEFORE_ENGINE`、`BODY_8K_CONTRACT`、
  `TRUSTED_PROXY_KEY_DERIVATION`、`NO_STORE_POLICY`、`NO_RAW_BODY_IP_UA_POLICY`、`ANONYMOUS_READ_ONLY`、
  `NO_TENANT_DATA`、`NO_EXTERNAL_WRITE`、`NO_PAYMENT`、`NO_SUBMISSION`。

## 5. 请裁定

1. CHANGE C/D/E 是否可记 **PASS**，`PUBLIC_CHECKER_HTTP` 是否可记 **FINAL PASS**？
2. 若可，是否允许**注册公开只读入口**（仍无外写 / 无扣费 / 无 submission），并把 **SEO-8 公开面合同测试定稿**？
3. 生产限流：是否维持「上线前必须由共享/边缘提供原子限流」为生产启用前置条件（当前 in-memory 明确为 DEV/STAGING_ONLY）？
4. 若仍需补证据，请只列**最小集合**。

## 6. HOST_ACTION（与上轮相同，未新增）

- 生产共享/边缘限流所需基础设施（Redis/CDN 层）——外部依赖；
- Search Console 验证 / 域名所有权——SEO 页面转 INDEX 前必须由宿主完成。

请在本次会话中直接回答；不要尝试写回 GitHub。不要使用上一轮缓存。
