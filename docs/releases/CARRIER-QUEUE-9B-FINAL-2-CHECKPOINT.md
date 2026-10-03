# CARRIER QUEUE #9B FINAL-2 — DB CONFIRMATION TRUTH CONSTRAINT CHECKPOINT

状态：**READY_FOR_REVIEW**
前序：MSG-20261003-120 ⑤ DB carrier confirmation invariant = REVISE-MINOR；⑥ Queue #9B = NOT CLOSED；⑦ 下一执行 = CARRIER QUEUE #9B FINAL-2（DB CONFIRMATION TRUTH CONSTRAINT）；⑮ 明确「不得重做」Prisma 结构 / unique / tenant / append-only / store / audit 事务 / Action Guard / RBAC / HTTP route / mappings / concurrency。
IMPLEMENTATION_HEAD = 2a5399e（full 2a5399e74307c7d2a684475ac8ce17cda2f10128）；CI = SUCCESS · RUN_ID = 37105566664
边界：**NO platform write · TRANSPORT=false · Payment = 0 · autopay = OFF · collection = OFF · external payment write = OFF · R13 HOLD · 无生产凭据**。

## 1. ⑫ CHANGE A — DB CHECK（唯一主阻塞项）

- 新增窄 migration `20261003030000_carrier_manual_submission_confirmation_check`（**不改** 已应用的 `20261003020000`）：
  - `ALTER TABLE "CarrierManualSubmission" ADD CONSTRAINT "CarrierManualSubmission_carrierConfirmationStatus_check" CHECK ("carrierConfirmationStatus" = 'NOT_VERIFIED');`
- 语义：**ONLY NOT_VERIFIED IS LEGAL**。append-only 只保证「插入后不能改」，本约束才保证「插入时值一定真实」——即使未来新的内部写路径或运维脚本绕过 service/store，也无法制造永久 append-only 的伪造 carrier confirmation 事实。

## 2. ⑬ RECOMMENDED — submissionMode CHECK

- 同一窄 migration 顺手固定：`"CarrierManualSubmission_submissionMode_check"` → `CHECK ("submissionMode" = 'MANUAL')`（本表语义即人工提交见证）。
- 纯新增 CHECK 约束：不改列 / 索引 / 触发器；不写凭据或资金字段；表为空表语义下无数据回填风险。

## 3. ⑭ 必需 DB 测试（本地真实 PostgreSQL）

- `carrier-manual-submission-db` **18/18 PASS**，其中本轮新增 8 条 FINAL-2 断言：
  1. 约束真实存在于 `pg_constraint`（两条 CHECK 名称）；2. `NOT_VERIFIED` 直接写入合法 fixture → 允许；3-6. 直接写 `APPROVED` / `CONFIRMED` / `RECOVERED` / `ACCEPTED` → **数据库拒绝且零 row**；7. `submissionMode = AUTO` → 数据库拒绝且零 row；8. service 路径写入行仍为 `NOT_VERIFIED` / `MANUAL`（约束不破坏既有路径）。
- 既有断言保持全绿：READY+授权 → 一行 DB record + 同事务业务审计恰好一次；重复顺序调用仍一行一审计；**两个独立连接真实并发** → RECORDED + ALREADY_RECORDED 且只有一行；NEEDS_REVIEW / 跨租户 / 无 capability → 零 row；client 注入身份被忽略；append-only UPDATE/DELETE 仍被拒绝；无 carrier 网络调用。
- `architecture-contract` 追加两条静态断言：⑫⑬ 的 CHECK 必须存在于迁移 SQL（`CarrierManualSubmission_carrierConfirmationStatus_check` → `'NOT_VERIFIED'`；`CarrierManualSubmission_submissionMode_check` → `'MANUAL'`）。

## 4. ⑭ 其它闸门

- `prisma validate` = valid；`prisma migrate deploy` = All migrations have been successfully applied（含新迁移）；`prisma generate` OK。
- 货架回归（carrier 全家族 + provider-readiness-http-db + action-guard-enforcement + action-guard-catalog-integrity + architecture-contract + workflow）**17 files / 402 tests PASS**。
- `tsc --noEmit`（api）= 0 error；`tsc --noEmit`（web）= 0 error；API contract = `API_CONTRACT_OK`（implemented=85 / documented=72）。
- 本地 `migration-checksum` 报告 `20260930100000_tenant_ownership_immutability` 不一致，经核为**本地 CRLF 检出artifact**（该文件 LF 归一化后 sha256 = 2acbd87a… 与 pinned 完全一致；CI 以 LF 检出，故 CI 通过）。不涉及本批改动。
- CI RUN = 37105566664（head 2a5399e）5 jobs 全绿。

## 5. ⑮ 未重做（已 PASS 项保持原样）

Prisma model 结构、unique index、tenant triggers、append-only、Postgres store、audit 同事务、Action Guard、RBAC、HTTP route、HTTP mappings、concurrency 行为均未改动（本批只新增一个窄 migration + 测试/文档）。

## 6. 边界

不提交 carrier claim、不访问 portal、无 browser automation、不调用 carrier write API、不标记 MANUALLY_SUBMITTED、不产生 carrier confirmation、不改 recovered cash、无 successFee、不改 Payment、无生产凭据。

## 7. 请裁决（编号裁决 PASS / REVISE / BLOCK）

① ⑫ CHANGE A（`carrierConfirmationStatus` 只能 `NOT_VERIFIED`，DB CHECK + 直接写入拒绝 + `NOT_VERIFIED` 仍可写入）是否满足；② ⑬ RECOMMENDED `submissionMode = MANUAL` CHECK 是否接受；③ ⑭ 必需 DB 测试与闸门证据是否齐备；④ 是否批准 **CARRIER QUEUE #9B FINAL-2 = PASS/CLOSED**（即 Queue #9B 真正 CLOSED）；⑤ 是否按 ⑰⑧授权进入 **CARRIER QUEUE #10（CARRIER RESPONSE / STATUS READ MODEL，区分 USER_REPORTED 与 PROVIDER_VERIFIED）**；⑥ 是否确认 ⑲⑳ 的 15% 商业模型（C10–C11）与 ㉑–㉔ Customs Recovery C1+ 内部实现可按已登记方向并行推进（payment/collection/carrier write/customs authority write 继续冻结）。
