# Enterprise Trust Readiness（状态与证据清单）

维护规则：**只允许**以下四种状态；任何「已合规」的表述必须有外部证据，否则必须写 `NOT_AVAILABLE`。

- `IMPLEMENTED`：代码/控制已实现并有仓库内证据（测试、迁移、闸门）。
- `VERIFIED`：实现 + 可重复验证（CI 或真实 DB 验收）。
- `EXTERNAL_AUDITED`：由独立第三方出具报告（**当前无任何项达到此状态**）。
- `NOT_AVAILABLE`：尚未取得（含尚未开始 / 无外部证据）。

## 1. 控制清单

| 项目 | 状态 | 证据 / 说明 |
|---|---|---|
| Tenant isolation | VERIFIED | 全库 tenant 触发器清单（`tools/tenant-triggers/required-triggers.json`，运行库 psql 校验 91 baseline / 67 immutable） |
| RBAC | VERIFIED | `apps/api/src/services/workflow/permissions.ts` + Action Guard 矩阵与 HTTP 用例 |
| Immutable audit | VERIFIED | audit coverage 闸门 + 受保护动作注册；append-only 事实表（触发器拒绝 UPDATE/DELETE） |
| Secret handling | IMPLEMENTED | SecretVault 抽象 + 无凭据落库（测试断言事实/账本表不含 credential 字段） |
| Credential lifecycle（轮换/撤销） | IMPLEMENTED | 轮换路径与撤销契约存在；生产轮换为 HOST_APPROVAL_REQUIRED |
| Incident response status | NOT_AVAILABLE | 尚无正式 runbook 演练记录 |
| Backup / restore status | VERIFIED | CI job「Backup restore verify · synthetic dataset」持续通过 |
| RTO / RPO status | NOT_AVAILABLE | 未定义目标值，需宿主与架构方确认 |
| DPA status | NOT_AVAILABLE | 法务文书未签署（LEGAL_OR_LICENSE_REQUIRED） |
| Subprocessor list status | NOT_AVAILABLE | 未登记 |
| Penetration test status | NOT_AVAILABLE | 未进行第三方渗透测试 |
| SOC 2 status | NOT_AVAILABLE | **未取得 SOC 2 报告**；不得对外宣称 SOC2_COMPLIANT |
| ISO 27001 status | NOT_AVAILABLE | **未取得 ISO 27001 认证**；不得对外宣称 ISO27001_CERTIFIED |
| Data retention / deletion policy | IMPLEMENTED | 删除/保留契约与部署说明存在；生产执行 HOLD |
| Encryption at rest / in transit verification | IMPLEMENTED | 传输 TLS（部署层）+ 存储加密配置说明；**未做外部验证** |

## 2. 对外表述约束（硬规则）

- 允许对外表述：`SECURITY_CONTROLS_IMPLEMENTED`（内部实现与控制清单）。
- **禁止**在未取得外部证据前使用：`SOC2_COMPLIANT`、`ISO27001_CERTIFIED`、`BANK_GRADE_SECURITY`。
- 该约束由测试 `apps/api/src/__tests__/enterprise-trust-claims.test.ts` 静态守卫（扫描 README/docs/api 说明；本清单自身允许出现在“禁止”语境）。

## 3. 与 Gate 的关系

- 本清单不改变任何 Gate：真实 filing / 外写 / 资金 / 生产凭据继续 HOLD_EXTERNAL。
- 任何 `EXTERNAL_AUDITED` 结论必须由宿主提供第三方报告后方可更新。
