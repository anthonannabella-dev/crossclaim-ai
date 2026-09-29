/**
 * EFFECTIVE KILL SWITCH RESOLVER
 * ------------------------------------------------------------------
 * 依据：EFFECTIVE-KILL-SWITCH-RESOLUTION-DESIGN（MSG-20260929-64 R2 = PASS / FROZEN；MSG-20260929-65 Implementation GO）
 *
 * 三层分离（不得回退）：
 *   Config Value     （部署态：环境配置 / tenant 配置；宿主与运维可写）
 *   Control Request  （KillSwitchRequest：平台内 OWNER/ADMIN 经 POST /admin/kill-switch 可写）
 *   Effective Value  （本模块的派生投影；**不落库**、无第二事实源）
 *
 * 不变量（架构方冻结）：
 *   I1 Effective Value is never persisted —— 本模块只返回内存对象，绝不写库
 *   I2 Control Request cannot mutate Config Value —— 只读端口（类型层面即无写路径）
 *   I3 Disabled decision always dominates Enabled decision —— 逐层短路；同层冲突 disabled 优先
 *   I4 Resolver failure cannot enable protected actions —— 任何异常 → disabled（observability 例外但标 stale）
 *
 * 优先级（§12.1 定稿）：
 *   Global HARD DISABLED > Tenant DISABLED > Tenant ENABLED > Global Config ENABLED > Environment Default
 *
 * 缓存（§12.3 定稿）：仅进程内内存缓存，键 (organizationId, scope)，TTL 默认 5s / 上限 30s，
 *   禁止 Redis / CDN / 浏览器缓存；控制面写入后由写路径主动 invalidate。
 */

import {
  KILL_SWITCH_DEFAULTS,
  KILL_SWITCH_SCOPES,
  parseKillSwitchValue,
  type KillSwitchConfig,
  type KillSwitchScope,
  type KillSwitchValue,
} from './kill-switch';

export const KILL_SWITCH_RESOLUTION_SOURCES = [
  'global-hard-disabled',
  'tenant-control',
  'tenant-config',
  'global-config',
  'environment-default',
  'fail-closed',
] as const;
export type KillSwitchResolutionSource = (typeof KILL_SWITCH_RESOLUTION_SOURCES)[number];

export type KillSwitchControlState = 'NONE' | 'PENDING_ENABLE' | 'APPLIED' | 'EXPIRED' | 'CANCELLED';

export const KILL_SWITCH_RESOLVER_DEFAULT_TTL_MS = 5_000;
export const KILL_SWITCH_RESOLVER_MAX_TTL_MS = 30_000;

export interface EffectiveKillSwitch {
  scope: KillSwitchScope;
  value: KillSwitchValue;
  source: KillSwitchResolutionSource;
  controlState: KillSwitchControlState;
  /** 降级：DB 不可用等（业务 scope 同时为 disabled/fail-closed） */
  degraded: boolean;
  /** 陈旧：返回的是上次已知值（仅 observability 在降级时可能为 true） */
  stale: boolean;
  /** 评估时间（降级且 stale 时为**上次成功评估**时间，不冒充当前时间） */
  evaluatedAt: string;
  /** 本次判定是否命中进程内缓存 */
  cacheHit: boolean;
}

/** 控制面只读行（I2：端口类型本身不含任何写方法） */
export interface KillSwitchControlRow {
  id: string;
  scope: string;
  target: string;
  state: string;
  appliedAt: Date | null;
  confirmedAt: Date | null;
  expiresAt: Date;
  requestedBy: string;
}

export interface KillSwitchControlReadPort {
  findMany(args: {
    where: { organizationId: string };
    select: {
      id: true;
      scope: true;
      target: true;
      state: true;
      appliedAt: true;
      confirmedAt: true;
      expiresAt: true;
      requestedBy: true;
    };
  }): Promise<KillSwitchControlRow[]>;
}

export interface EffectiveKillSwitchResolver {
  resolve(scope: string, organizationId: string): Promise<EffectiveKillSwitch>;
  resolveAll(organizationId: string): Promise<EffectiveKillSwitch[]>;
  invalidate(organizationId: string, scope?: string): void;
}

