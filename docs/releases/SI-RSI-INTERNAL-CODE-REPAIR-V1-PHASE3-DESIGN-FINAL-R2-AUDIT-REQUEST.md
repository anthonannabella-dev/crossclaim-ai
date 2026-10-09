# SI/RSI INTERNAL CODE REPAIR V1 —— PHASE 3 设计 FINAL-R2 复审请求（只读修订，仍未实施）

审计编号（请在回复标题中沿用）：MSG-20261009-13
REVIEWED_HEAD = 7dc8535e（分支 feat/si-rsi-internal-code-repair-v1）
上一轮裁决：MSG-20261009-12 = PASS WITH REVISE（PHASE3_DESIGN_ACCEPTED=YES_WITH_CONDITIONS；
PHASE3_IMPLEMENTATION_AUTHORIZED=NO；REQUIRED_CHANGES = CHANGE 1–3 P0 + CHANGE 4–8 P1；
NEXT_AUTHORIZED=PHASE3_DESIGN_FINAL_R2_READ_ONLY；NEXT_AUDIT=MSG-20261009-13）
durable 记录：docs/releases/SI-RSI-INTERNAL-CODE-REPAIR-V1-PHASE3-DESIGN.md（§8 FINAL-R2 修订、§9 状态转移表、§10 未实施声明）

重要声明：本轮**仍为只读设计修订**。未实现 FaultTrustedFactsAdapter、未建立候选消费通道、未实施 Builder/Judge、未接线、
未修改 Runtime / 队列 / Action Guard、未改 Prisma/migration、未修改封板 RC/main、未开启真实 Provider/支付/报关/外写。
EXTERNAL_WRITE = HOLD；PRODUCTION_READY = NO；PHASE3_IMPLEMENTATION_AUTHORIZED 仍为 NO。

一、CHANGE 1（P0）封闭「授权撤销 ↔ 执行副作用」竞态
承认上一版的缺口：fenced settle 只能证明**最终状态写入**被拒，不能证明窗口内已发生的副作用不存在。
本轮新增契约：
1. **最终授权门**：在实际执行动作**之前**、紧邻副作用入口处再次调用可信适配器（authorizeAtExecution），
   校验组织身份 / 授权版本 / 撤销状态 / 有效期 / 动作类型 / 限额。
2. **执行期持续校验**：动作执行期间按固定节拍校验租约未过期 + fencing token 未被替换；失败即触发取消协议。
3. **取消协议**：每个副作用声明取消语义 —— CANCEL_SAFE（提交前可中止、无外部可见效果）/
   CANCEL_UNSAFE（一旦开始即可能产生外部可见效果 ⇒ **本阶段禁止**；外写/支付/报关/运输恒 HOLD）。
4. **唯一提交边界**：每个可见副作用声明唯一提交点（如 DB COMMIT 或外部请求发出）；提交点前失败 ⇒ 无副作用；
   提交点后失败 ⇒ **必须如实登记"可能已发生"**，不得因事后 settle 失败而宣称「零副作用」。
5. **线性化要求**：撤销与提交之间须有可证明的线性化顺序（① 提交点持与授权版本绑定的行级锁/条件写；② 提交前带版本号 CAS；
   ③ 等效串行化+防重+取消协议）；无法证明 ⇒ BLOCK / HUMAN_REVIEW。
6. 不可逆动作本阶段继续禁止；不得以「执行前二次检查」替代可证明的线性化。
验收矩阵（实施阶段逐格覆盖；零副作用断言只覆盖"可被系统实际阻断"的窗口）：
| 撤销时点 | 期望 | 证据 |
| claim 前 | 不领取 | claim 拒绝 + 原因码 |
| claim 后、执行前 | 最终授权门拒绝 | 门禁拒绝记录；零次调用副作用入口 |
| 执行中、提交前 | 取消协议生效 | 取消证据 + 无提交记录 |
| 提交边界处 | 撤销先赢或提交先赢，二者其一 | 线性化顺序证明（锁/CAS/串行化） |
| 提交后 | 如实登记"可能已发生"，不得宣称零副作用 | 副作用登记 + 人工处置路径 |

二、CHANGE 2（P0）A 路径候选与客户任务的强身份隔离
1. 内部故障候选**不是**客户请求；不得把 INTERNAL_FAULT 改写成 CUSTOMER_GOAL_QUEUE 以复用客户 Standing Authorization。
2. 候选必须保留 incidentId、**服务端解析所得**的可信租户关系、任务类型与来源身份。
3. **载荷中的 organizationId 一律不是可信身份**（沿用 PHASE 2 契约）。
4. **入队前**与**认领后**必须**分别**重新解析授权与身份（两次独立解析，任一次失败即拒绝）。
5. 现有客户授权**不得**自动扩大到内部代码修改；内部修复须走 CHANGE 3 的独立权限模型。
6. INTERNAL_FAULT 不得借队列转换绕过 Action Guard / 审批 / Kill Switch。
7. 必须定义 incident ↔ task 的持久化关联、去重键（同因不重复入队）、状态转移（见 §9）与崩溃恢复规则（不重复消费、不身份漂移）。
8. **本轮不修改队列代码**（上述均为设计契约）。

