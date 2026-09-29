# TASK2 (D) 租户触发器清单证据

生成时间：2026-09-30T08:52:41.4254489+09:00

## A. 现有 cc_tenant* 触发器（名称 | 表 | 启用状态）

```text
cc_tenant_appeal | Appeal | enabled=O
cc_tenant_immutable__Appeal | Appeal | enabled=O
cc_tenant_immutable__AuditLog | AuditLog | enabled=O
cc_tenant_billinginvoice | BillingInvoice | enabled=O
cc_tenant_immutable__BillingInvoice | BillingInvoice | enabled=O
cc_tenant_immutable__CanonicalFact | CanonicalFact | enabled=O
cc_tenant_canonicalfactsource | CanonicalFactSource | enabled=O
cc_tenant_immutable__CanonicalFactSource | CanonicalFactSource | enabled=O
cc_tenant_immutable__Case | Case | enabled=O
cc_tenant_caseevidence | CaseEvidence | enabled=O
cc_tenant_immutable__CaseEvidence | CaseEvidence | enabled=O
cc_tenant_caseopportunity | CaseOpportunity | enabled=O
cc_tenant_immutable__CaseOpportunity | CaseOpportunity | enabled=O
cc_tenant_claim | Claim | enabled=O
cc_tenant_immutable__Claim | Claim | enabled=O
cc_tenant_claimitem_caseid | ClaimItem | enabled=O
cc_tenant_claimitem_opportunityid | ClaimItem | enabled=O
cc_tenant_claimitem_ruleversionid | ClaimItem | enabled=O
cc_tenant_immutable__ClaimItem | ClaimItem | enabled=O
cc_tenant_claimitemevidence_claimitemid | ClaimItemEvidence | enabled=O
cc_tenant_claimitemevidence_evidenceid | ClaimItemEvidence | enabled=O
cc_tenant_immutable__ClaimItemEvidence | ClaimItemEvidence | enabled=O
cc_tenant_evidenceartifact | EvidenceArtifact | enabled=O
cc_tenant_immutable__EvidenceArtifact | EvidenceArtifact | enabled=O
cc_tenant_evidenceedge | EvidenceEdge | enabled=O
cc_tenant_immutable__EvidenceEdge | EvidenceEdge | enabled=O
cc_tenant_feecalculation | FeeCalculation | enabled=O
cc_tenant_immutable__FeeCalculation | FeeCalculation | enabled=O
cc_tenant_fileasset | FileAsset | enabled=O
cc_tenant_immutable__FileAsset | FileAsset | enabled=O
cc_tenant_immutable__ImportBatch | ImportBatch | enabled=O
cc_tenant_importbatch | ImportBatch | enabled=O
cc_tenant_immutable__KillSwitchRequest | KillSwitchRequest | enabled=O
cc_tenant_kill_switch_request | KillSwitchRequest | enabled=O
cc_tenant_immutable__Membership | Membership | enabled=O
cc_tenant_immutable__Payment | Payment | enabled=O
cc_tenant_payment_invoiceid | Payment | enabled=O
cc_tenant_immutable__PaymentEvent | PaymentEvent | enabled=O
cc_tenant_immutable__PaymentProcessingAttempt | PaymentProcessingAttempt | enabled=O
cc_tenant_paymentprocessingattempt_paymenteventid | PaymentProcessingAttempt | enabled=O
cc_tenant_paymentprocessingattempt_paymentid | PaymentProcessingAttempt | enabled=O
cc_tenant_immutable__RecoveryGraphEdge | RecoveryGraphEdge | enabled=O
cc_tenant_recoverygraphedge | RecoveryGraphEdge | enabled=O
cc_tenant_immutable__RecoveryGraphNode | RecoveryGraphNode | enabled=O
cc_tenant_immutable__RecoveryLedgerEntry | RecoveryLedgerEntry | enabled=O
cc_tenant_recoveryledgerentry | RecoveryLedgerEntry | enabled=O
cc_tenant_immutable__RecoveryOpportunity | RecoveryOpportunity | enabled=O
cc_tenant_immutable__RecoveryPayout | RecoveryPayout | enabled=O
cc_tenant_immutable__RecoveryRoute | RecoveryRoute | enabled=O
cc_tenant_recoveryroute | RecoveryRoute | enabled=O
cc_tenant_immutable__RuleEvaluation | RuleEvaluation | enabled=O
cc_tenant_ruleevaluation | RuleEvaluation | enabled=O
cc_tenant_immutable__RuleEvaluationShadow | RuleEvaluationShadow | enabled=O
cc_tenant_ruleevaluationshadow | RuleEvaluationShadow | enabled=O
cc_tenant_immutable__RuleSet | RuleSet | enabled=O
cc_tenant_immutable__RuleVersion | RuleVersion | enabled=O
cc_tenant_ruleversion | RuleVersion | enabled=O
cc_tenant_immutable__Session | Session | enabled=O
cc_tenant_immutable__Settlement | Settlement | enabled=O
cc_tenant_settlement | Settlement | enabled=O
cc_tenant_immutable__SourceConnection | SourceConnection | enabled=O
cc_tenant_immutable__SourceTransaction | SourceTransaction | enabled=O
cc_tenant_sourcetransaction | SourceTransaction | enabled=O
cc_tenant_immutable__UserInvitation | UserInvitation | enabled=O
``` 

共 64 条。

## B. 含 organizationId 的表（归属不可变触发器覆盖目标）

```text
Appeal
AuditLog
BillingInvoice
CanonicalFact
CanonicalFactSource
Case
CaseEvidence
CaseOpportunity
Claim
ClaimItem
ClaimItemEvidence
EvidenceArtifact
EvidenceEdge
FeeCalculation
FileAsset
ImportBatch
KillSwitchRequest
Membership
Payment
PaymentEvent
PaymentProcessingAttempt
RecoveryGraphEdge
RecoveryGraphNode
RecoveryLedgerEntry
RecoveryOpportunity
RecoveryPayout
RecoveryRoute
RuleEvaluation
RuleEvaluationShadow
RuleSet
RuleVersion
Session
Settlement
SourceConnection
SourceTransaction
UserInvitation
``` 

共 36 张；覆盖要求：每张表应有 cc_tenant_immutable__<表名> 且 tgenabled=O。


## C. 覆盖核对结果（TASK2 D）

- 基线 cc_tenant 族（排除 immutable）：28 条
- 归属不可变族 cc_tenant_immutable__*：36 条
- 缺少归属不可变触发器的表：0 张

