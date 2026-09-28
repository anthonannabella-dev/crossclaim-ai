#!/usr/bin/env node
/**
 * CrossClaim agent-bridge · Watcher
 * ---------------------------------------------------------------
 * 作用：轮询 GitHub，发现 ChatGPT 侧的新裁决/新评论；没有新消息则静默。
 *
 * ⚠️ DETECTION ONLY（仅检测）：
 *   本脚本只做「轮询 → 解析 → 打印」。它不会唤醒任何 Agent、
 *   不会执行裁决、不会提交/合并/部署。执行环节由被唤醒的 Codex 会话
 *   或宿主完成。请勿把它描述为无人值守闭环。
 *
 * 设计要点：
 *   - 令牌只从环境变量读取（GITHUB_TOKEN / GH_TOKEN），绝不落盘
 *   - 已处理 ID 持久化到 .state/lastSeen.json，保证幂等（同一条回复不会被处理两次）
 *   - 只读：本脚本不向 GitHub 写任何东西
 *
 * 用法：
 *   GITHUB_TOKEN=xxx node watcher.mjs --once     # 跑一轮（适合放进定时任务）
 *   GITHUB_TOKEN=xxx node watcher.mjs            # 持续轮询
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = path.join(HERE, '.state');
const STATE_FILE = path.join(STATE_DIR, 'lastSeen.json');

const REPO = process.env.CROSSCLAIM_REPO || 'anthonannabella-dev/crossclaim-ai';
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
const INTERVAL_MS = Number(process.env.WATCH_INTERVAL_MS || 4 * 60 * 1000);
const ONCE = process.argv.includes('--once');
const BRIDGE_ISSUE_PREFIX = 'AI-BRIDGE';

const API = 'https://api.github.com';

function log(...args) {
  console.log('[bridge]', ...args);
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { issueComments: 0, prComments: {}, reviews: {} };
  }
}

function saveState(state) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(
    STATE_FILE,
    JSON.stringify({ ...state, lastRun: new Date().toISOString() }, null, 2),
  );
}

async function gh(pathname) {
  if (!TOKEN) {
    throw new Error('缺少 GITHUB_TOKEN（只读即可）。令牌不会被写入任何文件。');
  }
  const res = await fetch(API + pathname, {
    headers: {
      Authorization: 'Bearer ' + TOKEN,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'crossclaim-agent-bridge',
    },
  });
  if (!res.ok) throw new Error('GitHub ' + res.status + ' on ' + pathname);
  return res.json();
}

/** 解析 [CHATGPT -> CODEX] 回复块 */
function parseVerdict(body) {
  if (!body || !body.includes('CHATGPT')) return null;
  const verdictMatch = body.match(/VERDICT\s*:?\s*\n?\s*(PASS|REVISE|BLOCK)/i);
  if (!verdictMatch) return null;
  const grab = (label) => {
    const re = new RegExp(label + '\\s*:?\\s*\\n([\\s\\S]*?)(?=\\n[A-Z_]{3,}\\s*:|$)', 'i');
    const m = body.match(re);
    return m ? m[1].trim() : null;
  };
  return {
    verdict: verdictMatch[1].toUpperCase(),
    keep: grab('KEEP'),
    change: grab('CHANGE'),
    risks: grab('RISKS'),
    test: grab('TEST'),
    next: grab('NEXT'),
  };
}

async function findBridgeIssue() {
  const issues = await gh('/repos/' + REPO + '/issues?state=all&per_page=100');
  return issues.find((i) => !i.pull_request && i.title.startsWith(BRIDGE_ISSUE_PREFIX)) || null;
}

async function runOnce(state) {
  const findings = [];

  const issue = await findBridgeIssue();
  if (issue) {
    const comments = await gh('/repos/' + REPO + '/issues/' + issue.number + '/comments?per_page=100');
    for (const c of comments.filter((x) => x.id > (state.issueComments || 0))) {
      findings.push({
        channel: 'AI-BRIDGE#' + issue.number,
        id: c.id,
        author: c.user.login,
        parsed: parseVerdict(c.body),
      });
      state.issueComments = Math.max(state.issueComments || 0, c.id);
    }
  }

  const prs = await gh('/repos/' + REPO + '/pulls?state=open&per_page=50');
  for (const pr of prs) {
    const comments = await gh('/repos/' + REPO + '/issues/' + pr.number + '/comments?per_page=100');
    const seen = state.prComments[pr.number] || 0;
    for (const c of comments.filter((x) => x.id > seen)) {
      findings.push({
        channel: 'PR#' + pr.number,
        id: c.id,
        author: c.user.login,
        parsed: parseVerdict(c.body),
      });
      state.prComments[pr.number] = Math.max(seen, c.id);
    }

    const reviews = await gh('/repos/' + REPO + '/pulls/' + pr.number + '/reviews?per_page=100');
    const seenReview = state.reviews[pr.number] || 0;
    for (const r of reviews.filter((x) => x.id > seenReview)) {
      findings.push({
        channel: 'PR#' + pr.number + ' review',
        id: r.id,
        author: r.user.login,
        state: r.state,
      });
      state.reviews[pr.number] = Math.max(seenReview, r.id);
    }
  }

  if (findings.length === 0) {
    // 章程 §十三：没有新消息不做任何动作（连日志都不打，避免噪声）
    return { changed: false };
  }

  log('发现 ' + findings.length + ' 条新消息');
  for (const f of findings) {
    log('- ' + f.channel + ' by ' + f.author + ' (id=' + f.id + ')');
    if (f.parsed) {
      log('  VERDICT: ' + (f.parsed.verdict || '(未解析到)'));
      if (f.parsed.next) log('  NEXT   : ' + f.parsed.next);
      if (f.parsed.change) log('  CHANGE : ' + f.parsed.change);
    }
  }
  return { changed: true };
}

async function main() {
  const state = loadState();

  if (ONCE) {
    await runOnce(state);
    saveState(state);
    return;
  }

  log('开始轮询 ' + REPO + '，间隔 ' + INTERVAL_MS / 1000 + 's（Ctrl+C 退出）');
  for (;;) {
    try {
      await runOnce(state);
      saveState(state);
    } catch (err) {
      // 网络/令牌问题不应让监视器退出；下一轮重试
      console.error('[bridge] 本轮失败：' + err.message);
    }
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }
}

main().catch((err) => {
  console.error('[bridge] 致命错误：' + err.message);
  process.exit(1);
});
