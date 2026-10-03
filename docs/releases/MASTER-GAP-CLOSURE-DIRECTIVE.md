# HOST DIRECTIVE 2026-10-03（补充五）— MASTER GAP CLOSURE（最终目标差集驱动）

登记时间：2026-10-03（UTC+9）｜登记时 HEAD：`0693821`

## 0. 模式定义

每轮自治执行必须重新计算：

```text
FINAL PRODUCT TARGET
  − CURRENT REPOSITORY IMPLEMENTATION
  − 已明确属于 HOST / EXTERNAL / REAL-DATA / API 的事项
= INTERNAL REMAINING GAP
```

规则：

- 不依赖真实 API / 真实账号 / 真实客户数据 / 生产凭据 / 资金操作 / 法律牌照 / 生产部署的缺口 → 全部进 SAFE_CONTINUATION_QUEUE 自动执行。
- 不因宿主历史消息跳序、未再次提醒或旧 TASK 文件缺失而跳过功能。
- PASS → 自动进入下一内部缺口；REVISE → 自动修改并重送审；BLOCK → 自动寻找合规替代，仅真正 HOST_REQUIRED 才停。
- 每完成一个单元必须重算差集；单个 Queue CLOSED ≠ 项目完成。
- 每轮检查：TODO/placeholder/mock-only、contract-only 未持久化、service 有但 HTTP 未接线、HTTP 有但真实 DB 未验收、Schema 有字段但无 DB constraint、UI 无真实 backend、文档落后代码、测试仅 happy path、模块未串成闭环；发现即入队。

`INTERNAL_CODE_COMPLETE = TRUE` 仅在 A–G 同时满足时允许标记：A 内部差集=0；B 全量 CI PASS；C 所有 migration 可从空库执行；D HTTP/DB/Action Guard/Tenant/Audit/Concurrency 全部验收；E 前后端真实接线完成；F README/FINAL-GATE/PRODUCTION-READINESS/API BACKLOG 与代码同步；G 剩余事项全部归类为 API_INTEGRATION_REQUIRED / REAL_DATA_REQUIRED / HOST_APPROVAL_REQUIRED / PRODUCTION_VALIDATION_REQUIRED / LEGAL_OR_LICENSE_REQUIRED。

## 1. FINAL PRODUCT TARGET（20 项）

1 Platform Recovery｜2 Carrier/Logistics Recovery｜3 Customs/Trade Recovery｜4 一次账户体系下多平台多账号连接｜5 Opportunity Detection｜6 Evidence / Recovery Graph｜7 Eligibility / Rule Evaluation｜8 Estimated Recoverable Amount｜9 Claim-Ready Package｜10 Human Approval / Action Guard｜11 Submission / Broker Handoff 安全边界｜12 Carrier/Platform/Customs Response Tracking｜13 Settlement / Recovered Cash Truth｜14 15% Success Fee 商业模型｜15 Fee Preview / Fee Guard / Billing｜16 Dashboard / Admin / Operations｜17 Audit / RBAC / Tenant Isolation｜18 Idempotency / Concurrency / Retry / Failure Recovery｜19 Security / Privacy / Credential Boundary｜20 完整 HTTP/DB/Schema/Frontend/Tests/CI/Documentation

> 逐项目标 → 实现状态 → 缺口 的映射见 `docs/releases/MASTER-GAP-CLOSURE-REGISTER.md`（本指令的执行登记表）。
