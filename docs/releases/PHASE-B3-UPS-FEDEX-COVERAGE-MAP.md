# PHASE B3 — UPS / FEDEX 第一接入 覆盖映射（status map）

来源：`docs/releases/BACKEND-ARCHITECTURE-DIRECTIVE.md` §32 PHASE B3（OAuth + Account Discovery + Tracking Read + Capability Detection；**禁止**安装/启用 Direct Claim API）。
结论：**B3 的内部职责已由 Carrier Queue #3 / #4 覆盖**；剩余部分全部属 HOLD_EXTERNAL（真实凭据与真实 provider 调用）。
边界：**NO platform write · Payment = 0 · autopay/collection/external write OFF · R13 HOLD · TRANSPORT=false · 无生产凭据**。

## 1. 逐项映射

| B3 要求 | 现状 | 证据 |
|---|---|---|
| UPS / FedEx 授权契约（分别声明） | 完成 | `services/carriers/carrier-auth-contract.ts`（authKind / endpoint 抽象 / token expiry / refresh / 只读 scope 意图 / credentialRef-only） |
| provider 支持流程 vs 当前选定流程 | 完成 | `connector-capability.ts`：`supportedAuthFlows` / `selectedAuthFlow` / `authFlowSelectionReason` + `assertCarrierAuthTruth` |
| Account Discovery（UPS） | 完成（契约 + sandbox） | `carrier-account-discovery.ts`：`accountIdentityStrategy = PROVIDER_DISCOVERY`，0/1/多分支、显式选择、幂等 |
| Account identity（FedEx） | 完成（契约 + sandbox） | 同上：`PROVIDER_VERIFIED_REGISTRATION`（候选账号 + 姓名 + 地址 → provider 验证 → 才成为 verified identity） |
| Tracking Read | 完成（read-only 归一化 + 双向绑定） | `carrier-tracking-read.ts`（request/response account·tracking binding、状态枚举、事件排序去重、失败分类） |
| Capability Detection | 完成 | `connector-capability.ts` + `/provider-readiness` 的 `carriers[]`（authFlows / selectedAuthFlow / accountIdentityStrategy / implemented=false） |
| Direct Claim API | **未安装 / 未启用** | `supportsDirectClaimSubmission=false` + `capabilityAudit.audited=false` + `DIRECT_CLAIM_SUBMISSION_NOT_AUDITED` |

## 2. 仍待 HOLD_EXTERNAL 的部分

UPS/FedEx developer credentials、callback / config registration、真实 seller/carrier 授权、sandbox / production provider 调用、real-data validation、TRANSPORT enablement —— 全部需 HOST 提供，且不阻塞内部实现。

## 3. 与后续队列的接口

Invoice / POD 只读事实由 Carrier Queue #5 提供，证据装配由 Queue #6（`ShipmentEvidenceBundle`）提供；B3 不再新增事实源，后续真实接入只需替换 provider adapter 实现。
