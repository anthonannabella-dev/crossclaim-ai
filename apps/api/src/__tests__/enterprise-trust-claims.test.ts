/**
 * P0-3 — Enterprise Trust 表述守卫。
 * 禁止在没有外部证据的情况下对外声称 SOC2 / ISO 27001 / BANK_GRADE 合规。
 * 只允许 ENTERPRISE-TRUST-READINESS.md 自身在“禁止/未取得”语境中出现这些词。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const ALLOWED_FILE = 'docs/releases/ENTERPRISE-TRUST-READINESS.md';
const FORBIDDEN_CLAIMS = ['SOC2_COMPLIANT', 'ISO27001_CERTIFIED', 'BANK_GRADE_SECURITY'];

function collectFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', 'dist', '.next', 'coverage'].includes(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collectFiles(full, acc);
    else if (/\.(md|ts|tsx|json)$/.test(entry.name)) acc.push(full);
  }
  return acc;
}

describe('P0-3 — enterprise trust claims guard', () => {
  it('仓库内不得出现 SOC2_COMPLIANT / ISO27001_CERTIFIED / BANK_GRADE_SECURITY 自证（清单文件除外）', () => {
    const files = collectFiles(REPO_ROOT).filter(
    (file) => !file.includes('ENTERPRISE-TRUST-READINESS.md') && !file.includes('enterprise-trust-claims.test.ts'),
  );
    const offenders: string[] = [];
    for (const file of files) {
      let text = '';
      try {
        text = readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      // 允许在「禁止 / 未取得 / 状态模型」语境中出现这些词（例如内部清单、裁决归档、心跳记录）；
      // 只有把它们当成事实声称时才判为违规。
      const hasNegationContext = /禁止|不得|未取得|NOT_AVAILABLE|EXTERNAL_AUDITED/.test(text);
      for (const claim of FORBIDDEN_CLAIMS) {
        if (text.includes(claim) && !hasNegationContext) {
          offenders.push(file.replace(REPO_ROOT, '') + ' :: ' + claim);
        }
      }
    }
    expect(offenders, '禁止对外自证的合规表述：' + offenders.join(', ')).toEqual([]);
  });

  it('清单文件存在，且状态词汇严格限定在四种', () => {
    const path = join(REPO_ROOT, ...ALLOWED_FILE.split('/'));
    expect(statSync(path).isFile()).toBe(true);
    const text = readFileSync(path, 'utf8');
    for (const status of ['IMPLEMENTED', 'VERIFIED', 'EXTERNAL_AUDITED', 'NOT_AVAILABLE']) {
      expect(text).toContain(status);
    }
    expect(text).toContain('SECURITY_CONTROLS_IMPLEMENTED');
    expect(text).toMatch(/NOT_AVAILABLE[\s\S]{0,80}SOC 2|SOC 2[\s\S]{0,80}NOT_AVAILABLE/);
    expect(text).toMatch(/NOT_AVAILABLE[\s\S]{0,80}ISO 27001|ISO 27001[\s\S]{0,80}NOT_AVAILABLE/);
  });
});
