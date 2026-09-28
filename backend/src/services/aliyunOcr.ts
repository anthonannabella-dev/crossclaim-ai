// @ts-nocheck — 阿里云 SDK 类型在本仓库未必解析，按可选增强层处理（与 pipelineQueue 同风格）
// ============================================================
// 阿里云 OCR 接入（带「并发上限 + QPS 限速 + 429 退避」护栏）
// ------------------------------------------------------------
// 设计要点：
//  - 全局 Client 只建一次复用（避免每次请求新建）。
//  - 只识别「图片/扫描件」；数字文件(PDF文本层/Excel/Word)仍由 runDocumentOCR 本地解析(免费)。
//  - 并发≤8、QPS≤8：贴着阿里云账号级「10QPS / 10并发」上限留余量，从源头不触发限流。
//  - 遇到 Throttling.User / 429：指数退避后重试（绝不立即重试——阿里云明确要求）。
//  - 启用条件：检测到 ALIYUN_OCR_ACCESS_KEY_ID/SECRET；未配置或 SDK 缺失则视为未启用，
//    调用方(runDocumentOCR)自动回落本地 Tesseract，不影响现有行为。
//
// ⚠️ 限流为「单进程内」有效。若水平扩容多实例，账号级 10QPS 是全局共享的，
//    需改用 Redis 分布式限流，或购买阿里云 QPS 叠加包扩容。
// ============================================================
import { Readable } from 'stream';
import pLimit from 'p-limit';

const KEY_ID = process.env.ALIYUN_OCR_ACCESS_KEY_ID || '';
const KEY_SECRET = process.env.ALIYUN_OCR_ACCESS_KEY_SECRET || '';
const ENDPOINT = process.env.ALIYUN_OCR_ENDPOINT || 'ocr-api.cn-hangzhou.aliyuncs.com';

const CONCURRENCY = Number(process.env.ALIYUN_OCR_CONCURRENCY || 8);
const QPS = Number(process.env.ALIYUN_OCR_QPS || 8);
const MAX_RETRY = Number(process.env.ALIYUN_OCR_MAX_RETRY || 3);

/** 是否启用阿里云 OCR（密钥齐全即启用） */
export function isAliyunOcrEnabled(): boolean {
  return !!(KEY_ID && KEY_SECRET);
}

// ---------- 全局 Client（懒加载、单例） ----------
let client: any = null;
function getClient(): any {
  if (client) return client;
  // 延迟 require：SDK 未安装时抛错 → 调用方 catch 后回落 Tesseract
  const OcrApi = require('@alicloud/ocr-api20210707');
  const OpenApi = require('@alicloud/openapi-client');
  const Client = OcrApi.default || OcrApi.Client || OcrApi;
  const Config = OpenApi.Config || (OpenApi.default && OpenApi.default.Config) || OpenApi.default;
  const config = new Config({ accessKeyId: KEY_ID, accessKeySecret: KEY_SECRET });
  config.endpoint = ENDPOINT;
  client = new Client(config);
  return client;
}

// ---------- 并发闸（p-limit） ----------
const limit = pLimit(CONCURRENCY);

// ---------- QPS 时间闸（相邻请求最小间隔） ----------
const MIN_INTERVAL_MS = Math.max(1, Math.ceil(1000 / QPS));
let nextAllowedAt = 0;
async function qpsGate(): Promise<void> {
  const now = Date.now();
  const wait = Math.max(0, nextAllowedAt - now);
  nextAllowedAt = Math.max(now, nextAllowedAt) + MIN_INTERVAL_MS;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 判断是否为限流错误（Throttling.User / 429） */
export function isThrottleError(err: any): boolean {
  const code = err?.code || err?.data?.Code || err?.Code || '';
  const status = err?.statusCode || err?.status;
  return (
    code === 'Throttling.User' || code === 'Throttling' ||
    status === 429 || /throttl/i.test(err?.message || '')
  );
}

/**
 * 单张图片识别 → 纯文本。
 * 经过：并发闸(≤CONCURRENCY) → QPS闸(≤QPS) → 调用；遇限流指数退避重试(不立即重试)。
 */
export async function recognizeImage(buffer: Buffer): Promise<string> {
  return limit(() => recognizeWithRetry(buffer));
}

async function recognizeWithRetry(buffer: Buffer): Promise<string> {
  let attempt = 0;
  for (;;) {
    await qpsGate();
    try {
      return await callOnce(buffer);
    } catch (err: any) {
      attempt++;
      if (isThrottleError(err) && attempt < MAX_RETRY) {
        const backoff = 1000 * Math.pow(2, attempt - 1); // 1s, 2s, 4s ...（指数退避，非立即重试）
        // eslint-disable-next-line no-console
        console.warn(`[AliyunOCR] 限流(Throttling)，第${attempt}次退避${backoff}ms后重试`);
        await sleep(backoff);
        continue;
      }
      throw err;
    }
  }
}

/** 单次调用（RecognizeAdvanced 通用文字识别，返回全文 content） */
async function callOnce(buffer: Buffer): Promise<string> {
  const OcrApi = require('@alicloud/ocr-api20210707');
  const DarabonbaStream = require('@alicloud/darabonba-stream').default;
  const Util = require('@alicloud/tea-util');
  const RuntimeOptions = Util.RuntimeOptions || (Util.default && Util.default.RuntimeOptions);

  const c = getClient();
  // body 需为 darabonba-stream 的 BytesReadable 类型
  const stream = DarabonbaStream.readFromBytes(buffer);
  const request = new OcrApi.RecognizeAdvancedRequest({ body: stream });
  const runtime = new RuntimeOptions({ readTimeout: 20000, connectTimeout: 10000 });
  const resp = await c.recognizeAdvancedWithOptions(request, runtime);

  // RecognizeAdvanced 的 body.data 是 JSON 字符串：{ content, prism_wordsInfo, ... }
  const data = resp?.body?.data;
  const parsed = typeof data === 'string' ? JSON.parse(data) : data;
  return String(parsed?.content || '').slice(0, 10000).trim();
}

/** 启动自检：真实跑一次小图识别，验证「密钥有效 + 服务已开通 + 能返回文本」 */
export async function selfTest(buffer: Buffer): Promise<{ ok: boolean; sample?: string; error?: string }> {
  if (!isAliyunOcrEnabled()) return { ok: false, error: '未配置 ALIYUN_OCR_ACCESS_KEY_ID/SECRET' };
  try {
    const text = await recognizeImage(buffer);
    return { ok: true, sample: text.slice(0, 50) };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
}
