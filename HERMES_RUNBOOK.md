# 关务 SaaS 日常维护速查表

> 发给 Hermes 用。每条带验证标准，跑完对照就知道成没成。

**路径前提：** 项目在 `D:\customs-saas`，后端容器名 `customs-backend`，容器已挂载宿主机 `backend/dist`。

---

## 一、重启后一键自检

> 重启完把这段整体发给 Hermes。

任务：检查关务 SaaS 重启后是否一切正常。请逐条执行并回报输出。

### ① 看所有容器状态

```cmd
cd /d D:\customs-saas
docker compose ps
```

期望：`customs-backend`、`customs-postgres`、`customs-redis`、`customs-seaweedfs` 都是 `Up`（backend 显示 `healthy` 更好）。若 backend 是 `Restarting` 或 `Exited`，执行第④步抓日志。

### ② 验证后端核心代码已正确加载（最关键）

```cmd
docker compose exec backend node -e "const c=require('/app/dist/services/customsCodes.js'); console.log(c.toCustomsCode(c.COUNTRY_CODES,'中国'), Object.keys(c.COUNTRY_CODES).length);"
```

期望输出：**`142 715`**
- 142 = "中国"正确映射成海关代码
- 715 = 国别代码表全部加载
- 两者都对 = 三大服务正常运行

### ③ 确认挂载的 dist 是新版

```cmd
docker compose exec backend sh -c "wc -c /app/dist/services/customsCodes.js"
```

期望：**8341**。若为 1214 或为空，说明 dist 异常，执行第⑤步修复。

### ④ （仅当 backend 没起来时）抓日志定位

```cmd
docker compose logs --tail=60 backend
```

回报最后 60 行里任何含 `Error`、`Cannot`、`did not initialize`、`is required` 的行。先不要自行改动。

### ⑤ （仅当第③步 dist 异常时）重新生成并重启

```cmd
cd /d D:\customs-saas\backend
npm run build
docker restart customs-backend
```

等 10 秒后重跑第②步，确认输出 `142 715`。

### 判定标准

**① 容器都 Up + ② 输出 142 715 + ③ 输出 8341 = 重启后系统完全正常**，无需任何操作。

---

## 二、通用验证命令（多数操作后用它确认）

```cmd
cd /d D:\customs-saas
docker compose exec backend node -e "const c=require('/app/dist/services/customsCodes.js'); console.log(c.toCustomsCode(c.COUNTRY_CODES,'中国'), Object.keys(c.COUNTRY_CODES).length);"
```

**期望输出：** `142 715`

---

## 场景 1️⃣：电脑/Docker 重启后，确认系统正常

就是上面的"重启后一键自检"。

---

## 场景 2️⃣：改了后端源码（backend/src 里的 .ts），让改动生效

> ⚠ 容器读的是挂载的 backend/dist，必须先重新编译再重启

```cmd
cd /d D:\customs-saas\backend
npm run build
docker restart customs-backend
```

等待 10 秒后验证：

```cmd
docker compose exec backend node -e "const c=require('/app/dist/services/customsCodes.js'); console.log(c.toCustomsCode(c.COUNTRY_CODES,'中国'), Object.keys(c.COUNTRY_CODES).length);"
```

- `npm run build` 无报错（tsc 成功无输出即正常）
- 最终输出 `142 715`
- 若 build 报 TS 错误，把完整报错回报，**不要 restart**

---

## 场景 3️⃣：后端起不来 / 报错，查日志定位

```cmd
cd /d D:\customs-saas
docker compose ps
docker compose logs --tail=80 backend
```

回报 `customs-backend` 的状态、以及日志最后 80 行里任何含 `Error/error/Cannot/did not initialize` 的行。**先不要自己改任何东西。**

---

## 场景 4️⃣：误删了 backend/dist，或容器找不到代码

> 现象：容器报找不到模块、或 `wc -c` 为空。重新编译即可恢复。

```cmd
cd /d D:\customs-saas\backend
npm run build
dir dist\services\customsCodes.js
docker restart customs-backend
```

等待 10 秒验证：

```cmd
docker compose exec backend sh -c "wc -c /app/dist/services/customsCodes.js"
```

- `dir` 显示 `customsCodes.js` 约 8341 字节
- `wc -c` 输出 `8341`

---

## 场景 5️⃣：要加新的 npm 依赖（这种才需要重建镜像）

> ⚠ 只有改了 `package.json`、装了新包才需要走这条。普通改代码用场景 2 即可。
> ⚠ 已知隐患：这台机器 build 在 `npm install` 阶段易中断。执行前先清 C 盘（场景 6）。

```cmd
cd /d D:\customs-saas
docker compose build --no-cache backend
docker compose up -d --force-recreate backend
```

等 build 完整结束（出现 `naming to ... DONE` 或回到提示符）再继续验证：

```cmd
docker compose exec backend node -e "const c=require('/app/dist/services/customsCodes.js'); console.log(c.toCustomsCode(c.COUNTRY_CODES,'中国'), Object.keys(c.COUNTRY_CODES).length);"
```

期望 `142 715`。若 build 在 `#9 npm install` 几秒内中断/报 `CANCELED`，停止并回报——很可能是磁盘空间不足，先做场景 6。

---

## 场景 6️⃣：清磁盘（解决 build 卡顿的根治措施，有空时做）

```cmd
dir C:\ | findstr 可用
docker system df
docker system prune -f
```

提示用户手动操作（Hermes 可能无权限）：打开 Windows「设置 → 系统 → 存储 → 临时文件」，勾选「以前的 Windows 安装文件」(Windows.old) 并删除，通常可释放 20-40GB。

完成后再次 `dir C:\ | findstr 可用` 确认空间增加。**目标：C 盘可用 ≥ 20GB。**

---

## 🔒 三条铁律

1. **`D:\customs-saas\backend\dist` 永远不能删** —— 容器靠它运行。
2. **改了后端 `.ts` 代码 → 必须 `npm run build` + `docker restart customs-backend`** —— 光改源码不编译，容器看不到。
3. **出问题先查日志（场景 3）、先别瞎改** —— 把日志发出来，再动手。
