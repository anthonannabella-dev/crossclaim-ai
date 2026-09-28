/**
 * Wave 1 · 存储适配层（C-0003 / Gate 1 · 第 1 项）
 * ---------------------------------------------------------------
 * 三类断言：
 *   1. 租户边界：跨租户读写、路径穿越、非法 key 一律拒绝
 *   2. 完整性：sha256 校验；签名令牌的签名与过期校验
 *   3. 真实行为：本地驱动真实落盘可回读；S3 驱动对本地假 S3 服务端发真实签名请求
 */

import http from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  LocalFileSystemStorage,
  S3CompatibleStorage,
  StorageAccessError,
  StorageIntegrityError,
  StorageNotFoundError,
  assertTenantScopedKey,
  buildStorageKey,
  issueSignedUrl,
  sanitizeFilename,
  sha256Hex,
  signRequest,
  sealToken,
  openToken,
} from '../services/storage';
import { createServer } from '../server';
import { createLogger } from '../config/logger';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const ASSET = '33333333-3333-4333-8333-333333333333';
const OTHER_ASSET = '44444444-4444-4444-8444-444444444444';
const SECRET = 'test-storage-url-secret-0123456789';
const BASE = 'http://localhost:3000';

let tmpRoot: string;

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'crossclaim-storage-'));
});

afterAll(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

function localAdapter(now?: () => number): LocalFileSystemStorage {
  return new LocalFileSystemStorage({
    rootDir: tmpRoot,
    secret: SECRET,
    publicBaseUrl: BASE,
    ...(now ? { now } : {}),
  });
}

// ============================================================
describe('storageKey 的构造与租户校验', () => {
  it('按 <organizationId>/<sha 前两位>/<fileAssetId> 构造', () => {
    const sha256 = 'ab'.padEnd(64, '0');
    expect(buildStorageKey({ organizationId: ORG_A, fileAssetId: ASSET, sha256 })).toBe(
      `${ORG_A}/ab/${ASSET}`,
    );
  });

  it('拒绝非 UUID 的租户 / 资产 id 与非法 sha256', () => {
    expect(() =>
      buildStorageKey({ organizationId: 'not-a-uuid', fileAssetId: ASSET, sha256: 'a'.repeat(64) }),
    ).toThrow(StorageAccessError);
    expect(() =>
      buildStorageKey({ organizationId: ORG_A, fileAssetId: '../../etc/passwd', sha256: 'a'.repeat(64) }),
    ).toThrow(StorageAccessError);
    expect(() =>
      buildStorageKey({ organizationId: ORG_A, fileAssetId: ASSET, sha256: 'short' }),
    ).toThrow(StorageAccessError);
  });

  it('key 必须属于该租户', () => {
    const key = `${ORG_A}/ab/${ASSET}`;
    expect(() => assertTenantScopedKey(key, ORG_A)).not.toThrow();
    expect(() => assertTenantScopedKey(key, ORG_B)).toThrow(StorageAccessError);
  });

  it('拒绝穿越与混淆写法', () => {
    const bad = [
      `${ORG_A}/../${ORG_B}/${ASSET}`,
      '/etc/passwd',
      `${ORG_A}//${ASSET}`,
      `${ORG_A}/%2e%2e/x`,
      `${ORG_A}/ab/${ASSET}\\..\\x`,
      `${ORG_A}/./${ASSET}`,
      '',
    ];
    for (const key of bad) {
      expect(() => assertTenantScopedKey(key, ORG_A), key).toThrow(StorageAccessError);
    }
  });
});

// ============================================================
describe('签名下载令牌', () => {
  const payload = {
    storageKey: `${ORG_A}/ab/${ASSET}`,
    fileAssetId: ASSET,
    organizationId: ORG_A,
    expiresAt: Date.now() + 60_000,
  };

  it('加密后只有持密钥者能还原载荷', () => {
    const token = sealToken(payload, SECRET);
    expect(openToken(token, SECRET).storageKey).toBe(payload.storageKey);
  });

  // CHANGE #22：令牌不能泄露 storageKey —— base64url 解码也看不到明文
  it('令牌是不透明的：解码任何一段都看不到 storageKey / 对象路径', () => {
    const token = sealToken(payload, SECRET);
    const decoded = token
      .split('.')
      .map((part) =>
        Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('latin1'),
      )
      .join('|');

    expect(decoded).not.toContain(payload.storageKey);
    expect(decoded).not.toContain(ORG_A);
    expect(decoded).not.toContain(ASSET);
    expect(decoded).not.toContain('storageKey');
    expect(decoded).not.toContain('fileAssetId');
  });

  it('篡改密文、换密钥、残缺令牌都会失败', () => {
    const token = sealToken(payload, SECRET);
    const [iv, ciphertext, tag] = token.split('.');
    const tamperedCipher = `${ciphertext.slice(0, -2)}${ciphertext.slice(-2) === 'AA' ? 'BB' : 'AA'}`;

    expect(() => openToken(`${iv}.${tamperedCipher}.${tag}`, SECRET)).toThrow(StorageAccessError);
    expect(() => openToken(`${iv}.${ciphertext}.${tag}`, `${SECRET}-other`)).toThrow(
      StorageAccessError,
    );
    expect(() => openToken('not-a-token', SECRET)).toThrow(StorageAccessError);
    expect(() => openToken(`${iv}.${ciphertext}`, SECRET)).toThrow(StorageAccessError);
  });

  it('载荷里的 fileAssetId 必须与 storageKey 一致', () => {
    const mismatched = sealToken({ ...payload, fileAssetId: OTHER_ASSET }, SECRET);
    expect(() => openToken(mismatched, SECRET)).toThrow(/不一致/);

    const missing = sealToken(
      { ...payload, fileAssetId: undefined as unknown as string },
      SECRET,
    );
    expect(() => openToken(missing, SECRET)).toThrow(StorageAccessError);
  });

  it('过期令牌被拒绝；TTL 有上限', () => {
    const expired = sealToken({ ...payload, expiresAt: Date.now() - 1 }, SECRET);
    expect(() => openToken(expired, SECRET)).toThrow(/过期/);

    const now = () => 1_700_000_000_000;
    const signed: ReturnType<typeof issueSignedUrl> = issueSignedUrl(
      { secret: SECRET, publicBaseUrl: BASE, now },
      { storageKey: payload.storageKey, organizationId: ORG_A, options: { ttlSeconds: 999_999 } },
    );
    expect((new Date(signed.expiresAt).getTime() - now()) / 1000).toBe(900);
  });

  it('文件名会被清洗，不会带出路径', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFilename('C:\\Users\\evil\\secret.pdf')).toBe('secret.pdf');
    expect(sanitizeFilename('a"b.pdf')).toBe('ab.pdf');
    expect(sanitizeFilename('发票 2026.pdf')).toBe('发票 2026.pdf');
  });
});

