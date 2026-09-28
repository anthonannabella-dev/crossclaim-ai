/**
 * Repository guard: the dependency license gate must scan every real workspace.
 * ---------------------------------------------------------------------------
 * C-0008-A found that `tools/license-gate` still pointed at legacy directory
 * names ('.', 'backend', 'frontend'), so every check was reported as SKIP and
 * `apps/api` was never actually scanned while the CI job stayed green. This
 * test fails if the workspace list drifts from the real ones again.
 */

import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.join(__dirname, '..', '..', '..', '..');
const GATE_PATH = path.join(REPO_ROOT, 'tools', 'license-gate', 'check-licenses.mjs');
const ALLOWLIST_PATH = path.join(REPO_ROOT, 'tools', 'license-gate', 'allowlist.json');

function readGateWorkspaces(): string[] {
  const source = fs.readFileSync(GATE_PATH, 'utf8');
  const match = /const WORKSPACES = \[([^\]]*)\]/.exec(source);
  if (!match) throw new Error('WORKSPACES_CONST_NOT_FOUND');
  return [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

/** Every directory under apps/ that actually carries a package.json. */
function realWorkspaces(): string[] {
  const appsDir = path.join(REPO_ROOT, 'apps');
  return fs
    .readdirSync(appsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter((entry) => fs.existsSync(path.join(appsDir, entry.name, 'package.json')))
    .map((entry) => `apps/${entry.name}`)
    .sort();
}

const dependencyNames = (workspace: string): string[] => {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, workspace, 'package.json'), 'utf8'),
  ) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  return [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})];
};

describe('许可证闸门 — workspace 覆盖守卫', () => {
  it('WORKSPACES 与 apps/ 下真实 workspace 完全一致（无 SKIP 空转）', () => {
    const gate = readGateWorkspaces();
    const real = realWorkspaces();

    expect(real.length).toBeGreaterThanOrEqual(2);
    expect(gate.slice().sort()).toEqual(real);
    // 旧项目遗留的目录名不得再出现（它们会让所有检查静默 SKIP）
    for (const legacy of ['.', 'backend', 'frontend', 'apps/web-old']) {
      expect(gate).not.toContain(legacy);
    }
  });

  it('每个 workspace 都有可扫描的依赖，且 allowlist 结构可用', () => {
    for (const workspace of readGateWorkspaces()) {
      expect(dependencyNames(workspace).length).toBeGreaterThan(0);
    }

    const allowlist = JSON.parse(fs.readFileSync(ALLOWLIST_PATH, 'utf8')) as {
      policy?: { allow?: string[]; review?: string[]; deny?: string[] };
    };
    const allow = allowlist.policy?.allow ?? [];
    const deny = allowlist.policy?.deny ?? [];
    // 常用的宽松许可证必须在 allow；copyleft 必须在 deny 或 review，不能被静默放过。
    expect(allow).toEqual(expect.arrayContaining(['MIT', 'Apache-2.0']));
    expect(deny.length + (allowlist.policy?.review?.length ?? 0)).toBeGreaterThan(0);
    for (const license of ['GPL-3.0', 'AGPL-3.0']) {
      expect(allow).not.toContain(license);
    }
  });
});
