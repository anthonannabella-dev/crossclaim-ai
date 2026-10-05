# BG-016 —— 单一 Acceptance Head + 四份状态一致 guard（加固）

- 分支：`gate/7-commercial-validation`
- 载体：`tools/autopilot/acceptance-consistency.mjs`（提交门禁会跑；退出码 0 = 一致）
- 本轮范围：在既有四源一致性检查之上，补两条**此前缺失**的硬校验，并修正 STATE 里的占位 HEAD。

## 1. 既有能力（本轮之前就有，未重做）

脚本已在同一个 acceptance HEAD 上比对四份来源：

1. `docs/releases/ACCEPTANCE-MATRIX.json`（单一权威）
2. `.autopilot/STATE.json`（open backlog / arch_pending / final_status）
3. `docs/releases/MASTER-GAP-CLOSURE-REGISTER.md`
4. `docs/releases/FINAL-ACCEPTANCE-REPORT.md`

并检查：矩阵 HEAD 是否真实存在且是本分支祖先、STATE 未完成项与矩阵 `open_internal_items` 完全一致、
Layer 2 Golden Path 缺口是否已 materialize、REGISTER/REPORT 是否与矩阵同 HEAD 且状态取值合法、
`STATE.final_status` 三个矛盾面、以及已审计 CLOSED 的域不得继续写 PARTIAL/IN_PROGRESS。

## 2. 本轮新增（C1b / C1c）

### C1b —— 冻结的 `FINAL_ACCEPTANCE_HEAD` 是不可变常量

```
FROZEN_FINAL_ACCEPTANCE_HEAD = '0f7f7ac'
FROZEN_MIN_DECLARATIONS      = 10
扫描目录                      = docs/releases · tools/autopilot · .autopilot
匹配模式                      = FINAL_ACCEPTANCE_HEAD = <sha> / FROZEN ACCEPTANCE TREE … <sha>
```

- 任何“声明处”的值 ≠ `0f7f7ac` → `FROZEN_HEAD_CHANGED`（直接 FAIL）。
- 声明总数 < 10 → `FROZEN_HEAD_DECLARATIONS_MISSING`（防止常量被悄悄删掉后“因为无声明而通过”）。
- 只在**赋值/表格声明**处匹配，普通叙述里提到历史 SHA 不会误报。

### C1c —— STATE 的 HEAD 字段必须是单一来源

`state.head` / `state.current_head` / `state.CURRENT_HEAD` 必须彼此一致，并且指向本仓库真实存在的 commit
（浅克隆下对象缺失只记 NOTE，不误判）。注意：状态文件通常在“下一个 commit”之前写入，因此**不要求**它等于
`git rev-parse HEAD`，只要求单一来源 + 真实存在。

同批修正：STATE 里此前的占位值 `PENDING_THIS_COMMIT` 已改为真实 commit `dfb5f08`。

## 3. 验证

- `node tools/autopilot/acceptance-consistency.mjs` → `ACCEPTANCE_CONSISTENCY=OK head=1525a77 open_internal_items=74 areas=21`（退出码 0）。
- 合成文本验证：真实声明 `0f7f7ac` 通过；伪造 `FINAL_ACCEPTANCE_HEAD = \`deadbee\`` 会被判为 `FROZEN_HEAD_CHANGED`；
  仅叙述“未动”而不含赋值不产生误报；当前仓库共 17 处声明，全部等于 `0f7f7ac`。
- 提交门禁（`api-contract` / `audit-coverage` / `autopilot-rules` + 本 guard）全 OK。

## 4. 边界

本轮只改**验收一致性工具**与状态登记，不触碰产品代码、Schema、公开 API、权限与授权；
`FINAL_ACCEPTANCE_HEAD = 0f7f7ac` 保持不动（现在有机器校验兜底），
`EXTERNAL_WRITE / PAYMENT / TRANSPORT / PRODUCTION_CREDENTIALS / RSI_MODEL_NETWORK / RSI_PAID_MODEL_CALLS` 全部 HOLD。
