# B2-FIX R1 历史口径纠偏与证据口径统一（CHANGE G）

依据：架构方 **MSG-20260930-04**（C-0002 RE-REVIEW = REVISE）的 B1 / B2 / B3 与三项主动申报风险裁定，
以及 **MSG-20260930-06 CHANGE G**（提交历史口径纠偏；注意动态挂载只覆盖迁移执行时已有的表）。

范围声明：本文件只纠正**历史叙述与证据口径**。不修改领域语义、不放宽任何隔离约束、不删除失败测试。

---

## 1. 「现有子表触发器 = 等价复合外键约束」的表述作废

旧表述（`ARCHITECTURE_CONTRACT.md` §5.2、`DOMAIN_MODEL.md` §4.2、`B2-TENANT-IMMUTABILITY-PLAN.md`）
把 `cc_tenant_*` 子表触发器称为「等价数据库级约束 / 等价复合外键约束」。该说法**过强，已作废**。

准确口径：

- `crossclaim_assert_tenant_integrity()` 只在**引用行自身 INSERT / UPDATE 时**比较
  `NEW.organizationId` 与被引用行 `organizationId`，不一致抛 `check_violation`（SQLSTATE 23514）。
- 它**不阻止被引用对象事后改变归属**：普通外键只引用 `id`，`@@unique([organizationId, id])` 不会因此变成复合外键；
  A 租户 `Case` 改成 B 租户后，既有 `Claim → Case` 关系会静默变成跨租户。
- `RuleSet` 同时改 `ownerType / ownerKey / organizationId` 使其满足既有 CHECK 时，已存在的 `RuleVersion` 不会被重新校验。

这两类缺口由本轮新增迁移 `20260930100000_tenant_ownership_immutability` 的归属不可变触发器
（`cc_tenant_immutable__*`、`cc_ruleset_ownership_immutable`）覆盖。

即：**子表引用校验 + 归属不可变** 两者合起来才接近复合外键的语义；单说前者等价是不成立的。

---

## 2. B1：`b626a6a` 当时是 REVISE，不追认 PASS

- `b626a6a`（B1 跨租户引用保护）当时判定为 **REVISE**：`BillingInvoice.caseId` 未挂租户触发器；
  通用函数在 `organizationId` 为空时整体跳过。
- 该问题后来由迁移 `20260928070000_tenant_integrity_fixes` 修复（补挂触发器、补 `RuleVersion` 归属校验等）。
- 记录口径：**「当时 REVISE、后来修复」**。后续修复成立，不等于当时的提交获得架构 PASS；
  历史 ACK / TEST 记录不得被追认为架构验收。

---

## 3. B2：本轮修复范围与证据边界

- B2 的修复=新增迁移（不改历史迁移），只加约束、不改数据；发现历史脏数据时另出清理方案。
- 在本轮 READY_FOR_REVIEW 之前，B2 一律 **NOT COMPLETE**，不给多租户地基完整 PASS。
- 触发器计数与清单：见 §9。

---

## 4. B3：许可证闸门曾「扫描空转」（历史记录）

- 历史问题：npm 许可证闸门的 `WORKSPACES` 指向旧目录，导致扫描实际为空，得到的是「无问题」的假象。
- 当前状态：已在 main 修复，并有覆盖守卫测试防止再次空转；本轮 `license-gate` 作业与其余 4 个作业同为 SUCCESS。
- 记录口径：**历史空转必须留痕**，不能因为当前绿灯就当作「一直有效」。

---

## 5. `deploy-smoke` 的升级路径只证明幂等

- 旧 `deploy-smoke` 的「升级路径」是在同一空库上再次 `migrate deploy`，只证明**重复执行幂等**，
  不能证明「旧版本库带数据升级到 B2」。
- 本轮补齐：`tools/upgrade-verify/two-stage-upgrade.mjs`——
  ① 独立临时库只应用 B2 之前迁移 → ② 播种关联合成数据 → ③ 保留数据应用 B2 → ④ 断言数据/归属/引用未变且新保护真实拒绝非法写入 → ⑤ 再次 `migrate deploy` = `No pending migrations`（幂等，仅作附加检查）。
- CI 与本地均执行；本地取证见 §8。

---

## 6. 动态挂载的固有限制

`cc_forbid_tenant_reassignment()` 是按「迁移执行时**已存在**且含 `organizationId` 的表」循环挂 trigger 的。

- 之后**新增**的 tenant-owned 表不会自动获得归属不可变触发器，必须**补迁移**。
- 为使漏挂无法悄悄通过，CI 采用**双向清单**：既检查清单内每个触发器存在（名称/表/事件/启用），
  也反向检查运行库中不存在清单未覆盖的启用 `cc_tenant_*`（`tools/tenant-triggers/`）。
