/**
 * 适配器注册表
 * ---------------------------------------------------------------
 * 只做「平台标识 → 适配器」的登记与查找，不承载任何平台逻辑。
 * 注册时做一次能力体检，把 Phase 1 不该出现的东西挡在系统之外：
 *   - platform 标识必须自洽、非空
 *   - domains / channels 不能为空（否则适配器无法被正确调用）
 *   - maxPageSize 必须在 1..1000
 *   - supportsClaimSubmission 必须为 false（第三方写入需先回架构方审计）
 */

import type { Channel } from '@prisma/client';
import {
  AdapterCapabilityError,
  AdapterNotFoundError,
  AdapterRegistryError,
  type AdapterCapabilities,
  type ExternalAdapter,
} from './types';

export interface AdapterRegistry {
  /** 注册；平台标识重复 / 能力体检不通过时抛错 */
  register(adapter: ExternalAdapter): void;
  /** 取一个适配器；未注册时抛 AdapterNotFoundError */
  get(platform: string): ExternalAdapter;
  /** 已注册适配器（按注册顺序） */
  list(): ExternalAdapter[];
  /** 按渠道筛选（同一渠道可以有多个平台适配器） */
  byChannel(channel: Channel): ExternalAdapter[];
}

const MAX_PAGE_SIZE_CEILING = 1000;

export function assertAdapterCapabilities(adapter: ExternalAdapter): AdapterCapabilities {
  const caps = adapter.capabilities();

  if (!caps.platform || caps.platform !== adapter.platform) {
    throw new AdapterRegistryError(
      `适配器 platform 标识不一致：capabilities=${caps.platform} / adapter=${adapter.platform}`,
    );
  }
  if (!caps.displayName) {
    throw new AdapterRegistryError(`适配器 ${caps.platform} 缺少 displayName`);
  }
  if (caps.domains.length === 0) {
    throw new AdapterRegistryError(`适配器 ${caps.platform} 未声明任何 domain`);
  }
  if (caps.channels.length === 0) {
    throw new AdapterRegistryError(`适配器 ${caps.platform} 未声明任何 channel`);
  }
  if (
    !Number.isInteger(caps.maxPageSize) ||
    caps.maxPageSize < 1 ||
    caps.maxPageSize > MAX_PAGE_SIZE_CEILING
  ) {
    throw new AdapterRegistryError(
      `适配器 ${caps.platform} 的 maxPageSize 必须在 1..${MAX_PAGE_SIZE_CEILING}`,
    );
  }
  // Phase 1 写入闸门：类型上已锁死 false，这里再挡一次非类型化调用方（JS / any）
  if ((caps as { supportsClaimSubmission?: unknown }).supportsClaimSubmission !== false) {
    throw new AdapterCapabilityError(
      `适配器 ${caps.platform} 声称具备第三方写入能力：Phase 1 未开启，需先回架构方审计`,
    );
  }
  return caps;
}

export function createAdapterRegistry(adapters: readonly ExternalAdapter[] = []): AdapterRegistry {
  const registered = new Map<string, ExternalAdapter>();

  const registry: AdapterRegistry = {
    register(adapter) {
      assertAdapterCapabilities(adapter);
      if (registered.has(adapter.platform)) {
        throw new AdapterRegistryError(`适配器已注册: ${adapter.platform}`);
      }
      registered.set(adapter.platform, adapter);
    },
    get(platform) {
      const found = registered.get(platform);
      if (!found) throw new AdapterNotFoundError(`未注册的适配器: ${platform}`);
      return found;
    },
    list() {
      return [...registered.values()];
    },
    byChannel(channel) {
      return [...registered.values()].filter((adapter) =>
        adapter.capabilities().channels.includes(channel),
      );
    },
  };

  for (const adapter of adapters) registry.register(adapter);
  return registry;
}
