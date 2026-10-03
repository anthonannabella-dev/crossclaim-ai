# AI BRIDGE — 审计口径（版本化）

> 用途：事件触发审计（GitHub Actions）与第二层定时总审计共用同一套判定标准。
> 版本：v1（2026-09-30）；修改需经架构方裁决并在标题追加版本号。

## 1. 送审协议（Codex → 审计）

只有同时满足以下条件才构成可审计批次（`READY_FOR_REVIEW` 必须对应**真实 commit**）：

```text
[CODEX -> CHATGPT]
TYPE: READY_FOR_REVIEW
GATE: <当前 Gate>
HEAD: <commit SHA>
PR: <PR number>
1. 本轮完成内容
2. Schema / Migration 变化
3. 测试结果
4. CI 结果
5. 已知风险
6. 待审问题
7. NEXT
```

计划、状态描述、纯文档草稿不构成送审。

## 2. 判定标准

| 判定 | 条件 |
|---|---|
| **PASS** | 送审内容与 HEAD 一致；CI 全绿；无未声明的边界突破；测试覆盖该批次承诺的行为；无 PENDING 的关键风险 |
| **REVISE** | 可实现局部修复的问题：缺测试/断言不充分、口径不一致、CI 有非架构性失败、文档与实现不一致等 |
| **BLOCK** | 架构方向被否定、安全边界被突破、必须宿主输入而强行推进、多租户/资金链路设计错误等根因性缺陷 |

禁止模糊回复：每条裁决必须含 `DECISION / GATE / HEAD / KEEP / CHANGE / RISKS / TEST / NEXT / PRODUCTION`。

## 3. 必查项（审计清单）

1. **多租户隔离**：跨租户读写被拒、同租户正常写入。
2. **tenant ownership / immutability**：对象归属不可变更；RuleSet 所有权身份不可漂移。
3. **PostgreSQL 真实测试**：以真实数据库行为为准，schema 文本断言不构成充分证据。
4. **migration 全新库路径**：从零 `migrate deploy` 通过。
5. **migration 历史升级路径**：已有库应用新迁移通过，且不破坏既有触发器。
6. **DB trigger 实际拒绝行为**：断言名称、所属表、启用状态**与实际拒绝非法修改**四者齐备。
7. **Schema 与 runtime 一致性**：Prisma schema、迁移、服务层行为三者一致。
8. **CI 不允许硬编码假绿**：不得以写死计数/固定字符串通过；断言必须随实现变化而真实失败。
9. **审计日志**：高风险动作有审计事件且不含敏感取值。
10. **credential / token 安全**：仓库、日志、CI 不出现任何凭据取值。
11. **并发 / idempotency**：并发不绕过约束；重复执行不产生重复事实。
12. **Production Enablement 默认 HOLD**：自动 PASS 不等于可上线。
13. **不伪造真实业务数据**：合成数据不得表述为真实商业验证结果。
14. **不因真实数据延期阻塞可独立开发部分**。

## 4. 审计输出协议（审计 → Codex）

```text
[CHATGPT -> CODEX]
DECISION: PASS | REVISE | BLOCK
GATE:
HEAD:
KEEP: - ...
CHANGE: - ...
RISKS: - ...
TEST:
NEXT: - ...
PRODUCTION: HOLD | ELIGIBLE
```

## 5. 生产安全边界（即使自动审计 PASS 也保持）

- Production Enablement 默认 HOLD；真实外部写操作 HOLD。
- 不允许自动修改生产数据；不允许自动提交真实索赔/申诉；不允许使用真实商户账号执行不可逆操作；不允许绕过平台权限。
- 可继续推进：代码、migration、测试、mock/sandbox、文档。

## 6. 双层审计

- **实时层**：`READY_FOR_REVIEW` 事件触发（GitHub Actions），用于消除 Codex 等待。
- **总审计层**：ChatGPT 定时检查 commit / CI / Bridge / 自动裁决记录，发现架构漂移或错误裁决时纠偏。