- 因此新增保护必须同时更新 `tools/tenant-triggers/required-triggers.json`，否则 `ci.yml` 的清单步骤变红。

---

## 7. 非阻塞后续项（不得误读为已完成）

沿用架构方裁定，以下均为**已记录的非阻塞项**：

| 项 | 裁定 | 触发条件 |
| --- | --- | --- |
| `RuleVersion` 版本与哈希可复算 | Gate 0 **非阻塞技术债** | 进入真实金额结果验收前必须可复算：保存当时的定义、输入、评估器身份、舍入规则；历史结果不得随升级静默改写；短哈希不作防篡改 |
| Python / pip 许可证扫描 | **当前非阻塞后续项** | 引入或启用 Python 服务前必须完成；现有 npm job 只证明直接依赖 |
| Logging / Health / Storage / Audit | **旧「四项未实现」清单作废** | 当时是后续交付项，当前已有实现；但「代码存在」≠「生产运行效果已验收」 |

必须后置（不在工程修复范围）：真实脱敏数据准确率、正式平台 API、真实账号授权、真实追回与到账、生产部署与生产存储验证。

---

## 8. 本轮自查更正：一次误报与它的真实原因

### 8.1 误报内容

在本轮早期，`b2-tenant-ownership-behavior-db` 曾把「B 租户写入引用 A 租户 `RuleVersion` 的 `RuleEvaluation` 未被拒绝」
判定为**跨租户保护缺口**，并据此申报「新发现缺口 → 需要架构裁决」。

### 8.2 取证结论（运行库，未输出任何连接串或凭据）

```
pg_get_triggerdef:
  CREATE TRIGGER cc_tenant_ruleevaluation BEFORE INSERT OR UPDATE ON public."RuleEvaluation"
    FOR EACH ROW EXECUTE FUNCTION crossclaim_assert_tenant_integrity(
      'ruleVersionId','RuleVersion','sourceTransactionId','SourceTransaction',
      'opportunityId','RecoveryOpportunity')
pg_get_functiondef(crossclaim_assert_tenant_integrity):
  IF ref_org IS NOT NULL AND ref_org <> own_org THEN
    RAISE EXCEPTION 'cross-tenant reference blocked: %.% -> % (id=%)' USING ERRCODE = 'check_violation';
tgenabled = 'O'（启用）；session_replication_role = origin（无复制绕过）
```

即：触发器参数、函数逻辑、启用状态、目标保护标记与 SQLSTATE 均**符合架构方 RULE**，**不存在缺口、不存在迁移漂移**。

### 8.3 真实原因

失败断言使用了**大小写敏感**的正则 `/TENANT|CROSS/`，而数据库实际消息是小写 `cross-tenant reference blocked: …`。
断言与消息大小写不匹配 → 测试把「已被正确拒绝」误判为「未被拒绝」。

### 8.4 更正动作

- 断言改为大小写不敏感，并升级为**目标保护标记 + SQLSTATE 23514** 双断言；
- 补齐 MSG-20260930-09 TEST 清单遗漏项：B 租户已有评估改 `ruleVersionId` 为 A 版本必须被 UPDATE 拒绝；
  伪全局版本（`organizationId IS NULL` 却指向 TENANT `RuleSet`）必须被拒绝；不存在的版本必须由外键拒绝（23503）
  且**不得**当作跨租户保护证据；
- 所有拒绝用例都复查「失败后无非法新增行、原引用/原归属未变」。

结论：本轮**没有发生架构修复**（保护本来就是对的），发生的是**测试断言缺陷**；该误报在此如实留痕。

---

## 9. 当前计数口径（替代旧的「24 表 / 28 触发器 + 数量下限」）

| 族 | 数量 | 说明 |
| --- | --- | --- |
| `cc_tenant_*`（引用完整性，排除 immutable） | 28 | 迁移 `20260928060000_tenant_integrity` + `20260928070000_tenant_integrity_fixes` |
| `cc_tenant_immutable__*`（归属不可变，BEFORE UPDATE） | 36 | 迁移 `20260930100000_tenant_ownership_immutability`，与「含 `organizationId` 的表」逐表对应 |
| scoped 归属触发器 | 2 | `cc_ruleset_ownership_immutable`（`RuleSet`）、`cc_ruleversion_ownership`（`RuleVersion`） |

CI 断言方式（`tools/tenant-triggers/`、`.github/workflows/ci.yml`）：

1. 清单内每个触发器必须存在、挂在指定表、`tgtype` 与 `tgenabled='O'` 均匹配；
2. 运行库不得出现清单未覆盖的启用 `cc_tenant_*`；
3. 每张含 `organizationId` 的表都要有 `cc_tenant_immutable__<表>`；
4. **不再使用「总数 ≥ N」的下限断言**（下限无法证明每一条必要保护都存在）。
