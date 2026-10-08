/**
 * PHASE 2 / CHANGE 4A（审计 MSG-20261008-20）—— 测试卫生与可诊断性
 * ---------------------------------------------------------------
 * 复审要求：
 *   · 保存完整测试日志（含**失败用例名、堆栈与测试数据库标记**）；
 *   · 收拢 S1/S3/S5 的客户端释放、数据清理与共享表竞争；
 *   · 对偶发失败用例实现隔离；固定环境下连续 ≥5 轮全套件通过后再提交记录。
 *
 * 本文件只提供**测试期**的确定性工具，不参与任何运行时路径
 * （文件名不以 `.test.ts` 结尾 ⇒ 不被 vitest 收集）：
 *   · `testDatabaseMarker()` —— 只回「主机:端口/库名」，**绝不回显用户名或口令**；
 *   · `unreachableDatabaseUrl()` —— 由**真实测试库 URL** 派生不可达 URL（换端口 + 换库名），
 *     避免在仓库里硬编码任何凭据字面量（S5 故障注入改用本函数）；
 *   · `uniqueTaskKeys()` —— 每轮独立任务键，避免共享表上的跨轮竞争。
 */

/** 测试数据库标记（可写入日志/汇报，用于区分「跑的是哪个库」；不含凭据） */
export function testDatabaseMarker(env: NodeJS.ProcessEnv = process.env): string {
  const url = env.DATABASE_URL;
  if (typeof url !== 'string' || url.trim() === '') return 'DB_MARKER_UNAVAILABLE';
  try {
    const parsed = new URL(url);
    const port = parsed.port === '' ? '5432' : parsed.port;
    return `${parsed.hostname}:${port}${parsed.pathname}`;
  } catch {
    return 'DB_MARKER_UNPARSEABLE';
  }
}

/**
 * 由真实测试库 URL 派生一个**不可达** URL（默认端口 55999）用于故障注入。
 * 保留真实主机/用户/口令结构，只改端口与库名 ⇒ 连接必然失败，且仓库内无凭据字面量。
 */
export function unreachableDatabaseUrl(
  options: { port?: string; database?: string; env?: NodeJS.ProcessEnv } = {},
): string {
  const env = options.env ?? process.env;
  const url = env.DATABASE_URL;
  if (typeof url !== 'string' || url.trim() === '') {
    throw new Error('TEST_DB_URL_MISSING: DATABASE_URL 未设置，无法派生故障注入 URL');
  }
  const parsed = new URL(url);
  parsed.port = options.port ?? '55999';
  parsed.pathname = '/' + (options.database ?? 'crossclaim_unreachable');
  return parsed.toString();
}

/** 每轮独立的任务键：`<prefix><suffix>-<index>`，避免跨轮共享表上的键冲突 */
export function uniqueTaskKeys(prefix: string, count: number, suffix: string): readonly string[] {
  return Array.from({ length: count }, (_, index) => `${prefix}${suffix}-${index}`);
}
