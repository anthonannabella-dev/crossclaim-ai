# upgrade-verify —— B2 两段升级验证

B2-FIX R1 / MSG-20260930-06 CHANGE E + MSG-20260930-07 ANSWER。

## 为什么需要

「全量迁移后再次 migrate deploy」只能证明幂等，不能证明旧库升级路径。
因此用独立临时库走真实两段升级：

1. 阶段 1：只用「B2 之前」的迁移建立旧版结构（临时 schema 目录 = 仓库迁移副本去掉 B2），播种关联合成数据。
2. 阶段 2：保留数据，用仓库真实迁移目录执行 migrate deploy（因此只会落 B2 迁移），再跑保护行为断言。

全程不 reset、不清库、不换库；结束后强制删除临时库。

## 断言

- 原数据仍在，归属与引用关系未变：Case.organizationId、Claim→Case 同租户、RuleEvaluation→RuleVersion 指向不变。
- cc_tenant_immutable__* 触发器按「含 organizationId 的表」逐表安装。
- tools/tenant-triggers/emit-check-sql.mjs 清单校验在升级后的库上通过。
- 升级后的真实拒绝行为：父对象改租户（TENANT_REASSIGNMENT_FORBIDDEN）、RuleSet 所有权变更
  （RULESET_OWNERSHIP_IMMUTABLE）、跨租户 RuleEvaluation INSERT 与 UPDATE（cross-tenant reference blocked）
  全部被拒，且失败后状态未变。
- 再次 migrate deploy = No pending migrations（幂等；仅作附加检查，不替代升级证据）。

## 用法

```bash
# CI / 已安装 psql 的机器
DATABASE_URL=postgresql://... node tools/upgrade-verify/two-stage-upgrade.mjs

# 本地（Docker Postgres）
$env:CC_PSQL_CMD='docker exec -i crossclaim-postgres psql -U crossclaim'
node tools/upgrade-verify/two-stage-upgrade.mjs
```

安全：只用合成数据与 cc_upgrade_<hex> 临时库；脚本从不打印连接串或凭据。
