import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { loadEnv, validateEnv } from './config/env';
import { errorHandler, notFound } from './middleware/errorHandler';
import { apiLimiter, authLimiter } from './middleware/rateLimiter';
import { securityHeaders, sanitizeInput } from './middleware/security';
import { registerRoutes } from './routes';
import { startCronJobs } from './services/cronJobs';

const app = express();

const env = loadEnv();

// 运行时环境变量完整性校验
const envWarnings = validateEnv();
if (envWarnings.length > 0) {
  console.warn('\n⚠ 环境变量配置警告:');
  envWarnings.forEach(w => console.warn('  ⚠ ' + w));
}

// 安全中间件
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'https:'],
      fontSrc: ["'self'"],
      connectSrc: ["'self'"],
      frameSrc: ["'none'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
    },
  },
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true,
  },
}));

// CORS: 生产环境限制到具体域名，开发环境允许 localhost
const corsOrigin = env.CORS_ORIGIN || 'http://localhost:80';
app.use(cors({
  origin: corsOrigin === '*' ? '*' : corsOrigin.split(',').map(s => s.trim()),
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  maxAge: 86400,
}));

app.use(securityHeaders);
app.use(express.json({ limit: '10mb' }));
app.use(sanitizeInput);
app.use(morgan('combined'));

// trust proxy: nginx 后面正确获取真实 IP
app.set('trust proxy', 1);

// 全局限流（排除健康检查和 auth 路由）
app.use('/api', (req, res, next) => {
  // 登录、注册、健康检查不限流
  const skipPaths = ['/api/auth/login', '/api/auth/register', '/api/auth/forgot-password',
                     '/api/auth/reset-password', '/api/auth/sms/send', '/api/auth/sms/login'];
  if (skipPaths.includes(req.path)) return next();
  apiLimiter(req, res, next);
});

// 注册路由
registerRoutes(app);

// 错误处理
app.use(notFound);
app.use(errorHandler);

// 启动
const port = env.PORT;
app.listen(port, () => {
  console.log('Customs SaaS Backend running on port ' + port);
  console.log('Environment: ' + env.NODE_ENV);
  console.log('CORS origin: ' + corsOrigin);
  console.log('JWT_SECRET: ' + (env.JWT_SECRET ? '[configured]' : '[NOT CONFIGURED]'));

  // 启动定时任务
  startCronJobs();

  // 启动流水线持久化队列 worker(仅当 PIPELINE_QUEUE_ENABLED=true; 否则空操作)
  import('./services/queue/pipelineQueue')
    .then(({ startPipelineWorker }) => startPipelineWorker())
    .catch((err) => console.error('[Startup] 流水线队列启动失败:', (err as Error).message));

  // 服务启动后延迟 30s 跑一次卡死恢复:把上次进程崩溃时
  // 停在中间态(ocr_running/ai_checking/auto_filling)的报关分组重新推进。
  setTimeout(async () => {
    try {
      const { recoverStuckGroups } = await import('./services/groupPipelineService');
      const n = await recoverStuckGroups();
      if (n > 0) console.log(`[Startup] 恢复了 ${n} 个上次未完成的报关分组`);
    } catch (err) {
      console.error('[Startup] 卡死恢复失败:', (err as Error).message);
    }
  }, 30_000);
});

export default app;
