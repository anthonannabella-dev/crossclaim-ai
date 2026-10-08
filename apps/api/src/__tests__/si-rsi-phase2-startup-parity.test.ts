/**
 * PHASE 2 / P2-CHANGE1 —— 生产启动入口一致性（P0，静态契约 + 构建产物核对）
 * ---------------------------------------------------------------
 * 复审要求证明：systemd → rsi-run → Prisma → Recovery pack → ONE SI Runtime。
 * 验收条款：
 *   ① 实际部署入口包含 PRODUCT_RECOVERY_SI；
 *   ② 不得存在另一条遗漏 Recovery pack 的正式启动路径；
 *   ③ API / Web / RSI 分工明确；
 *   ④ 不创建第二套 scheduler / controller；
 *   ⑤ 使用与生产一致的构建产物进行验证。
 *
 * 边界：本机无 systemd/Linux ⇒ 只做「unit ↔ 构建产物」一致性核对；
 *      Linux 实机验证一律记 NOT VERIFIED，不在此声称 PASS。
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const repoFile = (relative: string): string => readFileSync(path.join('..', '..', relative), 'utf8');
const repoHas = (relative: string): boolean => existsSync(path.join('..', '..', relative));

const RSI_UNIT = repoFile('deploy/systemd/crossclaim-rsi.service');
const API_UNIT = repoFile('deploy/systemd/crossclaim-api.service');
const WEB_UNIT = repoFile('deploy/systemd/crossclaim-web.service');
const RSI_RUN_SRC = repoFile('apps/api/src/runtime/rsi-run.ts');
const INSTALLERS = ['deploy/install-rsi-service.sh', 'deploy/install-services.sh'].map(repoFile);

/** systemd ExecStart 中真正被执行的 JS 产物（相对仓库根；忽略启动参数） */
const execTarget = (unit: string): string => {
  const line = unit.split('\n').find((l) => l.startsWith('ExecStart='));
  if (line === undefined) throw new Error('EXECSTART_MISSING');
  const target = line.replace('ExecStart=/usr/bin/node ', '').trim().split(/\s+/)[0]!;
  return target.replace('/opt/crossclaim/', '');
};

describe('PHASE 2 / CHANGE 1 · 生产启动入口一致性', () => {
  it('C1-① RSI unit 的 ExecStart 指向的构建产物确实携带 PRODUCT_RECOVERY_SI 装配', () => {
    const target = execTarget(RSI_UNIT);
    expect(target).toBe('apps/api/dist/src/runtime/rsi-run.js');
    // ⑤ 与生产一致的构建产物：必须已构建，且产物内容含装配与日志标记
    expect(repoHas(target), `缺少构建产物 ${target}（需先 npm run build）`).toBe(true);
    const artifact = repoFile(target);
    expect(artifact).toContain('createProductionRecoveryPackDeps');
    expect(artifact).toContain('RSI_RECOVERY_PACK=');
    expect(artifact).toContain('PRODUCT_RECOVERY_SI');
    // 源码与产物一致（同一装配点）
    expect(RSI_RUN_SRC).toContain('createProductionRecoveryPackDeps');
    expect(RSI_RUN_SRC).toContain('productRecoveryPack: productionRecoveryPack');
  });

  it('C1-② 只有 RSI unit 引用 rsi-run：不存在另一条遗漏 Recovery pack 的正式启动路径', () => {
    const units = [RSI_UNIT, API_UNIT, WEB_UNIT];
    const referencing = units.filter((u) => u.includes('rsi-run.js'));
    expect(referencing).toHaveLength(1);
    expect(referencing[0]).toBe(RSI_UNIT);
    // 安装脚本不得另起一套 rsi-run / 自建 runtime
    for (const installer of INSTALLERS) {
      expect(installer).not.toContain('rsi-run.js');
      expect(installer).not.toContain('node dist/src/runtime/rsi-run');
    }
  });

  it('C1-③ API / Web / RSI 分工明确（各自入口不同、互不代管）', () => {
    expect(execTarget(API_UNIT)).toBe('apps/api/dist/src/server.js');
    expect(execTarget(WEB_UNIT)).toBe('apps/web/node_modules/next/dist/bin/next');
    expect(execTarget(RSI_UNIT)).toBe('apps/api/dist/src/runtime/rsi-run.js');
    expect(new Set([execTarget(API_UNIT), execTarget(WEB_UNIT), execTarget(RSI_UNIT)]).size).toBe(3);
  });

  it('C1-④ 不创建第二套 scheduler / controller（unit 无模板实例，源码边界为 0）', () => {
    for (const unit of [RSI_UNIT, API_UNIT, WEB_UNIT]) {
      expect(unit).not.toMatch(/^ExecStart=.*@/m);
      expect(unit).not.toContain('systemctl start crossclaim');
    }
    const source = readFileSync(path.join('..', '..', 'apps/api/src/runtime/rsi-run.ts'), 'utf8');
    expect(source).toContain('secondRuntime: 0');
  });

  it('C1-⑤ unit 中不含明文凭据，且 DATABASE_URL 由 EnvironmentFile 注入（生产同构）', () => {
    for (const unit of [RSI_UNIT, API_UNIT, WEB_UNIT]) {
      expect(unit).not.toMatch(/DATABASE_URL\s*=\s*postgres/i);
      expect(unit).toContain('EnvironmentFile=/etc/crossclaim/');
    }
  });
});
