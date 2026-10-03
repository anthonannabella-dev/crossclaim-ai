# LAYER 2 — GOLDEN PATH MATRIX（自动生成，请勿手改）

- 生成时间：2026-10-03T16:37:58.316Z
- 机器可读：`docs/releases/LAYER2-GOLDEN-PATH-MATRIX.json`；生成器：`tools/autopilot/golden-path-matrix.mjs`
- 判定规则：**COVERED 必须存在命名证据文件**（测试/前端）；否则 GAP，并自动登记为 backlog。
- 依据：MSG-20261003-135 CHANGE C（禁止用「专项测试很多」替代完整矩阵）。

## Platform Recovery（api 测试 11 个 / 前端 10 个）

| 能力轴 | 状态 | 证据 |
|---|---|---|
| http | COVERED | apps/api/src/__tests__/platform-write-golden-path-db.test.ts<br>apps/api/src/__tests__/platform-write-http-db.test.ts<br>apps/api/src/__tests__/platform-write-orchestrator-db.test.ts |
| persistence | COVERED | apps/api/src/__tests__/amazon-sp-connector-runner-db.test.ts<br>apps/api/src/__tests__/c2-platform-account-identity-db.test.ts<br>apps/api/src/__tests__/platform-write-golden-path-db.test.ts<br>apps/api/src/__tests__/platform-write-http-db.test.ts |
| db_invariant | COVERED | apps/api/src/__tests__/c2-platform-account-identity-db.test.ts |
| frontend | COVERED | apps/web/app/cases/[id]/claim-package/claim-package-view.tsx<br>apps/web/app/components/opportunity-actions.tsx<br>apps/web/app/opportunities/opportunity-list.tsx<br>apps/web/app/page.tsx |
| happy | COVERED | apps/api/src/__tests__/amazon-sp-connector-runner-db.test.ts<br>apps/api/src/__tests__/amazon-sp-read-only-adapter.test.ts<br>apps/api/src/__tests__/c2-platform-account-identity-db.test.ts<br>apps/api/src/__tests__/platform-write-adapter-capability.test.ts |
| negative | COVERED | apps/api/src/__tests__/amazon-sp-connector-runner-db.test.ts<br>apps/api/src/__tests__/amazon-sp-read-only-adapter.test.ts<br>apps/api/src/__tests__/c2-platform-account-identity-db.test.ts<br>apps/api/src/__tests__/platform-write-adapter-capability.test.ts |
| replay | COVERED | apps/api/src/__tests__/amazon-sp-connector-runner-db.test.ts<br>apps/api/src/__tests__/amazon-sp-read-only-adapter.test.ts<br>apps/api/src/__tests__/platform-write-adapter-capability.test.ts<br>apps/api/src/__tests__/platform-write-golden-path-db.test.ts |
| concurrency | COVERED | apps/api/src/__tests__/platform-write-golden-path-db.test.ts<br>apps/api/src/__tests__/platform-write-ledger-db.test.ts<br>apps/api/src/__tests__/platform-write-orchestrator-db.test.ts |
| failure_recovery | COVERED | apps/api/src/__tests__/amazon-sp-read-only-adapter.test.ts<br>apps/api/src/__tests__/platform-write-adapter-capability.test.ts<br>apps/api/src/__tests__/platform-write-ledger-db.test.ts<br>apps/api/src/__tests__/platform-write-orchestrator-db.test.ts |
| cross_tenant | COVERED | apps/api/src/__tests__/amazon-sp-connector-runner-db.test.ts<br>apps/api/src/__tests__/c2-platform-account-identity-db.test.ts<br>apps/api/src/__tests__/platform-write-golden-path-db.test.ts<br>apps/api/src/__tests__/platform-write-http-db.test.ts |
| rbac | COVERED | apps/api/src/__tests__/amazon-sp-connector-runner-db.test.ts<br>apps/api/src/__tests__/platform-write-golden-path-db.test.ts<br>apps/api/src/__tests__/platform-write-http-db.test.ts<br>apps/api/src/__tests__/platform-write-orchestrator-db.test.ts |
| amount_ledger | COVERED | apps/api/src/__tests__/amazon-sp-connector-runner-db.test.ts<br>apps/api/src/__tests__/platform-write-golden-path-db.test.ts<br>apps/api/src/__tests__/platform-write-http-db.test.ts<br>apps/api/src/__tests__/platform-write-ledger-db.test.ts |

## Logistics / Carrier Recovery（api 测试 17 个 / 前端 2 个）