export interface EffectiveKillSwitchResolverDeps {
  /** 只读端口（I2）：调用方只能传 findMany，无法从本模块发起写操作 */
  controlRequests: KillSwitchControlReadPort;
  config?: KillSwitchConfig;
  /** 缓存 TTL（默认 5s；超过上限 30s 会被夹到上限） */
  ttlMs?: number;
  now?: () => Date;
  /** 结构化降级日志（不含租户机密） */
  log?: (event: string, fields: Record<string, unknown>) => void;
}

interface ControlSnapshot {
  state: KillSwitchControlState;
  /** 仅 APPLIED 参与 effective：'enabled' | 'disabled' | null */
  appliedValue: KillSwitchValue | null;
  appliedAt: number | null;
}

const NO_CONTROL: ControlSnapshot = { state: 'NONE', appliedValue: null, appliedAt: null };

function isKnownScope(scope: unknown): scope is KillSwitchScope {
  return typeof scope === 'string' && (KILL_SWITCH_SCOPES as readonly string[]).includes(scope);
}

/** 判定优先级比较：appliedAt desc → confirmedAt desc（null 视为最小）→ id 字典序（并列时确定性） */
function pickLatestApplied(rows: KillSwitchControlRow[]): KillSwitchControlRow | null {
  const applied = rows.filter(
    (row): row is KillSwitchControlRow & { appliedAt: Date } =>
      row.state === 'APPLIED' && row.appliedAt !== null,
  );
  if (applied.length === 0) return null;
  applied.sort((a, b) => {
    const byApplied = b.appliedAt.getTime() - a.appliedAt.getTime();
    if (byApplied !== 0) return byApplied;
    const aConfirmed = a.confirmedAt ? a.confirmedAt.getTime() : -1;
    const bConfirmed = b.confirmedAt ? b.confirmedAt.getTime() : -1;
    if (bConfirmed !== aConfirmed) return bConfirmed - aConfirmed;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return applied[0] ?? null;
}

/**
 * 控制面快照：`controlState` 只用于呈现；只有 APPLIED 参与 effective value（§12.6）。
 * 未过期的 PENDING_ENABLE 优先呈现为「等待确认」。
 */
function toSnapshot(rows: KillSwitchControlRow[], nowMs: number): ControlSnapshot {
  const pending = rows.find((row) => row.state === 'PENDING_ENABLE' && row.expiresAt.getTime() > nowMs);
  if (pending) return { state: 'PENDING_ENABLE', appliedValue: null, appliedAt: null };
  const latest = pickLatestApplied(rows);
  if (latest) {
    return {
      state: 'APPLIED',
      appliedValue: latest.target === 'DISABLED' ? 'disabled' : 'enabled',
      appliedAt: latest.appliedAt ? latest.appliedAt.getTime() : null,
    };
  }
  if (rows.some((row) => row.state === 'CANCELLED')) {
    return { state: 'CANCELLED', appliedValue: null, appliedAt: null };
  }
  if (rows.some((row) => row.state === 'EXPIRED')) {
    return { state: 'EXPIRED', appliedValue: null, appliedAt: null };
  }
  return NO_CONTROL;
}

/**
 * 纯函数投影（I1/I3/I4 的可测核心）：给定配置与某 scope 的控制面快照，返回 value + source。
 */
export function projectEffectiveValue(
  scope: KillSwitchScope,
  organizationId: string,
  config: KillSwitchConfig | undefined,
  control: ControlSnapshot,
): { value: KillSwitchValue; source: KillSwitchResolutionSource } {
  const globalRaw = config?.global?.[scope];
  const tenantRaw = config?.tenant?.[organizationId]?.[scope];

  // 1) Global HARD DISABLED（非法 global 值按 fail-closed，不退化为默认）
  let globalValue: KillSwitchValue | null = null;
  if (globalRaw !== undefined) {
    globalValue = parseKillSwitchValue(globalRaw);
    if (globalValue === null) return { value: 'disabled', source: 'fail-closed' };
    if (globalValue === 'disabled') return { value: 'disabled', source: 'global-hard-disabled' };
  }

  // 2) Tenant 层（config 信号 + APPLIED 控制请求信号）；非法 tenant 值按 fail-closed
  let tenantValue: KillSwitchValue | null = null;
  if (tenantRaw !== undefined) {
    tenantValue = parseKillSwitchValue(tenantRaw);
    if (tenantValue === null) return { value: 'disabled', source: 'fail-closed' };
  }
  const controlValue = control.appliedValue;

  // I3：同层冲突 disabled 胜出
  if (tenantValue === 'disabled' || controlValue === 'disabled') {
    // 控制请求更严格且配置未禁用 → 以控制面解释（可回答"为什么被禁止"）
    if (controlValue === 'disabled' && tenantValue !== 'disabled') {
      return { value: 'disabled', source: 'tenant-control' };
    }
    return { value: 'disabled', source: 'tenant-config' };
  }
  if (tenantValue === 'enabled' || controlValue === 'enabled') {
    return {
      value: 'enabled',
      source: controlValue === 'enabled' ? 'tenant-control' : 'tenant-config',
    };
  }

  // 3) Global Config ENABLED（软开启：允许进入下一层，不是强制开启）
  if (globalValue === 'enabled') return { value: 'enabled', source: 'global-config' };

  // 4) Environment Default
  return { value: KILL_SWITCH_DEFAULTS[scope], source: 'environment-default' };
}

export function createEffectiveKillSwitchResolver(
  deps: EffectiveKillSwitchResolverDeps,
): EffectiveKillSwitchResolver {
  const ttlMs = Math.min(
    Math.max(deps.ttlMs ?? KILL_SWITCH_RESOLVER_DEFAULT_TTL_MS, 0),
    KILL_SWITCH_RESOLVER_MAX_TTL_MS,
  );
  const now = (): Date => (deps.now ? deps.now() : new Date());

  /** 缓存条目：键 = `${organizationId}|${scope}`；值 + 评估时间（评估时间为缓存新鲜度基准） */
  const cache = new Map<string, { at: number; snapshot: ControlSnapshot }>();
  /** 上次成功读取控制面的时间（用于 observability 的 lastKnown 与 stale 判定） */
  const lastKnownAt = new Map<string, number>();
  const key = (organizationId: string, scope: string): string => `${organizationId}|${scope}`;

  async function loadOrganizationControl(organizationId: string, at: number): Promise<Map<string, ControlSnapshot>> {
    // 一次查询取该租户全部控制面行（批量填充 6 个 scope；读取成本优化，键仍按 org+scope）
    const rows = await deps.controlRequests.findMany({
      where: { organizationId },
      select: {
        id: true,
        scope: true,
        target: true,
        state: true,
        appliedAt: true,
        confirmedAt: true,
        expiresAt: true,
        requestedBy: true,
      },
    });
    const byScope = new Map<string, ControlSnapshot>();
    for (const scope of KILL_SWITCH_SCOPES) {
      const scopeRows = rows.filter((row) => row.scope === scope);
      byScope.set(scope, scopeRows.length > 0 ? toSnapshot(scopeRows, at) : NO_CONTROL);
    }
    for (const [scope, snapshot] of byScope) {
      cache.set(key(organizationId, scope), { at, snapshot });
    }
    lastKnownAt.set(organizationId, at);
    return byScope;
  }

  function fresh(organizationId: string, scope: string, at: number): ControlSnapshot | null {
    const entry = cache.get(key(organizationId, scope));
    if (!entry) return null;
    if (at - entry.at > ttlMs) return null;
    return entry.snapshot;
  }

  async function effectiveFor(
    scope: string,
    organizationId: string,
  ): Promise<EffectiveKillSwitch> {
    const at = now();
    const atMs = at.getTime();

    // 非法 scope：I4（未知 = disabled）
    if (!isKnownScope(scope)) {
      return {
        scope: scope as KillSwitchScope,
        value: 'disabled',
        source: 'fail-closed',
        controlState: 'NONE',
        degraded: false,
        stale: false,
        evaluatedAt: at.toISOString(),
        cacheHit: false,
      };
    }

    // 配置层短路：Global HARD DISABLED 无需读控制面（也天然免疫 DB 故障）
    const globalRaw = deps.config?.global?.[scope];
    if (globalRaw !== undefined) {
      const parsedGlobal = parseKillSwitchValue(globalRaw);
      if (parsedGlobal === null) {
        return failClosed(scope, at);
      }
      if (parsedGlobal === 'disabled') {
        return {
          scope,
          value: 'disabled',
          source: 'global-hard-disabled',
          controlState: cache.get(key(organizationId, scope))?.snapshot.state ?? 'NONE',
          degraded: false,
          stale: false,
          evaluatedAt: at.toISOString(),
          cacheHit: false,
        };
      }
    }

    let control: ControlSnapshot;
    let cacheHit = false;
    let degraded = false;
    let stale = false;
    try {
      const cached = fresh(organizationId, scope, atMs);
      if (cached) {
        control = cached;
        cacheHit = true;
      } else {
        const loaded = await loadOrganizationControl(organizationId, atMs);
        control = loaded.get(scope) ?? NO_CONTROL;
      }
    } catch (error) {
      // I4：解析器失败不得放行业务动作
      const isObservability = scope === 'observability';
      const lastKnown = lastKnownAt.get(organizationId);
      const cachedEntry = cache.get(key(organizationId, scope));
      deps.log?.('killswitch.resolver_degraded', {
        scope,
        reason: error instanceof Error ? error.name : 'unknown',
      });
      if (isObservability && cachedEntry) {
        // 仅 observability：允许返回上次已知值，但必须显式标记陈旧
        const projected = projectEffectiveValue(scope, organizationId, deps.config, cachedEntry.snapshot);
        return {
          scope,
          value: projected.value,
          source: projected.source,
          controlState: cachedEntry.snapshot.state,
          degraded: true,
          stale: true,
          evaluatedAt: new Date(lastKnown ?? cachedEntry.at).toISOString(),
          cacheHit: true,
        };
      }
      if (isObservability) {
        // 没有任何上次已知值：使用环境默认并标降级（不阻塞监控；不是陈旧值）
        return {
          scope,
          value: KILL_SWITCH_DEFAULTS[scope],
          source: 'environment-default',
          controlState: 'NONE',
          degraded: true,
          stale: false,
          evaluatedAt: at.toISOString(),
          cacheHit: false,
        };
      }
      return failClosed(scope, at, { degraded: true });
    }

    const projected = projectEffectiveValue(scope, organizationId, deps.config, control);
    const degradedDefault =
      !degraded && !stale && projected.value === 'disabled' && projected.source === 'environment-default';
    void degradedDefault;
    return {
      scope,
      value: projected.value,
      source: projected.source,
      controlState: control.state,
      degraded,
      stale,
      evaluatedAt: at.toISOString(),
      cacheHit,
    };
  }

  function failClosed(
    scope: KillSwitchScope,
    at: Date,
    flags: { degraded?: boolean } = {},
  ): EffectiveKillSwitch {
    return {
      scope,
      value: 'disabled',
      source: 'fail-closed',
      controlState: 'NONE',
      degraded: flags.degraded ?? false,
      stale: false,
      evaluatedAt: at.toISOString(),
      cacheHit: false,
    };
  }

  return {
    async resolve(scope: string, organizationId: string): Promise<EffectiveKillSwitch> {
      return effectiveFor(scope, organizationId);
    },
    async resolveAll(organizationId: string): Promise<EffectiveKillSwitch[]> {
      const results: EffectiveKillSwitch[] = [];
      for (const scope of KILL_SWITCH_SCOPES) {
        results.push(await effectiveFor(scope, organizationId));
      }
      return results;
    },
    invalidate(organizationId: string, scope?: string): void {
      if (scope) {
        cache.delete(key(organizationId, scope));
        return;
      }
      for (const known of KILL_SWITCH_SCOPES) cache.delete(key(organizationId, known));
    },
  };
}
