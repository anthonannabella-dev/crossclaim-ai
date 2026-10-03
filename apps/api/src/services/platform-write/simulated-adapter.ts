/**
 * 模拟投递通道（Phase 1 唯一可接线的端口）
 * ---------------------------------------------------------------
 * 结构约束：simulated 恒为 true，且**不做任何网络 I/O、不读 env、不读凭据**。
 * 调用记录保存在内存里，供测试断言「恰一次 / 零次」。
 */

import {
  PlatformWriteError,
  type PlatformWritePort,
  type PlatformWritePortOutcome,
  type PlatformWritePortRequest,
} from './types';

export interface SimulatedPlatformWritePort extends PlatformWritePort {
  readonly calls: PlatformWritePortRequest[];
  callCount(): number;
}

/**
 * @param outcomes 预置结果序列（按调用顺序消费）；用完后默认 SUCCEEDED
 * @param platform 端口自报的平台标识（仅用于审计口径，不代表真实平台）
 */
export function createSimulatedPlatformWritePort(
  platform = 'SIMULATED',
  outcomes: readonly PlatformWritePortOutcome[] = [],
): SimulatedPlatformWritePort {
  const calls: PlatformWritePortRequest[] = [];
  let served = 0;

  return {
    platform,
    simulated: true,
    calls,
    callCount() {
      return calls.length;
    },
    async submit(request: PlatformWritePortRequest): Promise<PlatformWritePortOutcome> {
      if (!request.idempotencyKey || !request.snapshotDigest) {
        throw new PlatformWriteError(
          'SIMULATED_PORT_REQUEST_INVALID',
          '模拟通道要求携带幂等键与快照摘要（无幂等键的提交一律拒绝）',
        );
      }
      calls.push({ ...request, payload: { ...request.payload } });
      served += 1;
      const scripted = outcomes[calls.length - 1];
      if (scripted) return scripted;
      return { status: 'SUCCEEDED', externalRef: platform + '-REF-' + String(served).padStart(4, '0') };
    },
  };
}
