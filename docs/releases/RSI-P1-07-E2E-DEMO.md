# RSI-P1-07 —— 端到端闭环 demo（信号 → task → runner → 证据 → Judge → decision）

- 分支：`gate/7-commercial-validation`
- 模块：`apps/api/src/runtime/rsi-e2e-loop.ts`（组合既有各段；runner 由宿主注入）
- 目的：把已落地的各段串成**一条可审计链**，并用同一份 transcript 证明全程零外写、零网络、不落库。

## 1. 链路

```
① POLICY_GENERATE   decideRsiPolicyAction('GENERATE_INCIDENT')   ← Kill Switch / 总开关在此拦截
② GENERATE          generateRsiWork(signals)                     ← 稳定 id + 去重 + OWNER 保护 + 敏感信号 fail-closed
③ CLAIM             createRsiContinuationEngine + CI_COMPLETED   ← 事件驱动领取（lease/dedupe）
④ RUN              注入 runner                                   ← BLOCK/REVISE 如实反映，绝不伪造 PASS
⑤ EVIDENCE         按风险等级为每类必需证据产出一条记录          ← 产出者必须 != builder，否则算自证
⑥ JUDGE            judgeCandidate(...)                           ← 自判禁止 + 独立证据 + 风险分级
⑦ RECORD           recordPromotionDecision(...)                  ← append-only（重复 dedupeKey 拒绝）
⑧ POLICY_PROMOTE   decideRsiPolicyAction('PROMOTE_LOW_RISK')     ← 只有显式开启 + stage 打开 + LOW 才“可自动提升”
```

任一环节失败都会**提前停止并如实记录**：`POLICY_DENIED:GENERATE_INCIDENT`、`NO_TASK_GENERATED`、
`NOT_CLAIMED:<reason>`。

## 2. 验收（`apps/api/src/__tests__/rsi-e2e-loop.test.ts`，8 例）

- happy path：MEDIUM 风险走到 `PROMOTED` + `RECORDED`，最后因 MEDIUM 不允许自动提升而回到 `OWNER_GATE_REQUIRED`
- Kill Switch 触发 → 连 incident 都不生成（`POLICY_DENIED`，步骤只有 1 条）
- 信号摘要含敏感数据 → `NO_TASK_GENERATED`（`SENSITIVE_SIGNAL`）
- runner `BLOCK` → 证据 FAILED → `REJECTED` + `SKIPPED_NOT_PROMOTED`
- builder 自任 judge → `SELF_JUDGE_FORBIDDEN`（并同时命中自证规则）
- HIGH 风险即便判定通过也**永不自动提升**
- LOW 风险 + stage 打开 + 显式开关 → `AUTO_PROMOTE_ELIGIBLE`（仍只是 decision，不应用变更）
- transcript 边界：`externalWritePerformed=false` / `writesDatabase=false` / `networkCalls=0` / 不执行 OWNER 级动作

`tsc --noEmit` exit 0；门禁 `api-contract` / `audit-coverage` / `autopilot-rules` 全 OK。

## 3. 诚实边界

- demo 会为「该风险等级要求的每一类证据」各生成一条来自**注入 runner** 的确定性记录；
  真实部署应由各自的执行器分别产出 TEST / REPLAY / BENCHMARK / SECURITY / POLICY 证据，
  因此本 demo 只证明**链路可达**，不代表生产评估覆盖度。
- 跨进程持久化（incident/task/evidence 落库）依赖 RSI-RT-06 状态表：staging apply 已获批，
  生产迁移 HOLD，本地数据库未建表。
- `EXTERNAL_WRITE / PAYMENT / TRANSPORT / PRODUCTION_CREDENTIALS / RSI_MODEL_NETWORK / RSI_PAID_MODEL_CALLS` 全 HOLD。