| 能力轴 | 状态 | 证据 |
|---|---|---|
| http | COVERED | apps/api/src/__tests__/carrier-claim-response-http-e2e-db.test.ts<br>apps/api/src/__tests__/carrier-claim-response-http.test.ts<br>apps/api/src/__tests__/carrier-manual-submission-http-e2e-db.test.ts<br>apps/api/src/__tests__/carrier-manual-submission-http.test.ts |
| persistence | COVERED | apps/api/src/__tests__/carrier-claim-response-db.test.ts<br>apps/api/src/__tests__/carrier-claim-response-http-e2e-db.test.ts<br>apps/api/src/__tests__/carrier-claim-response.test.ts<br>apps/api/src/__tests__/carrier-manual-submission-db.test.ts |
| db_invariant | COVERED | apps/api/src/__tests__/carrier-claim-response-db.test.ts<br>apps/api/src/__tests__/carrier-claim-response.test.ts<br>apps/api/src/__tests__/carrier-manual-submission-db.test.ts |
| frontend | COVERED | apps/web/app/integration-status/manual-response-form.tsx |
| happy | COVERED | apps/api/src/__tests__/carrier-auth-account-discovery.test.ts<br>apps/api/src/__tests__/carrier-claim-package.test.ts<br>apps/api/src/__tests__/carrier-claim-response-db.test.ts<br>apps/api/src/__tests__/carrier-claim-response-http-e2e-db.test.ts |
| negative | COVERED | apps/api/src/__tests__/carrier-auth-account-discovery.test.ts<br>apps/api/src/__tests__/carrier-claim-package.test.ts<br>apps/api/src/__tests__/carrier-claim-response-db.test.ts<br>apps/api/src/__tests__/carrier-claim-response-http-e2e-db.test.ts |
| replay | COVERED | apps/api/src/__tests__/carrier-auth-account-discovery.test.ts<br>apps/api/src/__tests__/carrier-claim-response-db.test.ts<br>apps/api/src/__tests__/carrier-claim-response-http-e2e-db.test.ts<br>apps/api/src/__tests__/carrier-claim-response-http.test.ts |
| concurrency | COVERED | apps/api/src/__tests__/carrier-claim-response-db.test.ts<br>apps/api/src/__tests__/carrier-manual-submission-db.test.ts<br>apps/api/src/__tests__/carrier-manual-submission.test.ts |
| failure_recovery | COVERED | apps/api/src/__tests__/carrier-settlement-reconciliation-readonly.test.ts |
| cross_tenant | COVERED | apps/api/src/__tests__/carrier-auth-account-discovery.test.ts<br>apps/api/src/__tests__/carrier-claim-response-db.test.ts<br>apps/api/src/__tests__/carrier-claim-response-http-e2e-db.test.ts<br>apps/api/src/__tests__/carrier-claim-response-http.test.ts |
| rbac | COVERED | apps/api/src/__tests__/carrier-claim-response-db.test.ts<br>apps/api/src/__tests__/carrier-claim-response-http-e2e-db.test.ts<br>apps/api/src/__tests__/carrier-claim-response-http.test.ts<br>apps/api/src/__tests__/carrier-manual-submission-db.test.ts |
| amount_ledger | COVERED | apps/api/src/__tests__/carrier-claim-package.test.ts<br>apps/api/src/__tests__/carrier-claim-response-db.test.ts<br>apps/api/src/__tests__/carrier-claim-response-http-e2e-db.test.ts<br>apps/api/src/__tests__/carrier-claim-response-http.test.ts |

## Customs / Trade Recovery（api 测试 26 个 / 前端 3 个）

