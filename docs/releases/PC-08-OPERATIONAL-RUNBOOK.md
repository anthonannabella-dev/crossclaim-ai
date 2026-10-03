# PC-08 最小 Operational Runbook（CrossClaim）

依据：MSG-20261003-93 ⑨（PC-08 OPS READINESS）。本 runbook 只覆盖**最小可执行**的运维步骤；
生产部署、真实凭据、真实外写、付款通道仍全部 HOLD。

通用前置与硬边界：

- `TRANSPORT=false`：**不得**在 PC-08 打开任何真实平台传输；`NO platform write`。
- `Payment = 0` / `collection = OFF`：不得发起任何扣款或真实支付动作。
- 任何需要真实凭据、生产环境写入或外部账号授权的动作 = **HOST APPROVAL REQUIRED**，Codex 不自动执行。
- 只读诊断入口：`GET /health/live`（liveness）、`GET /health/ready`（readiness）、`GET /ops-readiness`（OWNER/ADMIN）。

## 1. DB failure

症状：`/health/ready` 返回 503 且 `checks.database = DOWN`；业务端点 5xx。

1. `GET /health/live` 确认进程存活（200 = 进程本身没问题，问题在下游）。
2. `GET /health/ready` 读取 `checks.database`。
3. 在本机/运维机上确认 Postgres 容器或实例状态（只读命令）。
4. 若为连接池耗尽：观察 `docker compose ps` / 连接数，不重启生产库（需 HOST 授权）。
5. 若为迁移未应用导致缺列：**不要**手工改表；走 §2。
6. 恢复后再次 `GET /health/ready` 直到 200，并在审计中记录事件时间。

## 2. Migration failure

症状：CI `API · migration + typecheck + tests` 或部署 smoke 的迁移步骤失败；本地 `prisma migrate deploy` 报错。

1. 记录失败 migration 目录名与错误码；**不要**手改已应用的 migration 文件（checksum 门禁会拒绝）。
2. 本地复现：`npx prisma migrate status`（只读）。
3. 若 fresh DB 可应用、upgrade 失败：检查 backfill 前置条件与既有数据冲突，按既有 `migration-checksum` / `upgrade-verify` 工具定位。
4. 修复方式：新增一个前向 migration（不改历史文件），或修正代码；修复后重跑 CI。
5. 严禁 `migrate reset` / 手工 `DROP`（在真实环境属于破坏性动作，需 HOST 授权）。

## 3. Storage failure

症状：`/uploads` 或签名下载返回 503 `file_download_unavailable` / 上传失败。

1. 确认进程是否装配 storage（未装配时按契约 fail-closed，这是预期行为）。
2. 只读检查存储根目录可用性与磁盘空间。
3. 若为签名/密钥问题：确认 `STORAGE_URL_SECRET` 等配置存在（**不要**在日志或对话中打印取值）。
4. 恢复后重新上传/下载验证；失败期间不得以“跳过后校验”的方式绕过。

## 4. Login / session issue

症状：登录 401/403/429、会话失效、`/auth/me` 401。

1. 429 = rate limit（`/ops-readiness` 可见 `rateLimit` 策略）→ 等待窗口结束，不要提高上限来“绕过”。
2. 401 `ACCOUNT_LOCKED` / `ACCOUNT_DISABLED` → 按既有锁定策略处理（15 分钟锁定期）。
3. 会话失效：确认 `Session` 表与 `passwordChangedAt` 语义未被手动改动。
4. 未知邮箱登录失败是**故意**统一文案（不区分账号是否存在），不要为了排障泄露账号存在性。

## 5. Import failure

症状：`ImportBatch.status = FAILED`；客户侧 `/recovery-states` 显示 `REUPLOAD_REQUIRED`。

1. `GET /ops-readiness` 读取 `failedJobs.importFailed` / `importPartial` 计数。
2. 定位具体批次：`/imports` 列表与 `/imports/:id/error-report`（脱敏投影）。
3. 若为列映射/格式问题：修正源文件后重新上传（不要手工插行）。
4. 若为 account 归因缺失：连接未绑定账户时 ingest 会 fail-closed（预期）；按 §6/§7 的绑定/重绑流程处理。
5. 复核失败期间**必须**是零业务事实写入（`SourceTransaction = 0`）。

## 6. Provider auth failure

症状：`SourceConnection.status = NEEDS_AUTH / ERROR / REVOKED`；`/accounts` 显示 `REAL_OAUTH_EXTERNAL_GATE`。

1. 确认这是**预期**状态：真实 provider OAuth/API 目前仍被 gate 阻塞（PC-06 已冻结：`reconnect.available = false`）。
2. 不得伪造“重新连接”能力，也不得手工写入 token/refresh token。
3. legacy unbound 连接：按 §7 走显式重绑（同租户、一次性、审计）。
4. 需要真实 OAuth 时 → **HOST APPROVAL REQUIRED**（第三方账号授权 + 生产凭据）。

## 7. Reconciliation issue

症状：`/money` 金额与预期不符、`c2/r45` 一致性 checker 报非零。

1. 运行只读 checker（仓库内 `tools/consistency` / R45 checker）确认是否为真实漂移。
2. 核对事实链：Settlement → RecoveryPayout → FeeCalculation → BillingInvoice；**到账金额只来自 RecoveryPayout**（PC-05 冻结）。
3. 若存在 reversal：确认 `gross = Σ payout`、`adjustments = Σ REVERSAL`、`net = gross − adjustments`，不得双重冲减。
4. 不得手工 UPDATE 历史事实（append-only）；需要更正时走既有受控动作 + 人工审批。

## 8. Settlement mismatch

症状：平台显示已到账，但 `/money` 未显示；或 Settlement 与 payout 金额不一致。

1. 预期语义：`Settlement.status = RECEIVED` 但无 `RecoveryPayout` 记录 → `recovered = 0`（不作为已到账）。
2. 复核 receipt snapshot / canonical digest 是否与服务端构建一致。
3. 差额需补录到账事实时：走受保护写入路径（Action Guard + human approval），不得直接插表。
4. 若涉及真实资金处置 → HOST / 财务动作，Codex 不自动执行。

## 9. Kill switch procedure

1. 读取：`GET /ops-readiness` 的 `killSwitch.resolverReachable`（只读探针，不改变任何开关）。
2. 判定：resolver 不可达 → 系统自动回落 READ_ONLY（拒绝写入），这是**预期安全姿态**，不是故障。
3. 打开/关闭 kill switch 属于受控变更：必须通过既有 Admin 入口并留下审计；Codex 不代替人工决策。
4. 变更后再次读取 `GET /ops-readiness` 确认姿态；必要时用 §4 路径验证写入边界仍生效。

## 10. Rollback procedure

1. 先判定回滚对象：应用版本（可回滚）还是数据库 migration（**不一定**可回滚）。
2. 应用回滚：部署上一版本镜像/提交；DB 结构保持向前兼容（本项目 migration 以向前为主）。
3. 数据回滚：**不做**破坏性回滚（删除/覆盖真实数据需 HOST 授权）；优先前向修复 + 补偿动作。
4. 回滚后验证清单：`/health/live`、`/health/ready`、`/ops-readiness`、CI 全绿、关键回归套件绿。
5. 任何涉及生产环境、DNS、生产凭据的动作 → **HOST APPROVAL REQUIRED**。
