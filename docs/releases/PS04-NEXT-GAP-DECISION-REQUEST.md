# PS04 / NEXT-GAP DECISION REQUEST（READY_FOR_REVIEW）

- 时间：2026-10-03T14:55:54.165Z；REVIEWED_HEAD：`1686115`
- 背景：G4（Customs C1–C7）与 P0 BUSINESS SURVIVAL GATES 均已 PASS/CLOSED；SAFE_CONTINUATION_QUEUE 当前只剩 HOST_ACTION_REQUIRED 项，需要架构方就「下一个内部产品域」给出裁决，以便自动 dispatcher 继续 materialize 安全单元。

## 1. 当前已完成（证据摘要）

- G4 全链 CLOSED（匹配/资格/估算/claim-ready/handoff + 两批 Schema Delta + HTTP 只读路由 + PG E2E）；
- P0 生死线 A/B CLOSED（含 Trust 防自证 guard A1/A2/A3）；
- AUTOPILOT：CONTINUOUS runner + singleton lock + recovery-only watchdog + **GLOBAL BACKLOG DISPATCHER**（静态单元耗尽后自动从 backlog materialize 并执行，已验收 A→B→C）；
- TRACK A「Full Regression」本地 263 文件 / 2637 用例全绿；各提交 CI 均 success。

## 2. 请裁决（编号 PASS / REVISE / BLOCK 或选择）

**Q1 — PS04（Independent-site / Chargeback Recovery）是否现在启动内部链？**
- 登记表记录 PS04-1（design 边界）与 PS04-5 需架构方裁决；
- 若批准，拟先做**纯内部只读链**：支付/拒付事实契约 → 证据装配 → 资格输入平面 → claim-ready 证据包（不调用任何 PSP/真实争议 API）；
- 请问是否需要额外的合规/资金边界前置条件（例如：拒付追回的资金归属、是否允许代客户提交 dispute）。

**Q2 — 下一个内部缺口优先级（请排序或指定唯一项）**
1. PS04 内部链（独立站 / 拒付）；
2. Customs G4 HTTP **写入侧**接线（受 Action Guard 保护的 recovery-chain 触发端点，仍不 filing）；
3. Carrier 结果 → Settlement 自动对账缺口（资金链路，需架构方明确是否在 HOLD 内先做只读对账）；
4. Production Candidate 预检清单（属 HOST_ACTION_REQUIRED，仅登记不执行）。

**Q3 — dispatcher backlog 的授权范围**
- 是否同意 dispatcher 依据本裁决自动扩充 backlog 并 materialize 安全单元（仅限：契约/持久化/测试/文档/只读 HTTP），外部动作与资金动作继续 HOLD_EXTERNAL？

**Q4 — HOST_ACTION_REQUIRED 清单确认**
当前已登记：BG-006 Production Candidate 预检（生产部署 / DNS 或域名 / 付费服务 / 生产凭据 / 生产支付接入）。请确认这些仍由宿主书面放行，dispatcher 只登记不执行。

## 3. 边界（不变）

Production Enablement = HOLD · External Write = HOLD · Real Money = HOLD · Customer Submission = HOLD · Production Credentials = HOST_ONLY。
