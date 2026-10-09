# SI-RSI V2-06 — `/customs/unlock/[opportunityId]` 客户入口页与五语言

> 授权：HOST DIRECTIVE 2026-10-09「CUSTOMS OPPORTUNITY UNLOCK & AUTO-COMMISSION V2」PHASE B / PHASE G。
> 基线：`208ea9c7`（V2-05）。分支：`feat/customs-opportunity-unlock-v2`。

## 1. 交付物

| 文件 | 说明 |
| --- | --- |
| `apps/web/app/customs/unlock/[opportunityId]/page.tsx` | 客户入口页（server component） |
| `apps/web/app/components/customs-unlock-panel.tsx` | 付费面板（client component，**点击后才展开**） |
| `apps/web/i18n/customs-unlock-copy.ts` | 五语言文案（`Record<Locale, …>` 强制全语言覆盖） |

## 2. 页面必须展示的八项（PHASE B）

| 要求 | 实现 |
| --- | --- |
| ① 可信预估金额及币种 | 原样展示后端持久化字符串 `recoverableAmount` + `currency`；**前端不做换算、不做求和、不做推导** |
| ② 预估依据与时间 | "预估依据" 区块展示 `claimDeadline`（缺失显示 `—`）；`opportunityType` / `customerStatus` 作为来源标识 |
| ③ 初步资格状态与证据完整度 | 展示 `customerStatus.label` 与 `customerStatus.code` |
| ④ 选择启动关税追回 | 面板初始仅一个按钮；文案明确"点击后才会显示服务方案与费用" |
| ⑤ 服务费套餐及权益 | 展开后展示两种方案（单次深度核验 / 按月订阅）及其权益说明 |
| ⑥ 成功追回后另收 15% 的说明 | 独立区块，明确"仅在实际到账并核验对账后收取；未追回/未到账/仅预计/申请中 = 0" |
| ⑦ 第三方费用、退款和取消条件 | 明确第三方可能另收且客户直接承担；退款/取消按披露条款；**不承诺海关必然退款** |
| ⑧ 支付与授权状态 | 读取服务端 `PAYMENTS_ENABLED`：未启用时显示"支付通道未启用"，购买按钮禁用 |

## 3. 硬约束的落地方式

| 约束 | 实现 |
| --- | --- |
| 无真实事实不得显示业务完成状态 | 后端未给金额时**不显示金额**，也不显示付费入口，只提示资料不足 |
| 无真实机会不出现购买诱导 | 机会不存在 / 不属于当前账户 → 只渲染"未找到该机会"，不展示任何机会数据 |
| 禁止自动弹出强制购买框 | 付费面板由 `useState(false)` 控制，必须客户点击才展开；无自动跳转 |
| 五语言必须同步 | `CUSTOMS_UNLOCK_COPY: Record<Locale, CustomsUnlockCopy>` —— 少任一语言直接**编译失败** |
| 文案中不出现具体价格 | 面板只写"价格与币种以服务端签发的报价单为准"；草案价 $39/$49 **不进入 UI** |
| 不新增 API / Schema | 只复用既有 `/opportunities?domain=CUSTOMS` 只读端点，沿用 `/customs` 页的取数方式 |

## 4. 验证结果（本机真实执行）

```text
TSC  apps/web --noEmit   0 error（含新页面 / 组件 / 文案模块，已确认进入编译文件集）
```

## 5. 阻断与未验证（不伪造）

```text
BROWSER_E2E=NOT_VERIFIED           未启动真实前后端链路（API 依赖 PostgreSQL，本机无 DB）
ENTITLEMENT_AWARE_CTA=NOT_IMPLEMENTED
                                   已购用户"不重复要求购买同一服务"依赖权益读取端点，
                                   当前 API 未暴露该读取面（V2-05 的权益模型尚未接线）；
                                   因此页面暂以 alreadyCovered=false 渲染，未伪造权益状态
CHECKOUT_REDIRECT=NOT_IMPLEMENTED  未接入收银台；购买按钮保持禁用（Payment HOLD）
MULTI_DEVICE_VISUAL=NOT_VERIFIED   未做真机/多尺寸截图验收
```

## 6. 边界自证

未新增 Runtime / 调度器；未触碰 `main` / release 分支 / U1 封板代码；
未发起任何支付、Provider 或生产写入。