| 能力轴 | 状态 | 证据 |
|---|---|---|
| http | COVERED | apps/api/src/__tests__/customs-claim-ready-http.test.ts<br>apps/api/src/__tests__/customs-entry-fact-read-http.test.ts<br>apps/api/src/__tests__/customs-execution-contract.test.ts<br>apps/api/src/__tests__/customs-filing-provider.test.ts |
| persistence | COVERED | apps/api/src/__tests__/customs-claim-ready-http.test.ts<br>apps/api/src/__tests__/customs-entry-fact-read-http.test.ts<br>apps/api/src/__tests__/customs-entry-fact-store-db.test.ts<br>apps/api/src/__tests__/customs-ior-facts-db.test.ts |
| db_invariant | COVERED | apps/api/src/__tests__/customs-entry-fact-store-db.test.ts<br>apps/api/src/__tests__/customs-execution-contract.test.ts<br>apps/api/src/__tests__/customs-ior-facts-db.test.ts<br>apps/api/src/__tests__/customs-recovery-chain-http-e2e-db.test.ts |
| frontend | COVERED | apps/web/app/integration-status/start-recovery-form.tsx |
| happy | COVERED | apps/api/src/__tests__/customs-claim-ready-http.test.ts<br>apps/api/src/__tests__/customs-claim-ready-package.test.ts<br>apps/api/src/__tests__/customs-classification-discrepancy.test.ts<br>apps/api/src/__tests__/customs-duty-truth.test.ts |
| negative | COVERED | apps/api/src/__tests__/customs-claim-ready-package.test.ts<br>apps/api/src/__tests__/customs-classification-discrepancy.test.ts<br>apps/api/src/__tests__/customs-duty-truth.test.ts<br>apps/api/src/__tests__/customs-entry-contract.test.ts |
| replay | COVERED | apps/api/src/__tests__/customs-classification-discrepancy.test.ts<br>apps/api/src/__tests__/customs-duty-truth.test.ts<br>apps/api/src/__tests__/customs-entry-fact-store-db.test.ts<br>apps/api/src/__tests__/customs-filing-provider.test.ts |
| concurrency | COVERED | apps/api/src/__tests__/customs-entry-fact-store-db.test.ts<br>apps/api/src/__tests__/customs-ior-facts-db.test.ts<br>apps/api/src/__tests__/customs-return-fact-store-db.test.ts<br>apps/api/src/__tests__/customs-submission-ledger-db.test.ts |
| failure_recovery | COVERED | apps/api/src/__tests__/customs-recovery-chain-http.test.ts<br>apps/api/src/__tests__/customs-recovery-chain-service-db.test.ts<br>apps/api/src/__tests__/customs-recovery-eligibility.test.ts<br>apps/api/src/__tests__/customs-refund-linkage.test.ts |
| cross_tenant | COVERED | apps/api/src/__tests__/customs-claim-ready-http.test.ts<br>apps/api/src/__tests__/customs-entry-fact-read-http.test.ts<br>apps/api/src/__tests__/customs-entry-fact-store-db.test.ts<br>apps/api/src/__tests__/customs-execution-contract.test.ts |
| rbac | COVERED | apps/api/src/__tests__/customs-claim-ready-http.test.ts<br>apps/api/src/__tests__/customs-entry-fact-read-http.test.ts<br>apps/api/src/__tests__/customs-execution-contract.test.ts<br>apps/api/src/__tests__/customs-recovery-chain-http-e2e-db.test.ts |
| amount_ledger | COVERED | apps/api/src/__tests__/customs-claim-ready-http.test.ts<br>apps/api/src/__tests__/customs-claim-ready-package.test.ts<br>apps/api/src/__tests__/customs-classification-discrepancy.test.ts<br>apps/api/src/__tests__/customs-duty-truth.test.ts |

## Independent-site / Chargeback（api 测试 2 个 / 前端 1 个）

| 能力轴 | 状态 | 证据 |
|---|---|---|
| http | COVERED | apps/api/src/__tests__/independent-site-internal-closure.test.ts |
| persistence | COVERED | apps/api/src/__tests__/independent-site-internal-closure.test.ts |
| db_invariant | COVERED | apps/api/src/__tests__/independent-site-internal-closure.test.ts |
| frontend | COVERED | apps/web/app/money/recovery-money-view.tsx |
| happy | COVERED | apps/api/src/__tests__/chargeback-recovery-chain.test.ts<br>apps/api/src/__tests__/independent-site-internal-closure.test.ts |
| negative | COVERED | apps/api/src/__tests__/chargeback-recovery-chain.test.ts<br>apps/api/src/__tests__/independent-site-internal-closure.test.ts |
| replay | COVERED | apps/api/src/__tests__/independent-site-internal-closure.test.ts |
| concurrency | COVERED | apps/api/src/__tests__/independent-site-internal-closure.test.ts |
| failure_recovery | COVERED | apps/api/src/__tests__/chargeback-recovery-chain.test.ts |
| cross_tenant | COVERED | apps/api/src/__tests__/chargeback-recovery-chain.test.ts<br>apps/api/src/__tests__/independent-site-internal-closure.test.ts |
| rbac | COVERED | apps/api/src/__tests__/independent-site-internal-closure.test.ts |
| amount_ledger | COVERED | apps/api/src/__tests__/chargeback-recovery-chain.test.ts<br>apps/api/src/__tests__/independent-site-internal-closure.test.ts |

## GAP 汇总（自动 materialize 为 backlog）

- （无）

