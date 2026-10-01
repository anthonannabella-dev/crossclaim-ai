# CUSTOMS SELF-SERVICE PRICING CONTRACT（HOST DIRECTIVE 2026-10-02 补充四）

> 状态：**已登记（RECORDED）** —— 本文件为产品规则注册，**不实现** Checkout / Entitlement / Package Unlock。
> 队列影响：**NONE** —— 不打断 R45 → R46 → Full Regression 主队列；`CURRENT_R45_R46_QUEUE_UNCHANGED = YES`、`CUSTOMS_PRICING_IMPLEMENTATION_STARTED = NO`。
> 边界：价格全部**配置化**，不得硬编码进 Rule Engine / Recovery Domain；真实外写 / 生产支付 / 生产凭据 继续 HOLD。

## 登记状态

| 项 | 值 |
| --- | --- |
| CUSTOMS_PRICING_DIRECTIVE_RECORDED | YES |
| FREE_AUDIT_REGISTERED | YES |
| ONE_TIME_PACKAGE_REGISTERED | YES |
| PACKAGE_TIER_ENGINE_REGISTERED | YES |
| DATA_VOLUME_TIER_REGISTERED | YES |
| COMPLEXITY_TIER_REGISTERED | YES |
| CONTINUOUS_SUBSCRIPTION_REGISTERED | YES |
| ENTITLEMENT_GATE_REGISTERED | YES |
| CHECKOUT_FUNNEL_REGISTERED | YES |
| REAL_PAYMENT_VALIDATION_REGISTERED | YES |
| CURRENT_R45_R46_QUEUE_UNCHANGED | YES |
| CUSTOMS_PRICING_IMPLEMENTATION_STARTED | NO |

登记时间：2026-10-01T17:39:28.015Z

## 要点（不替代原文）

- 三层产品：**FREE AUDIT → SELF-SERVICE RECOVERY PACKAGE → CONTINUOUS SUBSCRIPTION**（Managed Recovery / Broker Success Fee 属第四阶段，不阻塞 V1）。
- FREE AUDIT 不要求信用卡，只展示汇总（Estimated Recoverable / Opportunities / Jurisdiction / Program / Matching counts / Documentation % / Missing Doc / Filing Route）；**不得**免费暴露完整交易清单、完整匹配、完整计算明细、evidence mapping、machine-readable filing dataset、Broker-Ready Package。
- Package 档位 = **MAX(EXPECTED_RECOVERY_TIER, DATA_VOLUME_TIER, COMPLEXITY_TIER)**；参考价 USD 299 / 699 / 1,499 / 2,999，Enterprise = Custom Quote，**全部为 EXPERIMENTAL 可配置商业测试价**。
- Entitlement 必须服务端校验（organizationId / permission / payment status / entitlement / packageId / packageVersion），**不得**仅前端隐藏。
- Self-Service Package Fee = 软件 / 数据处理 / Recovery Package 服务费，**不是 Success Fee**；Settlement → FeeCalculation → Success Fee 只属 Managed Recovery。
- Checkout 使用独立 Payment Provider；**不得**由 Platform OAuth 推导 Payment Authorization；不得保存 card number / CVV / bank password。
- 转化漏斗事件与核心指标必须记录（AUDIT_STARTED → … → PACKAGE_DOWNLOADED + median/价格比/毛利/复购/升级率）。
- V1 商业验证标准 = 至少一笔 **real Checkout / Deposit / Payment**；真实付费证据出现前价格一律标记 EXPERIMENTAL。

## 原文（逐字）

