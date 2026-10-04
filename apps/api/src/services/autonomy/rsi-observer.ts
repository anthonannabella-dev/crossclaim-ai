/**
 * RSI Phase-1 —— 只读 Observer（纯函数，零 IO / 零外写）
 * ---------------------------------------------------------------
 * 从**已有产物**生成脱敏信号：CI 运行结果、测试输出、backlog/HEAD 状态。
 * 硬规则：
 *   · 只读观察，绝不写库、绝不调 provider、绝不读凭据与客户数据；
 *   · 一切文本先过 `sanitizeSignalText()`：邮箱 / 电话 / 长数字串 / 带 token 的 URL / 绝对路径 → 打码；
 *   · **没有问题就不产生信号**（不需要用噪声证明系统在运行）；
 *   · 每个信号带 `dedupeKey`，供 RSI-P1-03 去重，避免同因重复建任务。
 */

export const RSI_SIGNAL_KINDS = [
  'CI_FAIL',
  'TEST_FAILURE',
  'TYPECHECK_FAILURE',
  'BACKLOG_STALL',
] as const;
export type RsiSignalKind = (typeof RSI_SIGNAL_KINDS)[number];

export interface RsiSignal {
  kind: RsiSignalKind;
  /** 用于去重的稳定键（同因只建一次任务）。 */
  dedupeKey: string;
  /** 已脱敏的一句话摘要。 */
  summary: string;
  /** 可追溯的只读引用（例如 run id、文件相对路径、commit）。 */
  refs: readonly string[];
  /** 观察到的风险等级（决定是否需要审计与 OWNER 参与）。 */
  riskClass: 'LOW' | 'MEDIUM' | 'HIGH';
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE_RE = /\+?\d[\d\s-]{7,}\d/g;
const LONG_DIGITS_RE = /\b\d{6,}\b/g;
const TOKEN_URL_RE = /https?:\/\/[^\s]*[?&](token|key|secret|signature)=[^\s&]+/gi;
const ABS_PATH_RE = /[A-Za-z]:\\(?:[^\\\s]+\\)+/g;

/** 脱敏：去掉一切可能变成 PII / 凭据 / 本机信息的内容。 */
export function sanitizeSignalText(text: string): string {
  return text
    .replace(TOKEN_URL_RE, 'https://[redacted-url]')
    .replace(EMAIL_RE, '[redacted-email]')
    .replace(PHONE_RE, '[redacted-phone]')
    .replace(LONG_DIGITS_RE, '[redacted-number]')
    .replace(ABS_PATH_RE, '[redacted-path]')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface RsiCiRunObservation {
  head: string;
  status: 'completed' | 'in_progress' | 'queued';
  conclusion: 'success' | 'failure' | null;
  runId: string;
}

/** CI 观察：只有 completed **且 conclusion=failure** 才产生信号；in_progress / success 一律静默。 */
export function observeCiRuns(runs: readonly RsiCiRunObservation[]): readonly RsiSignal[] {
  return runs
    .filter((run) => run.status === 'completed' && run.conclusion === 'failure')
    .map((run) => ({
      kind: 'CI_FAIL' as const,
      dedupeKey: `CI_FAIL:${run.head}:${run.runId}`,
      summary: sanitizeSignalText(`CI failed on ${run.head} (run ${run.runId})`),
      refs: [`run:${run.runId}`, `head:${run.head}`],
      riskClass: 'MEDIUM' as const,
    }));
}

const TEST_FAIL_RE = /^\s*(?:×|FAIL|✗)\s+(.+)$/;
const TSC_ERROR_RE = /(error TS\d+: .+)$/;

/** 测试 / 类型检查输出观察：只提取失败用例与 TS 错误，且全部脱敏。 */
export function observeBuildOutput(output: string, ref: string): readonly RsiSignal[] {
  const signals: RsiSignal[] = [];
  for (const line of output.split('\n')) {
    const tsc = TSC_ERROR_RE.exec(line);
    if (tsc) {
      const summary = sanitizeSignalText(tsc[1]!);
      signals.push({
        kind: 'TYPECHECK_FAILURE',
        dedupeKey: `TYPECHECK_FAILURE:${summary}`,
        summary,
        refs: [ref],
        riskClass: 'MEDIUM',
      });
      continue;
    }
    const test = TEST_FAIL_RE.exec(line);
    if (test) {
      const summary = sanitizeSignalText(test[1]!);
      signals.push({
        kind: 'TEST_FAILURE',
        dedupeKey: `TEST_FAILURE:${summary}`,
        summary,
        refs: [ref],
        riskClass: 'LOW',
      });
    }
  }
  return signals;
}

/** Backlog / HEAD 观察：队列非空且 HEAD 连续两轮未前进 → BACKLOG_STALL（防停机看门狗的核心信号）。 */
export function observeBacklogStall(input: {
  queueLength: number;
  headAtPreviousTick: string | null;
  headNow: string;
}): readonly RsiSignal[] {
  if (input.queueLength === 0) return [];
  if (input.headAtPreviousTick === null) return [];
  if (input.headAtPreviousTick !== input.headNow) return [];
  return [
    {
      kind: 'BACKLOG_STALL',
      dedupeKey: `BACKLOG_STALL:${input.headNow}`,
      summary: sanitizeSignalText(
        `HEAD unchanged at ${input.headNow} across two ticks with ${input.queueLength} queued unit(s)`,
      ),
      refs: [`head:${input.headNow}`],
      riskClass: 'MEDIUM',
    },
  ];
}
