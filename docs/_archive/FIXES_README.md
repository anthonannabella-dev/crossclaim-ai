# 报关 SaaS 修复交付包

本包是对 `customs-saas` 的一轮全面检查与修复产出。所有代码改动均通过 `tsc --noEmit`(strict)
全量编译,关键逻辑有测试覆盖(沙箱内 95/97 通过,余 2 个需真实数据库)。

> 提示:`.ts` 文件被某些系统按扩展名误认成 MPEG-TS 视频("播放类型")。它们其实是
> 纯文本 TypeScript 源码。请用编辑器打开,或直接放进项目,**不要双击**。

## 目录结构(已按项目路径归位,可直接覆盖)

```
backend/src/middleware/auth.ts                      外部网关鉴权:补 req.tenant/tenantRecord(修限流+用量)
backend/src/index.ts                                启动钩子:卡死恢复 + 队列 worker
backend/src/services/groupPipelineService.ts        P1富化修复 + 卡死恢复 + 队列调度 + 去@ts-nocheck
backend/src/services/cronJobs.ts                    每10分钟卡死恢复任务
backend/src/services/batchOCR.ts                    类型修复(去@ts-nocheck)
backend/src/services/queue/pipelineQueue.ts         【新增】BullMQ 持久化队列(可选增强层)
backend/src/routes/api/routes.ts                    外部网关:/submit-once 补审计日志 + 计时中间件上移
backend/src/routes/routes/batchGroup.ts             类型修复(去@ts-nocheck)
backend/src/routes/routes/document.ts               类型修复(去@ts-nocheck)
backend/src/routes/routes/taxRebateSupplement.ts    类型修复(去@ts-nocheck)
backend/__tests__/group_recovery.test.ts            【新增】卡死恢复测试(9)
backend/__tests__/pipeline_statemachine.test.ts     【新增】闭环状态机测试(11)
backend/__tests__/pipeline_queue.test.ts            【新增】队列调度契约测试(7)
backend/__tests__/declarationBuilder.test.ts        修复:补 prisma mock,解锁 32 个合规/XML 测试

ops/SECURITY_P0_密钥轮换清单.md                     P0 密钥泄露处置与轮换步骤
ops/gitignore.hardened                              加固版 .gitignore(覆盖到仓库根目录的 .gitignore)
ops/cleanup_repo.sh                                 P3 可逆清理脚本(默认 dry-run,--apply 才执行)
ops/p2_ts-nocheck_removal.patch                     去 @ts-nocheck 的统一 diff(含本包未单列的 5 个零改动文件)
```

## 应用方式

1. 备份现有仓库或确保在干净的 git 分支上。
2. 把 `backend/` 下的文件按相同路径覆盖到你的项目。
3. `ops/gitignore.hardened` 覆盖到仓库根目录的 `.gitignore`。
4. 新增依赖:`cd backend && npm install bullmq`(队列需要;不启用队列也可装着不用)。
5. 另有 5 个文件仅需删掉首行 `// @ts-nocheck`(本包未单列,见 `ops/p2_ts-nocheck_removal.patch`):
   `services/pdfGenerator.ts`、`services/ocrParser.ts`、`services/declarationService.ts`、
   `routes/routes/declaration.ts`、`routes/routes/ocr.ts`。

## 验证

```bash
cd backend
npx prisma generate          # 生成 Prisma 引擎(沙箱里被网络挡了,你的环境应正常)
npm test                     # 期望 97 全绿(含需 DB 的 notification/hscode)
npx tsc --noEmit             # 期望 EXIT 0
```

## 启用 BullMQ 持久化队列(可选)

默认关闭,流水线走 process.nextTick(原行为)。要启用(需 Redis):

```bash
export PIPELINE_QUEUE_ENABLED=true
export PIPELINE_QUEUE_CONCURRENCY=3   # 可选
npm run dev
```

启用后:OCR/AI/自动填制进持久化队列,进程重启不丢任务、失败指数退避重试 3 次、
耗尽进死信(分组置 error 转人工)。`recoverStuckGroups` 作为兜底保留。

## 待办(需你的环境实测,本包未覆盖)

- 真·端到端集成测试(真实 Postgres + mock OCR/DeepSeek 跑完整链)
- BullMQ 队列连 Redis 的运行时实测(入队/消费/重试/死信/重启恢复)
- P0 密钥轮换属运维动作,按 `ops/SECURITY_P0_密钥轮换清单.md` 执行

## 仍建议你权衡的设计项(本包未改)

- 外部 API token 永不过期(建议加 expiresAt)
- 外部 API 无 scope 权限分级(任何 token 都能打 /submit-once)
- 外部鉴权每请求 bcrypt 比对(建议改 HMAC 常量时间或缓存已验证 token)
