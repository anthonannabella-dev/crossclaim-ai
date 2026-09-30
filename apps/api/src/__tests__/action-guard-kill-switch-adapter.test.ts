// Kill Switch 适配器 v2 单测（CHANGE D：结构/健康严格化）

import { describe, expect, it, vi } from 'vitest';
import { createKillSwitchReadPort } from '../services/action-guard/kill-switch-adapter';

const ORG = 'b2a00000-0000-4000-8000-0000000000aa';

describe('Kill Switch read port adapter v2', () => {
  it('01 合法响应：scope/value/degraded 正确透传', async () => {
    const port = createKillSwitchReadPort({
      async resolve(scope: string) {
        return { scope, value: 'enabled', degraded: false, stale: true };
      },
    });
    await expect(port.resolve('submission', ORG)).resolves.toEqual({
      scope: 'submission',
      value: 'enabled',
      degraded: false,
      stale: true,
    });
  });

  it('02 未知 scope：不查 resolver，直接拒绝', async () => {
    const resolve = vi.fn();
    const port = createKillSwitchReadPort({ resolve });
    await expect(port.resolve('not_a_scope', ORG)).resolves.toEqual({
      scope: 'not_a_scope',
      value: 'disabled',
      degraded: true,
      stale: false,
    });
    expect(resolve).not.toHaveBeenCalled();
  });

  it('03 resolver 异常不吞（交由上层 fail closed）', async () => {
    const port = createKillSwitchReadPort({
      async resolve() {
        throw new Error('resolver db down');
      },
    });
    await expect(port.resolve('submission', ORG)).rejects.toThrow('resolver db down');
  });

  it('04 结构异常一律拒绝：scope 不匹配 / 缺 degraded / 非法 value', async () => {
    const cases = [
      { scope: 'billing', value: 'enabled', degraded: false }, // scope 不匹配
      { scope: 'submission', value: 'enabled' }, // 缺 degraded
      { scope: 'submission', value: 'ENABLED', degraded: false }, // 非法 value
      { scope: 'submission', value: 'enabled', degraded: 'no' }, // degraded 类型错
      undefined as never,
    ];
    for (const raw of cases) {
      const port = createKillSwitchReadPort({ async resolve() { return raw; } });
      const result = await port.resolve('submission', ORG);
      expect(result.value, JSON.stringify(raw)).toBe('disabled');
      expect(result.degraded, JSON.stringify(raw)).toBe(true);
      expect(result.stale, JSON.stringify(raw)).toBe(true);
    }
  });

  it('05 依赖缺失即失败', () => {
    expect(() => createKillSwitchReadPort(undefined as never)).toThrow('KILL_SWITCH_ADAPTER_MISSING_RESOLVER');
  });
});
