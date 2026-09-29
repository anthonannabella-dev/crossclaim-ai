# P2-4 PRODUCTION VALIDATION RUNBOOK CHECKPOINT

> 类型：**IMPLEMENTATION CHECKPOINT（P2-4）**
> 依据：**MSG-20260929-73**（P2-4 = GO，验收标准冻结）
> 分支：`gate/7-commercial-validation` @ **4c5bf3a**（实现 `c961e0d` / 修复 `4c5bf3a`）；main = `3c565e2`
> 边界：**CODE READY ≠ PRODUCTION VALIDATED**；真实数据 **WAITING_HOST_DATA**；无任何自动动作

---

## 1. 交付物

| 文件 | 内容 |
|---|---|
| `tools/validation/phase1-runbook.mjs` | Runbook 工具：`plan` / `audit-input <csv>` / `gate <candidates> <verified> [分类…]`；导出纯函数（阈值、Stage A 记账、Decision Gate、PHASE1-RESULT 渲染） |
| `apps/api/src/__tests__/phase1-runbook.test.ts` | 10 项用例（门槛冻结、Stage A 记账与 silent drop 检出、CSV 缺列不猜测、Gate 三态、未知分类 STOP_REWORK、8 节报告渲染） |
| `PHASE1-VALIDATION-RUNBOOK.md` | 运行手册（输入契约、步骤、门槛、失败处理、输出物、边界） |
| `templates/IMPORT-REPORT.md` / `templates/DATA-QUALITY-REPORT.md` / `templates/PHASE1-RESULT.md` | 三份报告模板（PHASE1-RESULT 固定 8 节 + Decision Gate） |

## 2. 对照冻结验收标准

| 冻结项 | 实现与证据 |
|---|---|
| **Stage A**：`input = normalized + quarantine + rejected`；禁止 silent drop、禁止自动修正未知字段、禁止猜测金额 | `auditImportIntegrity` 返回 `difference`/`silentDropDetected`；用例 02（自洽）/03（少记 7 行 → silent drop）/04（记账超额 → 异常）/05（缺 `amount`/`currency` → 全行 rejected，不猜测） |
| **Stage B**：`Candidate >= 10`，且 **Candidate ≠ Claim** | `evaluateDecisionGate` + 报告声明 `disclaimer`（用例 06/08） |
| **Stage C**：`human verification >= 5`，分类 `TRUE_POSITIVE`/`FALSE_POSITIVE`/`NEEDS_DATA` | 用例 07/08/09（未知分类 → `STOP_REWORK`，不允许臆造） |
| **Decision Gate 三选一** | `PASS_TO_MVP` / `CONTINUE_DATA_COLLECTION` / `STOP_REWORK`（用例 01/06/08/09） |
| **输出物** | `IMPORT-REPORT.md`、`DATA-QUALITY-REPORT.md`、`PHASE1-RESULT.md`（8 节 + Decision Gate；模板已落库） |
| **禁止自动动作** | `FORBIDDEN_AUTOMATIONS`（auto-submit-claim / auto-appeal / auto-commission / auto-charge / auto-amount-promise / auto-platform-action）；渲染报告固定输出该清单（用例 01/10） |
| 阶段一**禁止**判断商业指标 | 报告中不出现 `recoveryAmount`/`successRate`/`ARR`/`billingCapacity`（用例 10） |

## 3. 工具运行证据（本地）

```text
$ node tools/validation/phase1-runbook.mjs plan
P2-4 Production Validation Runbook（CODE READY ≠ PRODUCTION VALIDATED）
Stage A：input = normalized + quarantine + rejected（阈值：禁止 silent drop）
Stage B：Candidate >= 10（Candidate ≠ Claim）
Stage C：human verification >= 5（TRUE_POSITIVE / FALSE_POSITIVE / NEEDS_DATA）
Decision Gate：PASS_TO_MVP / CONTINUE_DATA_COLLECTION / STOP_REWORK
输出：IMPORT-REPORT.md / DATA-QUALITY-REPORT.md / PHASE1-RESULT.md
禁止：auto-submit-claim, auto-appeal, auto-commission, auto-charge, auto-amount-promise, auto-platform-action
真实数据：WAITING_HOST_DATA（不得使用真实客户数据做测试）
```

## 4. 测试与 CI

| 项 | 结果 |
|---|---|
| P2-4 单元 | 10/10 PASS |
| 全量（CI） | **115 files / 1094 tests 全绿** |
| **CI（HEAD `4c5bf3a`，run `36613658101`）** | **五作业全部 SUCCESS**：API（迁移 + typecheck + 115 files / 1094 tests）/ Web（build）/ 许可证闸门 / Deploy smoke / Backup restore verify |
| 首轮失败与修复 | `c961e0d` 的 API 作业因 CJS 下 top-level await（TS1378 等）失败 → `4c5bf3a` 改为 `beforeAll` 动态导入 + 类型断言后转绿（如实记录，非绕过） |

## 5. 边界确认

- ❌ 未使用真实客户数据；未提交 Claim/Appeal；未扣佣/收费/承诺金额；未调用任何平台
- ❌ 未接线 Action Guard（仍 DESIGN ONLY / HOLD）；未改 Schema；未改 runtime 行为
- ✅ Kill Switch 继续保持只读观察层；`Production Enablement = HOLD`
- ⚠ 真实数据到位后，Runbook 的 Stage A/B/C 需由宿主提供数据并执行；产出 `PHASE1-RESULT.md` 后由架构方判定 Decision Gate

## 6. 待裁决

- **Q1**：`c961e0d` / `4c5bf3a`（含本报告提交）是否批准 fast-forward 合并到 `main`？
- **Q2**：P2 四项（P2-1…P2-4）已全部交付，下一步建议：**(a)** 进入 **Final Production Gate 准备**（汇总 P2-1…P2-4 证据、`BACKUP_VERIFY_COVERAGE_CLOSE` 状态、Secret 轮换演练为 HOST PENDING、真实数据 WAITING_HOST_DATA，形成候选清单供架构方裁决）；或 **(b)** 另案开始 **ACTION-GUARD-DESIGN**（DESIGN ONLY）。请指定顺序与边界。
