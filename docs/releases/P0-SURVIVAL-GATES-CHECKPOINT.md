# P0 BUSINESS SURVIVAL GATES CHECKPOINT（第四次送审）

- 时间：2026-10-03T13:32:03.012Z；REVIEWED_HEAD：`5dfb753`
- 前序裁决：MSG-20261003-127（REVISE）已执行；MSG-20261003-128（G4 C1–C7 = PASS/CLOSED）已归档。

## 0. 本批新增（宿主 FINAL ACCEPTANCE RULES 2026-10-03）

| 生死线 | 状态 | 关键证据 |
|---|---|---|
| A. 海关合规与证据链比对（Import ↔ Return/Export/Destruction） | VERIFIED（CLOSED 待路由级 E2E 的 CI `3417377`） | 匹配契约 10/10；Return 事实 append-only PG 5/5；全链 evidence PG E2E **8/8**；只读视图 3/3；**路由级 HTTP E2E 4/4**（401/403/404/200 + 跨租户 404） |
| B. 数据安全与客户筛选 | **CLOSED** | Qualification 11/11；判定 append-only PG 5/5；后端强制 Gate（未过 → 409）；VIEWER 绕过 → 403；Enterprise Trust 状态模型 + 禁自证守卫 2/2 |

## 1. A：链路与 fail-closed 语义（实测断言）

- EXACT：`confirmed = 200.000000`（10 × 200/10，仅按已匹配数量）；
- PARTIAL：`80.000000`（4 × 200/10，按比例、不放大）；
- AMBIGUOUS：`NOT_READY` 且 `confirmed = {}`；
- digest 篡改：`RECONCILIATION_REQUIRED` 且 `confirmed = {}`；
- qualification 未通过：`NOT_READY` + HTTP **409**；
- 前端绕过（VIEWER 直调）：**403**；OWNER：200；
- policyVersion 重算：新增历史，`latest` 判定生效；
- 跨租户：不可见（404 / 隔离）。

## 2. B：Gate 与信任状态

- 判定四态 QUALIFIED / CONDITIONAL / NOT_QUALIFIED / INDETERMINATE；阈值全部来自 versioned policy（无 magic number）。
- 昂贵外部能力仅在 QUALIFIED 下允许；CONDITIONAL 需人工确认；INDETERMINATE / NOT_QUALIFIED 绝不触发外呼。
- Enterprise Trust：`IMPLEMENTED / VERIFIED / EXTERNAL_AUDITED / NOT_AVAILABLE`；SOC 2、ISO 27001、BANK_GRADE 一律 **NOT_AVAILABLE**，内部代码/CI/PG 只能支撑前两者；守卫禁止任何自证表述。

## 3. 工程与数据

- 模型 70 / 迁移 56；tenant 触发器 92 baseline / 35 append-only（psql 校验 OK）；
- 本批迁移：`20261003160000`（Return 事实）、`20261003170000`（qualification 判定）、`20261003180000`（claim evidence）；
- 新路由：`GET /customs-entry-facts/:entryFactId/return-claim-evidence`（只读、持久化结果、`recomputedOnRead=false`），API.md 已登记（contract 89/76）；
- 闸门：`prisma validate` valid、`migrate deploy` 空库可执行、tsc api/web 0 error、audit coverage / autopilot rules OK。

## 4. 边界（不因本批改变）

- HOLD_EXTERNAL：真实 filing / broker 提交 / 外呼 / 生产凭据 / 资金动作全部关闭；
- 未来开启须另开 **Production / Transport Enablement Gate**，并需宿主书面放行。

## 5. 请裁决

1. A 的链路（append-only 事实 → 确定性匹配 → qualification → evidence package → HTTP → PG E2E）是否满足 fail-closed 与“不得进入 claim-ready”的要求？
2. B 的 Gate 是否满足“后端强制、不可由前端绕过、不得触发付费 API / filing / 外呼 / 资金动作”？
3. Enterprise Trust 状态模型与禁自证守卫是否满足要求？
4. 是否批准 A / B 两条生死线 CLOSED（在路由级 E2E 的 CI 结果确认后）？
