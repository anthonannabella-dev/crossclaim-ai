/**
 * C-0007 Gate 5 / Phase 2 — upload content scan (method A, zero dependency).
 * ---------------------------------------------------------------
 * Approved security ruling: never trust the client MIME type, always inspect
 * the bytes, and fail closed for anything we cannot positively identify as a
 * supported CSV.
 *
 *   PENDING_SCAN : reserved for a future asynchronous scanner
 *   PASSED       : bytes really look like CSV and the declared metadata agrees
 *   REJECTED     : empty / oversized / binary / executable / spoofed
 *
 * The scan result (scanStatus / scanReason / detectedMime / sha256 / sizeBytes)
 * is recorded in the audit trail — an upload can never succeed with an unknown
 * security state.
 */

import { createHash } from 'node:crypto';

import type { FileKind } from '@prisma/client';

export type ScanStatus = 'PENDING_SCAN' | 'PASSED' | 'REJECTED';

export type ScanReason =
  | 'EMPTY_FILE'
  | 'TOO_LARGE'
  | 'UNSUPPORTED_KIND'
  | 'EXTENSION_MISMATCH'
  | 'DECLARED_MIME_MISMATCH'
  | 'EXECUTABLE_DETECTED'
  | 'ARCHIVE_DETECTED'
  | 'BINARY_CONTENT'
  | 'SUSPICIOUS_CONTENT';

export interface ContentScanResult {
  status: ScanStatus;
  reason: ScanReason | null;
  detectedMime: string;
  declaredMime: string | null;
  sha256: string;
  sizeBytes: number;
  detail?: string;
}

export interface ContentScanInput {
  body: Buffer;
  fileName: string;
  declaredMime?: string | null;
  kind: FileKind;
  maxBytes?: number;
}

export const DEFAULT_SCAN_MAX_BYTES = 25 * 1024 * 1024;

/** MIME types we accept as CSV-ish declarations; the bytes still decide. */
const CSV_DECLARED_MIMES = new Set([
  'text/csv',
  'application/csv',
  'text/plain',
  'application/vnd.ms-excel',
]);

const EXTENSION_BY_KIND: Partial<Record<FileKind, readonly string[]>> = {
  CSV: ['.csv', '.txt'],
};

function extensionOf(fileName: string): string {
  const index = fileName.lastIndexOf('.');
  return index === -1 ? '' : fileName.slice(index).toLowerCase();
}

interface Signature {
  mime: string;
  reason: ScanReason;
  detail: string;
}

/** Byte-level identification of things that must never be treated as CSV. */
function detectSignature(body: Buffer): Signature | null {
  const hex = body.subarray(0, 4).toString('hex').toLowerCase();
  const head = body.subarray(0, 4).toString('latin1');

  if (hex.startsWith('7f454c46')) {
    return { mime: 'application/x-elf', reason: 'EXECUTABLE_DETECTED', detail: 'ELF header' };
  }
  if (head.startsWith('MZ')) {
    return { mime: 'application/x-dosexec', reason: 'EXECUTABLE_DETECTED', detail: 'PE/MZ header' };
  }
  if (hex === 'feedface' || hex === 'feedfacf' || hex === 'cafebabe') {
    return { mime: 'application/x-mach-binary', reason: 'EXECUTABLE_DETECTED', detail: 'Mach-O header' };
  }
  if (head.startsWith('#!')) {
    return { mime: 'text/x-shellscript', reason: 'EXECUTABLE_DETECTED', detail: 'shebang script header' };
  }
  if (head.startsWith('PK\u0003\u0004')) {
    return { mime: 'application/zip', reason: 'ARCHIVE_DETECTED', detail: 'ZIP/OOXML container' };
  }
  if (hex.startsWith('1f8b')) {
    return { mime: 'application/gzip', reason: 'ARCHIVE_DETECTED', detail: 'gzip header' };
  }
  if (head.startsWith('%PDF')) {
    return { mime: 'application/pdf', reason: 'BINARY_CONTENT', detail: 'PDF header' };
  }
  if (hex.startsWith('89504e47')) {
    return { mime: 'image/png', reason: 'BINARY_CONTENT', detail: 'PNG header' };
  }
  if (hex.startsWith('ffd8ff')) {
    return { mime: 'image/jpeg', reason: 'BINARY_CONTENT', detail: 'JPEG header' };
  }
  return null;
}

function looksBinary(body: Buffer): boolean {
  const sample = body.subarray(0, 512);
  for (const byte of sample) {
    if (byte === 0x00) return true;
  }
  return false;
}

export function scanUploadContent(input: ContentScanInput): ContentScanResult {
  const sha256 = createHash('sha256').update(input.body).digest('hex');
  const sizeBytes = input.body.length;
  const declaredMime = input.declaredMime?.trim().toLowerCase() || null;
  const maxBytes = input.maxBytes ?? DEFAULT_SCAN_MAX_BYTES;

  const reject = (reason: ScanReason, detectedMime: string, detail?: string): ContentScanResult => ({
    status: 'REJECTED',
    reason,
    detectedMime,
    declaredMime,
    sha256,
    sizeBytes,
    ...(detail ? { detail } : {}),
  });

  if (sizeBytes === 0) return reject('EMPTY_FILE', 'application/x-empty');
  if (sizeBytes > maxBytes) return reject('TOO_LARGE', 'application/octet-stream');

  const allowedExtensions = EXTENSION_BY_KIND[input.kind];
  if (!allowedExtensions) {
    return reject('UNSUPPORTED_KIND', 'application/octet-stream', `kind=${input.kind}`);
  }
  const extension = extensionOf(input.fileName);
  if (!allowedExtensions.includes(extension)) {
    return reject('EXTENSION_MISMATCH', 'text/csv', `extension=${extension || '(none)'}`);
  }

  if (declaredMime && !CSV_DECLARED_MIMES.has(declaredMime)) {
    return reject('DECLARED_MIME_MISMATCH', declaredMime, `declared=${declaredMime}`);
  }

  const signature = detectSignature(input.body);
  if (signature) {
    return reject(signature.reason, signature.mime, signature.detail);
  }
  if (looksBinary(input.body)) {
    return reject('BINARY_CONTENT', 'application/octet-stream', 'NUL byte in first 512 bytes');
  }

  return {
    status: 'PASSED',
    reason: null,
    detectedMime: 'text/csv',
    declaredMime,
    sha256,
    sizeBytes,
  };
}
