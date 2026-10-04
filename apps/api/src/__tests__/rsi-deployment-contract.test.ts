/**
 * RSI 部署合同（防止「unit / 安装脚本 / 运行时入口 / package 脚本」四者漂移）。
 * 只读源码契约，不执行 systemd（本机无 systemd，不伪造执行证据）。
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const repoFile = (relative: string): string => readFileSync(path.join('..', '..', relative), 'utf8');

const unit = repoFile('deploy/systemd/crossclaim-rsi.service');
const installer = repoFile('deploy/install-rsi-service.sh');
const pkg = JSON.parse(repoFile('apps/api/package.json')) as { scripts: Record<string, string> };

describe('RSI 部署合同', () => {
  it('RSI_DEPLOY_UNIT_STARTS_EVENT_DRIVEN_ENTRY：unit 指向 rsi-run 且 exit 状态路径可写', () => {
    expect(unit).toContain('rsi-run.js'); // 事件驱动入口，而非裸控制器
    expect(unit).not.toContain('rsi-controller.js'); // 不应退回旧入口
    // 状态目录必须与硬化授予的写路径一致，否则发布器/日志无处可写
    expect(unit).toContain('Environment=RSI_STATE_FILE=/var/lib/crossclaim-rsi/');
    expect(unit).toContain('Environment=RSI_ADMIN_SNAPSHOT_PATH=/var/lib/crossclaim-rsi/');
    expect(unit).toContain('ReadWritePaths=/var/lib/crossclaim-rsi');
  });

  it('RSI_DEPLOY_UNIT_KEEPS_HARDENING_AND_RESTART_LIMITS：硬化与防 crash-loop 配置齐全', () => {
    for (const key of [
      'User=crossclaim-rsi',
      'NoNewPrivileges=true',
      'ProtectSystem=strict',
      'ProtectHome=true',
      'PrivateTmp=true',
      'CapabilityBoundingSet=',
      'EnvironmentFile=/etc/crossclaim/rsi.env',
      'Restart=on-failure',
      'RestartSec=5',
      'StartLimitIntervalSec=300',
      'StartLimitBurst=5',
      'WantedBy=multi-user.target',
    ]) {
      expect(unit).toContain(key);
    }
  });

  it('RSI_DEPLOY_INSTALLER_IS_IDEMPOTENT_AND_SECRET_FREE：安装脚本幂等、不覆盖 env、不写凭据', () => {
    expect(installer).toContain('--dry-run');
    expect(installer).toContain('keep existing');
    expect(installer).toContain('systemctl daemon-reload');
    expect(installer).toContain('systemctl enable');
    expect(installer).toContain('RSI_HEALTH_OK');
    // 不得写入真实凭据：模板里 DATABASE_URL 只作为说明出现
    expect(installer).not.toMatch(/DATABASE_URL\s*=\s*postgres/i);
    // 事件驱动入口消费的 artifact 路径必须被文档化（未设=静默）
    for (const name of ['RSI_TASKS_PATH', 'RSI_CI_RESULTS_PATH', 'RSI_VERDICT_PATH', 'RSI_TEST_RESULTS_PATH']) {
      expect(installer).toContain(name);
    }
  });

  it('RSI_DEPLOY_PACKAGE_SCRIPTS_PRESENT：真实启动命令存在', () => {
    for (const script of ['rsi:dev', 'rsi:start', 'rsi:run', 'rsi:health', 'export:recover-static']) {
      expect(pkg.scripts).toHaveProperty(script);
    }
    expect(pkg.scripts['rsi:run']).toContain('rsi-run');
    expect(pkg.scripts['rsi:dev']).toContain('rsi-controller');
  });
});
