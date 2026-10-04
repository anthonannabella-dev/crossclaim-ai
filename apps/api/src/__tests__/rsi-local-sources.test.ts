/** 本地只读源验收：CI/verdict/测试解析、缺失静默、非法 JSON 不阻断、只读边界。 */

import { describe, expect, it } from 'vitest';

import {
  RSI_LOCAL_SOURCES_BOUNDARY,
  createLocalEventSources,
  parseCiResults,
  parseTestResults,
  parseVerdict,
  type RsiReadFile,
} from '../runtime/rsi-local-sources';

const files = (map: Record<string, string>): RsiReadFile => async (path) => {
  const value = map[path];
  if (value === undefined) throw new Error('ENOENT');
  return value;
};

describe('RSI 本地只读源', () => {
  it('RSI_LOCAL_SOURCES_PARSE_ARTIFACTS：CI / verdict / 测试结果按契约解析，非法行被跳过', async () => {
    const ci = parseCiResults(
      JSON.stringify([
        { runId: '1', head: 'aaa', status: 'completed', conclusion: 'failure' },
        { runId: '2', head: 'bbb', status: 'in_progress', conclusion: null },
        { runId: 'bad' }, // 缺字段 → 跳过
        'nonsense',
      ]),
    );
    expect(ci).toEqual([
      { runId: '1', head: 'aaa', status: 'completed', conclusion: 'failure' },
      { runId: '2', head: 'bbb', status: 'in_progress', conclusion: null },
    ]);

    expect(parseVerdict('{"messageId":"m1","verdict":"REVISE"}')).toEqual({ messageId: 'm1', verdict: 'REVISE' });
    expect(parseVerdict('{"messageId":"m1","verdict":"MAYBE"}')).toBeUndefined();
    expect(parseTestResults('{"fingerprint":"t1","passed":false}')).toEqual({ fingerprint: 't1', passed: false });
    expect(parseTestResults('not json')).toBeUndefined();
  });

  it('RSI_LOCAL_SOURCES_MISSING_ARTIFACT_IS_SILENT：文件缺失/非法 JSON → 该源静默返回 undefined', async () => {
    const sources = createLocalEventSources({
      readFile: files({ '/verdict.json': '{"messageId":"m1","verdict":"PASS"}', '/bad.json': '{oops' }),
      paths: { ciResultsPath: '/missing-ci.json', verdictPath: '/verdict.json', testResultsPath: '/bad.json' },
    });

    expect(await sources.readCi!()).toBeUndefined(); // 缺失 → 静默
    expect(await sources.readVerdict!()).toEqual({ messageId: 'm1', verdict: 'PASS' });
    expect(await sources.readTests!()).toBeUndefined(); // 非法 JSON → 静默

    // 未配置路径的源也应静默
    const bare = createLocalEventSources({ readFile: files({}), paths: {} });
    expect(await bare.readCi!()).toBeUndefined();
    expect(await bare.readVerdict!()).toBeUndefined();
    expect(await bare.readTests!()).toBeUndefined();
  });

  it('RSI_LOCAL_SOURCES_BOUNDARY_READONLY：只读边界自证', () => {
    expect(RSI_LOCAL_SOURCES_BOUNDARY.readOnly).toBe(true);
    expect(RSI_LOCAL_SOURCES_BOUNDARY.writesFiles).toBe(false);
    expect(RSI_LOCAL_SOURCES_BOUNDARY.performsNetworkCalls).toBe(false);
    expect(RSI_LOCAL_SOURCES_BOUNDARY.readsCredentials).toBe(false);
    expect(RSI_LOCAL_SOURCES_BOUNDARY.silentOnMissingArtifact).toBe(true);
  });
});
