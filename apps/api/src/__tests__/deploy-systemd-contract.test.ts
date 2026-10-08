/**
 * Linux 部署合同（systemd）—— AUDIT-RC-1 CHANGE 1（MSG-20261008-14）
 * ---------------------------------------------------------------
 * 只读源码契约：不执行 systemd（开发机无 systemd，因此不伪造执行证据）。
 * 目的：防止「unit / 安装脚本 / 编译产物入口 / package 脚本」四者漂移，
 *       并锁死「RSI 只有一个 systemd 主实例入口」与「unit 中不得出现真实凭据」。
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const repoFile = (relative: string): string => readFileSync(path.join('..', '..', relative), 'utf8');

const API_UNIT = repoFile('deploy/systemd/crossclaim-api.service');
const WEB_UNIT = repoFile('deploy/systemd/crossclaim-web.service');
const RSI_UNIT = repoFile('deploy/systemd/crossclaim-rsi.service');
const SERVICES_INSTALLER = repoFile('deploy/install-services.sh');
const RSI_INSTALLER = repoFile('deploy/install-rsi-service.sh');
const API_PKG = JSON.parse(repoFile('apps/api/package.json')) as { scripts: Record<string, string> };
const WEB_PKG = JSON.parse(repoFile('apps/web/package.json')) as { scripts: Record<string, string> };

const UNITS: ReadonlyArray<readonly [string, string]> = [
  ['crossclaim-api', API_UNIT],
  ['crossclaim-web', WEB_UNIT],
  ['crossclaim-rsi', RSI_UNIT],
];

describe('CHANGE 1 · systemd 服务齐全且入口指向真实编译产物', () => {
  it('01 三个服务 unit 均存在且各自有唯一 SyslogIdentifier', () => {
    for (const [name, unit] of UNITS) {
      expect(unit, name).toContain(`SyslogIdentifier=${name}`);
      expect(unit, name).toContain('WantedBy=multi-user.target');
    }
  });

  it('02 API 入口 = dist/src/server.js（与 package.json start 一致）', () => {
    expect(API_UNIT).toContain('ExecStart=/usr/bin/node /opt/crossclaim/apps/api/dist/src/server.js');
    expect(API_PKG.scripts.start).toBe('node dist/src/server.js');
  });

  it('03 RSI 入口 = dist/src/runtime/rsi-run.js（事件驱动入口，不是裸控制器）', () => {
    expect(RSI_UNIT).toContain(
      'ExecStart=/usr/bin/node /opt/crossclaim/apps/api/dist/src/runtime/rsi-run.js',
    );
    expect(RSI_UNIT).not.toContain('dist/src/runtime/rsi-controller.js');
    expect(RSI_PKG_START_PRESENT()).toBe(true);
  });

  it('04 Web 入口 = node_modules 内 next CLI（不依赖 PATH / npx），端口与 package.json 一致', () => {
    expect(WEB_UNIT).toContain(
      'ExecStart=/usr/bin/node /opt/crossclaim/apps/web/node_modules/next/dist/bin/next start -p 3001',
    );
    expect(WEB_PKG.scripts.start).toContain('next start -p 3001');
  });

  it('05 不出现 API 构建产物的旧错误路径（dist/ 少了 src/ 段）', () => {
    for (const [name, unit] of UNITS) {
      // 只约束 apps/api 的编译产物：web 的 node_modules/next/dist/bin 是合法的第三方路径
      expect(unit, name).not.toMatch(/apps\/api\/dist\/(?!src\/)/);
      expect(unit, name).not.toContain('/dist/server.js');
      expect(unit, name).not.toContain('/dist/runtime/');
    }
  });
});

function RSI_PKG_START_PRESENT(): boolean {
  return API_PKG.scripts['rsi:start'].includes('dist/src/runtime/rsi-controller.js');
}

describe('CHANGE 1 · 单实例约束（systemd 不会意外拉起多个 RSI 主实例）', () => {
  it('06 只有 crossclaim-rsi.service 引用 rsi-run 入口', () => {
    const referencing = UNITS.filter(([, unit]) => unit.includes('rsi-run.js')).map(([name]) => name);
    expect(referencing).toEqual(['crossclaim-rsi']);
  });

  it('07 无模板实例（@）且 unit 文件不启用多实例', () => {
    for (const [name, unit] of UNITS) {
      expect(name, name).not.toContain('@');
      expect(unit, name).not.toContain('ExecStartPre=+/usr/bin/systemctl start');
    }
    expect(RSI_UNIT).toContain('Type=simple');
  });

  it('08 跨实例互斥说明在 unit 中明示（durable lease / ownerRef）', () => {
    expect(RSI_UNIT).toContain('ownerRef');
    expect(RSI_UNIT).toContain('单实例');
  });
});

describe('CHANGE 1 · 硬化 / 重启 / 优雅停止 / 日志', () => {
  it('09 三个 unit 均有专用用户（非 root）与独立 Group', () => {
    expect(API_UNIT).toContain('User=crossclaim-api');
    expect(API_UNIT).toContain('Group=crossclaim-api');
    expect(WEB_UNIT).toContain('User=crossclaim-web');
    expect(WEB_UNIT).toContain('Group=crossclaim-web');
    expect(RSI_UNIT).toContain('User=crossclaim-rsi');
    for (const [name, unit] of UNITS) {
      expect(unit, name).not.toMatch(/^User=root$/m);
    }
  });

  it('10 三个 unit 均具备最小权限硬化集合', () => {
    for (const [name, unit] of UNITS) {
      for (const key of [
        'NoNewPrivileges=true',
        'PrivateTmp=true',
        'ProtectSystem=strict',
        'ProtectHome=true',
        'CapabilityBoundingSet=',
        'AmbientCapabilities=',
        'RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX',
      ]) {
        expect(unit, `${name} :: ${key}`).toContain(key);
      }
    }
  });

  it('11 崩溃自动恢复 + 防 crash loop + 可写路径显式声明 + 日志进 journald', () => {
    for (const [name, unit] of UNITS) {
      for (const key of [
        'Restart=on-failure',
        'RestartSec=5',
        'StartLimitIntervalSec=300',
        'StartLimitBurst=5',
        'KillSignal=SIGTERM',
        'TimeoutStopSec=30',
        'StandardOutput=journal',
        'StandardError=journal',
      ]) {
        expect(unit, `${name} :: ${key}`).toContain(key);
      }
      expect(unit, name).toMatch(/ReadWritePaths=\/var\/lib\/crossclaim-/);
      expect(unit, name).toMatch(/StateDirectory=crossclaim-/);
    }
  });

  it('12 API 本地存储在 StateDirectory 内（ProtectSystem=strict 下 /opt 只读）', () => {
    expect(API_UNIT).toContain('Environment=STORAGE_LOCAL_ROOT=/var/lib/crossclaim-api/storage');
    expect(API_UNIT).toContain('ReadWritePaths=/var/lib/crossclaim-api');
  });

  it('13 Web 只放开自身 build cache，且不承载数据库凭据', () => {
    expect(WEB_UNIT).toContain('/opt/crossclaim/apps/web/.next');
    expect(WEB_UNIT).not.toContain('DATABASE_URL');
  });
});

describe('CHANGE 1 · 环境变量加载与「不含真实凭据」', () => {
  it('14 每个服务各有独立 EnvironmentFile（不在 unit 内联凭据）', () => {
    expect(API_UNIT).toContain('EnvironmentFile=/etc/crossclaim/api.env');
    expect(WEB_UNIT).toContain('EnvironmentFile=/etc/crossclaim/web.env');
    expect(RSI_UNIT).toContain('EnvironmentFile=/etc/crossclaim/rsi.env');
  });

  it('15 CHANGE 3 联动：RSI unit 默认要求 reconcile，且可被 EnvironmentFile 覆写（顺序正确）', () => {
    const flagAt = RSI_UNIT.indexOf('Environment=RSI_RECONCILE_REQUIRED=true');
    const fileAt = RSI_UNIT.indexOf('EnvironmentFile=/etc/crossclaim/rsi.env');
    expect(flagAt).toBeGreaterThan(-1);
    expect(fileAt).toBeGreaterThan(-1);
    expect(flagAt).toBeLessThan(fileAt);
  });

  it('16 任何 unit / 安装脚本都不得内联真实凭据', () => {
    const sources: ReadonlyArray<readonly [string, string]> = [
      ...UNITS,
      ['install-services.sh', SERVICES_INSTALLER],
      ['install-rsi-service.sh', RSI_INSTALLER],
    ];
    for (const [name, text] of sources) {
      expect(text, name).not.toMatch(/DATABASE_URL\s*=\s*postgres/i);
      expect(text, name).not.toMatch(/sk-[A-Za-z0-9]{10,}/);
      expect(text, name).not.toMatch(/STORAGE_URL_SECRET\s*=\s*\S/);
      expect(text, name).not.toMatch(/AUDIT_IP_SALT\s*=\s*\S/);
      expect(text, name).not.toMatch(/RSI_RECONCILE_REQUIRED=true\s*\n\s*DATABASE_URL/);
    }
  });
});

describe('CHANGE 1 · 安装脚本幂等且可 staging 验证', () => {
  it('17 install-services.sh：dry-run / 不覆盖 env / daemon-reload / enable / 双服务健康检查', () => {
    expect(SERVICES_INSTALLER).toContain('--dry-run');
    expect(SERVICES_INSTALLER).toContain('keep existing');
    expect(SERVICES_INSTALLER).toContain('systemctl daemon-reload');
    expect(SERVICES_INSTALLER).toContain('systemctl enable crossclaim-api crossclaim-web');
    expect(SERVICES_INSTALLER).toContain('http://127.0.0.1:3000/health');
    expect(SERVICES_INSTALLER).toContain('http://127.0.0.1:3001/');
  });

  it('18 install-services.sh：创建两个专用用户，且不在模板中写任何密钥取值', () => {
    expect(SERVICES_INSTALLER).toContain('ensure_user crossclaim-api');
    expect(SERVICES_INSTALLER).toContain('ensure_user crossclaim-web');
    expect(SERVICES_INSTALLER).toContain('/etc/crossclaim/api.env');
    expect(SERVICES_INSTALLER).toContain('/etc/crossclaim/web.env');
    expect(SERVICES_INSTALLER).toContain('CROSSCLAIM_API_URL=http://127.0.0.1:3000');
  });

  it('19 install-rsi-service.sh：环境模板声明 reconcile 必需（生产不得静默 NOT_CONFIGURED）', () => {
    expect(RSI_INSTALLER).toContain('RSI_RECONCILE_REQUIRED=true');
  });
});
