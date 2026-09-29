# TASK2 (D) 租户触发器清单证据

生成时间：2026-09-30T08:52:26.3795998+09:00

## A. 现有 cc_tenant* 触发器（名称 | 表 | 启用状态）

```text

``` 

共 0 条。

## B. 含 organizationId 的表（归类不可变触发器覆盖目标）

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

共 36 张；覆盖要求：每张表都应有 cc_tenant_immutable__<表名> 且启用。

