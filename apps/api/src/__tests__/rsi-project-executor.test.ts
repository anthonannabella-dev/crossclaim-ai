/** RSI 项目执行器验收：真命令 + 证据 artifact；写证据失败不得变成 PASS。 */

import { describe, expect, it } from 'vitest';

import {
  createProjectTestExecutor,
  RSI_PROJECT_EXECUTOR_BOUNDARY,
  type RsiEvidenceArtifact,
} from '../runtime/rsi-project-executor';
import type { RsiSafeTask } from '../services/autonomy/rsi-continuation-engine';

const task: RsiSafeTask = { id: 'A', priority: 'P1', dedupeKey: 'd:A' };
const node = process.execPath;

describe('RSI 项目执行器', () => {
  it('RUNS_TESTS_AND_EMITS_EVIDENCE_ARTIFACT：退出 0 → PASS + 证据 artifact', async () => {
    const writes: { path: string; content: string }[] = [];
    const executor = createProjectTestExecutor({
      command: node,
      args: ['-e', 'console.log("targeted-tests-ok")'],
      head: 'abcdef1',
      evidencePath: '/tmp/rsi-evidence.json',
      writeEvidence: async (path, content) => {
        writes.push({ path, content });
      },
    });

    const result = await executor.run(task);
    expect(result.status).toBe('PASS');
    expect(result.evidenceRef.startsWith('head:abcdef1:test:')).toBe(true);
    expect(writes).toHaveLength(1);
    const artifact = JSON.parse(writes[0]!.content) as RsiEvidenceArtifact;
    expect(artifact.kind).toBe('RSI_TEST_EVIDENCE');
    expect(artifact.status).toBe('PASS');
    expect(artifact.head).toBe('abcdef1');
    expect(writes[0]!.content).not.toContain('targeted-tests-ok'); // 只留摘要
  });

  it('FAILING_TESTS_ARE_REVISE_AND_WRITE_NO_EVIDENCE：非 0 → REVISE 且不写证据', async () => {
    const writes: string[] = [];
    const executor = createProjectTestExecutor({
      command: node,
      args: ['-e', 'process.exit(2)'],
      evidencePath: '/tmp/rsi-evidence.json',
      writeEvidence: async (_path, content) => {
        writes.push(content);
      },
    });
    const result = await executor.run(task);
    expect(result.status).toBe('REVISE');
    expect(result.evidenceRef).toContain('test-refused:');
    expect(writes).toHaveLength(0);
  });

  it('ARTIFACT_WRITE_FAILURE_BLOCKS：证据写失败 → BLOCK（不得成为无证据的 PASS）', async () => {
    const executor = createProjectTestExecutor({
      command: node,
      args: ['-e', 'console.log(1)'],
      evidencePath: '/tmp/rsi-evidence.json',
      writeEvidence: async () => {
        throw new Error('disk full');
      },
    });
    const result = await executor.run(task);
    expect(result.status).toBe('BLOCK');
    expect(result.evidenceRef).toBe('evidence-write-failed');
  });

  it('BOUNDARY：复用白名单执行器、只留摘要、失败即 BLOCK', () => {
    expect(RSI_PROJECT_EXECUTOR_BOUNDARY.reusesAllowlistedCommandRunner).toBe(true);
    expect(RSI_PROJECT_EXECUTOR_BOUNDARY.taskDataNeverBecomesCommand).toBe(true);
    expect(RSI_PROJECT_EXECUTOR_BOUNDARY.evidenceArtifactIsDigestOnly).toBe(true);
    expect(RSI_PROJECT_EXECUTOR_BOUNDARY.artifactWriteFailureYieldsBlock).toBe(true);
    expect(RSI_PROJECT_EXECUTOR_BOUNDARY.performsExternalWrite).toBe(false);
  });
});
