# [SEO → ARCHITECT] PUBLIC ENGINE IMPLEMENTATION AUDIT（MSG-20261005-06 五项必修已落地）

## 0. 耐久记录与送审基线

- 本文件即耐久记录：`docs/releases/SEO-PUBLIC-ENGINE-IMPLEMENTATION-AUDIT-REQUEST.md`（随本批 commit 推到 `gate/7-commercial-validation`）。
- **代码送审 HEAD = `efcc125`**；上一轮裁决 **MSG-20261005-06（PASS WITH REVISE）** 已逐字归档（FNV `29fe15cb` / 386 行 / `FULL_COPY_OK`）。
- 通道说明：本机 `gh` token 仍失效，耐久记录继续用仓库文件。

## 1. 声明（硬边界，未变）

- 公开只读入口仍**默认关闭**（`PUBLIC_SEO_CHECKER_ENABLED=false`）；`seo-public-ports` 的 engine registry **仍为空** →
  `listRegisteredBasisKeys()` 为空、公开 Checker 继续 fail-closed（`estimate = null`）、indexability gate 保守判 noindex。
- 无租户数据、无 PII、匿名只读、零外写、不扣费、不创建 submission；estimate 只可能标注为估算；
  `EXTERNAL_WRITE / PAYMENT / TRANSPORT / PRODUCTION_CREDENTIALS / PRODUCTION_PUBLIC_CHECKER = HOLD`；本轮**零公开行为变更**。

## 2. 五项必修逐条落地

| 裁决项 | 落地 | 证据 |
| --- | --- | --- |
| ① eligibility 必须显式「自报预筛」语义 + 必填由规则决定 | `seo-public-engine-schema.ts`：`buildPublicEligibilitySchemaForRule(rule)`，每个字段 `required` 直接取自 `rule.eligibility.requires*`（`minimumEvidenceCount > 0` 才要求 `evidenceCount`）；`SeoPublicCheckerOutcome.eligibilityLabel` 类型**只允许 `PRELIMINARY_SELF_REPORTED \| null`**，checker 在 eligibility 真正执行时置标签、拒绝结果一律 `null` | `seo-public-engine-schema.test.ts` 7 例；`seo-public-eligibility-label.test.ts` 3 例（含「序列化里不得出现 VERIFIED / READY_TO_FILE」断言） |
| ② 证据只作数量门槛，最终标签保持 prelim | 语义常量 `EVIDENCE_VALIDITY_VERIFICATION = NOT_PERFORMED` 固化；输出不含任何「已验证/可申报」字样（类型层面不可表示） | 同上 |
| ③ DUTY_DIFFERENCE 不得循环（不得把用户自报可退额当输入） | `seo-public-duty-difference.ts`：输入改为 `dutyPaidAmount` + `dutyActuallyDueAmount` + `currency`，`difference = max(0, paid − due)` 由引擎自行推导；`refundableAmount` 已从 schema 移除 | `seo-public-duty-difference.test.ts` 8 例（含 CIRCULAR_MODEL_IS_GONE） |
| ④ 不得人工制造区间 | 输出为 point estimate：`min === max` = 推导出的差额；无 ±%、无成功率、无历史比例；非正差额或输入不可用一律 `estimate = null` | 同上（NO_ARTIFICIAL_RANGE / NON_POSITIVE_YIELDS_NULL） |
| ⑤ 双 schema 编排（此前 checker 只取一套 schema） | `seo-public-answer-orchestration.ts`：读 eligibility + calculation 两套 schema → 建 union whitelist → 同 key 定义冲突即 `SCHEMA_CONFLICT` fail-closed → 两侧都不含的 key 拒绝 → 分别投影 `eligibilityAnswers` / `calculationAnswers`；**已接进 `runPublicSeoChecker`**（单 schema 选择已删除，per-engine 投影） | `seo-public-answer-orchestration.test.ts` 9 例；checker 套件回归通过 |

## 3. 关键判定：DUTY_DIFFERENCE engine **不注册**（诚实结论）

按你的要求，只有在规则能**真实解释**为 `dutyPaid − dutyActuallyDue` 时才注册。事实核查结果：

- 仓库内**没有** `us-customs-drawback` 的规则定义：该 slug 只出现在**测试夹具**与**文档**；
- 生产规则来自数据库 `RuleVersion` 行（宿主环境数据，不在仓库内）；
- 仓库内唯一可证的是 `kind: 'DUTY_DIFFERENCE'` 与 `basisKey` 字符串 —— 那是**标识**，不是数学语义证明。

因此：`DUTY_DIFFERENCE_ENGINE_REGISTRATION = NOT_REGISTERED`；`PUBLIC_CALCULATOR = UNAVAILABLE（estimate = null）`。
注册前置条件（含所需 RuleVersion 语义与 sourceReference、架构确认、仍仅 DEV/STAGING 显式开启）已写入
`docs/releases/SEO-DUTY-DIFFERENCE-REGISTRATION-DECISION.md`。

## 4. 证据汇总

- `npx tsc --noEmit`（apps/api）= **exit 0**。
- `npx vitest run src/__tests__/seo-` = **23 文件 / 164 例全过**（本轮新增：engine-schema 7、eligibility-label 3、duty-difference 8、answer-orchestration 9）。
- 提交门禁：api-contract / audit-coverage / autopilot-rules 全 OK。

## 5. 请裁定

1. 上述 5 项是否可记 **PASS / CLOSED**？
2. `PUBLIC ENGINE IMPLEMENTATION` 是否可记 **PASS**（前提：registry 仍为空、入口仍默认关闭、estimate 仍为 null）？
3. 若日后某份生效 `RuleVersion` 证实了「已缴 − 应缴」语义，是否**只需按既有前置条件注册**（代码与 schema 均已就绪），无需再次设计送审？若仍需一次注册审计，请说明最小材料。
4. 若仍需补证据，请只列**最小集合**。

请在本次会话中直接回答；不要尝试写回 GitHub。不要使用上一轮缓存。
