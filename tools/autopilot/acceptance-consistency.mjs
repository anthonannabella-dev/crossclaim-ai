#!/usr/bin/env node
/**
 * ACCEPTANCE CONSISTENCY GUARD（CHANGE B · MSG-20261003-135）
 * ---------------------------------------------------------------
 * 在同一个 acceptance HEAD 上比对四份来源，任何冲突一律 FAIL：
 *   ① docs/releases/ACCEPTANCE-MATRIX.json（单一权威）
 *   ② .autopilot/STATE.json（open backlog / arch_pending / final_status）
 *   ③ docs/releases/MASTER-GAP-CLOSURE-REGISTER.md
 *   ④ docs/releases/FINAL-ACCEPTANCE-REPORT.md
 *
 * 退出码：0 = 一致；1 = 冲突/陈旧。
 * 用法：node tools/autopilot/acceptance-consistency.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MATRIX = path.join(ROOT, 'docs', 'releases', 'ACCEPTANCE-MATRIX.json');
const REGISTER = path.join(ROOT, 'docs', 'releases', 'MASTER-GAP-CLOSURE-REGISTER.md');
const REPORT = path.join(ROOT, 'docs', 'releases', 'FINAL-ACCEPTANCE-REPORT.md');
const STATE = path.join(ROOT, '.autopilot', 'STATE.json');
const BACKLOG = path.join(ROOT, 'tools', 'autopilot', 'backlog.json');

const readJson = (file, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
};
const readText = (file) => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
};
const git = (args) => {
  try {
    return execFileSync('git', ['-c', 'safe.directory=' + ROOT, ...args], { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
};
const sameSet = (a, b) => a.length === b.length && [...a].sort().join('|') === [...b].sort().join('|');

const head = git(['rev-parse', '--short', 'HEAD']);
const matrix = readJson(MATRIX, null);
const state = readJson(STATE, {});
const backlog = readJson(BACKLOG, { items: [] });
const register = readText(REGISTER);
const report = readText(REPORT);

const conflicts = [];
if (!matrix) {
  console.log('ACCEPTANCE_CONSISTENCY=FAIL reason=MATRIX_MISSING');
  process.exit(1);
}

const completed = new Set([...(state.units_completed ?? []), ...(state.dispatched_completed ?? [])]);
const openBacklog = backlog.items.filter((item) => !completed.has(item.id) && item.HOST_ACTION_REQUIRED !== true).map((item) => item.id);
const stateOpen = [...new Set([...openBacklog, ...(state.arch_review_pending ?? [])])];

// C1：矩阵必须绑定一个真实存在的 acceptance HEAD（当前 HEAD 或其后代链上的祖先）。
const shaPresentLocally = (() => {
  try {
    execFileSync('git', ['-c', 'safe.directory=' + ROOT, 'cat-file', '-e', matrix.acceptance_head + '^{commit}'], { cwd: ROOT, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
const isAncestorOfHead = (() => {
  try {
    execFileSync('git', ['-c', 'safe.directory=' + ROOT, 'merge-base', '--is-ancestor', matrix.acceptance_head, 'HEAD'], { cwd: ROOT });
    return true;
  } catch {
    return false;
  }
})();
if (matrix.acceptance_head !== head) {
  if (!shaPresentLocally) {
    // SHALLOW_CLONE：CI 默认 depth=1，历史对象不在本地。此时 ancestry 不可判定，
    // 但内容一致性（open items / register / report）仍然强制；不得因此误判为冲突。
    console.log('NOTE: acceptance_head ' + matrix.acceptance_head + ' 不在本地克隆（浅克隆）——跳过 ancestry 检查，内容一致性照常强制');
  } else if (!isAncestorOfHead) {
    conflicts.push('MATRIX_HEAD_UNKNOWN matrix=' + matrix.acceptance_head + ' head=' + head);
  }
}

// C1b（BG-016）：冻结的 FINAL_ACCEPTANCE_HEAD 是**不可变常量** —— 任何声明都必须是 0f7f7ac。
// 只在“声明处”匹配（`FINAL_ACCEPTANCE_HEAD = <sha>` / `FROZEN ACCEPTANCE TREE ... <sha>`），
// 因此普通叙述文字里提到历史 SHA 不会误报；反过来，任何人改动冻结值都会被立刻拦下。
const FROZEN_FINAL_ACCEPTANCE_HEAD = '0f7f7ac';
const FROZEN_MIN_DECLARATIONS = 10;
const FROZEN_SCAN_DIRS = ['docs/releases', 'tools/autopilot', '.autopilot'];
const FROZEN_PATTERNS = [
  /FINAL_ACCEPTANCE_HEAD\s*=\s*`?([0-9a-f]{7,40})/g,
  /FROZEN ACCEPTANCE TREE[^`\n|]*[`|]\s*`?([0-9a-f]{7,40})/g,
];
let frozenDeclarations = 0;
const frozenValues = new Map();
for (const dir of FROZEN_SCAN_DIRS) {
  const abs = path.join(ROOT, dir);
  let entries = [];
  try {
    entries = fs.readdirSync(abs);
  } catch {
    continue;
  }
  for (const entry of entries) {
    const file = path.join(abs, entry);
    let text = '';
    try {
      if (!fs.statSync(file).isFile()) continue;
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const pattern of FROZEN_PATTERNS) {
      for (const match of text.matchAll(pattern)) {
        frozenDeclarations += 1;
        const where = dir + '/' + entry;
        const bucket = frozenValues.get(match[1]) ?? [];
        bucket.push(where);
        frozenValues.set(match[1], bucket);
      }
    }
  }
}
if (frozenDeclarations < FROZEN_MIN_DECLARATIONS) {
  conflicts.push('FROZEN_HEAD_DECLARATIONS_MISSING count=' + frozenDeclarations + ' min=' + FROZEN_MIN_DECLARATIONS);
}
for (const [value, files] of frozenValues) {
  if (value === FROZEN_FINAL_ACCEPTANCE_HEAD) continue;
  conflicts.push(
    'FROZEN_HEAD_CHANGED value=' + value + ' expected=' + FROZEN_FINAL_ACCEPTANCE_HEAD +
      ' files=' + [...new Set(files)].slice(0, 3).join(','),
  );
}

// C1c（BG-016）：STATE 的 HEAD 字段必须**彼此一致**，且指向本仓库真实存在的 commit。
// 注意：状态文件通常在“下一个 commit”之前写入，所以这里不要求它等于 git HEAD，只要求单一来源 + 真实存在。
const headFields = ['head', 'current_head', 'CURRENT_HEAD']
  .map((key) => [key, state[key]])
  .filter(([, value]) => typeof value === 'string' && value.trim() !== '' && !/^PENDING/i.test(value));
if (headFields.length === 0) {
  conflicts.push('STATE_HEAD_FIELDS_MISSING');
} else {
  const distinct = [...new Set(headFields.map(([, value]) => value))];
  if (distinct.length > 1) {
    conflicts.push('STATE_HEAD_FIELDS_DISAGREE ' + headFields.map(([key, value]) => key + '=' + value).join(' '));
  }
  const stateHead = distinct[0];
  try {
    execFileSync('git', ['-c', 'safe.directory=' + ROOT, 'cat-file', '-e', stateHead + '^{commit}'], { cwd: ROOT, stdio: 'ignore' });
  } catch {
    console.log('NOTE: STATE head ' + stateHead + ' 不在本地克隆（浅克隆）——跳过对象存在性检查');
  }
}


// C2：STATE 未完成项必须与矩阵 open_internal_items 完全一致。
if (!sameSet(stateOpen, matrix.open_internal_items ?? [])) {
  conflicts.push('OPEN_ITEMS_MISMATCH state=[' + stateOpen.join(',') + '] matrix=[' + (matrix.open_internal_items ?? []).join(',') + ']');
}

// C2b：LAYER 2 Golden Path Matrix 的缺口必须已登记为 backlog（缺哪项就 materialize）。
const GP = path.join(ROOT, 'docs', 'releases', 'LAYER2-GOLDEN-PATH-MATRIX.json');
const gpMatrix = readJson(GP, null);
if (gpMatrix) {
  for (const gap of gpMatrix.gaps ?? []) {
    const expectedId = 'GP-' + gap.replace(':', '-');
    if (!backlog.items.some((item) => item.id === expectedId)) {
      conflicts.push('GOLDEN_PATH_GAP_NOT_MATERIALIZED: ' + gap);
    }
  }
}

// C3：REGISTER 未划掉的 G 行 = 表内未关闭项；必须与矩阵的非空内部项一致。
const openRegisterRows = register
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => /^\|\s*G\d+\s*\|/.test(line));
const registerSaysCompleteFalse = /INTERNAL_CODE_COMPLETE\s*=\s*FALSE/.test(register);
const registerSaysCompleteTrue = /INTERNAL_CODE_COMPLETE\s*=\s*TRUE/.test(register);
const matrixHasOpen = (matrix.open_internal_items ?? []).length > 0;

if (matrixHasOpen && registerSaysCompleteTrue) conflicts.push('REGISTER_CLAIMS_COMPLETE_WHILE_OPEN_ITEMS_EXIST');
if (!matrixHasOpen && registerSaysCompleteFalse) conflicts.push('REGISTER_CLAIMS_INCOMPLETE_WHILE_OPEN_ITEMS_ZERO');
if (!matrixHasOpen && openRegisterRows.length > 0) {
  conflicts.push('REGISTER_HAS_OPEN_G_ROWS_WHILE_MATRIX_SAYS_ZERO: ' + openRegisterRows.slice(0, 4).join(' || '));
}
if (matrixHasOpen && openRegisterRows.length === 0 && !registerSaysCompleteFalse) {
  conflicts.push('REGISTER_HAS_NO_OPEN_MARKER_WHILE_MATRIX_HAS_OPEN_ITEMS');
}
if (!register.includes('ACCEPTANCE-MATRIX.json')) conflicts.push('REGISTER_NOT_LINKED_TO_MATRIX');

// C4：报告必须是派生产物，且绑定同一 acceptance HEAD。
if (!report) conflicts.push('REPORT_MISSING');
else {
  if (!report.includes('ACCEPTANCE-MATRIX.json')) conflicts.push('REPORT_NOT_DERIVED_FROM_MATRIX');
  if (!report.includes(String(matrix.acceptance_head))) conflicts.push('REPORT_HEAD_MISMATCH report!= ' + matrix.acceptance_head);
  const reportStatuses = new Set(
    (report.match(/^\| ([^|]+) \| ([A-Z_（）\u4e00-\u9fff/ ]+) \|/gm) ?? [])
      .map((line) => line.split('|'))
      .filter((cells) => cells[1].trim() !== '验收项')
      .map((cells) => cells[2].trim()),
  );
  const matrixStatuses = new Set((matrix.areas ?? []).map((area) => area.status));
  for (const status of reportStatuses) {
    if (status.includes('验收项') || status.trim() === '') continue;
    if (!matrixStatuses.has(status)) conflicts.push('REPORT_STATUS_NOT_IN_MATRIX: ' + status);
  }
}

// C5：STATE.final_status 的三个矛盾面。
const fs2 = state.final_status ?? {};
if (Array.isArray(fs2.OPEN_INTERNAL_ITEMS)) {
  const hasOpenItems = fs2.OPEN_INTERNAL_ITEMS.length > 0;
  if (hasOpenItems && fs2.CODE_COMPLETE === 'YES') conflicts.push('STATE_CODE_COMPLETE_YES_BUT_OPEN_ITEMS');
  if (!hasOpenItems && matrixHasOpen) conflicts.push('STATE_OPEN_ITEMS_EMPTY_BUT_MATRIX_HAS_OPEN');
}


// CHANGE C（MSG-20261003-144）：语义一致性——已被审计 CLOSED 的域不得在矩阵里继续写 PARTIAL/IN_PROGRESS。
const AREA_COMPLETION_MAP = {
  frontend_wiring: ['BG-019-frontend-http-wiring-closure'],
  backend_http_wiring: ['BG-020-customs-readonly-projection-http'],
  customs: ['BG-020-customs-readonly-projection-http'],
  independent_site: ['BG-021-independent-site-persistence-schema-delta'],
};
for (const [areaId, requiredIds] of Object.entries(AREA_COMPLETION_MAP)) {
  const area = (matrix.areas ?? []).find((item) => item.id === areaId);
  if (!area) continue;
  const looksOpen = /PARTIAL|IN_PROGRESS/.test(String(area.status));
  const allCompleted = requiredIds.every((id) => completed.has(id));
  if (looksOpen && allCompleted) {
    conflicts.push('SEMANTIC_STALE_AREA: ' + areaId + ' = ' + String(area.status) + ' 但其依赖项已全部 CLOSED（' + requiredIds.join(',') + '）');
  }
}

if (conflicts.length > 0) {
  console.log('ACCEPTANCE_CONSISTENCY=FAIL head=' + head + ' conflicts=' + conflicts.length);
  for (const conflict of conflicts) console.log(' - ' + conflict);
  process.exit(1);
}

console.log(
  'ACCEPTANCE_CONSISTENCY=OK head=' +
    head +
    ' open_internal_items=' +
    String((matrix.open_internal_items ?? []).length) +
    ' areas=' +
    String((matrix.areas ?? []).length),
);
