# CLAUDE.md — 报关 SaaS 项目说明（给 Claude Code 读）

## 技术栈
- 后端 `backend/`：Node + TypeScript + Express + Prisma(PostgreSQL)；端口 **3000**
- 前端 `frontend/`：React + Vite + Ant Design；端口 **5173**
- 基础设施（docker-compose.yml）：Postgres 16、Redis 7、SeaweedFS(对象存储, S3 兼容, 端口 8333)
- OCR：后端内置 `tesseract.js`(图片) + `pdf-parse`(PDF)，npm 即用，无需额外服务
- AI 校验：DeepSeek（需 `DEEPSEEK_API_KEY`）

## 后端常用命令（backend/ 目录下）
- 装依赖：`npm install`
- 类型检查/构建：`npm run build`（= tsc，**验证代码正确性最关键的一步**）
- 生成 Prisma Client：`npm run db:generate`
- 迁移数据库：`npm run db:migrate`（prisma migrate deploy）
- 起开发服务：`npm run dev`（tsx watch，:3000）
- 单元测试：`npm test`（jest）

## 必需环境变量（.env，放项目根 / backend 视配置而定）
POSTGRES_PASSWORD、REDIS_PASSWORD、DATABASE_URL、REDIS_URL、JWT_SECRET、DEEPSEEK_API_KEY
（DATABASE_URL 本地示例：postgresql://customs:customs_dev@localhost:5432/customs_saas）

## 「自动化报关」闭环契约（本次重点验证对象）
状态机：pending → ocr_running → ai_checking → auto_filling → pending_review
→ pre_checking → **checked(预检通过·待导出)** → **declared(导出XML即申报登记)**
→ customs_review(回填接单) → released(回填放行) → **completed(结关→自动归档)**

关键改动文件：
- `backend/src/services/groupPipelineService.ts`：去掉假申报；导出即申报登记(markExported)；结关自动归档(archiveGroup)
- `backend/src/services/declarationBuilder.ts`：generateCustomsXML 按**海关总署2018年第67号公告**生成 DecHead/DecLists 标准报文
- `backend/src/routes/routes/batchGroup.ts`：导出端点推进状态

## 批次流水线 API（均需 Bearer Token，前缀 /api）
- GET  /batch-group              列表
- GET  /batch-group/stats        统计
- GET  /batch-group/:id          详情
- POST /batch-group/:id/start-auto-fill     启动自动填制(从 ai_done)
- POST /batch-group/:id/approve-review      通过复核(→ checked)
- POST /batch-group/:id/reject-review       驳回
- GET  /batch-group/:id/export-xml          导出XML(checked → declared)
- POST /batch-group/:id/customs-response    回执回填 {action: accepted|released|rejected|completed}

## 后端验证目标（按顺序，全部要绿）
1. `npm run build` 类型零报错（重点检查上面三个改动文件）
2. `docker compose up -d postgres redis seaweedfs` 起来，`npm run db:migrate` 成功
3. `npm run dev` 后端正常监听 3000，无启动崩溃
4. `npm test` 通过
5. 接口验证闭环（鉴权 token 可读 auth 路由用 register/login 自取，或用 db:seed）：
   - 造一个到达 `checked` 的批次 → GET export-xml 应返回 XML，且该批次状态变 `declared`
   - 导出的 XML 根节点 `DecMessage`，含 `DecHead`/`DecLists`，字段名 IEFlag/CodeTS/GName/DeclPrice 等
   - POST customs-response {action:'released'} → released；{action:'completed'} → completed
   - 结关后该批次 `archivedAt` 非空（自动归档生效），审计日志有 `batch_group_archived`

## 约定
- 遇报错先读日志定位再改；改完重跑对应验证步骤
- 不要提交 .env / 密钥；执行高风险命令前先说明
