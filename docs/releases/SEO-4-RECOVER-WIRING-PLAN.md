# SEO-4 —— /recover 路由接线与多语言（实施计划）

> 依据：`docs/releases/SEO-P3-GAP-AUDIT.md`、`MSG-20261004-28`（SEO-3 PUBLIC API SECURITY = REVISE）第 ④ 条
> `SEO-4_RECOVER_PAGE_WIRING = AUTHORIZED`、`DEFAULT_NOINDEX = REQUIRED`；公开 Checker 的 POST API 仍 `HOLD`。

## 1. 本单元范围（只做页面层，不开放 Checker HTTP）

- `/recover/[slug]` 页面渲染器接线：consuming SEO-2 `RecoveryRuleDefinition v1` + SEO-6 indexability gate + SEO-5 metadata/JSON-LD/sitemap builders + SEO-7 事件契约。
- 默认 `noindex`：只有 indexability gate 全绿（生效中 RuleVersion + 真实 capability + 至少一个真实 Checker/Calculator + 实质内容 + 真实 sourceReferences + 无版本冲突 + canonical 明确）才允许 `index`。
- 语言：5 语言 parity（en / zh-Hans / zh-Hant / ja / es），所有面向用户文案走 i18n key；`CUSTOMER_UI_HARDCODED_STRING_COUNT = 0`。
- canonical + hreflang：每个 slug × locale 一条 canonical，hreflang 互指且含 x-default。

## 2. 硬规则（不得违反）

- **Recovery Rule 单源**：页面禁止硬编码规则/资格/截止日/计算/费率；一切取自生效中的 `RuleVersion` / `RecoveryRuleDefinition v1`。
- 公开 Checker/Calculator 仍：匿名只读、无租户数据、无 PII、限流、零外写、不创建 submission、不绕过 Action Guard、不扣费；estimate 必须标注为估算。
- 禁止批量空洞 AI 页面、关键词换词、虚构追回率/金额/案例/法规。

## 3. 最小执行顺序（每步都可独立提交与验证）

1. 路由骨架 + 404/重复 slug/过期/冲突/locale fallback（SEO-6 已有每页计划，先接线不产出可见内容）。
2. metadata（title/description/canonical/hreflang/robots）由 gate 驱动，默认 `noindex`。
3. JSON-LD（只用真实 sourceReferences 生成，禁止编造）。
4. sitemap：只纳入通过 gate 的 URL；robots 与 sitemap 保持一致。
5. 页面实质内容 + 内部链接（Customs 高意图优先），i18n 5 语言 parity。
6. 合同测试：hardcoded string = 0、i18n parity、gate→robots 一致性、无 Checker POST 路由注册。

## 4. 验收（本单元完成时）

- `pnpm/npm` 构建 + 类型检查干净；SEO 合同测试全绿。
- `CUSTOMER_UI_HARDCODED_STRING_COUNT = 0`；5 语言 key parity = 100%。
- 未注册任何公开 Checker POST 路由；`PUBLIC_CHECKER_HTTP` 仍 HOLD。
- `TRANSPORT=false`、`EXTERNAL_WRITE=HOLD`、`PAYMENT=HOLD`、生产凭据 ABSENT；`FINAL_ACCEPTANCE_HEAD=0f7f7ac` 未动。

## 5. 阶段 1 测试用例清单（不可省略，逐条命名）

| 用例 | 输入 | 期望 |
| --- | --- | --- |
| RECOVER_SLUG_NOT_FOUND | 未注册 slug | 统一 404，不泄漏注册表（不做 fingerprinting） |
| RECOVER_SLUG_DUPLICATE | 同一 slug 两条生效 RuleVersion | fail-closed：不进 sitemap、robots=noindex、canonical 不指向该页 |
| RECOVER_RULE_EXPIRED | RuleVersion effectiveTo 已过 | 不 INDEX、不进 sitemap、页面显示升级提示（文案来自 i18n key） |
| RECOVER_VERSION_CONFLICT | canonical selector 判定 >1 active | 与 DUPLICATE 同口径 fail-closed，且记录 reasonCode |
| RECOVER_LOCALE_FALLBACK | 缺失某语言内容 | 回退到默认语言并输出 hreflang 互指 + x-default，不产出空壳页面 |
| RECOVER_NO_CHECKER_HTTP | 任意公开请求 | 不存在 Checker POST 路由（api-contract gate 断言） |

> 每条用例都必须只消费生效中的 RuleVersion / RecoveryRuleDefinition v1，不得在测试或页面里硬编码规则、资格、截止日、计算或费率。