```text
[HOST PRODUCT DIRECTIVE — CUSTOMS SELF-SERVICE PRICING]补充并冻结 CrossClaim Customs Recovery 的 Self-Service 商业模式。IMPORTANT：- 不打断当前 R45 → R46 → Full Regression 主队列。- 当前登记 PRODUCT_SPEC / pricing backlog / .autopilot TASKS。- 价格必须配置化，不得硬编码进 Rule Engine / Recovery Domain。- 本批次只登记产品规则；进入 Customs V1 时再实施 Checkout / Entitlement / Package Unlock。==================================================1. 三层商业模式   ==================================================CrossClaim Customs Recovery 使用三层产品：A. FREE AUDITB. SELF-SERVICE RECOVERY PACKAGEC. CONTINUOUS CUSTOMS RECOVERYManaged Recovery / Broker Success Fee 属后续第四阶段能力，不阻塞 V1。==================================================2. FREE AUDIT — 免费客户可以：Connect / Upload Trade Data→ Scan→ 查看 Recovery Summary。免费展示：- Estimated Recoverable Amount- Recovery Opportunity Count- Country / Jurisdiction- Recovery Program- Matched Import Count- Matched Export Count- Documentation Completeness %- Missing Document Categories- Filing Route- High-level recovery reason示例：Estimated Recoverable:USD 37,800Qualifying Opportunities:143Documentation:94% completeFiling Route:BROKER_OR_AGENTCTA：[Unlock Recovery Package]FREE AUDIT 不要求信用卡。不得免费暴露：- 完整 qualifying transaction list- 完整 Import ↔ Export matching- 完整 calculation details- 完整 evidence mapping- machine-readable filing dataset- Broker-Ready Package。==================================================3. SELF-SERVICE RECOVERY PACKAGE第一次商业化优先使用“一次性 Package Fee”，不是强制订阅。建议初始测试价格：PACKAGE_SExpected Recoverable ≤ USD 5,000参考价格：USD 299PACKAGE_MUSD 5,000–20,000参考价格：USD 699PACKAGE_LUSD 20,000–100,000参考价格：USD 1,499PACKAGE_XLUSD 100,000–500,000参考价格：USD 2,999ENTERPRISE«USD 500,000或多国 / 超大数据量 / 特殊复杂场景→ Custom Quote»以上均为 HOST 可配置商业测试价格，不得写死。==================================================4. 定价不能只看预计追回金额最终 Package Tier 必须综合：A. EXPECTED_RECOVERY_TIERB. DATA_VOLUME_TIERC. COMPLEXITY_TIER最终档位：PACKAGE_TIER =MAX(EXPECTED_RECOVERY_TIER,DATA_VOLUME_TIER,COMPLEXITY_TIER)避免出现：预计追回 $4,000但客户上传 300,000 行数据仍只收最低价。建议初始 DATA_VOLUME 参考：S：≤500 customs/import entriesM：501–2,500L：2,501–10,000XL：10,001–25,000Enterprise：>25,000建议 COMPLEXITY 因素包括：- multi-country- multiple importer entities- multiple brokers- multiple currencies- multiple HS/HTS schemes- incomplete source data- multiple filing programs- advanced matching- manual-review-heavy cases具体阈值必须配置化。==================================================5. 客户付款后得到什么Payment Success→ Package Entitlement Created→ Unlock Complete Recovery Package。完整 Package 至少包含：- complete qualifying transaction list- Import ↔ Export matching- expected recovery calculation- calculation basis- rule eligibility explanation- evidence checklist- evidence mapping- missing-document list- source provenance- Filing Route- filing instructions- official authority information- Broker-Ready Package- Claim-Ready Package- PDF summary- CSV/XLSX/JSON export where applicable- manifest- packageVersion- digest- generatedAt客户购买的是“可进入申报环节的 Recovery Package”，不是普通 AI report。==================================================6. Package Unlock 权限必须建立明确 entitlement：FREE→ summary onlyPAID_PACKAGE→ 指定 Package Version 可下载SUBSCRIPTION→ 按 Plan 权限生成/下载 PackageENTERPRISE→ Contract entitlement不得仅通过前端隐藏内容。服务端必须验证：organizationIduser permissionpayment statusentitlementpackageIdpackageVersion之后才能下载。==================================================7. CONTINUOUS SUBSCRIPTION完成一次性 Package 商业验证后，再开放持续订阅。初始参考价格：CUSTOMS_STARTERUSD 299 / month- up to 500 entries/year 或 HOST 配置额度- continuous scanning- opportunity dashboard- deadline monitoring- limited Package generationCUSTOMS_GROWTHUSD 799 / month- up to 2,500 entries/year- continuous scanning- more Package allowance- advanced matching- priority processingCUSTOMS_SCALEUSD 1,999 / month- up to 10,000 entries/year- continuous scanning- high Package allowance- multi-source matching- team / enterprise featuresENTERPRISECustom Quote- high volume- multi-country- API- custom rule packs- dedicated limits所有价格、limits、Package allowance 均配置化。==================================================8. Package Fee 与 Subscription 的关系不得让客户重复付费而无法理解。支持以下商业策略：ONE_TIME_ONLYSUBSCRIPTION_ONLYPACKAGE_CREDIT_TO_SUBSCRIPTIONSUBSCRIPTION_INCLUDES_PACKAGES推荐默认：第一次客户：FREE AUDIT→ ONE-TIME PACKAGE如果客户之后开启 Continuous Plan：允许 HOST 配置：首个 Package Fee 可抵扣首月或部分订阅费用。该抵扣属于商业配置，不进入 Recovery Ledger / Settlement逻辑。==================================================9. Success Fee 不属于 Self-ServiceSelf-Service Package Fee：是软件 / 数据处理 / Recovery Package 服务费。它在 Package 解锁时收费，不依赖最终 Customs Refund 是否成功。不得把 Self-Service Package Fee 表述为成功费。Managed Recovery 后续才能采用：Settlement confirmed→ FeeCalculation→ Success Fee。==================================================10. PaymentPackage Checkout 使用独立 Payment Provider。流程：FREE AUDIT→ Unlock Recovery Package→ Checkout→ Payment confirmed→ Entitlement granted→ Download。不得：Platform OAuth→ 自动推导 Payment Authorization。不得保存：card numberCVVbank password。==================================================11. 转化漏斗必须记录Customs V1 必须记录：AUDIT_STARTEDDATA_UPLOADEDAUDIT_COMPLETEDRECOVERY_FOUNDRESULT_VIEWEDCHECKOUT_STARTEDCHECKOUT_COMPLETEDPACKAGE_GENERATEDPACKAGE_DOWNLOADED核心指标：Audit → Recovery FoundRecovery Found → CheckoutCheckout → PaidPaid → Package Download以及：Median Estimated RecoveryMedian Package PricePackage Price / Expected Recovery %Gross MarginRepeat Scan RateSubscription Upgrade Rate==================================================12. V1 商业验证标准不是“客户说愿意付钱”。必须获得至少一笔：real Checkout或real Deposit或real Payment。优先验证：客户看到明确 Estimated Recoverable Amount 后，是否愿意支付 USD 299 / 699 / 1,499 / 2,999 中对应档位，换取完整 Claim-Ready / Broker-Ready Package。在真实付费证据出来以前：价格全部标记为 EXPERIMENTAL。==================================================13. 当前执行要求现在只完成登记：CUSTOMS_PRICING_DIRECTIVE_RECORDED =FREE_AUDIT_REGISTERED =ONE_TIME_PACKAGE_REGISTERED =PACKAGE_TIER_ENGINE_REGISTERED =DATA_VOLUME_TIER_REGISTERED =COMPLEXITY_TIER_REGISTERED =CONTINUOUS_SUBSCRIPTION_REGISTERED =ENTITLEMENT_GATE_REGISTERED =CHECKOUT_FUNNEL_REGISTERED =REAL_PAYMENT_VALIDATION_REGISTERED =CURRENT_R45_R46_QUEUE_UNCHANGED = YESCUSTOMS_PRICING_IMPLEMENTATION_STARTED = NO登记完成后继续当前 R45/R46 主队列，不得停下来等待本指令进一步确认。
```

## 冻结

NO automatic Settlement from R45 · NO automatic Fee · NO automatic Invoice issuance · NO Payment activation · NO autopay · NO platform write · TRANSPORT=false · NO production credentials；R13 Payment Activation Gate = HOLD。
