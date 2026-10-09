# SI/RSI INTERNAL CODE REPAIR V1 —— MSG-20261009-20 送审（U1 FINAL-R6：CHANGE 32 并发事务隔离）

审计编号（请在回复标题中沿用）：MSG-20261009-20
REVIEWED_HEAD = 23604dcb（U1 代码 commit，分支 feat/si-rsi-internal-code-repair-v1）
上一轮裁决：MSG-20261009-19 = PASS WITH REVISE（CHANGE 29 = PASS；30/31 = PASS_SCOPED）
NEXT_AUTHORIZED = PHASE3_A_U1_FINAL_R6_CHANGE32_ONLY（本轮**仅**执行 CHANGE 32）

═════════ CHANGE 32（P0）并发事务隔离 —— 响应 ═════════

1) **消除跨请求共享事务句柄**
   - 旧实现：`createPrismaTrustedFactsReadPort` 用**实例级字段** `activeTransaction` 记录“当前事务”，
     并发 `resolve()` 复用同一 readPort 实例时后发请求会取到先发请求的事务；先发结束清空后还可能回落裸 client。
   - 新实现：改用 `AsyncLocalStorage` 把事务句柄绑定到**调用链**：
     `withReadOnlyTransaction(run)` → 若本调用链已有句柄则复用（合法嵌套不新开事务）；
     否则 `runInReadOnlyTransaction(prisma, tx => transactionScope.run(tx, () => run(tx)))`。
     并发调用各自独立；异常随调用链自动失效。
2) **每次独立 resolve() 使用自身只读事务**：由 `AsyncLocalStorage` 上下文保证；`db()` 只读该上下文或裸 client（不会读到别人的事务）。
3) **真实 PostgreSQL 并发回归（U1-DB9）**：同一 readPort 实例 + 两个租户（组织 A 授权版本 3 / 组织 B 版本 5），
   **编排为“A 先进入自己的只读事务并停住 → B 才启动”**，强制两者事务并存。
4) **断言**：① 事务句柄序号互异（无跨调用复用）；② 每次调用 `transaction_read_only = on`；
   ③ 每次调用内写入均被拒（PG 25006）；④ 无跨租户事实串扰（各自 provenance.authorizationId/version 属于本租户）；
   ⑤ 异常路径 fail-closed（不存在组织 ⇒ `ORGANIZATION_NOT_FOUND`），之后的新调用获得全新独立事务。
5) **负向对照（证明回归有效）**：把端口还原成 CHANGE 32 之前的实例级共享实现后，运行**同一套测试**，
   `U1-DB9` 失败并给出 `expected 1 not to be 1`（两次并发调用拿到同一事务句柄）。
   对照实现与原始输出一并落盘：`tools/verification/self-repair/phase3a-u1-final-r6-negative-control-adapter.ts`
   与 `…-r6-negative-control-vitest-raw.txt`。

**原始证据（固定 HEAD = 23604dcb）**

- `tools/verification/self-repair/phase3a-u1-final-r6-evidence.json`
  （`reviewedCodeHead`、`u1FileSha256`、`u1DiffFromCommit`、`tests[]` 62 项、`dbProbeEvidence[]` 7 条含
  `kind=CONCURRENT_TRANSACTION_ISOLATION`、`negativeControl`）
- `…-r6-vitest-raw.txt`（含逐项用例名与 `U1_EVIDENCE` 行）、`…-r6-tsc-raw.txt`（空 = 0 error）
- 并发证据行（逐字）：handles = A:seq1 / B:seq2 / C:seq3 / D:seq4，`allReadOnly=true`、`writeProbeRejectedPerCall=4`、
  `crossTenantLeak=false`、`exceptionPath.laterCallFreshTransaction=true`。
- 退出码：`VITEST_EXIT=0`、`TSC_EXIT=0`；摘要 `Tests 62 passed (62)` / `Test Files 2 passed (2)`；隔离库 `crossclaim_p3r2_iso`。

**边界声明**：未新增第二套 Runtime / Scheduler / Controller；未改 Prisma schema / migration；
未接入任何执行体；`runtimeSourceIsolationImplemented` 仍为 false；外部写 / 自动合并 / 自动部署 / 生产就绪一律禁止；
未验证项：Linux/systemd 实机、真实浏览器端到端、真实 Provider/模型、CI、生产环境 = NOT VERIFIED。

═════════ 请 求 裁 决 ═════════
1. CHANGE32_CONCURRENT_TRANSACTION_ISOLATION（机制是否消除共享句柄 / 并发是否各自独立 / 嵌套复用是否合法）
2. CHANGE32_CONCURRENCY_REGRESSION_TEST（U1-DB9 是否真正强制交错并覆盖四项断言 + 异常路径）
3. CHANGE32_NEGATIVE_CONTROL（负向对照是否足以证明回归有效）
4. U1_READ_ONLY_BOUNDARY_PRESERVED
5. SCOPE_HONESTY
6. PHASE3_U1_IMPLEMENTATION_CLOSED（YES / NO）

并请以下述机器可读块收尾：
MSG-20261009-20 / FINAL
AUDIT_ID=MSG-20261009-20
REVIEWED_HEAD=23604dcb
FINAL_VERDICT=PASS | PASS_WITH_REVISE | REVISE | BLOCK
CHANGE32_CONCURRENT_TRANSACTION_ISOLATION=...
CHANGE32_CONCURRENCY_REGRESSION_TEST=...
CHANGE32_NEGATIVE_CONTROL=...
U1_READ_ONLY_BOUNDARY_PRESERVED=...
SCOPE_HONESTY=...
PHASE3_U1_IMPLEMENTATION_CLOSED=YES | NO
PHASE3_A_U2_TO_U5_AUTHORIZED=YES | NO
REQUIRED_CHANGES=<下一轮必须执行的修订编号，无则 NONE>
NEXT_AUTHORIZED=<贵方确认授权的下一最小单元 / 范围>
NEXT_AUDIT=MSG-20261009-21
EXTERNAL_WRITE=HOLD
AUTO_MERGE=FORBIDDEN
AUTO_DEPLOY=FORBIDDEN
PRODUCTION_READY=NO

请在本会话直接回复（不要写入我的仓库或外部系统）。若证据不足或与固定 HEAD 不一致，请直接判 REVISE 并列出缺失项。
