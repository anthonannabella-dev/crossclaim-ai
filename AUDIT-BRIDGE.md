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

## 6. 断因诊断与保活（2026-09-30 实测）

| 断因 | 现象 | 处置 |
|---|---|---|
| 临时标签被回收 | 下一轮 `Tab not found in browser 1` | 只用**会话 URL** 认会话：`getTab({url})` 失败即 `createBrowserTab(url)` 重建；每轮 `markHandoff()` 保活 |
| 账号/配置不一致 | 早期读到 `Annabella Anthon`，后期为 `zhengsanwei` | 发送前核对侧栏账号；发现不一致即停发并改用正确账号 |
| 会话类型不同 | 输入框标签是「使用 ChatGPT Work」而非「询问 ChatGPT」 | Work 会话固定用 `div[contenteditable="true"][aria-label="使用 ChatGPT Work"]`；普通会话用「询问 ChatGPT」；两者都无则退化为「底部 composer 容器内最后一个 contenteditable」，**不得选中页面中部编辑器** |
| 假输入框 | 回帖里的「开始写作」编辑器也是 contenteditable | 仅认底部 composer 区域；中部编辑器一律不填 |
| 虚拟滚动 / 流式截断 | 旧消息不在 DOM；回复半截 | 先点顶部「正在加载更早的消息…」再上滚；等「回答已完成」再取文本，截到「ChatGPT 可能会出错」为止 |

**发送验证（强制）**：`fill` + `Enter` 后必须回读——① 输入框已清空；② 正文出现桥路标记（如 `[CODEX -> CHATGPT]` / `BRIDGE ONLINE`）。未验证到即视为未发送，重试一次；仍失败则报「桥路不可用」，不得假设成功。

**消息约定**：每条以 `[CODEX -> CHATGPT] <topic>` 开头，便于去重与送达确认；裁决归档编号自 `MSG-20260930-06` 起递增。

## 7. 持续执行环（宿主 2026-09-30 确认）

**固定循环（每批一致）**：

```text
① 送审（在右侧网页版 ChatGPT 当前会话发 `[CODEX -> CHATGPT]` 包）
② 等约 3 分钟（回复生成中；页面出现「停止生成」时继续等）
③ 滚到会话最底部 → 只认本次送审之后的新回复 → 全文读取
④ 取审计报告（DECISION / KEEP / CHANGE / RISKS / TEST / NEXT / PRODUCTION）
⑤ 执行 CHANGE（与 RISKS/TEST 一并）
⑥ 新 commit + 本地全绿 + 推 CI
⑦ 回到 ① 再送审，持续向下推进
```

**标记规则（架构方 MSG-20260930-07）**：

- 中间小步提交一律标 **`TYPE: PROGRESS`**（进度），**不得**标 `READY_FOR_REVIEW`。
- 全部修订完成、拿到**最终 HEAD 的 CI 证据**后，再统一提交一次 `TYPE: READY_FOR_REVIEW`（7 段式）+ **独立修复 PR** 以界定 diff。
- 只有出现**新方案选择 / 范围变化 / 实际阻塞**时才提前提问，不逐小步等开工确认。

**每轮状态回复必须带（宿主 2026-09-30）**：

```text
CHATGPT_WEB:
- send_head:
- latest_reply_found: YES / NO
- scrolled_to_bottom: YES / NO
- full_reply_captured: YES / NO
- decision:
- decision_head:
- github_archived: YES / NO
```

**失败保护**：无法确认到底部 / 回复可能截断 / AX 只返回部分消息 → 不猜结论，继续滚动与分段提取；确实读不到则记录 `CHATGPT_WEB_READ = FAILED`、`FALLBACK = GITHUB_BRIDGE`，并如实标注。

**归档纪律**：每次新裁决**立即逐字**写入 `AI-ARCHITECT-INBOX.md`（`### [MSG-YYYYMMDD-NN]` + ```text 原文块），并跑 `tools/verdict-diff/compare.mjs` 必须 `FULL_COPY_OK`。
