# SI/RSI INTERNAL CODE REPAIR V1 —— MSG-20261009-19 送审（U1 FINAL-R5：CHANGE 29–31，证据核验）

审计编号（请在回复标题中沿用）：MSG-20261009-19
REVIEWED_HEAD = e4c2f27d（U1 代码 commit，分支 feat/si-rsi-internal-code-repair-v1）
本轮执行依据：MSG-20261009-18 的 NEXT_AUTHORIZED = PHASE3_A_U1_FINAL_R5_EVIDENCE_VERIFICATION_ONLY
上一轮裁决：MSG-20261009-18 = REVISE（CHANGE 27 = PASS_SCOPED；REQUIRED_CHANGES = CHANGE 29/30/31，全部为证据核验）

重要（通道事实）：评审方无法访问本仓库（远端为私有库，Git blob 亦不可读）。
因此本轮把 CHANGE 29/30/31 要求的原始材料**逐字内联为该会话的后续消息**：

M1 本送审说明（即本条）
M2 固定 HEAD 完整文件内容：apps/api/src/services/self-repair/trusted-facts-adapter.ts（逐字，分片）
M3 固定 HEAD 完整文件内容：apps/api/src/__tests__/phase3a-u1-trusted-facts-adapter.test.ts（逐字，分片）
M4 固定 HEAD 完整文件内容：apps/api/src/__tests__/phase3a-u1-trusted-facts-adapter-db.test.ts（逐字，分片）
M5+M6 evidence.json 的实际内容（核心视图：保留全部实际字段与取值；仅两条超大内嵌字段以显式 OMITTED 标记指向 M2–M4 与 M7）
M7 原始 Vitest verbose 输出（逐字，分片）

分片说明：每条消息只按**行边界**切分，不做改写；分片头标注 [part i/N] 与总字符数，
故可用「分片数量 + 每片字符数」核对完整性。行尾可能由通道规范化为 CRLF，除此之外逐字一致。
（上游文件在仓库中以 LF 存储；比较指纹时请以 git show HEAD:<path> 的字节为准。）

═════════ CHANGE 29（P0）：可独立核对的固定 HEAD 文件内容 + 指纹计算 + 关键调用链 ═════════
- M2/M3/M4 给出三个 U1 文件的**完整内容**；上一轮已给出的 sha256 为：
  trusted-facts-adapter.ts = 47ac5d21…（见下）；本轮 R5 版本指纹随 M2–M4 内容重新计算并附在 M5 的 u1FileSha256 中。
- 指纹计算方式（u1-r5 证据包 fingerprintMethod）：sha256 / raw bytes / node:
  crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')。
- 关键调用链（本轮新增钉死）：
  resolve()(entry) → ③ checkScopeDeclaration(policy, executionContext.resourceScope, executionContext.notApplicableScopeDimensions)
  → 通过后 → readPort.withReadOnlyTransaction(run) → findOrganization / listStandingAuthorizations
  → selectAuthorization(rows, actionType, trustedScope, at) → 事实与 provenance 组装。
  请求侧不存在 resourceScope / notApplicableScopeDimensions 字段（源码可核对）；夹带无用例见 M3 第 4 项与 U1-DB8。

═════════ CHANGE 30（P0）：evidence.json 实际内容 + 完整执行记录与退出码 ═════════
- M5/M6 = evidence.json（schema crossclaim.si-rsi.u1-final-r5-evidence/1）的实际字段与取值；
  M7 = 原始 Vitest verbose 输出（含逐项用例名称与状态）。
- 退出码：VITEST_EXIT=0 / TSC_EXIT=0；摘要行 Tests 61 passed (61) / Test Files 2 passed (2)；
  隔离库 127.0.0.1:55432/crossclaim_p3r2_iso。
- 证据 JSON 及原始输出的落盘路径（供你方核对描述一致性）：tools/verification/self-repair/phase3a-u1-final-r5-evidence.json、
  …-vitest-raw.txt、…-tsc-raw.txt。

