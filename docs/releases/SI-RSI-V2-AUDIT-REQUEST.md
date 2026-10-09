# SI-RSI V2 — 独立审计请求（V2-01 → V2-09）

## 送审锚点

```text
REPOSITORY = anthonannabella-dev/crossclaim-ai
BRANCH     = feat/customs-opportunity-unlock-v2
BASE_HEAD  = 21e49891
REVIEW_HEAD= f47ba314
```

## 变更集（26 个文件，全部为本阶段新增/修改）

```powershell
git -C D:/crossclaim-ai diff --name-only c6e03c51..f47ba314
```

代码：`apps/api/src/services/customs/` 7 个模块（paid-api-gate / paid-provider-composition /
opportunity-unlock-state / profit-gate / unlock-payment / execution-chain / success-fee-collection）、
`apps/api/src/runtime/customs-unlock-si-pack.ts`、`apps/web` 3 个文件（页面 / 面板 / 五语言文案）。
测试：`apps/api/src/__tests__/` 8 个新套件（合计 165 项，含既有 success-fee-guard）。
文档：8 份 `docs/releases/SI-RSI-V2-0N-*.md` + 本矩阵。

## 请审计方重点核验

1. **免费/付费边界**：`customs-paid-api-gate.ts` 是否真的无法从免费路径触发收费调用；
   `customs-paid-provider-composition.ts` 的全出口覆盖断言与静态扫描是否可能被绕过。
2. **金额语义**：`customs-opportunity-unlock-state.ts` 是否在 C4 非 ELIGIBLE 或 C5 非 ESTIMATED 时
   一律不输出金额；多币种是否确实不换算、不合计；关税纠错与 Duty Drawback 是否可能被重复计算。
3. **Profit Gate**：`customs-profit-gate.ts` 是否存在"只看追回总额"的路径；概率是否可能被当成确定值；
   定点算术（BigInt, floor to cent）是否存在高估收入或负数处理的漏洞。
4. **支付与权益**：`customs-unlock-payment.ts` 的验签（HMAC + 时间戳窗口 + timingSafeEqual）、
   幂等（`eventId` 与 `eventId → ent-<quoteId>`）与生命周期处置是否自洽；
   是否存在前端状态/URL/伪造回调解锁的路径。
5. **执行链**：`customs-execution-chain.ts` 的 11 状态是否存在跳跃（例如 Profit Gate 之后才校验授权）；
   是否存在"未验证结算即产生应收"或"同一结算重复计费"的路径。
6. **成功费收款**：`customs-success-fee-collection.ts` 五态是否互相排斥；
   `AUTO_COLLECTION=HOLD` 是否在任何输入组合下都不会变成 `COLLECTED`。
7. **运行时唯一性**：`customs-unlock-si-pack.ts` 是否可能创建第二运行时/调度器，
   或消费 `task:recovery:` 保留命名空间；`externalWritePerformed` 是否恒为 false。
8. **页面与文案**：`/customs/unlock/[opportunityId]` 是否在无可信金额时仍可能露出付费入口；
   五语言是否真的同步（`Record<Locale, …>` 是否覆盖全部 locale）。

## 明确声明（请勿把下列项判为通过）

```text
BROWSER_E2E=NOT_VERIFIED · POSTGRESQL_IT=NOT_RUN · REAL_PROVIDER=NOT_VERIFIED
REAL_PAYMENT_WEBHOOK_E2E=NOT_VERIFIED · MULTI_DEVICE_VISUAL=NOT_VERIFIED
PACK_REGISTRATION=NOT_WIRED · ENTITLEMENT_AWARE_CTA=NOT_IMPLEMENTED · CHECKOUT_REDIRECT=NOT_IMPLEMENTED
PRODUCTION_READY=NO · AUTO_COLLECTION=HOLD · REAL_PROVIDER_WRITE=HOLD
```

## 复现命令

```powershell
cd D:/crossclaim-ai/apps/api && npx vitest run src/__tests__/customs-*   # 注意：含 DB 套件，需 PostgreSQL
npx tsc --noEmit
cd ../web && npx tsc --noEmit
```
