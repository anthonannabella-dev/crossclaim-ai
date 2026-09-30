# migration-checksum —— 同名重纳迁移的字节冻结

B2-FIX R1 / MSG-20260930-06 CHANGE F。

`20260930100000_tenant_ownership_immutability` 的经历：

| 阶段 | commit | 说明 |
| --- | --- | --- |
| 原合入 | `d629333` | 新增迁移禁止 tenant-owned 对象改 organizationId 与 RuleSet 所有权漂移 |
| 整体回退 | `c93a07e` | 因 CI 硬编码期望失败而 Revert（迁移文件被删除） |
| 同名重纳 | `5c4e0db` | 同一文件名重新纳入，未改历史迁移 |

CHANGE F 要求：同名重纳必须与「已应用版本」**字节一致**并核对 checksum，语义一致不足。

## 证据（本机取证，2026-09-30）

```
BLOB_ORIGINAL   = 3304c9b98f25be0a5871f7c5b3c65ea8b07e611f   (d629333)
BLOB_REINCLUDED = 3304c9b98f25be0a5871f7c5b3c65ea8b07e611f   (5c4e0db)
BLOBS_IDENTICAL = True
sha256(blob)    = 2acbd87a731283c6e90f8121d49c3f55fc937eac8014a89a0b7d60929b87a884
还有：本机合成开发库 _prisma_migrations 中该迁移记录的 checksum 同为 2acbd87a…，状态 finished、未 rolled back。
```

即：原合入版本、同名重纳版本、本机应用记录三者 checksum 完全一致（2269 字节）。

## CI 用法

```bash
node tools/migration-checksum/check-migration-checksums.mjs --root .
```

`pinned-checksums.json` 保存冻结值；任何对已应用迁移文件的字节改动都会让 CI 变红。
