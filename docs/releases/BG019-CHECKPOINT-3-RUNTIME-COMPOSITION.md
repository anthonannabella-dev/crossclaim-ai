# BG-019 CHECKPOINT 3 — CHANGE C + D + E（runtime composition / producer / runtime E2E guard）

- 依据：**MSG-20261003-142 = REVISE（仅 CHANGE C + D + E + runtime E2E guard）**；REVIEWED_HEAD `291b5dd`

## CHANGE C + E — 默认 runtime composition

- 新增 `createDefaultReadDeps(prisma)` 并于 **`createRuntime` 默认装配**：`customsEntryFactStore` / `qualificationRead`（→ `createPrismaQualificationAssessmentStore.loadLatestAssessment`）/ `independentSiteState`（→ `createPrismaPs04StateLoaders`：handoff、latest response、latest settlement、latest phase1 projection，全部 tenant scoped）。
- 两个 runtime E2E **不手工注入**这些只读依赖（只 `createServer({...createDefaultReadDeps(prisma)})`），证明 composition root 真的接上了。
- `platform-qualification-runtime-http-e2e-db.test.ts`：真实登录 → `GET /platform-accounts/:id/qualification` → **200** 且返回预置持久化判定；读取前后判定行数不变；401 / 403 / 404 语义正确。
- `independent-site-phase1-runtime-http-e2e-db.test.ts`：默认 runtime → `GET /independent-site-disputes/:ref/state` → 200。

## CHANGE D — Phase-1 producer wiring

- 新增 `runPs04Phase1(input, { store })`：执行**现有内部链** `assembleChargebackRecoveryPackage` 后，**自动** `appendProjection(...)`（同一 immutable 结果 → `ALREADY_APPENDED`；结果变化 → 追加历史）。
- E2E 先断言投影表为空 → 跑一次 Phase 1 → 投影**自动产生**（1 行）→ 再跑一次 → `ALREADY_APPENDED`（仍 1 行）→ 默认 runtime HTTP 读出 `phase1 != null` 且 `notPersisted = []`，qualification/evidence/claim-ready 三项均为 READY/QUALIFIED。
- 测试**没有**手工 seed 投影，也没有手工注入 state deps。

## CHANGE 7 — Matrix Guard 再加强

- frontend cell 除「真实后端调用 + 域 token + 关键状态 token」外，**必须存在命名 runtime E2E 证据**：
  Platform → `platform-qualification-runtime-http-e2e-db.test.ts`；Independent-site → `independent-site-phase1-runtime-http-e2e-db.test.ts`。
- 缺该文件时 frontend cell 直接判 GAP（杜绝「页面写对了但默认 runtime 永远 404」的假阳性）。加严后四域矩阵仍 **0 缺口**。

## 证据

- `platform-qualification-runtime-http-e2e-db.test.ts` → **1/1 PASS**（真实 HTTP + PostgreSQL）
- `independent-site-phase1-runtime-http-e2e-db.test.ts` → **1/1 PASS**（真实 HTTP + PostgreSQL，含 producer 自动产生投影）
- `api tsc` EXIT=0；`API_CONTRACT_OK`；audit-coverage OK；autopilot rules OK。

## 边界

External Write=HOLD · Real Money=HOLD · Customer Submission=HOLD · Production Credentials=HOST_ONLY；`externalWritePerformed` / `autoSubmitAllowed` 仍由 DB CHECK 强制为 false。
