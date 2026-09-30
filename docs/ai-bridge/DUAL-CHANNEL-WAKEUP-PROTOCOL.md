# 双通道即时唤醒协议（Dual-Channel Immediate Wake-up）

> 宿主指示（2026-09-30，JST）：架构审计改为「双通道即时唤醒」；本节为该协议的落地记录。
> 定位：这是**通信与留档纪律**，不改变任何领域语义、Gate 边界或安全策略。

## 1. 通道角色

| 通道 | 角色 |
| --- | --- |
| GitHub（PR / Issue comment） | **唯一正式审计消息总线与 Source of Truth**；完整审计材料写在这里 |
| 右侧 ChatGPT Web 会话（`/c/6abc2d93-…`） | **仅即时唤醒**；不重复粘贴全文 |
| GitHub 每小时巡检 / watcher | 仅 watchdog / fallback，不再作为正常等待周期 |

## 2. 需要架构审计时的固定动作

1. **先写 GitHub**：在当前 PR / Issue 提交一条完整审计请求 comment，字段固定为
   `GATE`、`HEAD`、`CHANGE`、`Schema / migration`、`tests`、`CI`、`evidence`、`requested decision`。
2. **确认提交**：回读该 comment，记录 `comment URL / ID`。
3. 不等待每小时巡检。
4. **立即唤醒**：在右侧 ChatGPT 当前会话发送一条**短消息**（不粘贴全文）：

   ```text
   [CODEX → CHATGPT]
   CrossClaim GitHub 已有新的架构审计请求。
   HEAD=<CURRENT_HEAD>
   GATE=<CURRENT_GATE>
   请立即读取当前 PR/Issue 最新 Codex 审计消息，检查 GitHub 最新代码、CI 和证据，并把正式 VERDICT 写回 GitHub。
   不使用上一轮缓存。
   ```

5. ChatGPT Web 只承担唤醒；**只有 GitHub 不可访问时**才允许把完整材料贴进 Web。
6. 正式裁决以 **GitHub 上最新架构回复**为准（PASS / ACK / REVISE / BLOCK）。
7. 发完唤醒后：继续所有不依赖该裁决的工作；高频检查右侧 ChatGPT；同时检查 GitHub 是否出现新的架构回复；出现即全文读取并执行。
8. 若右侧回复「已审计 / 已写回 GitHub」，**立即查询 GitHub**，不等 watcher。
9. 宿主不参与任何复制粘贴。

## 3. 何时才允许 HOST_ACTION_REQUIRED

仅当 **GitHub 与 ChatGPT 通道都无法自行恢复**（或命中既有的宿主专属清单：付费、生产部署、DNS、删真实数据、Secret 轮换、API 正式申请、第三方真实账号、真实客户数据、法律/牌照高风险、仓库可见性、不可逆外部操作）时才通知宿主。

## 4. 首次使用记录（2026-09-30）

| 项 | 值 |
| --- | --- |
| 正式审计请求（GitHub） | PR #11 comment `5901785441` — https://github.com/anthonannabella-dev/crossclaim-ai/pull/11#issuecomment-5901785441 |
| 请求 HEAD / GATE | `e40d4f9` / C-0002 / B2-FIX R1 集成（base `main`） |
| 集成 HEAD CI | run 36651145264 → 5/5 SUCCESS |
| 唤醒消息（ChatGPT Web） | 已发送并回读验证（输入框清空 + 会话尾部出现该 `你说：` 轮次） |

## 5. 与既有归档纪律的关系

- `AI-ARCHITECT-INBOX.md` 的逐字归档纪律继续有效：**任何**裁决（无论来自 GitHub 还是 Web）都必须逐字归档，并用
  `tools/verdict-diff/compare.mjs` 自检为 `FULL_COPY_OK`。
- 过渡期说明：MSG-20260930-09 / -10 发生在协议切换之前，来源为 Web 全文并要求全文归档；自本协议起，正式裁决应落在 GitHub，
  归档时以 GitHub 上的架构回复为原文来源。