// ============================================================
describe('本地磁盘驱动', () => {
  it('写入后可回读，并返回 sha256 与元数据', async () => {
    const storage = localAdapter();
    const body = Buffer.from('承运商账单,2026-09\nUSD,12.34\n', 'utf8');

    const stored = await storage.put({
      organizationId: ORG_A,
      fileAssetId: ASSET,
      body,
      contentType: 'text/csv',
    });

    expect(stored.storageKey.startsWith(`${ORG_A}/`)).toBe(true);
    expect(stored.sha256).toBe(sha256Hex(body));
    expect(stored.size).toBe(body.byteLength);

    const got = await storage.get(stored.storageKey, ORG_A);
    expect(got.body.equals(body)).toBe(true);
    expect(got.metadata.contentType).toBe('text/csv');

    const head = await storage.head(stored.storageKey, ORG_A);
    expect(head?.size).toBe(body.byteLength);
  });

  it('跨租户读取被拒绝（即使 key 猜对）', async () => {
    const storage = localAdapter();
    const stored = await storage.put({
      organizationId: ORG_A,
      fileAssetId: OTHER_ASSET,
      body: Buffer.from('x'),
    });
    await expect(storage.get(stored.storageKey, ORG_B)).rejects.toThrow(StorageAccessError);
    await expect(storage.head(stored.storageKey, ORG_B)).rejects.toThrow(StorageAccessError);
  });

  it('内容与登记 sha256 不符时拒绝写入', async () => {
    const storage = localAdapter();
    await expect(
      storage.put({
        organizationId: ORG_A,
        fileAssetId: ASSET,
        body: Buffer.from('real'),
        expectedSha256: sha256Hex(Buffer.from('not-real')),
      }),
    ).rejects.toThrow(StorageIntegrityError);
  });

  it('读不存在的对象抛 NotFound；非法 key 抛 Access', async () => {
    const storage = localAdapter();
    await expect(storage.get(`${ORG_A}/aa/${OTHER_ASSET}`, ORG_A)).rejects.toThrow(StorageNotFoundError);
    await expect(storage.get('../../etc/passwd', ORG_A)).rejects.toThrow(StorageAccessError);
    expect(await storage.head(`${ORG_A}/aa/${OTHER_ASSET}`, ORG_A)).toBeNull();
  });

  it('签名 URL 可换回对象，过期后拒绝', async () => {
    let clock = 1_700_000_000_000;
    const storage = localAdapter(() => clock);
    const body = Buffer.from('证据材料');
    const stored = await storage.put({
      organizationId: ORG_A,
      fileAssetId: ASSET,
      body,
      contentType: 'text/plain',
    });

    const signed = await storage.createSignedUrl(stored.storageKey, ORG_A, {
      ttlSeconds: 60,
      filename: 'evidence.txt',
    });
    expect(signed.url.startsWith(`${BASE}/files/`)).toBe(true);

    const opened = await storage.openSignedUrl(signed.token);
    expect(opened.body.equals(body)).toBe(true);
    expect(opened.filename).toBe('evidence.txt');
    expect(opened.organizationId).toBe(ORG_A);
    expect(opened.fileAssetId).toBe(ASSET);

    clock += 61_000;
    await expect(storage.openSignedUrl(signed.token)).rejects.toThrow(/过期/);
  });
});

