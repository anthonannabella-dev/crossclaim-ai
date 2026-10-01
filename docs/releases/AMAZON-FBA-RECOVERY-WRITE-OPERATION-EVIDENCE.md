# R42 — Amazon FBA Recovery Write-Operation Capability Evidence（DOCS / EVIDENCE ONLY）

> 依据：**MSG-20261001-27 = PASS** NEXT「R42 — Amazon FBA Recovery Write-Operation Capability Evidence；只做官方能力取证，不得实现 write adapter」。
> 分支 `gate/7-commercial-validation` · Codex · 2026-10-01
> **取证方式（只读）**：官方文档索引 `https://developer-docs.amazon.com/sp-api/llms.txt`（216,733 bytes）全量字符串检索 + `sp-api/reference/*` 分册抽样；**未访问任何账号、未配置任何凭据、未发送任何写请求**。

## 0. 本轮回答的唯一问题

> **Amazon 官方当前是否提供一个第三方应用可使用的、用于 FBA inventory-loss / reimbursement recovery 的明确写 operation（即能创建/提交 recovery action）？**

**答：没有找到。结论 = `NOT_AVAILABLE / NOT_PROVEN` → Amazon 保持 READ-ONLY，`platform.write` 保持 NEEDS_MANUAL。**

## 1. 检索证据（可复现）

对官方文档索引做全量、大小写不敏感计数：

| 关键词 | 命中次数 |
| --- | --- |
| `reimburse` | **0** |
| `claim` | **0** |
| `safe-t` / `SAFE-T` | **0** |
| `a-to-z` | **0** |
| `dispute` | **0** |

即：官方 SP-API 文档索引中**不存在** reimbursement / claim / dispute 相关的 API 或 operation 页面。

同时抽样 API Reference 分册确认相关域只有**只读**能力：

| 官方入口 | 性质 | 说明 |
| --- | --- | --- |
| Finances v0 / Finances v2024-06-19 | READ | “Retrieve financial information for a selling business.”（检索类） |
| Finance Remittance v2026-03-17 | READ | 对账（`getRemittanceHeaders` / `getRemittance`） |
| FBA Inventory v1 | READ（+sandbox-only 写） | `getInventorySummaries` 为只读；`createInventoryItem` / `deleteInventoryItem` / `addInventory` 官方标注 **sandbox-only**（仅沙盒库存，不构成恢复写入口） |
| Reports API | READ | 生成/下载报表；`createReport` 只是**创建报表任务**，不是创建索赔 |
| Fulfillment Inbound / createFulfillmentOrder / createOrder | 物流动作 | 发货/出库指令，与 FBA 库存损失索赔无关 |

## 2. 12 项输出（按 MSG-20261001-27 NEXT 清单）

| # | 项目 | 结论 |
| --- | --- | --- |
| 1 | 目标业务动作的准确名称 | FBA inventory-loss / reimbursement recovery（对账差异的 recovery action 发起或推进，例如 reimbursement claim / SAFE-T claim） |
| 2 | 对应官方 API / operation 名称 | **未找到**（索引 `reimburse`/`claim`/`safe-t`/`a-to-z`/`dispute` 命中均为 0） |
| 3 | API version / endpoint | n/a（无 operation） |
| 4 | required role / scope | n/a（无 operation） |
| 5 | 是否能创建 / 提交 recovery action | **NOT_PROVEN**（无官方写入口证据） |
| 6 | provider idempotency | n/a（无 operation） |
| 7 | operation / request identifier | n/a（无 operation） |
| 8 | post-write status query | 不存在对应写操作的状态查询；仅有**只读**财务/库存检索（Finances、FBA Inventory），**不能**充当写后的确认机制 |
| 9 | ambiguous timeout / 5xx recovery | n/a（无 operation） |
| 10 | sandbox / test capability | 仅存在 sandbox-only 库存操作（`createInventoryItem` / `deleteInventoryItem` / `addInventory`），不是恢复写入口 |
| 11 | 六项 transport prerequisites 最终矩阵 | 全部 **NOT_PROVEN**（无 operation 可逐项验证） |
| 12 | 最终结论 | **`NOT_AVAILABLE / NOT_PROVEN` → NEEDS_MANUAL** |

### 六项 transport prerequisites 矩阵（MSG-20261001-25 CHANGE C 冻结）

| 门槛 | 状态 |
| --- | --- |
| write endpoint/operation 与所需授权明确 | NOT_PROVEN |
| idempotency / replay 语义明确 | NOT_PROVEN |
| provider operation / request identifier 明确 | NOT_PROVEN |
| write 后可查询最终状态或等价确认机制 | NOT_PROVEN |
| ambiguous（timeout / reset / 5xx）不重复写恢复策略 | NOT_PROVEN |
| sandbox/test evidence + CrossClaim PG/H/D 基线 | NOT_PROVEN（无 write 对象） |

## 3. 明确排除（不得误判为写入口）

以下均**不能**作为“自动发起 FBA 索赔”的证据（架构方在 MSG-20261001-27 明确点名）：

- `createReport`（创建**报表**任务）；
- reimbursement 查询类 API；
- inventory adjustment 查询类 API；
- Seller Central UI 流程（人工操作，非 API）；
- Case / Support API 的泛化能力；
- 浏览器自动化（**禁止**用于绕过官方 API 能力缺失）。

判据（架构方）：**官方文档没有明确证明 = NOT_PROVEN**；**不能从「能够读取 reimbursement」推导出「能够创建 reimbursement claim」**。

## 4. 取证限制（诚实声明）

1. 本轮证据来自**官方文档索引 + 公开 API 分册**；不排除存在需特定 program / 邀请制 / 私有协议才能访问的写能力 —— 但**在获得官方明确文档前一律视为 NOT_PROVEN**。
2. 未访问任何真实卖家账号；未尝试 Seller Central 或任何 UI 路径。
3. 若未来获得官方写 operation 文档，必须按 MSG-20261001-25 CHANGE C 的六项门槛**逐项**取证（附具体文档页 / 版本 / 取证日期），六项全达才可进入 write adapter **design**（仍非实现）。

## 5. 对产品路径的影响（与架构方 RISKS 一致）

Amazon 侧当前可行且安全的产品路径是：

```text
自动发现（read-only adapter 已就绪：orders/… → ClaimItem/Quarantine）
  → 自动核算（Rule Engine 既有能力）
  → 自动证据包
  → 人工一键提交（NEEDS_MANUAL / Seller Central 人工流程）
```

**能安全自动发现和准备证据 ≠ 必须自动提交**；不因追求闭环而降低 transport 安全门槛。

## 6. 边界与保持项

未实现任何 write adapter、未新增 Schema/migration/依赖、未接真实凭据/账号、`PLATFORM_WRITE_TRANSPORT_ENABLED=false` 保持；Amazon 组合根仍**不纳入生产**（仅 test/fixture composition、disabled descriptor、无凭据开发装配）。

保持：**AMAZON WRITE HOLD · REAL WRITE ADAPTER HOLD · TRANSPORT=false · PRODUCTION CREDENTIALS HOLD · REAL EXTERNAL WRITE HOLD · CUSTOMER SUBMISSION HOLD**。
