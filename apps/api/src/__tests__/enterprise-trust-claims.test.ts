/**
 * CHANGE A（MSG-20261003-129）— Enterprise Trust 禁自证 guard 回归。
 *  · 仓库扫描：所有出现必须处于否定/未取得局部语境；
 *  · 反例（必须 FAIL）：同文件别处有 NOT_AVAILABLE，但某处是肯定式 SOC2_COMPLIANT；
 *  · 正例（必须 PASS）：SOC2_COMPLIANT is NOT_AVAILABLE / 未取得，不得对外宣称。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { findSelfAssertedClaims } from '../services/compliance/trust-claim-guard';

const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
/**
 * 非“对外声明”来源（定义机制 / 裁决归档），不作为自证扫描对象：
 *  · guard 模块自身与其测试；
 *  · 架构方裁决归档（引用他的原话，不是我们的对外表述）。
 */
const NON_CLAIM_SOURCES = [
  'enterprise-trust-claims.test.ts',
  join('services', 'compliance', 'trust-claim-guard.ts'),
  'AI-ARCHITECT-INBOX.md',
];

function collectFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', 'dist', '.next', 'coverage'].includes(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collectFiles(full, acc);
    else if (/\.(md|ts|tsx|json)$/.test(entry.name)) acc.push(full);
  }
  return acc;
}

describe('CHANGE A — trust claim guard (occurrence/local-context)', () => {
  it('反例必须 FAIL：同文件别处出现 NOT_AVAILABLE 不能豁免肯定式 SOC2_COMPLIANT', () => {
    const text = [
      'Our platform is SOC2_COMPLIANT and bank grade.',
      '',
      'SOC 2 status = NOT_AVAILABLE',
    ].join('\n');
    const hits = findSelfAssertedClaims(text);
    expect(hits.map((hit) => hit.claim)).toContain('SOC2_COMPLIANT');
  });

  it('正例必须 PASS：未取得 / 不得对外宣称 / NOT_AVAILABLE 同句', () => {
    const text = 'SOC2_COMPLIANT is NOT_AVAILABLE / 未取得，不得对外宣称；ISO27001_CERTIFIED 亦未取得，不得宣称。';
    expect(findSelfAssertedClaims(text)).toEqual([]);
  });

  it('CHANGE A2 双向反例：同行串扰不得豁免', () => {
    const first = 'SOC2_COMPLIANT；ISO27001_CERTIFIED is NOT_AVAILABLE';
    const firstHits = findSelfAssertedClaims(first).map((hit) => hit.claim);
    expect(firstHits).toContain('SOC2_COMPLIANT');
    expect(firstHits).not.toContain('ISO27001_CERTIFIED');

    const second = 'SOC2_COMPLIANT is NOT_AVAILABLE；ISO27001_CERTIFIED';
    const secondHits = findSelfAssertedClaims(second).map((hit) => hit.claim);
    expect(secondHits).not.toContain('SOC2_COMPLIANT');
    expect(secondHits).toContain('ISO27001_CERTIFIED');
  });

  it('局部语境边界：跨行否定不豁免，同行否定才豁免', () => {
    const crossLine = 'SOC2_COMPLIANT\n未取得';
    expect(findSelfAssertedClaims(crossLine).length).toBe(1);
    const sameLine = 'SOC2_COMPLIANT 未取得';
    expect(findSelfAssertedClaims(sameLine).length).toBe(0);
  });

  it('仓库扫描：不得存在肯定式自证（清单文件/本测试自身除外）', () => {
    const files = collectFiles(REPO_ROOT).filter((file) => !NON_CLAIM_SOURCES.some((source) => file.endsWith(source)));
    const offenders: string[] = [];
    for (const file of files) {
      let text = '';
      try {
        text = readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      for (const hit of findSelfAssertedClaims(text)) {
        offenders.push(file.replace(REPO_ROOT, '') + ' :: ' + hit.claim + ' :: ' + hit.excerpt);
      }
    }
    expect(offenders, '肯定式自证合规表述：' + offenders.join(' | ')).toEqual([]);
  });

  it('清单文件存在且状态词汇严格限定在四种', () => {
    const path = join(REPO_ROOT, 'docs', 'releases', 'ENTERPRISE-TRUST-READINESS.md');
    expect(statSync(path).isFile()).toBe(true);
    const text = readFileSync(path, 'utf8');
    for (const status of ['IMPLEMENTED', 'VERIFIED', 'EXTERNAL_AUDITED', 'NOT_AVAILABLE']) {
      expect(text).toContain(status);
    }
    expect(text).toContain('SECURITY_CONTROLS_IMPLEMENTED');
    expect(findSelfAssertedClaims(text)).toEqual([]);
  });
});