// ============================================================
describe('SigV4 签名（S3 驱动用）', () => {
  it('生成标准 Authorization 头；同输入稳定、内容变化则签名变化', () => {
    const url = new URL('http://localhost:8333/crossclaim/org/ab/asset');
    const credentials = { accessKeyId: 'AKIATEST', secretAccessKey: 'secret-key-for-test' };
    const date = new Date('2026-09-28T07:00:00.000Z');
    const base = {
      method: 'PUT',
      url,
      headers: { 'content-length': '3', 'content-type': 'text/plain' },
      region: 'us-east-1',
      credentials,
      date,
    };

    const first = signRequest({ ...base, payloadHash: sha256Hex(Buffer.from('abc')) });
    const again = signRequest({ ...base, payloadHash: sha256Hex(Buffer.from('abc')) });
    const different = signRequest({ ...base, payloadHash: sha256Hex(Buffer.from('abd')) });

    expect(first.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIATEST\/20260928\/us-east-1\/s3\/aws4_request/,
    );
    expect(first.authorization).toContain('SignedHeaders=');
    expect(first['x-amz-date']).toBe('20260928T070000Z');
    expect(first.authorization).toBe(again.authorization);
    expect(first.authorization).not.toBe(different.authorization);
  });
});

// ============================================================
describe('S3 兼容驱动（对本地假 S3 服务端验证真实请求）', () => {
  const received: Array<{ method: string; url: string; headers: http.IncomingHttpHeaders; body: Buffer }> = [];
  let s3Server: http.Server;
  let endpoint: string;

  beforeAll(async () => {
    s3Server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        received.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
        if (req.url?.includes('not-here')) {
          res.writeHead(404).end();
          return;
        }
        if (req.method === 'PUT') {
          res.writeHead(200).end();
          return;
        }
        if (req.method === 'HEAD') {
          res.writeHead(200, { 'content-length': '3', 'content-type': 'text/plain' }).end();
          return;
        }
        res.writeHead(200, { 'content-type': 'text/plain', 'content-length': '3' }).end(Buffer.from('abc'));
      });
    });
    await new Promise<void>((resolve) => s3Server.listen(0, '127.0.0.1', resolve));
    const address = s3Server.address();
    endpoint = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => s3Server.close(() => resolve()));
  });

  function s3Adapter(): S3CompatibleStorage {
    return new S3CompatibleStorage({
      endpoint,
      bucket: 'crossclaim',
      region: 'us-east-1',
      credentials: async () => ({ accessKeyId: 'AKIATEST', secretAccessKey: 'secret-key-for-test' }),
      secret: SECRET,
      publicBaseUrl: BASE,
    });
  }

  it('PUT / GET / HEAD 都带 SigV4 签名，且使用 path-style 桶地址', async () => {
    const storage = s3Adapter();
    const stored = await storage.put({
      organizationId: ORG_A,
      fileAssetId: ASSET,
      body: Buffer.from('abc'),
      contentType: 'text/plain',
    });
    expect(stored.storageKey).toBe(`${ORG_A}/${sha256Hex(Buffer.from('abc')).slice(0, 2)}/${ASSET}`);

    const got = await storage.get(stored.storageKey, ORG_A);
    expect(got.body.toString('utf8')).toBe('abc');

    const head = await storage.head(stored.storageKey, ORG_A);
    expect(head?.contentType).toBe('text/plain');

    const putRequest = received.find((r) => r.method === 'PUT');
    expect(putRequest?.url).toBe(`/crossclaim/${stored.storageKey}`);
    expect(putRequest?.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIATEST\//);
    expect(putRequest?.headers['x-amz-content-sha256']).toBe(sha256Hex(Buffer.from('abc')));
    expect(putRequest?.body.toString('utf8')).toBe('abc');

    const getRequest = received.find((r) => r.method === 'GET');
    expect(getRequest?.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 /);
  });

  it('跨租户 key 在发请求前就被拒绝', async () => {
    const storage = s3Adapter();
    await expect(storage.get(`${ORG_B}/aa/${ASSET}`, ORG_A)).rejects.toThrow(StorageAccessError);
  });

  it('404 映射为 StorageNotFoundError', async () => {
    const storage = s3Adapter();
    await expect(storage.get(`${ORG_A}/aa/${ASSET}-not-here`, ORG_A)).rejects.toThrow(
      StorageNotFoundError,
    );
  });
});