═════════ CHANGE 31（P1）：七张表内容级快照 + 探针执行路径 ═════════
- 七张相关表不再以计数代替内容一致性：对每张表执行
  SELECT count(*)::bigint AS n, coalesce(md5(string_agg(row_to_json(t)::text, chr(10) ORDER BY row_to_json(t)::text)), 'empty') AS digest FROM "<Table>" t
  得到「count:md5」内容级摘要（任何行任何字段变化都会改变 digest）；before/after 全表摘要逐表一致（identical=true）。
  实现代码见 M4（tableContentDigests 与 snapshot），原始取值见 M5 的 dbProbeEvidence kind=TABLE_SNAPSHOT。
- 探针执行路径：两条拒写探针各由**独立** runInReadOnlyTransaction 调用（各自 BEGIN…SET TRANSACTION READ ONLY）；
  公共入口探针在 resolve() 实际使用的同一事务内执行（transaction_read_only=on 且写入被 REJECT）。

═════════ CHANGE 27 残留项（上一轮要求「展示现有实现并证明不存在绕过路径」） ═════════
- 策略未覆盖的维度：既不能提供取值、也不能声明不适用 ⇒ SCOPE_DIMENSION_NOT_DECLARED（fail-closed）。
- 未知值 / 重复值：维度取值只接受字符串（非字符串 ⇒ REQUIRED_SCOPE_MISSING / OPTIONAL_SCOPE_UNDECLARED），
  重复声明按 Set 语义等价（返回值按固定维度顺序去重）；授权匹配只使用通过校验的维度（providedDimensions）。
  用例：M3 中「策略与范围声明检查」一项已覆盖未声明维度与重复声明。

═════════ 请 求 裁 决 ═════════
1. CHANGE29_FIXED_HEAD_FILE_CONTENT_AND_CHAIN（完整文件内容 + 指纹计算方式 + 关键调用链是否足以独立核对）
2. CHANGE30_EVIDENCE_JSON_AND_EXECUTION_RECORD（evidence.json 实际内容 + 完整执行记录与退出码）
3. CHANGE31_TABLE_CONTENT_SNAPSHOT_AND_PROBE_PATH（七张表内容级摘要 + 探针执行路径）
4. CHANGE27_RESIDUAL_DIMENSION_HANDLING（未声明/未知/重复维度的处理与「无绕过路径」）
5. U1_READ_ONLY_BOUNDARY_PRESERVED
6. SCOPE_HONESTY
7. PHASE3_U1_IMPLEMENTATION_CLOSED（YES / NO）

并请以下述机器可读块收尾：
MSG-20261009-19 / FINAL
AUDIT_ID=MSG-20261009-19
REVIEWED_HEAD=e4c2f27d
FINAL_VERDICT=PASS | PASS_WITH_REVISE | REVISE | BLOCK
CHANGE29_FIXED_HEAD_FILE_CONTENT_AND_CHAIN=...
CHANGE30_EVIDENCE_JSON_AND_EXECUTION_RECORD=...
CHANGE31_TABLE_CONTENT_SNAPSHOT_AND_PROBE_PATH=...
CHANGE27_RESIDUAL_DIMENSION_HANDLING=...
U1_READ_ONLY_BOUNDARY_PRESERVED=...
SCOPE_HONESTY=...
PHASE3_U1_IMPLEMENTATION_CLOSED=YES | NO
PHASE3_A_U2_TO_U5_AUTHORIZED=YES | NO
REQUIRED_CHANGES=<下一轮必须执行的修订编号，无则 NONE>
NEXT_AUTHORIZED=<贵方确认授权的下一最小单元 / 范围>
NEXT_AUDIT=MSG-20261009-20
EXTERNAL_WRITE=HOLD
AUTO_MERGE=FORBIDDEN
AUTO_DEPLOY=FORBIDDEN
PRODUCTION_READY=NO

请在本会话直接回复（不要写入我的仓库或外部系统）。若 M2–M7 中任一条缺失或分片不完整，请直接判 REVISE 并指出缺哪一片。
