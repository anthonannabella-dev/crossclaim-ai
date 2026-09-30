# B2-FIX R1 任务队列（自治循环；完成即自动进入下一项）

## B2-FIX R1 —— 架构方最终裁决 MSG-20260930-10 = PASS（REVIEWED_HEAD 62dffa6 / CODE_HEAD 1144401）

- [x] RuleSet ownership immutable behavior tests (8626e56)
- [x] 1. RuleVersion + RuleEvaluation reference behavior tests（MSG-09 TEST 清单 7/7；0023f51）
- [x] 2. D：既有租户触发器逐项核对（清单式 CI 断言；c74d9bb）
- [x] 3. E：独立临时 PostgreSQL 两段升级（c74d9bb）
- [x] 4. F：迁移同名重纳 byte-identical + checksum（c74d9bb）
- [x] 5. G：历史口径纠偏（docs/releases/B2-FIX-R1-RECORD-CORRECTIONS.md；c74d9bb）
- [x] 6. final local verification（prisma validate / tsc / 17 专项 / 两段升级全绿）
- [x] 7. final CI（62dffa6 run 36650230743 → 5/5 SUCCESS）
- [x] 8. 审查对比 PR #10（base b2-fix-r1-baseline —— 架构方已注明其不交付到 main）
- [x] 9. READY_FOR_REVIEW（已投递并回读验证）
- [x] 10. ChatGPT final audit（MSG-20260930-10 = PASS，已逐字归档 FULL_COPY_OK 52/52）
- [x] 11. 面向 main 的正常集成 PR #11（base main；集成 HEAD e40d4f9；CI run 36651145264 = 5/5 SUCCESS；正式审计请求 comment 5901785441）
- [x] 12. MSG-20260930-10 的三项非阻塞文字口径修正（§8.4 限定 + §10 新增；随集成 PR 复核）

## 边界（持续有效）

- Production Enablement / 真实外写 / 资金操作 / 客户提交 / 生产凭据 = HOLD。
- 本次 PASS ≠ 自动审计桥 / 自治 runner / 产品整体 / 真实数据 / 生产启用通过。
- 进入下一重大 Gate 需架构方裁决；合并决策归架构方，且不得绕过分支保护。

## 下一队列（已授权，等待 PR #11 裁决后再开工）

- [ ] 13. Gate 7 授权队列推进：① ACTION GUARD = 已完成（CP1）；③ PRODUCTION CONTROL PLANE = **PASS**（MSG-20260930-16 / REVIEWED_HEAD e460a82）；**当前动作 = ② RUNTIME BUSINESS BLOCKING 的业务接入覆盖**（`payment.capture` PASS / `payment.replay` PASS / `payment.retry_due` R18 送审中；其余入口见 `docs/releases/ACTION-GUARD-CP2-STATUS-AND-INTEGRATION-CHECKLIST.md` §3）；**② 整体 NOT COMPLETE 之前不开 ⑤/⑥/⑦**（MSG-20260930-16 的优先顺序）。
- 开工前先确认：不与 PR #11 的集成范围冲突；涉及安全/资金/规则引擎/Gate 边界的部分需架构方裁决。

## 双账（B2）

| 账目 | 状态 | 证据 |
| --- | --- | --- |
| B2-FIX R1 工程修复（审 PASS） | PASS | MSG-20260930-10（REVIEWED_HEAD 62dffa6 / CODE_HEAD 1144401） |
| B2-FIX R1 面向 main 的集成（审 PASS + MERGE APPROVED） | PASS | MSG-20260930-11（REVIEWED_HEAD e40d4f9 / PR #11 / comment 5901910080） |
| 已交付 main | MERGED + main CI 5/5 SUCCESS（run on 16b47a2） | merge commit `16b47a2` |

> 说明：架构方要求「B2 已审 PASS」与「已交付 main」分别记账；上表即两账分列。

## Gate 7 授权队列（MSG-20260930-03，8 项）

| 项 | 状态 | 证据 |
| --- | --- | --- |
| ① ACTION GUARD（设计 → 实现） | 已完成（CP1 = 纯决策函数 + 审计事件） | 8109003 / 26f78e8 起 |
| ② RUNTIME BUSINESS BLOCKING（Action Guard CP2） | **进行中（整体 NOT COMPLETE）** | 第一批 HITL 提交入口：已接入（见 `ACTION-GUARD-CP2-STATUS-AND-INTEGRATION-CHECKLIST.md` §5/§6）；账单登记入口 `payment.capture` = PASS（MSG-20260930-24 / REVIEWED_REF 73115a3）；`payment.replay` = PASS（MSG-20260930-28 / REVIEWED_REF 08fc45d）；冻结批次 `payment.retry_due` = **送审中**（R18：HEAD 4c695c0 / CI run 36718083469 / Issue #2 comment 5911844071）；其余入口见 §3 清单 TODO |
| ③ PRODUCTION CONTROL PLANE | **已完成 = PASS** | MSG-20260930-16（REVIEWED_HEAD e460a82 / Issue #2 comment 5902610608）；实现：`control-plane.ts` / `control-plane-wiring.ts` / `control-plane-status.ts` / `capability-source.ts` / `kill-switch-adapter.ts`（四层模式 READ_ONLY/DRY_RUN/MANUAL_REVIEW/WRITE_ENABLED，默认 READ_ONLY；配置异常回落 READ_ONLY） |
| ⑤ RELIABILITY | 待开工（**须待 ② 业务覆盖完成**） | MSG-20260930-16 原文顺序：「修复后再推进 ② 业务接入第一批 HITL 提交入口，**优先于新增⑤可靠性工作**」 |
| ⑥ OPERATIONS-ADMIN | 待开工 | — |
| ⑦ SECURITY HARDENING | 待开工 | — |

> CP2 已交付：runtime-guard（fail closed + 审计不可用降级）/ capability-source（Kill Switch 接线）/ guard-enforcement（唯一执行入口 + 不可绕过静态检查），共 34 项 Action Guard 单测。
