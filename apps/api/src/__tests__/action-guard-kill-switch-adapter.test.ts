// Kill Switch → Action Guard 适配器单测（授权项 ③ 真实依赖接线）

import { describe, expect, it, vi } from 'vitest';
import { createKillSwitchReadPort } from '../services/action-guard/kill-switch-adapter';

const ORG = 'b2a00000-0000-4000-8000-0000000000aa';

describe('Kill Switch read port adapter', () => {
  it('01 透传 resolver 的 enabled / disabled 与 degraded / stale', async () => {
    const port = createKillSwitchReadPort({
      async resolve(scope: string, organizationId: string) {
        expect(organizationId).toBe(ORG);
        return { scope, value: scope === 'submission' ? 'enabled' : 'disabled', degraded: false, stale: true };
      },
    });
    await expect(port.resolve('submission', ORG)).resolves.toEqual({
      scope: 'submission',
      value: 'enabled',
      degraded: false,
      stale: true,
    });
    await expect(port.resolve('billing', ORG)).resolves.toMatchObject({ value: 'disabled' });
  });

  it('02 未知 scope：不查 resolver，直接按未启用（fail closed + degraded 标记）', async () => {
    const resolve = vi.fn();
    const port = createKillSwitchReadPort({ resolve });
    const result = await port.resolve('not_a_scope', ORG);
    expect(result).toEqual({ scope: 'not_a_scope', value: 'disabled', degraded: true, stale: false });
    expect(resolve).not.toHaveBeenCalled();
  });

  it('03 resolver 异常不被吞掉（交由 capability source 判 STATE_UNAVAILABLE）', async () => {
    const port = createKillSwitchReadPort({
      async resolve() {
        throw new Error('resolver db down');
      },
    });
    await expect(port.resolve('submission', ORG)).rejects.toThrow('resolver db down');
  });

  it('04 resolver 返回可疑值（缺 value）：按 disabled 处理', async () => {
    const port = createKillSwitchReadPort({
      async resolve(scope: string) {
        return { scope, value: undefined as never, degraded: false };
      },
    });
    await expect(port.resolve('submission', ORG)).resolves.toMatchObject({ value: 'disabled' });
  });

  it('05 依赖缺失即失败（不允许静默放行）', () => {
    expect(() => createKillSwitchReadPort(undefined as never)).toThrow('KILL_SWITCH_ADAPTER_MISSING_RESOLVER');
  });
});