// ============================================================
describe('HTTP 下载路由（签名 URL 端到端）', () => {
  let appServer: http.Server;
  let base: string;
  let storage: LocalFileSystemStorage;

  beforeAll(async () => {
    storage = localAdapter();
    appServer = createServer({
      prisma: {} as never,
      log: createLogger({ level: 'error', sink: () => undefined }),
      storage,
      // CHANGE #21：下载需要审计；测试注入一个记录用的桩
      audit: { record: async () => ({ id: 'audit-stub', createdAt: new Date() }) },
    });
    await new Promise<void>((resolve) => appServer.listen(0, '127.0.0.1', resolve));
    const address = appServer.address();
    base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => appServer.close(() => resolve()));
  });

  it('有效令牌可下载原始字节；篡改令牌返回 403', async () => {
    const body = Buffer.from('合规证据 PDF 占位字节', 'utf8');
    const stored = await storage.put({
      organizationId: ORG_A,
      fileAssetId: ASSET,
      body,
      contentType: 'application/pdf',
    });
    const signed = await storage.createSignedUrl(stored.storageKey, ORG_A, {
      ttlSeconds: 60,
      disposition: 'attachment',
      filename: 'evidence.pdf',
    });

    const ok = await fetch(signed.url.replace(BASE, base));
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toBe('application/pdf');
    expect(ok.headers.get('content-disposition')).toContain('evidence.pdf');
    expect(Buffer.from(await ok.arrayBuffer()).equals(body)).toBe(true);

    const [payloadPart] = signed.token.split('.');
    const denied = await fetch(`${base}/files/${payloadPart}.AAAA`);
    expect(denied.status).toBe(403);
  });

  it('裸 storageKey 不能当下载地址', async () => {
    const response = await fetch(`${base}/files/${ORG_A}/aa/${ASSET}`);
    expect(response.status).toBe(403);
  });

  // CHANGE #19：畸形百分号编码不得抛异常击穿 handler
  it('畸形令牌路径返回 400/403，不抛异常', async () => {
    for (const suffix of ['%', '%ZZ', '%E0%A4%A']) {
      const response = await fetch(`${base}/files/${suffix}`);
      expect([400, 403], suffix).toContain(response.status);
    }
  });

  // CHANGE #20：中文文件名走 RFC 5987；CR/LF 被剥离
  it('中文文件名使用 filename*=UTF-8，且 CRLF 注入被剥离', async () => {
    const body = Buffer.from('发票内容', 'utf8');
    const stored = await storage.put({
      organizationId: ORG_A,
      fileAssetId: OTHER_ASSET,
      body,
      contentType: 'application/pdf',
    });

    const cn = await storage.createSignedUrl(stored.storageKey, ORG_A, {
      ttlSeconds: 60,
      filename: '发票 2026.pdf',
    });
    const cnResponse = await fetch(cn.url.replace(BASE, base));
    expect(cnResponse.status).toBe(200);
    const disposition = cnResponse.headers.get('content-disposition') ?? '';
    expect(disposition).toContain("filename*=UTF-8''");
    expect(disposition).toContain('%E5%8F%91%E7%A5%A8'); // "发票"
    expect(disposition).toContain('filename="');

    const evil = await storage.createSignedUrl(stored.storageKey, ORG_A, {
      ttlSeconds: 60,
      filename: 'evil\r\nX-Injected: 1',
    });
    const evilResponse = await fetch(evil.url.replace(BASE, base));
    expect(evilResponse.status).toBe(200);
    const evilDisposition = evilResponse.headers.get('content-disposition') ?? '';
    expect(evilDisposition).not.toMatch(/[\r\n]/);
    // 关键：注入文本不会变成新的响应头
    expect(evilResponse.headers.get('x-injected')).toBeNull();
  });
});
