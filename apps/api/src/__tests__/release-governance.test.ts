/**
 * 部署来源统一与防混乱治理 —— 静态契约测试
 * ---------------------------------------------------------------
 * 依据：HOST 指令「部署来源统一与防混乱治理」第 2–6、8 条。
 * 只读源码/文档/清单与 unit 文件；不执行部署、不连接服务器。
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const repoFile = (relative: string): string => readFileSync(path.join('..', '..', relative), 'utf8');
const repoHas = (relative: string): boolean => existsSync(path.join('..', '..', relative));

const DEPLOYMENT = repoFile('DEPLOYMENT.md');
const MANIFEST_RAW = repoFile('deploy/release-manifest.json');
const MANIFEST = JSON.parse(MANIFEST_RAW) as Record<string, unknown>;
const VERIFIER = repoFile('deploy/verify-release.mjs');
const ARCHIVE_INDEX = repoFile('docs/archive/DEPLOYMENT-HISTORY.md');

const UNITS = [
  repoFile('deploy/systemd/crossclaim-api.service'),
  repoFile('deploy/systemd/crossclaim-web.service'),
  repoFile('deploy/systemd/crossclaim-rsi.service'),
];

describe('部署来源统一 · 唯一入口文档', () => {
  it('01 DEPLOYMENT.md 声明自己是唯一正式部署入口', () => {
    expect(DEPLOYMENT).toContain('唯一正式部署入口');
    expect(DEPLOYMENT).toContain('deploy/release-manifest.json');
    expect(DEPLOYMENT).toContain('deploy/verify-release.mjs');
  });

  it('02 文档覆盖 HOST 要求的九个方面', () => {
    for (const section of [
      '权威来源与版本锁定',
      '前置条件',
      '环境变量',
      '数据库迁移',
      '构建',
      '服务安装与启动',
      '健康检查',
      '回滚',
      '部署前强制门禁',
    ]) {
      expect(DEPLOYMENT, section).toContain(section);
    }
  });

  it('03 明确禁止自行选择 main / 旧 release / 开发分支，并以 SHA 为唯一权威', () => {
    expect(DEPLOYMENT).toContain('main');
    expect(DEPLOYMENT).toContain('唯一权威');
    expect(MANIFEST.forbiddenDeploymentBranches).toEqual(
      expect.arrayContaining(['main', 'release/integration-20261008', 'gate/*', 'feat/*', 'fix/*']),
    );
  });

  it('04 三个 systemd unit 的 Documentation 一律指向唯一入口 DEPLOYMENT.md', () => {
    for (const unit of UNITS) {
      expect(unit).toContain('Documentation=file:/opt/crossclaim/DEPLOYMENT.md');
      expect(unit).not.toContain('RSI-DEPLOYMENT.md');
    }
  });
});

describe('部署来源统一 · 机器可读清单', () => {
  it('05 必需字段齐全', () => {
    for (const key of [
      'manifestVersion',
      'releaseId',
      'releaseCommit',
      'releaseBranch',
      'deploymentEntryDoc',
      'forbiddenDeploymentBranches',
      'sealingCommitPolicy',
      'services',
      'requiredEnvVarNames',
      'commands',
      'healthChecks',
      'rollback',
      'gates',
      'boundaries',
      'secretPolicy',
    ]) {
      expect(Object.keys(MANIFEST), key).toContain(key);
    }
  });

  it('06 releaseCommit 已锁定为完整 SHA（不是占位符）', () => {
    expect(typeof MANIFEST.releaseCommit).toBe('string');
    expect(MANIFEST.releaseCommit as string).toMatch(/^[0-9a-f]{40}$/);
  });

  it('07 三个服务均记录 unit / ExecStart / 账户 / 环境变量文件 / 端口 / 健康检查', () => {
    const services = MANIFEST.services as Array<Record<string, unknown>>;
    expect(services).toHaveLength(3);
    for (const service of services) {
      expect(service.unit).toMatch(/^deploy\/systemd\/crossclaim-.*\.service$/);
      expect(repoHas(service.unit as string), service.unit as string).toBe(true);
      expect(String(service.execStart)).toContain('/opt/crossclaim/');
      expect(String(service.user)).toMatch(/^crossclaim-/);
      expect(String(service.environmentFile)).toMatch(/^\/etc\/crossclaim\//);
      expect(Array.isArray(service.ports)).toBe(true);
      expect(typeof service.healthCheck).toBe('string');
    }
  });

  it('08 记录迁移 / 构建 / 启动 / 门禁命令与环境变量名称清单', () => {
    const commands = MANIFEST.commands as Record<string, string>;
    for (const key of ['installDeps', 'migrate', 'buildApi', 'buildWeb', 'installServices', 'restart', 'preflightGate']) {
      expect(commands[key], key).toBeTruthy();
    }
    const envNames = MANIFEST.requiredEnvVarNames as Record<string, string[]>;
    expect(Object.keys(envNames)).toEqual([
      '/etc/crossclaim/api.env',
      '/etc/crossclaim/web.env',
      '/etc/crossclaim/rsi.env',
    ]);
    expect(envNames['/etc/crossclaim/api.env']).toContain('DATABASE_URL');
    expect(envNames['/etc/crossclaim/rsi.env']).toContain('RSI_RECONCILE_REQUIRED');
    expect(MANIFEST.healthChecks as unknown[]).toHaveLength(5);
  });

  it('09 回滚与封板边界记录完整', () => {
    const rollback = MANIFEST.rollback as Record<string, unknown>;
    expect(String(rollback.applicationRollback)).toContain('systemctl restart');
    expect(String(rollback.schemaRollbackPolicy)).toContain('先加');
    const boundaries = MANIFEST.boundaries as Record<string, unknown>;
    expect(boundaries.productionDeploymentExecuted).toBe(false);
    expect(boundaries.productionReady).toBe(false);
    expect(boundaries.secondRuntime).toBe(0);
  });

  it('10 清单与文档不含任何真实凭据取值', () => {
    for (const [name, text] of [
      ['release-manifest.json', MANIFEST_RAW],
      ['DEPLOYMENT.md', DEPLOYMENT],
      ['verify-release.mjs', VERIFIER],
    ] as const) {
      expect(text, name).not.toMatch(/sk-[A-Za-z0-9]{12,}/);
      expect(text, name).not.toMatch(/postgres(ql)?:\/\/[^\s"']*:[^\s"'@]+@/i);
      expect(text, name).not.toMatch(/password\s*[:=]\s*\S/i);
      expect(text, name).not.toMatch(/DATABASE_URL\s*=\s*postgres/i);
    }
    expect((MANIFEST.secretPolicy as Record<string, unknown>).secretsInRepo).toBe(false);
  });
});

describe('部署来源统一 · 门禁脚本', () => {
  it('11 门禁校验 SHA 锁定 / 工作树 / 禁用分支 / 构建 / 定向测试', () => {
    expect(VERIFIER).toContain('releaseCommit');
    expect(VERIFIER).toContain('--untracked-files=all');
    expect(VERIFIER).toContain('forbiddenDeploymentBranches');
    expect(VERIFIER).toContain('merge-base');
    expect(VERIFIER).toContain('sealingCommitPolicy');
    expect(VERIFIER).toContain('RELEASE_GATE=FAIL');
  });

  it('12 门禁要求的分支策略为「仅允许封装提交」，且必需测试文件均存在', () => {
    const policy = MANIFEST.sealingCommitPolicy as Record<string, unknown>;
    expect(policy.mode).toBe('DOCS_ONLY_DESCENDANT');
    expect(policy.allowedPaths).toContain('deploy/release-manifest.json');
    const gates = MANIFEST.gates as Record<string, unknown>;
    expect(gates.requireGitHeadEqualsReleaseCommit).toBe(true);
    expect(gates.requireCleanWorktree).toBe(true);
    for (const testFile of gates.requiredTestFiles as string[]) {
      expect(repoHas(path.join('apps', 'api', testFile)), testFile).toBe(true);
    }
  });
});

describe('部署来源统一 · 历史文档归档（不得竞争）', () => {
  it('13 归档索引存在并列出被取代文档', () => {
    expect(repoHas('docs/archive/DEPLOYMENT-HISTORY.md')).toBe(true);
    expect(ARCHIVE_INDEX).toContain('唯一正式入口');
    expect(ARCHIVE_INDEX).toContain('RSI-DEPLOYMENT.md');
    expect(ARCHIVE_INDEX).toContain('OPERATIONS.md');
  });

  it('14 历史部署文档一律带 SUPERSEDED 标注且未被删除', () => {
    const archived = [
      'docs/releases/RSI-DEPLOYMENT.md',
      'P2-1-DEPLOYMENT-SMOKE-CHECKPOINT.md',
      'P2-PRODUCTION-HARDENING-DESIGN.md',
      'P2-2-BACKUP-RESTORE-CHECKPOINT.md',
      'P2-3-SECRET-ROTATION-DESIGN.md',
      'P2-3-SECRET-ROTATION-CHECKPOINT.md',
      'P2-4-VALIDATION-RUNBOOK-CHECKPOINT.md',
      'PHASE1-VALIDATION-RUNBOOK.md',
      'PRODUCTION-READINESS-CHECKLIST.md',
      'EXTERNAL-DATASET-SMOKE.md',
      'FINAL-PRODUCTION-GATE-REVIEW.md',
    ];
    for (const rel of archived) {
      expect(repoHas(rel), rel).toBe(true);
      expect(repoFile(rel), rel).toContain('SUPERSEDED（历史归档）');
    }
  });

  it('15 OPERATIONS.md 保持有效（未被误标为归档）', () => {
    expect(repoHas('OPERATIONS.md')).toBe(true);
    expect(repoFile('OPERATIONS.md')).not.toContain('SUPERSEDED（历史归档）');
  });
});
