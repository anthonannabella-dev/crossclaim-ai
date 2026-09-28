# License Gate

依赖许可证闸门。目标：**核心业务代码是自己的，第三方基座只用商业友好的宽松许可证。**

## 用法

```bash
# 在仓库根目录
node ops/license-gate/check-licenses.mjs

# 顺便导出机器可读报告
node ops/license-gate/check-licenses.mjs --json ops/license-gate/report.json
```

退出码 `0` = 通过，`1` = 有问题（CI 直接 fail）。

## 判定逻辑

| 情况 | 结果 |
|---|---|
| 许可证在 `allow` | ✅ 通过 |
| 许可证在 `deny`（GPL/AGPL/SSPL/BSL/Elastic/Sustainable Use 等） | ❌ 直接失败 |
| 许可证在 `review`（MPL/LGPL/EPL/UNKNOWN 等） | ❌ 失败，除非登记进 `approvedExceptions` |
| 双许可（如 `MIT OR GPL-3.0-or-later`） | ✅ 通过，但**必须**在 `resolvedDualLicenses` 里锁定分支 |
| 包未安装（`node_modules` 不存在） | ⏭ 跳过，不算失败 |
| 缺少 `license` 字段 | ❌ 失败 |

## 为什么需要它

1. **一个库的代码许可证 ≠ 它的模型许可证。** 模型权重另见 `MODEL_LICENSES.md`。
2. **一个 MIT 项目可能依赖 GPL 组件。** 必须逐层查，不能只看首页。
3. **已经踩过的坑**（见 `allowlist.json` 的 `approvedExceptions`）：
   `jszip` 双许可、`xlsx@0.18.5` 是最后的开放源许可版本、MinIO 服务端是 AGPL-3.0、
   `tradeflow/activepieces-main` 的 `ee/` 目录另授权、Redis 8+ 转 AGPL/RSAL。

## 已知边界

- 只扫 **npm 直接依赖**。Python 侧（`ocr_service/`）需要 `pip-licenses`，尚未接入。
- 只扫**直接依赖**，不递归传递依赖。传递依赖审计靠 SBOM 工具（如 `syft`），尚未接入。
- 只扫 `node_modules` 里**实际安装**的版本，所以 CI 里必须先 `npm ci`。

## workspace 覆盖守卫

`WORKSPACES` 必须与 `apps/` 下真实存在 `package.json` 的目录完全一致
（当前为 `apps/api` + `apps/web`）。新增 workspace 若忘记登记，CI 会因
`apps/api/src/__tests__/license-gate-guard.test.ts` 失败而拦下 —— 避免重演
「指向旧项目遗留目录名导致全部检查静默 SKIP、CI 仍然全绿」的问题。
