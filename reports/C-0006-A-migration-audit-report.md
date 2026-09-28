# C-0006-A Migration Audit Report (shadow detection parity)

- engine: FREIGHT_RATE_V1@1
- generatedAt: 2026-09-28T12:00:00.000Z
- organization: fixture-org
- scope: LOGISTICS / OTHER
- parity: **OK**

## Inputs

- legacy invoices: 5
- shadow invoices（仅 ACTIVE 事实）: 5
- legacy tracking: 5
- shadow tracking: 5
- ACTIVE fact transactions: 10
- excluded transactions: 0

## Fact coverage

- SourceTransaction rows: 10
- ACTIVE fact transactions: 10
- CONFLICT fact transactions: 0
- coverage ratio: 1.0000

## Detection comparison

- legacy: evaluations=5 opportunities=1 unmatchedTracking=0
- shadow: evaluations=5 opportunities=1 unmatchedTracking=0
- money trace: legacy=17.7500 shadow=17.7500

| invoice | tracking | result (legacy → shadow) | expected | actual | recoverable | ruleVersion | equal |
|---|---|---|---|---|---|---|---|
| INV-1001 | 1ZDEMO001 | OPPORTUNITY → OPPORTUNITY | 135.0000 / 135.0000 | 152.7500 / 152.7500 | 17.7500 / 17.7500 | fixture-rv-0-0 | yes |
| INV-1002 | 1ZDEMO002 | PASS → PASS | 133.2000 / 133.2000 | 133.2000 / 133.2000 | 0.0000 / 0.0000 | fixture-rv-0-0 | yes |
| INV-1003 | 1ZDEMO003 | PASS → PASS | 272.7000 / 272.7000 | 212.7500 / 212.7500 | 0.0000 / 0.0000 | fixture-rv-0-1 | yes |
| INV-1004 | 1ZDEMO004 | PASS → PASS | 130.1760 / 130.1760 | 54.2000 / 54.2000 | 0.0000 / 0.0000 | fixture-rv-0-2 | yes |
| INV-1005 | 1ZDEMO005 | PASS → PASS | 386.4600 / 386.4600 | 301.9900 / 301.9900 | 0.0000 / 0.0000 | fixture-rv-0-3 | yes |

## Mismatches

- none
