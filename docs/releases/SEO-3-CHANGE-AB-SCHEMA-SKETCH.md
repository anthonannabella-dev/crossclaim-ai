# SEO-3 CHANGE A/B — publicInputSchema 形状与校验顺序（实现草稿）

> 依据：`docs/releases/SEO-3-PUBLIC-API-AUDIT-REQUIREMENTS.md`（架构方 REVISE 裁决 / `3066ac2`）。
> 状态：**草稿（未实现）**。目标是把「格式白名单」升级为「语义白名单 + schema 驱动数值校验」。

## 1. schema 形状（registry 侧提供，不在 SEO 层硬编码字段）

```ts
export type PublicInputField =
  | { kind: 'boolean'; required?: boolean }
  | { kind: 'integer'; min: number; max: number; required?: boolean }
  | { kind: 'number'; min: number; max: number; required?: boolean }
  | { kind: 'enum'; options: readonly string[]; required?: boolean }
  | { kind: 'token'; maxLength: number; required?: boolean };

export interface PublicInputSchema {
  /** 允许的答案键（语义白名单）。未列出的 key 一律拒绝。 */
  fields: Record<string, PublicInputField>;
  /** 是否允许键全部缺省（默认 true；Check/Calc 各自决定）。 */
  allowEmpty?: boolean;
}

export interface PublicInputSchemaRegistry {
  /** basisKey → schema（未注册 = 该能力不可公开，fail-closed）。 */
  getPublicInputSchema(basisKey: string): PublicInputSchema | null;
}
```

示例（`engine:customs-drawback-eligibility`）：

```ts
{
  fields: {
    reexported:        { kind: 'boolean' },
    duty_amount:       { kind: 'number',  min: 0, max: 100_000_000 },
    days_since_import: { kind: 'integer', min: 0, max: 3650 },
    entry_type:        { kind: 'enum', options: ['CONSUMPTION', 'WAREHOUSE', 'FTZ'] },
  },
}
```

## 2. 校验顺序（CHANGE A + B 落点）

1. **请求形状**（已有）：slug token、答案对象、键格式、键数量 ≤12。
2. **schema 解析**：`registry.getPublicInputSchema(eligibilityMethod.basisKey)`；为 `null` → `NO_RECOVERY_CAPABILITY`（不得用未注册能力）。
3. **CHANGE A — 未知键拒绝**：`key ∉ schema.fields` → **`UNKNOWN_ANSWER_KEY`** → `INVALID_REQUEST`。**这一步必须在把答案传给引擎之前**。
4. **CHANGE B — 数值/类型校验**（逐字段，替换现有"number/boolean 直接 continue"）：
   - `boolean`：必须 `typeof === 'boolean'`；
   - `integer`：`Number.isFinite` 且 `Number.isInteger` 且 `min ≤ v ≤ max`；
   - `number`：`Number.isFinite` 且 `min ≤ v ≤ max`；
   - `enum`：必须是 `options` 之一；
   - `token`：字符串、长度上限、无控制字符；
   - `required` 缺省 → `INVALID_REQUEST`。
   - 类型不符 → `INVALID_REQUEST`；越界 → `INVALID_REQUEST`。
5. **PII 扫描（仅字符串）**：保留现有 `containsPersonalData()`；**不要**把该正则推广到数值（会误杀合法金额）。
6. 以上全部通过后，才调用 `runEligibility` / `runCalculation`。
7. **输出校验**（架构方新增要求）：engine 返回后校验 estimate/currency/disclaimerKey/reasonCodes，非法 → `ENGINE_OUTPUT_INVALID` → fail-closed。

## 3. 测试要点（实现时补）

- `phone` / `email` / `customer_name` / `secret` 等**格式合法但未注册**的 key → `UNKNOWN_ANSWER_KEY`。
- `{"phone": 14155550132}`（数值型 PII）→ 因未注册 key 被拒（不再依赖数值正则）。
- `duty_amount: -1` / `1e12` / `NaN` / `"100"`（字符串冒充数值）→ `INVALID_REQUEST`。
- `days_since_import: 1.5`（integer 字段给小数）→ `INVALID_REQUEST`。
- `entry_type: 'NOPE'`（enum 越界）→ `INVALID_REQUEST`。
- 合法金额（如 `duty_amount: 250000`）**不得**被 PII 规则误杀（回归断言）。
- 未注册 basisKey → `NO_RECOVERY_CAPABILITY`；engine 输出非法 → `ENGINE_OUTPUT_INVALID`。

## 4. 边界（不变）

匿名只读、无租户数据、无 PII、零外写、不建 submission、不扣费、不绕 Action Guard；`PUBLIC_CHECKER_HTTP = HOLD`（HTTP 接线需另送 PUBLIC HTTP FINAL 的 10 项）；`SEO-4 /recover 页面接线 = AUTHORIZED`（默认 NOINDEX 必须）。
