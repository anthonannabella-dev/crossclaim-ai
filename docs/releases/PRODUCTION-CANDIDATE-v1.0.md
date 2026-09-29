# PRODUCTION-CANDIDATE-v1.0 — CrossClaim AI

> 依据架构方 **MSG-20260929-42**（FINAL-GATE-REVIEW 最终裁决：**FINAL PASS**）。
> 判定：**PRODUCTION CANDIDATE = YES**（代码层达到生产候选）；`INTEGRATION STATUS = PENDING`、`PRODUCTION VALIDATION = PENDING`、`CODE BLOCKER = 0`、`HOST APPROVAL ITEMS = TRACKED`。
> 分支 `gate/7-commercial-validation`；HEAD `ed60bca`（CI completed success）。详细证据见 [`FINAL-GATE-REVIEW.md`](../../FINAL-GATE-REVIEW.md)。

## 1. Final Gate Result

| Gate | 结果 | 要点 |
|---|---|---|
| G1 核心业务闭环 | PASS | 输入层 → 事实层 → 操作层链路完整 |
| G2 Claim 生命周期 | PASS | 状态语义正确；Recovery 未混入 `ClaimStatus` |
| G3 Evidence Chain | PASS | 上传登记 → EvidenceArtifact → CaseEvidence，可追溯 |
| G4 Recovery / Settlement | PASS | 双事实源风险已处理 |
| G5 Submission Boundary | PASS | 自动提交严格冻结 |
| G6 外部依赖隔离 | PASS | `REAL_DATA_VALIDATION_PENDING` 管理清晰 |
| G7 权限安全 | PASS | HTTP 层权限与可达性问题已补齐 |
| G8 Observability | PASS | 审计、健康、监控边界正确 |
| G9 Deployment | PASS | 具备部署候选条件 |
| G10 分类 | PASS | CODE COMPLETE |

## 2. CODE COMPLETE Matrix

| 层 | 已交付 |
|---|---|
| 输入层 | Upload / Import / Adapter / Validation Harness / Quarantine |
| 事实层 | Claim（+ClaimItem）/ Evidence / Settlement / RecoveryPayout |
| 操作层 | Operations Dashboard / Notification Projection / Admin Console v1（A1–A6） |
| 安全层 | RBAC（5 角色 fail-closed）/ 租户隔离（27 触发器）/ Audit Trail / Kill Switch |
| 工程层 | 18 迁移 / CI 三道闸门 / 部署清单 / 回滚与恢复文档 |

规模：37 模型 / 39 枚举 / 18 迁移 / 27 租户触发器；API 契约 `implemented=52 / documented=53`；审计覆盖 `78 代码动作 vs 71 文档动作`；测试 106 files / 979 cases 全绿（真实 PostgreSQL 16）。

## 3. Pending Integration List

外部账号与平台对接（`INTEGRATION_PENDING`）：Shopify Partner/API、Amazon SP-API、Walmart API、TikTok Partner、Stripe、PayPal、物流 API（17TRACK / EasyPost）。

## 4. Pending Validation List

真实数据（`REAL_DATA_VALIDATION_PENDING`，对应 `REAL-DATA-VALIDATION-BACKLOG.md` RD-01…RD-12）：Shopify 导出、Amazon/Walmart Settlement、TikTok 数据、物流账单、Carrier SLA / DAS、Customs 数据、C88/7501、真实 Claim 案例；以及 Stripe test 全事件链。

## 5. Known Restrictions（产品边界，非代码缺失）

- 自动提交 Claim / Appeal：**FORBIDDEN**（`supportsClaimSubmission=false` 类型锁死，恒 `NEEDS_MANUAL`）
- Amazon Case / TikTok Dispute / Walmart 自动提交：**❌**
- 自动扣佣 / 自动资金划转 / 自动 PAID：**HOLD**
- Admin Console 为只读可观测层：无邀请 / 改角色 / 停用 / 删除 / 吊销会话 / 重置密码端点
- Admin 不展示金额、不展示完整邮箱（默认掩码）、不展示证据内容与 storageKey
- Claim 金额与 Recovery 金额分离；`Settlement.confirmedAmount` 为唯一事实，`RecoveryPayout.amount` 为到账事实，`receivedAmount = Σ payout` 仅为投影

## 6. Launch Checklist（宿主轨道）

- [ ] 生产域名 / TLS / 反向代理（HOST APPROVAL REQUIRED）
- [ ] 生产数据库与对象存储（S3 兼容）（HOST APPROVAL REQUIRED）
- [ ] 生产密钥管理与轮换（HOST APPROVAL REQUIRED）
- [ ] Stripe 账号（test → live）与 webhook 密钥（HOST APPROVAL REQUIRED）
- [ ] 真实/脱敏业务文件与真实客户数据（HOST APPROVAL REQUIRED）
- [ ] 托管账户 / 预授权 / 分账（KYC 与资金合规）（HOST APPROVAL REQUIRED）
- [ ] 平台条款确认（是否允许代提交）+ 沙箱内单次人工批准（HOST APPROVAL REQUIRED）
- [ ] Kill switch 设计裁决与实施（架构方 DESIGN-FIRST）

## 7. 下一阶段（架构方建议）

1. **Phase 1 真实数据验证**：先跑无需 API 的 Shopify CSV、Amazon Settlement、物流账单，贯通 `文件 → Import → Normalization → Evidence → Claim Candidate → Human Review`。
2. **Phase 2 单场景 MVP**：只开一个追回方向（建议 FBA/物流退款审计），验证「是否发现真实损失 / 客户是否愿意付费 / 回收金额是否存在」。
3. **Phase 3 商业闭环**：验证发现损失 → 客户认可 → 客户授权 → 追回成功 → 愿意支付佣金。

> 不再以「继续补功能」为推进方式；里程碑由真实数据与首批客户验证产生。
