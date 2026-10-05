/**
 * RSI 项目执行器（RSI-RT-01 收尾）：把「跑目标测试」变成可注入的默认执行器
 * ---------------------------------------------------------------
 * 复用已验收的 createCommandRunner（白名单 + 无 shell + 超时 BLOCK + 摘要证据），其之上只做两件事：
 *   1) 产出证据引用 test:<sha256:12>（可带 head:<sha>: 前缀，便于与提交关联）；
 *   2) 可选地把证据 artifact（JSON）写到指定路径，供只读事件源消费（不含 stdout/stderr 原文）。
 * 命令与参数只来自配置，绝不来自 task 数据；不读凭据、不写库、不外写。
 */

import { createCommandRunner, type RsiCommandRunnerInput, type RsiEvidenceRunner, type RsiRunnerEvidence } from './rsi-task-runner';

export interface RsiEvidenceArtifact {
  kind: 'RSI_TEST_EVIDENCE';
  status: 'PASS' | 'REVISE' | 'BLOCK';
  evidenceRef: string;
  head: string | null;
  finishedAt: string;
  exitCode: number | null;
  durationMs: number | null;
}

export interface RsiProjectExecutorOptions extends RsiCommandRunnerInput {
  /** 可选：证据 artifact 的写入路径（写入函数由宿主提供，保持本模块无额外 I/O 依赖）。 */
  evidencePath?: string;
  writeEvidence?: (path: string, content: string) => Promise<void>;
  /** 可选：关联提交，写入 evidenceRef 前缀 head:<sha>:。 */
  head?: string;
  now?: () => Date;
}

export function createProjectTestExecutor(options: RsiProjectExecutorOptions): RsiEvidenceRunner {
  const inner = createCommandRunner(options);
  const now = options.now ?? (() => new Date());

  return {
    async run(task): Promise<RsiRunnerEvidence> {
      const result = await inner.run(task);
      const digest = (result.stdoutDigest ?? 'unknown').slice(0, 12);
      const headPrefix = typeof options.head === 'string' && options.head !== '' ? `head:${options.head}:` : '';
      const evidenceRef = result.status === 'PASS' ? `${headPrefix}test:${digest}` : `${headPrefix}test-refused:${digest}`;

      if (options.evidencePath !== undefined && options.writeEvidence !== undefined && result.status === 'PASS') {
        const artifact: RsiEvidenceArtifact = {
          kind: 'RSI_TEST_EVIDENCE',
          status: result.status,
          evidenceRef,
          head: options.head ?? null,
          finishedAt: now().toISOString(),
          exitCode: result.exitCode ?? null,
          durationMs: result.durationMs ?? null,
        };
        try {
          await options.writeEvidence(options.evidencePath, JSON.stringify(artifact, null, 2) + '\n');
          options.log?.(`RSI_EVIDENCE_ARTIFACT_WRITTEN path=${options.evidencePath} ref=${evidenceRef}`);
        } catch {
          // 证据写失败绝不能变成 PASS：降级 BLOCK，避免「无证据的成功」。
          options.log?.('RSI_EVIDENCE_ARTIFACT_WRITE_FAILED -> BLOCK');
          return { ...result, status: 'BLOCK', evidenceRef: 'evidence-write-failed' };
        }
      }
      return { ...result, evidenceRef };
    },
  };
}

export const RSI_PROJECT_EXECUTOR_BOUNDARY = {
  reusesAllowlistedCommandRunner: true,
  taskDataNeverBecomesCommand: true,
  evidenceArtifactIsDigestOnly: true,
  artifactWriteFailureYieldsBlock: true,
  readsCredentials: false,
  writesDatabase: false,
  performsExternalWrite: false,
} as const;
