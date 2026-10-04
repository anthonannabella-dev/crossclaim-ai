# HOST_ACTION_REQUIRED —— 只有宿主能推进的事项（2026-10-04 汇总）

> 目的：把「阻塞内部工作」的外部动作集中在一处。除下列事项外，C18 与 TRACK C / SEO P3 的无外部账号工作都在继续推进。

## A. 立刻能解锁已授权工作的唯一一项

1. **提供一个非生产 staging 的 `DATABASE_URL`**，并明确回答：那个 shared 库是否承载真实客户数据？
   - 已授权但尚未执行的步骤：staging / non-prod shared `prisma migrate deploy`（candidate 已过 EXACT_ORDER_REPLAY = PASS、WHOLE_SCHEMA_DIFF_ZERO = PASS）。
   - 部署后要跑的 smoke：`migrate status` up to date → DB↔schema diff = 0 → C18 DB 不变量（缺证据 CROSSCLAIM_SAAS / binding 身份 UPDATE / lineage UPDATE / lineage DELETE / 跨租户 lineage INSERT 全部 reject）。
   - 若该库已含真实客户数据或属于生产，则按 production 处理，保持 HOLD。

## B. Provider / 法务 / 商业前置（决定能否接真实报关）

2. 注册 / 申请目标 Customs Provider 的开发者或合作方账号；
3. 接受第三方商业协议（SaaS 代客提交、数据处理条款等）；
4. 提交公司资料 / KYC / IOR / Broker 材料；
5. 签署真实 POA（授权委托）；
6. 提供生产 Client ID/Secret 与 webhook 签名密钥（含 key 轮换策略）；
7. 支付任何 provider 费用；
8. 明确授权开启真实 External Write 与首笔真实报关 / 退款 / 资金操作。

## C. SEO 生产化前置

9. Search Console / Bing 验证、域名所有权/令牌（决定 `/recover` 页面最终能否 INDEX 与提交 sitemap）。

## 当前边界（未变）

`C18_PRODUCTION_PERSISTENCE_CHECKPOINT = PASS / CLOSED`；`STAGING / NON-PROD SHARED MIGRATE = AUTHORIZED`；`STAGING_SMOKE = REQUIRED_BEFORE_PRODUCTION_DEPLOY`；
`REAL_DATA_SHARED` / `PRODUCTION_MIGRATE_DEPLOY` / `REAL_TRANSPORT` / `EXTERNAL_WRITE` / `PAYMENT` / `PRODUCTION_CREDENTIALS` / `PRODUCTION_ENABLEMENT` = HOLD；`TRANSPORT=false`；`FINAL_ACCEPTANCE_HEAD=0f7f7ac` 未动。
