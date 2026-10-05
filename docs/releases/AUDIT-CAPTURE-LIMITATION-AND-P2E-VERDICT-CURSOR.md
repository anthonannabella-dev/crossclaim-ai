# 审计裁决捕获限制 + P2-E 裁决归档游标（可复现记录）

## 1. 限制（实测结论）

在本会话使用右侧 ChatGPT 审计会话（`https://chatgpt.com/c/6ac1cdf0-1ec8-83ec-8036-0e66fcf5c6b9`）时：

- 页面上下文**不提供** `document.createElement`、`Blob`、`Selection.removeAllRanges`，因此「新建 textarea + execCommand('copy')」「Blob 下载」「Range 选中复制」三条落盘路径全部不可用；
- CUA 的 locator 选择器 `button:has-text("复制")` 返回 0 命中（元素存在于可访问性树，但该选择器语法不被支持）；
- 唯一可靠读取方式是 `playwright.evaluate(() => document.body.innerText)` 后按 `ChatGPT 说：` 分段；
- 可访问性树每次调用都会回传整页节点（约 10k tokens），因此「读一段 60 行」的实测成本 ≈ 12k tokens。

后果：单条 ≥700 行的裁决无法在单窗口内完成「读出 + 转写落盘」。已按 60 行/段分片推进。

## 2. 归档游标（P2-E 裁决）

```
verdict        = PASS WITH REVISE（P2-E v1 = Option A，AUTHORIZED_WITH_CONDITIONS；Option B = NOT_AUTHORIZED）
REVIEWED_HEAD  = 48e6e2a38faaa5e5fdda41fd5db0e262ec5c7e45
送审包 commit  = b34ddd36
目标文件       = work/stage/recovery-si-p2e/verdict-p2e.txt（拼接后逐字，无尾随换行）
总长度         = 10521 字符 / 731 行 / FNV1A = e2516425
已落盘         = verdict-part1.txt（第 1–59 行；自 `ARCHITECT VERDICT：PASS WITH REVISE（批准 P2-E v1 采用 Option A…` 至 `→ 才允许 P2-E 写入`）
下一段起点     = 第 60 行（0-based index 60），每段取 60 行
校验方式       = 全部段以 '\n' 拼接后：字符数 = 10521、行数 = 731、FNV1A = e2516425；通过后才 archive-verdict.mjs + compare.mjs（必须 FULL_COPY_OK）
```

任何一段若无法通过上述总校验，则不得写入 `AI-ARCHITECT-INBOX.md`（避免截断/错字入库）。

## 3. 已确认的裁决要点（供并行推进参考，不替代逐字归档）

- `P2_E_V1_OPTION = A`；`P2_E_OPTION_A = AUTHORIZED_WITH_CONDITIONS`；`P2_E_OPTION_B = NOT_AUTHORIZED`。
- 理由：既有 `RecoveryPackage` / `RecoveryPackageArtifact` / `FileAsset` / `AuditLog` + 两组 UNIQUE（`organizationId,claimItemId,packageVersion,packageDigest` 与 `organizationId,packageId,artifactKind,sha256`）+ tenant / append-only / controlled-mutation 触发器已存在；新建第二套表只会带来双写、双 lineage、迁移与状态同步。
- **必修 1（入口门禁）**：不得以「P2-D `claim.submit` = ALLOW」作为 P2-E 写入前提。正确入口：
  `fresh state → canonical READY alignment → verified P2-C package preview / deterministic facts → trusted ProductionControlPlane → evaluate(claim.prepare) → ALLOW → persistence transaction`。
  即 `P2_E_GUARD_ACTION = claim.prepare`（真实 Control Plane 下 `claim.submit + 无 approvalId → REQUIRE_APPROVAL` 是正确行为，不能拿它当内部准备前提）。
- **必修 2 / 3（标题已确认，正文待读）**：事务原子性；lineage 表述。

## 4. 解除阻塞的选项（等待宿主）

1. 宿主把该裁决正文粘贴到本线程 → 一次性落盘 + 归档 + `FULL_COPY_OK`；
2. 宿主批准 `ARCHIVE_MODE = SUMMARY_NON_VERBATIM / FULL_VERBATIM_PENDING` 的例外（未获批准前不采用）；
3. 否则按 60 行/段继续分段捕获（每段约消耗一个执行窗口）。

边界不变：`P2_E = HOLD_SCHEMA_DELTA`、`P2_F = HOLD`、`P2_G = HOLD`；`FINAL_ACCEPTANCE_HEAD = 0f7f7ac`。
