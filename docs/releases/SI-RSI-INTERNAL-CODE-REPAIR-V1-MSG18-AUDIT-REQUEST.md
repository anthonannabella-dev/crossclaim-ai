# SI/RSI INTERNAL CODE REPAIR V1 —— MSG-20261009-18 送审（U1 FINAL-R4：CHANGE 26–28）

审计编号（请在回复标题中沿用）：MSG-20261009-18
REVIEWED_HEAD = 68f8f5a9（U1 代码 commit，分支 feat/si-rsi-internal-code-repair-v1）
本轮执行依据：MSG-20261009-17 的 NEXT_AUTHORIZED = PHASE3_A_U1_FINAL_R4_EVIDENCE_VERIFICATION_ONLY
上一轮裁决：MSG-20261009-17 = REVISE（理由：证据可复核性不足；REQUIRED_CHANGES = CHANGE 26/27/28）

重要：上一轮指出评审方无法取得原始材料。本轮**在同一会话的下一条消息**中内联提供
固定 HEAD 的关键源码原文、逐项用例名称、原始测试输出摘要与全部 U1_EVIDENCE 证据行
（并附三个 U1 文件的 sha256）。请把那条消息与本文一起作为本轮送审材料。

本轮**只**处理 CHANGE 26–28，不扩大任何执行权限，不重复打开已通过的金额规则。
请裁决：是否可签署 PHASE3_U1_IMPLEMENTATION_CLOSED = YES（U2–U5 仍应保持 NO）。

═════════ CHANGE 26（P0）：可独立复核的原始材料 ═════════
- 下一条消息内联：codeCommit=68f8f5a9；三个 U1 文件的 sha256；适配器关键源码原文（范围策略、
  checkScopeDeclaration、resolve 的 ③ 前置校验、provenance.scopePolicy、runInReadOnlyTransaction）；
  原始输出摘要（61 passed (61) / 2 passed (2) / VITEST_EXIT=0 / TSC_EXIT=0 / DB=隔离库）；
  真实 PostgreSQL 8 项与端口级 53 项逐项名称与状态；全部 6 条 U1_EVIDENCE 证据行。
- 仓库内同时落盘：tools/verification/self-repair/phase3a-u1-final-r4-evidence.json 与
  phase3a-u1-final-r4-vitest-raw.txt、phase3a-u1-final-r4-tsc-raw.txt（供本地比对）。

═════════ CHANGE 27（P0）：范围声明链闭合（源码 + 用例） ═════════
上一轮要求确认：executionContext.resourceScope 是否真由可信服务端构造；以及 optional 维度
「没传」是否会产生范围意外扩大。本轮**用机制消除该口子**（不改变已批准的动作策略）：
1) 可选维度**必须二选一**：要么提供具体值，要么由服务端在可信上下文里**显式声明不适用**
   （executionContext.notApplicableScopeDimensions）；两者皆无 ⇒ OPTIONAL_SCOPE_UNDECLARED（fail-closed）。
   即：**省略不再等于放宽**，必须是一次显式的服务端决定。
2) 必需维度缺失 / 空串 / 被声明不适用 ⇒ REQUIRED_SCOPE_MISSING。
3) 同一维度既提供又声明不适用 ⇒ SCOPE_DECLARATION_CONFLICT（自洽性检查）。
4) provenance.scopePolicy 新增 notApplicableDimensions 与 providedDimensions，使「哪些维度参与匹配、
   哪些被显式排除、谁决定必需维度」全部可审计。
5) resolve() 入参**没有** resourceScope / notApplicableScopeDimensions 字段；有用例证明
   「请求侧夹带 resourceScope」既不会改变匹配结果，也不能替代可信上下文满足必需维度
   （仍报 REQUIRED_SCOPE_MISSING）。
诚实声明：U1 目前**尚未接线到任何生产调用点**（U2–U5 未授权实施），因此「resourceScope 由可信服务端构造」
在本轮的证据形式是：① 类型与运行时只从 executionContext 取值（源码）；② 请求侧夹带无效（用例）；
③ 夹带不能满足必需维度（用例）。真正的端到端可信装配链属于 U2 范围，本轮不主张已完成。

═════════ CHANGE 28（P1）：证据 JSON 与固定 HEAD 的对应 ═════════
- 证据 JSON 的 tests[] 逐项状态、commands[].exitCode、dbProbeEvidence[] 的探针独立性与七张表快照，
  均以「固定 HEAD = 68f8f5a9」的源码 diff 与三文件 sha256 绑定；详见下一条消息与仓库证据文件。

═════════ 请 求 裁 决 ═════════
1. CHANGE26_RAW_EVIDENCE_INLINE（内联原始材料是否足以独立复核）
2. CHANGE27_SCOPE_DECLARATION_CHAIN（可选维度省略必须显式声明；请求侧夹带无效；声明冲突 fail-closed）
3. CHANGE28_EVIDENCE_JSON_BINDING（逐项状态 / 退出码 / 探针独立性 / 七张表快照是否与固定 HEAD 一致）
4. U1_READ_ONLY_BOUNDARY_PRESERVED
5. SCOPE_HONESTY
6. PHASE3_U1_IMPLEMENTATION_CLOSED（YES / NO）

并请以下述机器可读块收尾：
MSG-20261009-18 / FINAL
AUDIT_ID=MSG-20261009-18
REVIEWED_HEAD=68f8f5a9
FINAL_VERDICT=PASS | PASS_WITH_REVISE | REVISE | BLOCK
CHANGE26_RAW_EVIDENCE_INLINE=...
CHANGE27_SCOPE_DECLARATION_CHAIN=...
CHANGE28_EVIDENCE_JSON_BINDING=...
U1_READ_ONLY_BOUNDARY_PRESERVED=...
SCOPE_HONESTY=...
PHASE3_U1_IMPLEMENTATION_CLOSED=YES | NO
PHASE3_A_U2_TO_U5_AUTHORIZED=YES | NO
REQUIRED_CHANGES=<下一轮必须执行的修订编号，无则 NONE>
NEXT_AUTHORIZED=<贵方确认授权的下一最小单元 / 范围>
NEXT_AUDIT=MSG-20261009-19
EXTERNAL_WRITE=HOLD
AUTO_MERGE=FORBIDDEN
AUTO_DEPLOY=FORBIDDEN
PRODUCTION_READY=NO

请在本会话直接回复（不要写入我的仓库或外部系统）。若下一条内联材料不完整或与本文声明不一致，
请直接判 REVISE 并指出缺口。
