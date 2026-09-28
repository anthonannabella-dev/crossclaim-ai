# 第三方开源许可声明

本项目使用以下第三方开源组件，严格遵守各组件许可协议。

## 运行时依赖

| 组件 | 版本 | 许可 | 用途 |
|------|------|------|------|
| Express.js | 4.x | MIT | HTTP Web 框架 |
| Prisma | 5.x | Apache-2.0 | ORM 数据库访问 |
| React | 18.x | MIT | 前端 UI 框架 |
| Ant Design | 5.x | MIT | UI 组件库 |
| Redis (ioredis) | 5.x | MIT | 缓存与消息队列 |
| MinIO Client | 8.x | Apache-2.0 | 对象存储 |
| PostgreSQL | 16 | PostgreSQL License | 关系数据库 |
| jsonwebtoken | 9.x | MIT | JWT 认证 |
| bcryptjs | 2.x | MIT | 密码哈希 |
| Zod | 3.x | MIT | 数据校验 |
| Zustand | 5.x | MIT | 状态管理 |
| Tesseract.js | 5.x | Apache-2.0 | OCR 识别引擎 |
| Winston | 3.x | MIT | 日志框架 |
| Helmet | 8.x | MIT | HTTP 安全头 |
| Swagger UI Express | 5.x | MIT | API 文档 |
| OpenAI SDK | 4.x | Apache-2.0 | AI API 调用 |
| Multer | 1.x | MIT | 文件上传 |

## 基础设施

| 组件 | 许可 | 用途 |
|------|------|------|
| Docker | Apache-2.0 | 容器化部署 |
| Nginx | 2-clause BSD | 反向代理 |
| Activepieces | MIT | 工作流引擎 |
| Alpine Linux | MIT | 容器基础镜像 |

## 许可合规确认

- [x] 全部依赖使用 MIT / Apache-2.0 / BSD / PostgreSQL License 协议
- [x] 无 GPL / AGPL / LGPL 传染性协议组件
- [x] 所有许可文件存档于各自的 node_modules 目录中
- [x] DeepSeek/微信/支付宝等第三方 API 仅通过环境变量配置，不嵌入源码
- [x] 本源码整体以 MIT 协议发布（闭源商用）
