# PC-01A CUSTOMER ONBOARDING CHECKPOINT（Self-Service Bootstrap Foundation）

状态：**READY_FOR_REVIEW / IMPLEMENTATION CHECKPOINT**（待架构方裁决）
IMPLEMENTATION_HEAD = 90dfb67
IMPLEMENTATION_HEAD_FULL = 90dfb6706070b0753ada2eb0cabfd033c4f06e2d
CI = SUCCESS · RUN_ID = 37021040007 · CI_HEAD = 90dfb67
过程记录：首次 CI（37020599958）= failure —— 新增 `POST /auth/signup` 未登记在 `API.md`，触发 API contract 闸门；已补文档后 5 jobs 全绿（37021040007）。
授权：MSG-20261002-81 ⑤（PC-01 = AUTHORIZED AS **PC-01A SELF-SERVICE BOOTSTRAP FOUNDATION**；**不得**直接开放 production public signup）。
边界：NO platform write · Payment = 0 · autopay = OFF · collection = OFF · external payment write = OFF · R13 HOLD · TRANSPORT=false · 无生产凭据。

## 1. A–I 约束逐项落地

| 约束 | 要求 | 实现 | 证据 |
|---|---|---|---|
| A Atomic bootstrap | User + Organization + Membership(role=OWNER) 同事务；任一步失败全回滚；不存在「User 无 Organization」或「Organization 无 OWNER」 | `bootstrapSelfServiceAccount()` 整体包在 `prisma.$transaction` 内，三步 + 两条审计同事务 | `self-signup-db`「valid signup → 同事务成功」「中途失败 → 0 partial」 |
| B Existing user protection | 同 email 已存在 → 稳定拒绝；不建第二个 User；不并入既有 User 到新 Organization | 事务内先 `user.findUnique({email})` → `EMAIL_ALREADY_REGISTERED` | 「duplicate email → reject，不建第二个 User / 不并入新组织」；HTTP 409 |
| C Organization identity | name 必填；slug server-normalized / unique / collision-safe；不信 client slug | `normalizeOrganizationSlug()`（NFKD + 去音标 + 折叠 + 限长，空值回退 `org`）+ `resolveUniqueSlug()`（base、base-2…base-20，仍冲突加随机后缀） | 「slug 冲突 → 服务端安全解析（唯一）」「client 注入 slug → 被忽略」「normalizeOrganizationSlug 规范化」 |
| D OWNER issuance | 只有本 bootstrap 事务为新 Organization 建唯一 OWNER；普通成员走 invitation/admin；不得因 signup 开 client 任意 role | membership 固定 `role: 'OWNER'`，`input.role` 被忽略 | 「client 注入 role=ADMIN/OWNER → 被忽略」 |
| E Password handling | 复用既有 hashing / policy；禁止明文入库；禁止 password/hash 进审计 | 复用 `assertPasswordPolicy` + `hashPassword`（`password.ts`），未另写 hash | 「invalid password → reject」「password 不以明文存储」「audit 不含 password/hash」 |
| F Email verification | 新 User `emailVerified=false`；不得伪造 true | User 创建显式 `emailVerified: false`；未调用任何 markEmailVerified | 「emailVerified=false（不得伪造 true）」 |
| G Session issuance | 未验证用户不得获得 production-capable session | 服务返回 `sessionIssued:false`；HTTP 201 **不设置 Set-Cookie**；DB 无 Session 行 | 「valid signup → …session 0」「feature gate ON → 不发 session」 |
| H Feature gate | 默认 OFF，fail-closed；开放前需 abuse/rate-limit + email verification + production decision | `PUBLIC_SIGNUP_ENABLED`（`isPublicSignupEnabled()`，仅 `'true'` 开启）；`server.ts` 注入 `signupEnabled`；服务层 gate 关闭即 `SIGNUP_DISABLED` | 「feature gate OFF（默认）→ 403 SIGNUP_DISABLED 且零写入」（服务层 + HTTP 双层） |
| I Audit | `user.self_signup_created` + `organization.bootstrapped`；不含 password/hash/token/secret | 两条 AuditLog 同事务写入，changes 仅含 email / role / emailVerified / slug / name / ownerUserId / source | 「audit 不含 password/hash」（逐条扫描 changes） |

## 2. 交付物

| 文件 | 说明 |
|---|---|
| `apps/api/src/services/auth/self-signup.ts` | PC-01A bootstrap 服务（gate / 校验 / 原子事务 / 审计 / 不发放 session） |
| `apps/api/src/services/auth/index.ts` | 导出 gate 常量、错误类型与 bootstrap 入口 |
| `apps/api/src/services/auth/http-routes.ts` | 新增 `POST /auth/signup`（gate 关闭 → 403 `SIGNUP_DISABLED`；成功 → 201 + 无 Set-Cookie） |
| `apps/api/src/server.ts` | 注入 `signupEnabled`（`PUBLIC_SIGNUP_ENABLED === 'true'`）+ `selfSignup` 端口 |
| `apps/web/app/signup/page.tsx` + `signup-form.tsx` | `/signup` 页面：gate 关闭时只显示「暂不可用」；成功后明确提示需邮箱验证（不自动登录） |
| `apps/api/src/__tests__/self-signup-db.test.ts` | 服务层验收 10/10（真实 PostgreSQL） |
| `apps/api/src/__tests__/self-signup-http-db.test.ts` | HTTP 契约验收 3/3（真实 HTTP + PostgreSQL） |
| `API.md` | 新增 `/auth/signup` 契约行（API contract 闸门要求） |

## 3. 验证证据

- `tsc --noEmit`（apps/api）：0 error；`tsc --noEmit`（apps/web）：0 error。
- `self-signup-db` **10/10 PASS**（真实 PostgreSQL）：原子性、重复邮箱、slug 冲突、client 注入忽略、密码策略/明文与审计泄漏、emailVerified=false、gate OFF 零写入、中途失败零残留、跨租户不串、slug 规范化。
- `self-signup-http-db` **3/3 PASS**：gate OFF → 403 `SIGNUP_DISABLED` 且零写入；gate ON → 201 且 `set-cookie` 为空、DB 无 Session、membership=OWNER；重复邮箱 → 409。
- 既有回归：`auth-http-db` 3/3 PASS（登录/Cookie/上传未受影响）。
- API contract 闸门：本地 `API_CONTRACT_OK`（implemented=69 / documented=56）。
- CI：RUN_ID = 37021040007 · head = 90dfb6706070b0753ada2eb0cabfd033c4f06e2d · 5 jobs 全绿（license-gate / backup-verify / deploy-smoke / api / web）。

## 4. 明确未做（遵守 MSG-20261002-81）

未开放 production public signup（gate 默认 OFF）；未实现真实 email 投递 / 邮箱验证流程（PC-01B）；未实现反滥用 / rate limit（PC-08）；未发放未验证用户的 session；未改动既有 invitation flow；未改 Schema / 未加 migration；未触碰 payment / external write / production credentials。

## 5. 下一执行单元（待裁决）

- 若 PASS：进入 **PC-02 Opportunity List**（customer-visible recovery loop 可加载的内部能力）。
- PC-01B（PRODUCTION SELF-SERVICE ACTIVATION：真实 email delivery / email verification / abuse controls / rate limiting / production enablement）= **HOLD_EXTERNAL / HOST**，不阻塞 PC-02。

边界保持：NO platform write · Payment = 0 · autopay = OFF · collection = OFF · external payment write = OFF · R13 HOLD · TRANSPORT=false · 无生产凭据。
