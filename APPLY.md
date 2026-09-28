# 应用指南 — 这批改动怎么放进原项目

## 简短回答

**代码文件**可以直接按路径覆盖进原项目(本包目录结构已和项目一致)。
但**不是纯拖文件就完事**——有 3 件必须做的事,漏了会运行期报错:

1. 覆盖文件
2. `npm install`(新增了 bullmq 依赖)
3. 跑数据库迁移(新增了 Declaration.billOfLading 列)

下面是完整步骤。

---

## 步骤

### 0. 先备份 / 切干净分支
```bash
git checkout -b fixes-apply    # 或先 git stash / 备份
```

### 1. 覆盖文件
把本包 `backend/` 下的文件,按相同相对路径覆盖到你项目的 `backend/` 下。
本包共 25 个文件,全部在 `backend/` 内(前端未改动)。

### 2. 安装新依赖(必须)
```bash
cd backend
npm install          # package.json 已含 bullmq;这步会装上
```
> 不装的话:队列默认关闭时能优雅降级(回落 nextTick),但建议装上。

### 3. 跑数据库迁移(必须)
提单管理优化给 Declaration 表加了 `billOfLading` 列。**不迁移的话,按提单查询会报列不存在。**
```bash
cd backend
npx prisma generate          # 重新生成客户端类型
npx prisma migrate deploy    # 应用 20260614120000_add_declaration_bill_of_lading
```
迁移内含:加列 + 从旧 `declarationJson` 回填存量提单号 + 建索引。

### 4. 验证
```bash
cd backend
npx tsc --noEmit             # 期望 EXIT 0
npm test                     # 期望 105 个用例全绿(你的环境有真实DB, notification/hscode 也会过)
```

### 5.(可选)启用 BullMQ 持久化队列
默认关闭,流水线走 process.nextTick(原行为)。要启用需 Redis:
```bash
export PIPELINE_QUEUE_ENABLED=true
export PIPELINE_QUEUE_CONCURRENCY=3   # 可选
```

---

## 不在"覆盖文件"范围、需单独处理的

- **P0 密钥轮换**:`.env` 里的 DeepSeek/数据库/JWT 等密钥已泄露,按 `ops/SECURITY_P0_密钥轮换清单.md` 轮换。这是运维动作,不是文件覆盖。
- **加固 .gitignore**:`ops/gitignore.hardened` 覆盖到仓库根目录的 `.gitignore`,防止以后打包再夹带密钥/临时文件。
- **清理仓库垃圾**:`ops/cleanup_repo.sh` 在仓库根目录跑(默认 dry-run 预览,`--apply` 才移入回收站)。

---

## 本包内容清单

### 代码(覆盖进 backend/)
| 文件 | 改动 |
|---|---|
| src/services/groupPipelineService.ts | P1制单富化修复 + 卡死恢复 + 队列调度 + 去@ts-nocheck |
| src/services/queue/pipelineQueue.ts | 【新增】BullMQ 持久化队列 |
| src/services/declarationService.ts | 提单管理走列查询 + 修混币种 + 去@ts-nocheck |
| src/services/documentAuditService.ts | 提单核对走列 + 结果缓存 + 历史改免费正则 |
| src/services/cronJobs.ts | 每10分钟卡死恢复 |
| src/services/batchOCR.ts / ocrParser.ts / pdfGenerator.ts | 去@ts-nocheck(类型修复) |
| src/middleware/auth.ts | 外部网关:补 tenant 上下文(修限流+用量) |
| src/routes/api/routes.ts | 外部网关:submit-once 补审计 + 计时中间件上移 |
| src/routes/routes/batchGroup.ts / document.ts / declaration.ts / ocr.ts / taxRebateSupplement.ts | 去@ts-nocheck / 类型修复 |
| src/index.ts | 启动钩子:卡死恢复 + 队列 worker |
| prisma/schema.prisma | Declaration 加 billOfLading 列 + 索引 |
| prisma/migrations/...add_declaration_bill_of_lading/ | 对应迁移 |
| package.json | 新增 bullmq 依赖 |
| __tests__/*.test.ts | 5 个新测试 + 1 个修复(declarationBuilder) |

### 运维(ops/,不进 backend/)
- SECURITY_P0_密钥轮换清单.md
- gitignore.hardened
- cleanup_repo.sh
- p2_ts-nocheck_removal.patch
