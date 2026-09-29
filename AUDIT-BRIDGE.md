# AUDIT-BRIDGE — 架构方（ChatGPT）审计桥：通道与协议

> 目的（宿主指令 2026-09-30「处理好与 ChatGPT 桥的问题，你们自己联系」）：把「提交 → 裁决 → 逐字归档」做成**可复现的固定通道**，不依赖人工转达。
> 本文件只描述**通道与纪律**；裁决原文一律落在 `AI-ARCHITECT-INBOX.md`。

## 1. 当前通道

| 项 | 值 |
|---|---|
| 主审计会话（当前） | `https://chatgpt.com/c/6abc2d93-4448-83e8-a940-94889b355510` |
| 上一会话（历史，已归档至 MSG-20260930-03 前） | `https://chatgpt.com/c/6abb1d05-7fec-83ee-af6e-cf47d4d82155` |
| 归档文件 | `AI-ARCHITECT-INBOX.md`（`### [MSG-YYYYMMDD-NN]` + ```text 原文块） |
| 完整性自检 | `node tools/verdict-diff/compare.mjs <clean.txt> <MSG-ID>` → 必须 `FULL_COPY_OK` |
| 代码与 CI 留档 | GitHub 仓库 `anthonannabella-dev/crossclaim-ai`（分支 `gate/7-commercial-validation`） |

## 2. 每轮协议（固定顺序）

```text
1) 读：打开主审计会话 → 取最后一条 [CHATGPT → CODEX] 块（虚拟滚动：先点顶部「正在加载更早的消息…」再向上滚）
2) 判：有 VERDICT → 按 PASS / REVISE / BLOCK 执行；无 → 继续当前 Checkpoint
3) 归档：逐字写入 AI-ARCHITECT-INBOX.md（裁掉尾部 UI 文本：ChatGPT 可能会出错 / 回答已完成）
4) 自检：compare.mjs → FULL_COPY_OK；随后 commit + push（CI 证据）
5) 回帖：提交 7 段式复核（IMPLEMENTATION SUMMARY / FILES / TESTS / SECURITY-COMPLIANCE BOUNDARY / CI RESULT / REMAINING ITEMS / NEXT PROPOSED CHECKPOINT）
```

## 3. 已知故障模式与处置（桥的可靠性）

| 故障 | 现象 | 处置 |
|---|---|---|
| 面板标签丢失 | `Tab not found`（会话页被关闭/回收） | 用会话 URL 重新 `createBrowserTab` 绑定；不换浏览器，只补标签 |
| 虚拟滚动 | 目标消息不在 DOM | 先点一次顶部「加载更早的消息…」，再持续向上滚动直到出现 |
| 流式未完成 | 回复末尾被截断（出现「停止」按钮） | 等「回答已完成」再取文本；必要时重读一次 |
| 宿主转达 | 裁决由宿主粘贴而非面板读取 | 仍按同一编号序列归档，并在标题注明「宿主转达」 |
| 编号冲突 | 同日重复编号（历史遗留） | 新裁决一律递增；历史重复只记录、不回改 |

## 4. 当前待办（桥上的下一封）

- 待提交：**B2 修复 PR 的 7 段式复核**（父对象归属变更保护：新增迁移 + 真实 PostgreSQL 六类验收测试 + B1/B3 历史口径纠偏）。
- 对应裁决：`MSG-20260930-04`（C-0002 RE-REVIEW = REVISE，不作 BLOCK、不要求回滚）。
- 提交后：等架构方复审；若返 REVISE，按条逐项修；若 PASS，继续 8 项工程顺序的下一项。

## 5. 边界（不因通道而放宽）

- 不使用公开/模拟数据冒充真实商业验证；Stage A/B/C 与 Decision Gate 门槛不变。
- Production Enablement 继续 HOLD；真实 Claim/Appeal/扣佣/收费/平台写操作继续禁止。
- 真实 Secret/OAuth/第三方生产凭据继续 HOST PENDING。
- 合并决策由架构方作出；不得绕过 GitHub 分支保护。
