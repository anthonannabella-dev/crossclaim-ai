/** RSI Runtime 独立进程入口验收：健康载荷、空转（Kill Switch/总开关）、只读边界。 */

import { afterEach, describe, expect, it } from 'vitest';

import { createRsiController, rsiHealthPayload } from '../runtime/rsi-controller';

const handles: { stop: () => Promise<void> }[] = [];
afterEach(async () => {
  while (handles.length > 0) await handles.pop()!.stop();
});

describe('RSI Runtime Controller', () => {
  it('RSI_RUNTIME_HEALTH_PAYLOAD：健康载荷自证零外写/零库写/无凭据，并暴露开关与计数', async () => {
    const controller = createRsiController({ env: {}, healthPort: 0, scanIntervalMs: 10_000 });
    handles.push(controller);
    const payload = JSON.parse(
      JSON.stringify({
        service: 'crossclaim-rsi-controller',
        health: controller.state.health,
        ...{ boundary: (await import('../runtime/rsi-controller')).rsiHealthPayload(
          { enabled: true, paused: false, stages: { OBSERVE: true, AUTO_INCIDENT: true, AUTO_PATCH: true, AUTO_VALIDATE: true, AUTO_JUDGE: true, AUTO_PROMOTE_LOW_RISK: false } },
          controller.state,
        ).boundary },
      }),
    ) as { health: string; boundary: Record<string, unknown> };

    expect(payload.health).toBe('HEALTHY');
    expect(payload.boundary).toEqual({
      externalWritePerformed: false,
      transportEnabled: false,
      productionCredentials: 'ABSENT',
      writesDatabase: false,
    });
  });

  it('RSI_RUNTIME_KILL_SWITCH_IDLES：Kill Switch / 总开关关闭时保持存活但空转', async () => {
    const paused = createRsiController({ env: { RSI_PAUSED: '1' }, healthPort: 0, scanIntervalMs: 10_000 });
    handles.push(paused);
    expect(paused.state.health).toBe('PAUSED');
    // 触发一次 tick：暂停时不得累加扫描计数（不产生新任务/信号）
    await (paused.state as never as { tick: () => Promise<void> }).tick();
    expect(paused.state.scanCount).toBe(0);
    expect(paused.state.lastScanAt).toBeNull();

    const disabled = createRsiController({ env: { RSI_ENABLED: 'false' }, healthPort: 0, scanIntervalMs: 10_000 });
    handles.push(disabled);
    expect(disabled.state.health).toBe('PAUSED');
    await (disabled.state as never as { tick: () => Promise<void> }).tick();
    expect(disabled.state.scanCount).toBe(0);
  });

  it('RSI_RUNTIME_SCAN_WHEN_HEALTHY：开关正常时只读扫描累加，且回调可注入', async () => {
    let scans = 0;
    const controller = createRsiController({
      env: {},
      healthPort: 0,
      scanIntervalMs: 10_000,
      onScan: () => {
        scans += 1;
      },
      now: () => new Date('2026-10-05T00:00:00.000Z'),
    });
    handles.push(controller);
    await (controller.state as never as { tick: () => Promise<void> }).tick();
    expect(scans).toBe(1);
    expect(controller.state.scanCount).toBe(1);
    expect(controller.state.lastScanAt).toBe('2026-10-05T00:00:00.000Z');
  });

  it('RSI_RUNTIME_HEALTH_FIELDS_COMPLETE：健康载荷含 queue 连通性、上次 reconcile、上次 incident 与计数', async () => {
    const controller = createRsiController({
      env: {},
      healthPort: 0,
      scanIntervalMs: 10_000,
      now: () => new Date('2026-10-05T00:00:00.000Z'),
    });
    handles.push(controller);

    const payload = rsiHealthPayload(
      { enabled: true, paused: false, stages: { OBSERVE: true, AUTO_INCIDENT: true, AUTO_PATCH: true, AUTO_VALIDATE: true, AUTO_JUDGE: true, AUTO_PROMOTE_LOW_RISK: false } },
      controller.state,
    );
    for (const field of [
      'queueConnected',
      'lastReconcileAt',
      'lastIncidentRef',
      'activeTasks',
      'failedTasks',
      'pendingOwnerApprovals',
    ]) {
      expect(payload).toHaveProperty(field);
    }
    // 启动即记录一次 reconcile（用于「重启后恢复」可观测性）
    expect(controller.state.lastReconcileAt).toBe('2026-10-05T00:00:00.000Z');
    expect(controller.state.queueConnected).toBe(true);
    expect(controller.state.lastIncidentRef).toBeNull();
  });
});
