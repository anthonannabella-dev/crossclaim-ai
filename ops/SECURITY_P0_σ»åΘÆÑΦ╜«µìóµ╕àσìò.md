# P0 安全事件:密钥泄露与轮换清单

## 发生了什么

分发的 `customs-saas-complete.zip` 里包含了根目录的 `.env`(以及 `_ap_token.txt`、`.test_token.txt`)。
虽然 `.gitignore` **已经**忽略了 `.env`,但这个 zip 是用 `zip -r` 直接打包整个目录生成的——
`zip` 不读 `.gitignore`,于是被忽略的文件照样进了包。**凡是拿到过这个 zip 的人都已看到下列明文凭据,必须视为已泄露并全部轮换。**

> 本文档不写出任何真实密钥值,只标注键名与处置方式。

---

## 一、必须轮换(真实值已泄露)

按紧急程度排序。

| # | 凭据 | 紧急度 | 轮换后影响 | 处置 |
|---|---|---|---|---|
| 1 | `DEEPSEEK_API_KEY` | 🔴 最高(可计费、对外) | 无数据依赖,换值即可 | 登录 DeepSeek 控制台**吊销**旧 key,生成新 key,更新 `.env`,重启后端 |
| 2 | `JWT_SECRET` | 🔴 高 | **登出所有租户+管理员**(token 立即失效,需重新登录),无数据迁移 | 生成新随机值(见下),更新 `.env`,重启;提前知会用户会被登出一次 |
| 3 | `POSTGRES_PASSWORD` | 🔴 高 | 需同时改库口令 + `.env`,短暂重启 | 先 `ALTER USER ... PASSWORD`,再同步 `.env`,重启 backend 与 activepieces 容器 |
| 4 | `REDIS_PASSWORD` | 🟠 中高 | 同时改 Redis 配置 + `.env` | 改 `requirepass`,同步 `.env`,重启依赖服务 |
| 5 | `MINIO_PASSWORD`(+`MINIO_USER`) | 🟠 中高 | 改 MinIO 根凭据 + `.env` | 轮换 MinIO root 凭据,同步 `.env`;留意已签发的预签名 URL 会失效 |
| 6 | `SMTP_PASS`(+`SMTP_USER/HOST`) | 🟠 中 | 换邮箱授权码即可 | 在邮件服务商重置授权码/应用专用密码,更新 `.env` |
| 7 | `AP_JWT_SECRET` / `AP_ENCRYPTION_KEY` | 🟠 中 | **只影响 ActivePieces 容器**(本后端不用它加密落库数据)。换 `AP_ENCRYPTION_KEY` 后,ActivePieces 里已保存的连接凭据将无法解密,需在 AP 后台**重新授权各连接** | 换值后重启 activepieces 容器,逐个重连流程 |
| 8 | `ALIYUN_SMS_SIGN` / `ALIYUN_SMS_TEMPLATE` / `TENCENT_SMS_SIGN` / `TENCENT_SMS_TEMPLATE` | 🟡 低 | 签名/模板属配置非秘钥,泄露危害低;但 SMS **AccessKey 当前为空**,短信功能尚未真正接通 | 接入短信前补齐 AccessKey 时,确保不再写进会被打包的文件 |

### 生成强随机密钥(JWT / 加密类)

```bash
# JWT_SECRET / AP_JWT_SECRET:64 字节十六进制
openssl rand -hex 64
# AP_ENCRYPTION_KEY:ActivePieces 要求 32 字节十六进制(256-bit)
openssl rand -hex 16
```

---

## 二、无需轮换

- **sandbox 占位值**:`ALIPAY_*`、`WECHAT_*` 当前是 sandbox/示例值,上生产前替换为真实值即可(替换时同样别打进分发包)。
- **空值**:`FEISHU_*`、`DINGTALK_*`、`WECOM_WEBHOOK_URL`、`TENCENT_SMS_*`/`ALIYUN_SMS_*` 的 AccessKey 等当前为空。
- **用户密码**:走 `bcrypt`(`utils/crypto.ts` 的 `hashPassword`),与上述任何泄露密钥无关,**密码哈希本身安全**,无需强制用户改密(但若担心可发一次重置邀请)。

---

## 三、连带泄露的 token 文件

打包里还夹带了:
- `_ap_token.txt`、`.test_token.txt` —— 内含已签发的 JWT。**第 2 步轮换 `JWT_SECRET` 后,这些 token 自动失效**,无需单独处理,但文件本身要从仓库与分发流程中移除(已纳入加固版 `.gitignore`)。
- `_tmp_*.sql` —— 调试用 SQL,敏感度低,一并清理。

---

## 四、堵住根因:别再让密钥进包

`.gitignore` 拦不住 `zip -r`。今后分发请二选一:

**A. 用 git 的归档(只导出已跟踪、未忽略的文件)**
```bash
git archive --format=zip -o customs-saas-dist.zip HEAD
```

**B. 先用本次提供的 `cleanup_repo.sh` 清理,再排除敏感文件打包**
```bash
zip -r customs-saas-dist.zip customs-saas \
  -x '*/.env' '*/.env.*' '*/_*token*' '*/.test_token*' \
     '*/_tmp_*' '*/.hermes_backup*/*' '*/node_modules/*' '*/dist/*'
```

并把本次的**加固版 `.gitignore`** 覆盖进仓库,防止这些文件再被 `git add`。

---

## 五、轮换执行顺序(建议)

1. 先吊销 **DEEPSEEK_API_KEY**(对外可计费,风险最大)。
2. 选低峰期一次性轮换 **JWT_SECRET + DB/Redis/MinIO 口令**,统一重启(用户被登出一次)。
3. 轮换 **SMTP_PASS** 与 **ActivePieces AP_* 密钥**,重连 AP 流程。
4. 覆盖加固版 `.gitignore`,运行 `cleanup_repo.sh --apply` 清理仓库。
5. 改用 `git archive` 重新打分发包,确认包内 `grep -r DEEPSEEK customs-saas-dist/` 无任何真实值。
