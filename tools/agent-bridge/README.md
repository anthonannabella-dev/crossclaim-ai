# agent-bridge —— Codex ↔ ChatGPT 通信与监视

架构章程 §十一 / §十三：双方**不通过网页互控**，一律通过 GitHub 通信；
本地跑一个轻量 Watcher，有新消息才行动。

---

## 通信通道

| 通道 | 位置 | 用途 |
|---|---|---|
| 长期线程 | GitHub Issue `AI-BRIDGE \| Codex ↔ ChatGPT` | 架构裁决、方案选择、跨 PR 持续话题 |
| 单次审计 | 当前 PR 的评论 | 与本 PR 强绑定的审计往返 |
| 落地产物 | 仓库文件（如 `LEGACY_MIGRATION_AUDIT.md`） | 需要被引用的长文档 |

消息格式见仓库根 `AGENTS.md` §三。

---

## Watcher 做什么

> ### ⚠️ Detection only（仅检测）
>
> `watcher.mjs` **只做三件事**：轮询 GitHub、解析消息、打印结果。
>
> 它**不会**：
> - 唤醒 ChatGPT
> - 唤醒 Codex
> - 自动执行 `CHANGE` / `NEXT`
> - 自动提交、自动合并、自动部署
>
> 也就是说：**它不是无人值守闭环**。闭环的"执行"环节由被唤醒的
> Codex 智能体会话完成（例如通过本仓库配置的 5 分钟定时任务），
> 或者由宿主把裁决交给 Codex。本文件与 README 不对这一事实作任何夸大描述。

每轮检查（默认 4 分钟）：

1. `AI-BRIDGE` Issue 的新评论
2. 打开中的 PR 的新评论
3. 打开中的 PR 的新 review
4. 是否出现 `VERDICT: PASS / REVISE / BLOCK`

**没有新消息 → 不输出、不动作。**
有新消息 → 解析 `VERDICT / CHANGE / TEST / NEXT` 并打印结构化结果。

---

## 幂等保证

已处理的评论 ID 记在 `tools/agent-bridge/.state/lastSeen.json`（已 gitignore）。
**同一条回复不会被处理两次。**

---

## 运行

需要 GitHub 令牌（**只读即可**）。令牌只从环境变量读取，**不写进任何文件**。

```bash
export GITHUB_TOKEN=xxx        # Windows: $env:GITHUB_TOKEN="xxx"

node tools/agent-bridge/watcher.mjs --once   # 跑一轮（适合放进定时任务）
node tools/agent-bridge/watcher.mjs          # 持续轮询
```

可调环境变量：

| 变量 | 默认 | 说明 |
|---|---|---|
| `CROSSCLAIM_REPO` | `anthonannabella-dev/crossclaim-ai` | 目标仓库 |
| `WATCH_INTERVAL_MS` | `240000` | 轮询间隔（4 分钟） |

---

## Watcher 不做的事

- 不自动 merge
- 不自动改仓库可见性
- 不自动部署
- 不自动调用付费 / 第三方账号
- 不向 GitHub 写任何内容（**只读**）

以上属于 `AGENTS.md` §七 的 `HOST APPROVAL REQUIRED` 清单。
