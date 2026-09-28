# _archive —— 历史过程产物

本目录存放**已完成使命的过程性文档**，保留是为了可追溯，**不是当前行为的依据**。

## 为什么在这里

仓库里曾经叠了**三层互相覆盖的「交付包」痕迹**：

```
第 1 层 · 根目录散落件（README.md 描述的「修复交付包」）
第 2 层 · _tmp_patch/ —— 另一棵完整补丁树
第 3 层 · backend/ frontend/ —— 真正的产品代码
```

2026-09-28 的阶段 0 清场对这三层做了**逐文件语义比对**（不是文本比对），结论是：

**根目录散落件与 `_tmp_patch/` 全部是「旧版或等版」，没有任何未合并的功能。**

判定依据：

| 对比 | 结论 |
|---|---|
| 根 `groupPipelineService.ts` vs `backend/src/services/groupPipelineService.ts` | 产品侧**独有** 5 个符号（`ocrAndClassifyDocument` / `aiDocs` 等）→ 产品更新 |
| 根 `tenant.ts` vs `backend/src/routes/routes/tenant.ts` | 路由集合完全一致（各 8 条，双方均无独有项）→ 等版 |
| 根 `declarationElements.ts` / `documentAuditService.ts` / `pipelineQueue.ts` / `AuditLogPage.tsx` / `DutyCalculatorPage.tsx` / `pipeline_queue.test.ts` | 符号集合完全一致 → 等版 |
| `_tmp_patch/backend/prisma/schema.prisma` vs 产品 schema | 双方均 **31 个 model**，无独有项 → 等版 |
| `_tmp_patch` 的 4 个差异文件 | 3 个功能集一致，1 个（`groupPipelineService.ts`）产品侧更新 |

据此，冗余的源码副本已移入仓库外的隔离区，本目录只保留**过程性文档**。

## 本目录内容

| 文件 | 性质 |
|---|---|
| `APPLY.md` / `APPLY_COMPLETE.md` | 交付包的应用说明与完成记录 |
| `COMMIT_MSG.txt` | 当时的提交信息草稿 |
| `FIXES_README.md` | 修复包说明 |
| `HERMES_RUNBOOK.md` | hermes 自动化网关运行手册（该网关已从仓库移出） |
| `README_测试数据说明.md` | 测试数据说明（对应的 `_test_docs/` 已移入隔离区） |

## 当前的权威文档在哪

| 想了解 | 看这个 |
|---|---|
| 项目怎么跑 | `/README.md`、`/CLAUDE.md` |
| 报关闭环的行为契约 | `/修复说明.md`、`/导出XML闭环说明.md` |
| XML 字段映射 | `/XML代码映射说明.md` |
| 工具与依赖 | `/DEPENDENCIES.md`、`/归档调档与关税工具箱说明.md` |
| 依赖许可证规则 | `/ops/license-gate/` |

## 隔离区

被移出仓库的冗余副本与临时文件在：

`E:\zhuihuiweikuan-saas-quarantine\20260928_112721`

全部可复原（`Move-Item` 搬回原位即可）。确认无需保留后再手动删除。
