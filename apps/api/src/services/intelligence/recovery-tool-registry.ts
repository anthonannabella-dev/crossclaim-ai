/**
 * Recovery SI —— 受控工具注册表（Phase 1）
 * ---------------------------------------------------------------
 * 目标：**不允许模型直接调用任意 service**。所有能力必须显式登记，且只允许
 * `READ` / `PLAN` / `PREPARE` 三类访问级别；真实提交类工具在本阶段**不登记、不自动解锁**。
 *
 * fail-closed 规则：
 *   · 未登记工具 → `TOOL_NOT_REGISTERED`；
 *   · 名字命中执行类模式（submit/file/pay/capture/transport/credential…）→ `TOOL_NAME_FORBIDDEN`；
 *   · 访问级别不是 READ/PLAN/PREPARE → `TOOL_ACCESS_NOT_ALLOWED_IN_PHASE1`；
 *   · 调用缺少 tenant 上下文 → `TENANT_CONTEXT_REQUIRED`；
 *   · 重复登记同名工具 → 直接拒绝注册（`DUPLICATE_TOOL`）；
 *   · 工具返回体若含 secret/credential/token 字段 → `FORBIDDEN_TOOL_OUTPUT`（不落库、不外传）。
 */

import type { RecoveryDomain } from './customer-recovery-state';

export const RECOVERY_TOOL_ACCESS = ['READ', 'PLAN', 'PREPARE'] as const;
export type RecoveryToolAccess = (typeof RECOVERY_TOOL_ACCESS)[number];

export interface RecoveryToolContext {
  organizationId: string;
}

export interface RecoveryTool<Input = unknown, Output = unknown> {
  name: string;
  domain: RecoveryDomain | 'SETTLEMENT' | 'PAYMENT' | 'CLAIM';
  access: RecoveryToolAccess;
  description: string;
  invoke(input: Input, ctx: RecoveryToolContext): Promise<Output>;
}

export type RecoveryToolInvokeResult<Output = unknown> =
  | { ok: true; tool: string; output: Output }
  | {
      ok: false;
      reason:
        | 'TOOL_NOT_REGISTERED'
        | 'TOOL_NAME_FORBIDDEN'
        | 'TOOL_ACCESS_NOT_ALLOWED_IN_PHASE1'
        | 'TENANT_CONTEXT_REQUIRED'
        | 'FORBIDDEN_TOOL_OUTPUT'
        | 'TOOL_THREW';
      tool: string;
      detail?: string;
    };

/** Phase 1 明确禁止登记的执行类工具名模式 */
const FORBIDDEN_TOOL_NAME_PATTERN = /(submit|file|filing|pay|capture|transport|credential|secret|external[-_.]?write)/i;
const FORBIDDEN_OUTPUT_KEYS = /^(api_?key|api_?secret|secret|client_?secret|credential|credentials|password|passwd|access_?token|refresh_?token|bearer_?token|auth_?token|private_?key)$/i;

const hasForbiddenOutputField = (value: unknown, depth = 0): boolean => {
  if (depth > 4 || value === null || typeof value !== 'object') return false;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_OUTPUT_KEYS.test(key)) return true;
    if (hasForbiddenOutputField(nested, depth + 1)) return true;
  }
  return false;
};

export interface RecoveryToolRegistry {
  list(): readonly { name: string; domain: RecoveryTool['domain']; access: RecoveryToolAccess; description: string }[];
  has(name: string): boolean;
  invoke<Output = unknown>(
    name: string,
    input: unknown,
    ctx: RecoveryToolContext,
  ): Promise<RecoveryToolInvokeResult<Output>>;
}

export function createRecoveryToolRegistry(
  tools: readonly RecoveryTool[],
): RecoveryToolRegistry & { registrationErrors: readonly { name: string; reason: string }[] } {
  const registered = new Map<string, RecoveryTool>();
  const registrationErrors: { name: string; reason: string }[] = [];

  for (const tool of tools) {
    if (FORBIDDEN_TOOL_NAME_PATTERN.test(tool.name)) {
      registrationErrors.push({ name: tool.name, reason: 'TOOL_NAME_FORBIDDEN' });
      continue;
    }
    if (!(RECOVERY_TOOL_ACCESS as readonly string[]).includes(tool.access)) {
      registrationErrors.push({ name: tool.name, reason: 'TOOL_ACCESS_NOT_ALLOWED_IN_PHASE1' });
      continue;
    }
    if (registered.has(tool.name)) {
      registrationErrors.push({ name: tool.name, reason: 'DUPLICATE_TOOL' });
      continue;
    }
    registered.set(tool.name, tool);
  }

  return {
    registrationErrors,
    list: () =>
      [...registered.values()].map((tool) => ({
        name: tool.name,
        domain: tool.domain,
        access: tool.access,
        description: tool.description,
      })),
    has: (name) => registered.has(name),
    async invoke<Output = unknown>(
      name: string,
      input: unknown,
      ctx: RecoveryToolContext,
    ): Promise<RecoveryToolInvokeResult<Output>> {
      const tool = registered.get(name);
      if (tool === undefined) return { ok: false, reason: 'TOOL_NOT_REGISTERED', tool: name };
      if (typeof ctx?.organizationId !== 'string' || ctx.organizationId.trim() === '') {
        return { ok: false, reason: 'TENANT_CONTEXT_REQUIRED', tool: name };
      }
      try {
        const output = (await tool.invoke(input, ctx)) as unknown;
        if (hasForbiddenOutputField(output)) {
          return { ok: false, reason: 'FORBIDDEN_TOOL_OUTPUT', tool: name };
        }
        return { ok: true, tool: name, output: output as Output };
      } catch (error) {
        return {
          ok: false,
          reason: 'TOOL_THREW',
          tool: name,
          detail: error instanceof Error ? error.message : 'unknown',
        };
      }
    },
  };
}

export const RECOVERY_TOOL_REGISTRY_BOUNDARY = {
  explicitRegistrationOnly: true,
  unknownToolFailsClosed: true,
  modelCannotInventToolNames: true,
  directDatabaseMutation: false,
  providerCredentialAccess: false,
  phase1AccessLevels: RECOVERY_TOOL_ACCESS,
  executionToolsRegistered: false,
} as const;
