/**
 * C-0007 Phase 2 — upload content scan (zero dependency, byte-level).
 * Negative cases are the acceptance criteria the architecture review listed.
 */

import { describe, expect, it } from 'vitest';

import { scanUploadContent } from '../services/acquisition';

const CSV = Buffer.from(
  ['Invoice No,Reference Type,Invoice Date,Net Charge,Currency', 'INV-1,INVOICE,2026-09-01,100.0000,USD'].join('\n'),
  'utf8',
);

const scan = (body: Buffer, overrides: Partial<Parameters<typeof scanUploadContent>[0]> = {}) =>
  scanUploadContent({
    body,
    fileName: 'invoices.csv',
    declaredMime: 'text/csv',
    kind: 'CSV',
    ...overrides,
  });

describe('C-0007 Phase 2 — content scan', () => {
  it('passes a real CSV and reports sha256/size/detected mime', () => {
    const result = scan(CSV);
    expect(result.status).toBe('PASSED');
    expect(result.reason).toBeNull();
    expect(result.detectedMime).toBe('text/csv');
    expect(result.sizeBytes).toBe(CSV.length);
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects an empty file', () => {
    const result = scan(Buffer.alloc(0));
    expect(result.status).toBe('REJECTED');
    expect(result.reason).toBe('EMPTY_FILE');
  });

  it('rejects an oversized file', () => {
    const result = scan(Buffer.from('a,b\n1,2\n'.repeat(10), 'utf8'), { maxBytes: 10 });
    expect(result.status).toBe('REJECTED');
    expect(result.reason).toBe('TOO_LARGE');
  });

  it('rejects a spoofed MIME type (text/csv + PE header)', () => {
    const spoofed = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(64, 0x41)]);
    const result = scan(spoofed, { declaredMime: 'text/csv' });
    expect(result.status).toBe('REJECTED');
    expect(result.reason).toBe('EXECUTABLE_DETECTED');
    expect(result.detectedMime).toBe('application/x-dosexec');
  });

  it('rejects an extension spoof (evil.exe renamed to .csv)', () => {
    const elf = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(32, 0x01)]);
    const result = scan(elf, { fileName: 'evil.csv' });
    expect(result.status).toBe('REJECTED');
    expect(result.reason).toBe('EXECUTABLE_DETECTED');
  });

  it('rejects executable disguises (ELF / shebang) and archives/binaries', () => {
    expect(scan(Buffer.from('#!/bin/sh\nrm -rf /\n', 'utf8'), { fileName: 'script.csv' }).reason).toBe(
      'EXECUTABLE_DETECTED',
    );
    expect(
      scan(Buffer.concat([Buffer.from('PK\u0003\u0004'), Buffer.alloc(16)]), { fileName: 'book.csv' }).reason,
    ).toBe('ARCHIVE_DETECTED');
    expect(scan(Buffer.from('W29iamVjdA==', 'utf8'), { fileName: 'data.csv' }).status).toBe('PASSED');
    expect(scan(Buffer.concat([Buffer.from('a,b\n'), Buffer.from([0x00]), Buffer.from('1,2\n')])).reason).toBe(
      'BINARY_CONTENT',
    );
  });

  it('rejects a declared MIME that is not CSV-ish and an unsupported kind', () => {
    expect(scan(CSV, { declaredMime: 'application/octet-stream' }).reason).toBe('DECLARED_MIME_MISMATCH');
    expect(scan(CSV, { kind: 'PDF', fileName: 'x.pdf' }).reason).toBe('UNSUPPORTED_KIND');
    expect(scan(CSV, { fileName: 'x.xlsx' }).reason).toBe('EXTENSION_MISMATCH');
  });

  it('is deterministic: the same bytes always produce the same sha256', () => {
    expect(scan(CSV).sha256).toBe(scan(Buffer.from(CSV)).sha256);
  });
});
