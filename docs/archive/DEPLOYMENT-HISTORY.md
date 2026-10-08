# 部署文档归档索引（DEPLOYMENT HISTORY）

> 建立：2026-10-08（RC-LINUX-DEPLOY FINALIZATION · 部署来源统一治理）。
> 目的：把历史上分散的部署类文档**统一标记为归档**，确保只有一份正式流程，防止部署智能体或人员误用旧文档。
>
> **唯一正式入口**：仓库根 `DEPLOYMENT.md` ＋ `deploy/release-manifest.json` ＋ `node deploy/verify-release.mjs`。
> 本索引下的文档**只读保留**，不得删除，也不得作为部署依据。

---

## 1. 归档清单

| 文档 | 性质 | 归档原因 |
| --- | --- | --- |
| `docs/releases/RSI-DEPLOYMENT.md` | RSI 部署与自动启动说明（systemd） | 内容已并入 `DEPLOYMENT.md` 2.3 / 5 / 6 节；其「Test C/F 未实现」表述已过时 |
| `P2-1-DEPLOYMENT-SMOKE-CHECKPOINT.md` | 容器化部署 smoke 检查点 | 属 CI 自动化 smoke 记录，非人工部署流程 |
| `P2-PRODUCTION-HARDENING-DESIGN.md` | 生产加固设计 | 历史设计；落地条款已体现在 `DEPLOYMENT.md` 与 systemd unit |
| `P2-2-BACKUP-RESTORE-CHECKPOINT.md` | 备份/恢复验证检查点 | 属验证记录，非部署步骤 |
| `P2-3-SECRET-ROTATION-DESIGN.md` | 密钥轮换设计 | 属安全设计；轮换属 HOST 动作 |
| `P2-3-SECRET-ROTATION-CHECKPOINT.md` | 密钥轮换检查点 | 同上 |
| `P2-4-VALIDATION-RUNBOOK-CHECKPOINT.md` | 验证 runbook 检查点 | 历史 runbook |
| `PHASE1-VALIDATION-RUNBOOK.md` | 第一阶段验证 runbook | 历史 runbook |
| `PRODUCTION-READINESS-CHECKLIST.md` | 生产就绪清单 | 历史口径；当前口径见 `docs/releases/LINUX-DEPLOY-READINESS-AUDIT.md` |
| `EXTERNAL-DATASET-SMOKE.md` | 外部数据集 smoke | 历史验证记录 |
| `FINAL-PRODUCTION-GATE-REVIEW.md` | 生产门禁复核 | 历史评审记录 |

> `OPERATIONS.md` **不在归档范围**：它是运维（非部署）手册，与 `DEPLOYMENT.md` 互补。

---

## 2. 仍在生效的部署相关文档

| 文档 | 作用 |
| --- | --- |
| `DEPLOYMENT.md` | **唯一正式部署入口**（来源锁定 / 依赖 / 迁移 / 构建 / 启动 / 环境变量 / 健康检查 / 回滚 / 门禁） |
| `deploy/release-manifest.json` | 机器可读部署清单（Release ID / Commit / 服务 / 命令 / 环境变量名 / 健康检查 / 回滚） |
| `deploy/verify-release.mjs` | 部署前强制门禁（SHA 锁定 / 工作树 / 分支 / 构建 / 定向测试） |
| `docs/releases/LINUX-DEPLOY-READINESS-AUDIT.md` | 当前部署就绪审计与 GAP 清单 |
| `docs/releases/RC-LINUX-DEPLOY-FINALIZATION.md` | 本轮 systemd 补齐 + reconcile 接线的实施记录 |
| `OPERATIONS.md` | 运维手册（日志 / 故障 / 数据运维 / 事件响应） |

---

## 3. 归档规则

1. **只归档、不删除**：历史文档保留在仓库，便于追溯决策链；
2. **不得竞争**：任何归档文档中的步骤，与 `DEPLOYMENT.md` 冲突时以 `DEPLOYMENT.md` 为准；
3. 新增部署类文档前，先确认能否并入 `DEPLOYMENT.md`；确需独立成文时，必须同时在本索引登记。
