# Dependencies License Audit

## Backend (Node.js/Express + Prisma)

### Production Dependencies

| Package | Version | License | Usage |
|---------|---------|---------|-------|
| @prisma/client | 5.22 | Apache-2.0 | ORM / Database access |
| axios | 1.16 | MIT | HTTP client for external API calls |
| bcryptjs | 2.4 | MIT | Password hashing |
| cors | 2.8 | MIT | CORS middleware |
| express | 4.22 | MIT | Web framework |
| express-rate-limit | 7.5 | MIT | API rate limiting |
| express-validator | 7.3 | MIT | Request validation |
| helmet | 8.2 | MIT | Security headers (HSTS, CSP) |
| ioredis | 5.11 | MIT | Redis client (caching/sessions) |
| jsonwebtoken | 9.0 | MIT | JWT authentication |
| minio | 8.0 | Apache-2.0 | Object storage (MinIO/S3) |
| morgan | 1.10 | MIT | HTTP request logging |
| multer | 1.4 | MIT | File upload handling |
| node-cron | 3.0 | ISC | Scheduled tasks (auto-renewal, policy fetch) |
| openai | 4.104 | Apache-2.0 | AI API client (HS classification, diagnosis) |
| pdf-parse | 1.1 | MIT | PDF text extraction for OCR |
| sharp | 0.33 | Apache-2.0 | Image processing (bundles libvips-42.dll — LGPL-3.0, dynamic linking, not copyleft) |
| swagger-jsdoc | — | MIT | OpenAPI spec generation |
| swagger-ui-express | — | MIT | Swagger UI middleware |
| uuid | 10.0 | MIT | Unique ID generation |
| winston | 3.19 | MIT | Structured logging |
| xlsx | 0.18 | Apache-2.0 | Excel file generation |
| jspdf | — | MIT | PDF generation |
| zod | 3.25 | MIT | Schema validation |

### Development Dependencies

| Package | Version | License | Usage |
|---------|---------|---------|-------|
| @types/bcryptjs | — | MIT | TypeScript type definitions |
| @types/cors | — | MIT | TypeScript type definitions |
| @types/express | — | MIT | TypeScript type definitions |
| @types/jsonwebtoken | — | MIT | TypeScript type definitions |
| @types/morgan | — | MIT | TypeScript type definitions |
| @types/multer | — | MIT | TypeScript type definitions |
| @types/node-cron | — | MIT | TypeScript type definitions |
| @types/swagger-jsdoc | — | MIT | TypeScript type definitions |
| @types/swagger-ui-express | — | MIT | TypeScript type definitions |
| @types/uuid | — | MIT | TypeScript type definitions |
| prisma | 5.22 | Apache-2.0 | Database migrations / schema |
| tsx | 4.22 | MIT | TypeScript execution (dev) |
| typescript | 5.9 | Apache-2.0 | TypeScript compiler |
| vitest | 2.1 | MIT | Testing framework |

## Frontend (React + Vite + Ant Design)

### Production Dependencies

| Package | Version | License | Usage |
|---------|---------|---------|-------|
| @ant-design/icons | 5.6 | MIT | UI icons |
| antd | 5.29 | MIT | UI component library |
| axios | 1.16 | MIT | HTTP client |
| dayjs | 1.11 | MIT | Date formatting |
| react | 18.3 | MIT | UI framework |
| react-dom | 18.3 | MIT | React DOM renderer |
| react-dropzone | 14.4 | MIT | File drag-and-drop |
| react-router-dom | 6.30 | MIT | Client-side routing |
| zustand | 5.0 | MIT | Lightweight state management |

### Development Dependencies

| Package | Version | License | Usage |
|---------|---------|---------|-------|
| @vitejs/plugin-react | 4.7 | MIT | Vite React plugin |
| typescript | 5.9 | Apache-2.0 | TypeScript compiler |
| vite | 6.4 | MIT | Build tool / dev server |

## License Summary

| License | Count | Risk |
|---------|-------|------|
| MIT | 27 | None - permissive |
| Apache-2.0 | 7 | None - permissive |
| ISC | 1 | None - permissive |
| LGPL-3.0 (dynamic link) | 1 | None - libvips-42.dll bundled with sharp, dynamic linking, not copyleft |

**Overall Assessment**: All dependencies use permissive open-source licenses. One LGPL component (libvips, bundled with sharp as a DLL) is dynamically linked and does not impose copyleft obligations on the SaaS code. No GPL/AGPL or proprietary licenses detected. Safe for commercial use.

## Audit Date

2026-06-02