三、CHANGE 3（P0）修复权限分离覆盖「补丁生成 → 发布」全过程
| 维度 | 强化条款 |
| 工作区绑定 | 绑定基线 commit、**逐路径允许清单**、变更内容哈希（候选 diff 摘要） |
| 路径限制 | 禁止符号链接逃逸 / 路径穿越 / .git/hooks / 子模块 / 间接配置与脚本调用逃逸；仅允许清单内常规文件 |
| 命令限制 | 测试命令不得继承生产凭据、Docker socket、宿主敏感挂载、发布权限；默认禁网；命令白名单 |
| Judge 独立性 | Judge 不得由 Builder 构造/覆盖评审依据；必须核验**真实可复现**测试输出（命令+退出码+原始日志摘要） |
| 结果不可变性 | Judge 审核的补丁哈希必须与最终候选**完全一致**；不一致 ⇒ BLOCK / PATCH_DIGEST_MISMATCH / NO_APPLY |
| 提交边界 | 即使 Judge PASS 也只能产出**已验证候选**；禁止自动合并/部署/改封板分支 |
| 回滚边界 | 回滚必须**实际可行**（含数据与配置）；不可逆副作用**不得承诺**自动回滚 |
| 白名单口径 | services/** 不再整体默认可改，改为**逐路径允许清单**（每项需审计确认） |

四、CHANGE 4–8（P1）已补条款
- CHANGE 4 provenance 生命周期：绑定**执行主体 + 租户 + 会话 + 事实版本 + 读取时间**；旧证明 / 跨主体 / 跨会话证明不得复用。
- CHANGE 5 快照规则：明确 triagedAt TTL、授权版本、状态变更与**重新分流**规则；**过期快照不得进入执行**。
- CHANGE 6 重试与成本上限：分流/补丁 REVISE **有界**（次数 + 模型成本 + 时长），超限 ⇒ BLOCK。
- CHANGE 7 真实性验证：安全边界必须由**真实 PostgreSQL + 真实运行时路径**负向测试证明；**不允许**仅用 mock。
- CHANGE 8 崩溃收敛：定义崩溃后状态收敛与不可重复提交契约；恢复后不得重复副作用或身份漂移。

五、失败矩阵补充（§8.5）
新增：TOCTOU（检查与使用之间状态变化）⇒ 拒绝并重新分流；路径逃逸（符号链接/穿越/hooks/子模块/间接配置）⇒ 拒绝并留证；
崩溃恢复后重复消费 / 身份漂移 ⇒ 不重复副作用不漂移；**JUDGE_PASS_PATCH_CHANGED_AFTER_REVIEW** ⇒ BLOCK / PATCH_DIGEST_MISMATCH / NO_APPLY。

六、状态转移表（§9，节选）
CANDIDATE_REGISTERED →（快照未过期/非外写/非安全信号）→ ENQUEUE_PENDING →（入队前重解析身份+授权、不得改 kind、不得绕 Guard）→
ENQUEUED →（认领后再次重解析、租约获取成功）→ CLAIMED →（最终授权门通过 + 租约未过期 + fencing token 有效）→ EXECUTING →
（提交点前）CANCELED / （到达提交边界）COMMITTED 或 REJECTED_AT_COMMIT（线性化决定胜者，不可二者皆真）→
SETTLED 或 SETTLE_REJECTED_BUT_EFFECT_POSSIBLE（已过提交点 ⇒ 如实登记"可能已发生"）；
任意态遇撤销 ⇒ BLOCKED / CANCELED / REJECTED_AT_COMMIT（按五情形矩阵）；任意态崩溃 ⇒ RECOVERING → 收敛（不重复副作用）；需修代码 ⇒ CODE_REPAIR_CANDIDATE（独立权限模型，不得自动落地）。

七、如实声明的未实现事项（不虚报）
1. 未实现任何执行能力：适配器、候选消费通道、Builder/Judge、隔离沙箱、回滚机制**均未实现**。
2. 本轮**没有**用 mock 冒充安全边界证明——因为**尚未做任何实施**（CHANGE 7 是实施阶段的验收要求）。
3. runtimeSourceIsolationImplemented = false 仍成立（PHASE3_IMPLEMENTATION_PREREQUISITE）。
4. Linux/systemd、真实 Provider/模型、CI、生产环境**未验证**。
5. 历史测试债（P2E-DB5、broker hook）与历史载荷敏感残留**仍未关闭**。

八、请求裁决（逐项）
1. CHANGE1_REVOCATION_SIDE_EFFECT_RACE_CLOSED（五情形矩阵与线性化要求是否足以闭合）
2. CHANGE2_CANDIDATE_IDENTITY_ISOLATION（强身份隔离与 incident↔task 契约是否充分）
3. CHANGE3_REPAIR_PERMISSION_END_TO_END（工作区/路径/命令/Judge/不可变性/提交与回滚边界是否足够保守）
4. CHANGE4_TO_8_CLAUSES（四项 P1 条款是否满足）
5. FAILURE_MATRIX_AND_STATE_TABLE（含 TOCTOU / 路径逃逸 / 崩溃恢复 / JUDGE_PASS_PATCH_CHANGED_AFTER_REVIEW 与 §9 状态表）
6. DESIGN_ONLY_SCOPE_HONESTY
并给出：
FINAL VERDICT: PASS | PASS WITH REVISE | REVISE | BLOCK
REVIEWED_HEAD: <sha>
PHASE3_DESIGN_FINAL_ACCEPTED: YES | NO
PHASE3_IMPLEMENTATION_AUTHORIZED: YES | NO
NEXT_AUTHORIZED: <你方明确授权的下一步范围>
CHANGES: <必须执行的修订>
RISKS: <剩余风险>
请在本会话直接回复（不要写入我的仓库，也不要尝试访问外部系统）。若上文不可读，回复「需要重发」。
