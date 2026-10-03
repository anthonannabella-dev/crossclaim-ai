/**
 * C-0008-A — session-guarded internal upload endpoint.
 * ---------------------------------------------------------------
 *   POST /uploads  (raw body + x-file-name header, session cookie required)
 *     → byte-level content scan (fail closed)
 *     → Storage Adapter → FileAsset → ImportBatch → SourceTransaction → CanonicalFact
 *
 * No multipart dependency: the browser sends the File as the raw request body.
 * The connection used is the organization's FILE_UPLOAD connection; if the
 * organization has none yet, one is created through the lifecycle service
 * (audited), which keeps onboarding usable until C-0008-B adds connection
 * management.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

import type { PrismaClient } from '@prisma/client';

import type { AuditWriter } from '../audit';
import {
  AcquisitionError,
  createConnection,
  uploadWithScan,
  type ConnectionLifecyclePort,
  type FileAssetPort,
  type SourceConnectionPort,
  type FileAssetLookupPort,
} from '../acquisition';
import type { ImportRepository } from '../ingest';
import type { StorageAdapter } from '../storage';
import { parseCookies, readSessionToken } from './http-routes';
import { resolveSession, type SessionDeps } from './session';

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export interface UploadRouteDeps {
  prisma: PrismaClient;
  session: SessionDeps;
  connectionLifecycle: ConnectionLifecyclePort;
  connections: SourceConnectionPort;
  fileAssets: FileAssetPort;
  fileAssetLookup: FileAssetLookupPort;
  storage: StorageAdapter;
  imports: ImportRepository;
  audit: AuditWriter;
  maxBytes?: number;
}

function sendJson(res: ServerResponse, code: number, payload: unknown): void {
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

async function readRawBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) throw new AcquisitionError('FILE_TOO_LARGE', '上传内容超过大小上限');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function resolveFileUploadConnection(
  deps: UploadRouteDeps,
  organizationId: string,
): Promise<{ id: string }> {
  const existing = await deps.prisma.sourceConnection.findFirst({
    where: { organizationId, kind: 'FILE_UPLOAD' },
    select: { id: true, status: true },
    orderBy: { createdAt: 'asc' },
  });
  if (existing) return { id: existing.id };

  const created = await createConnection(
    {
      organizationId,
      domain: 'LOGISTICS',
      channel: 'OTHER',
      kind: 'FILE_UPLOAD',
      label: '默认上传连接',
    },
    { connections: deps.connectionLifecycle, audit: deps.audit },
  );
  return { id: created.id };
}

export async function handleUploadRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: UploadRouteDeps,
): Promise<boolean> {
  const path = (req.url ?? '/').split('?')[0];
  if (path !== '/uploads') return false;
  if ((req.method ?? 'GET') !== 'POST') {
    sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' });
    return true;
  }

  const token = readSessionToken(parseCookies(req.headers.cookie));
  const context = token ? await resolveSession(token, deps.session) : null;
  if (!context) {
    sendJson(res, 401, { error: 'UNAUTHENTICATED' });
    return true;
  }

  const fileName = typeof req.headers['x-file-name'] === 'string' ? req.headers['x-file-name'] : '';
  if (!fileName) {
    sendJson(res, 400, { error: 'MISSING_FILE_NAME' });
    return true;
  }
  const declaredMime = typeof req.headers['content-type'] === 'string' ? req.headers['content-type'] : null;

  const maxBytes = deps.maxBytes ?? MAX_UPLOAD_BYTES;
  let body: Buffer;
  try {
    body = await readRawBody(req, maxBytes);
  } catch (error) {
    sendJson(res, 413, {
      error: error instanceof AcquisitionError ? error.code : 'FILE_TOO_LARGE',
      message: error instanceof Error ? error.message : '上传失败',
    });
    return true;
  }

  try {
    const connection = await resolveFileUploadConnection(deps, context.organizationId);
    const result = await uploadWithScan(
      {
        organizationId: context.organizationId,
        connectionId: connection.id,
        domain: 'LOGISTICS',
        channel: 'OTHER',
        kind: 'CSV',
        originalName: fileName,
        declaredMime,
        body,
      },
      {
        connections: deps.connections,
        fileAssets: deps.fileAssets,
        fileAssetLookup: deps.fileAssetLookup,
        storage: deps.storage,
        imports: deps.imports,
        audit: deps.audit,
        maxBytes,
      },
    );

    sendJson(res, result.status === 'DUPLICATE' ? 200 : 201, {
      status: result.status,
      fileAssetId: result.fileAssetId,
      scan: {
        status: result.scan.status,
        detectedMime: result.scan.detectedMime,
        sha256: result.scan.sha256,
        sizeBytes: result.scan.sizeBytes,
      },
      import: result.import
        ? {
            batchId: result.import.batchId,
            status: result.import.status,
            rowsTotal: result.import.rowsTotal,
            rowsOk: result.import.rowsOk,
            rowsFailed: result.import.rowsFailed,
            duplicates: result.import.duplicates,
          }
        : null,
    });
    return true;
  } catch (error) {
    const code = error instanceof AcquisitionError ? error.code : 'UPLOAD_FAILED';
    sendJson(res, 422, { error: code, message: error instanceof Error ? error.message : '上传被拒绝' });
    return true;
  }
}
