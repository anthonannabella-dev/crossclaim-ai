# Operations Console v1 — E1/E2 证据

## 0. 准备
- prisma migrate deploy + seed：OK（开发库，幂等）
- API READY @ http://127.0.0.1:3100
- Web READY @ http://127.0.0.1:3101
- 登录 OWNER：HTTP 200
- 登录 OPS：HTTP 200
- 登录 FINANCE：HTTP 200
- 登录 VIEWER：HTTP 200
- 只读快照（前，登录后）：{"user":5,"membership":4,"session":13,"invitation":0,"audit":14,"cases":0,"claim":0,"settlement":0}

## 1. 四角色 API 权限矩阵（GET，权威判定）
| 角色 | API | method | HTTP | 期望 | 结果 |
|---|---|---|---|---|---|
| OWNER | `/admin/tenant-overview` | GET | 200 | 200 | PASS |
| OWNER | `/admin/audit` | GET | 200 | 200 | PASS |
| OWNER | `/admin/imports` | GET | 200 | 200 | PASS |
| OWNER | `/admin/recovery-review` | GET | 200 | 200 | PASS |
| OWNER | `/admin/members` | GET | 200 | 200 | PASS |
| OWNER | `/admin/system-health` | GET | 200 | 200 | PASS |
| OPS | `/admin/tenant-overview` | GET | 403 | 403 | PASS |
| OPS | `/admin/audit` | GET | 403 | 403 | PASS |
| OPS | `/admin/imports` | GET | 200 | 200 | PASS |
| OPS | `/admin/recovery-review` | GET | 403 | 403 | PASS |
| OPS | `/admin/members` | GET | 403 | 403 | PASS |
| OPS | `/admin/system-health` | GET | 200 | 200 | PASS |
| FINANCE | `/admin/tenant-overview` | GET | 403 | 403 | PASS |
| FINANCE | `/admin/audit` | GET | 403 | 403 | PASS |
| FINANCE | `/admin/imports` | GET | 403 | 403 | PASS |
| FINANCE | `/admin/recovery-review` | GET | 403 | 403 | PASS |
| FINANCE | `/admin/members` | GET | 403 | 403 | PASS |
| FINANCE | `/admin/system-health` | GET | 403 | 403 | PASS |
| VIEWER | `/admin/tenant-overview` | GET | 403 | 403 | PASS |
| VIEWER | `/admin/audit` | GET | 403 | 403 | PASS |
| VIEWER | `/admin/imports` | GET | 403 | 403 | PASS |
| VIEWER | `/admin/recovery-review` | GET | 403 | 403 | PASS |
| VIEWER | `/admin/members` | GET | 403 | 403 | PASS |
| VIEWER | `/admin/system-health` | GET | 403 | 403 | PASS |

## 2. 页面 GET + DOM 泄露扫描（E1/E2）
| 角色 | 页面 | method | HTTP | 泄露命中 | 无权限空态 |
|---|---|---|---|---|---|
| OWNER | `/operations` | GET | 200 | — | n/a |
| OWNER | `/admin` | GET | 200 | — | n/a |
| OWNER | `/admin/tenant-overview` | GET | 200 | — | n/a |
| OWNER | `/admin/audit` | GET | 200 | — | n/a |
| OWNER | `/admin/imports` | GET | 200 | — | n/a |
| OWNER | `/admin/recovery-review` | GET | 200 | — | n/a |
| OWNER | `/admin/members` | GET | 200 | — | n/a |
| OWNER | `/admin/system-health` | GET | 200 | — | n/a |
| OPS | `/operations` | GET | 200 | — | n/a |
| OPS | `/admin` | GET | 200 | — | n/a |
| OPS | `/admin/tenant-overview` | GET | 200 | — | PASS |
| OPS | `/admin/audit` | GET | 200 | — | PASS |
| OPS | `/admin/imports` | GET | 200 | — | n/a |
| OPS | `/admin/recovery-review` | GET | 200 | — | PASS |
| OPS | `/admin/members` | GET | 200 | — | PASS |
| OPS | `/admin/system-health` | GET | 200 | — | n/a |
| FINANCE | `/operations` | GET | 200 | — | n/a |
| FINANCE | `/admin` | GET | 200 | — | n/a |
| FINANCE | `/admin/tenant-overview` | GET | 200 | — | PASS |
| FINANCE | `/admin/audit` | GET | 200 | — | PASS |
| FINANCE | `/admin/imports` | GET | 200 | — | PASS |
| FINANCE | `/admin/recovery-review` | GET | 200 | — | PASS |
| FINANCE | `/admin/members` | GET | 200 | — | PASS |
| FINANCE | `/admin/system-health` | GET | 200 | — | PASS |
| VIEWER | `/operations` | GET | 200 | — | n/a |
| VIEWER | `/admin` | GET | 200 | — | n/a |
| VIEWER | `/admin/tenant-overview` | GET | 200 | — | PASS |
| VIEWER | `/admin/audit` | GET | 200 | — | PASS |
| VIEWER | `/admin/imports` | GET | 200 | — | PASS |
| VIEWER | `/admin/recovery-review` | GET | 200 | — | PASS |
| VIEWER | `/admin/members` | GET | 200 | — | PASS |
| VIEWER | `/admin/system-health` | GET | 200 | — | PASS |

- 只读快照（后）：{"user":5,"membership":4,"session":13,"invitation":0,"audit":14,"cases":0,"claim":0,"settlement":0}
- 快照一致性：PASS（完全一致）

## 3. 判定
- API 权限矩阵：PASS（24/24）
- E1（仅 GET）：4 角色 × 8 页面全部以 GET 访问；E3 静态扫描确认代码内无 POST/PUT/PATCH/DELETE
- E2（DOM 泄露）：PASS（无禁词命中）
