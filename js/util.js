'use strict';

/* 纯逻辑函数：转义 / 搜索高亮 / JSON 语法着色 / 规范化与拍平 / 列构建 / 导出文本构建（无 DOM、无状态依赖） */

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);

function esc(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function escAttr(s) { return esc(s); }

function highlight(raw, term) {
  const s = String(raw);
  if (!term) return esc(s);
  const t = term.toLowerCase();
  const lower = s.toLowerCase();
  let out = '', i = 0;
  for (;;) {
    const idx = lower.indexOf(t, i);
    if (idx === -1) { out += esc(s.slice(i)); break; }
    out += esc(s.slice(i, idx)) + '<mark>' + esc(s.slice(idx, idx + t.length)) + '</mark>';
    i = idx + t.length;
  }
  return out;
}

/* JSON 语法着色：键（后随冒号的字符串）/ 字符串 / 数字 / true / false / null / 符号。
   与 JSON 合法性无关，输入途中也会着色；不匹配的部分原样输出。 */
const HL_RE = /("(?:\\.|[^"\\])*")(\s*:)?|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|\b(true|false|null)\b|([{}\[\],])/g;

function highlightJson(text) {
  let out = '', last = 0, m;
  HL_RE.lastIndex = 0;
  while ((m = HL_RE.exec(text))) {
    out += esc(text.slice(last, m.index));
    if (m[1] !== undefined) {
      out += m[2] !== undefined
        ? `<span class="j-key">${esc(m[1])}</span>${esc(m[2])}`
        : `<span class="j-str">${esc(m[1])}</span>`;
    } else if (m[3] !== undefined) {
      out += `<span class="j-${m[3]}">${m[3]}</span>`;
    } else if (m[4] !== undefined) {
      out += `<span class="j-punct">${m[4]}</span>`;
    } else {
      out += `<span class="j-num">${esc(m[0])}</span>`;
    }
    last = HL_RE.lastIndex;
  }
  return out + esc(text.slice(last));
}

function flattenInto(v, prefix, out) {
  if (isObj(v)) {
    const keys = Object.keys(v);
    if (keys.length === 0) { out[prefix] = {}; return; }
    for (const k of keys) flattenInto(v[k], prefix ? prefix + '.' + k : k, out);
  } else {
    out[prefix] = v;
  }
}

function flattenRow(row) {
  const out = {};
  if (isObj(row)) flattenInto(row, '', out);
  else out[''] = row;
  return out;
}

function normalizeRows(parsed) {
  const arr = Array.isArray(parsed) ? parsed : [parsed];
  return arr.map(item => isObj(item) ? item : { '值': item });
}

function buildColumns(effectiveRows) {
  const cols = [];
  const seen = new Set();
  for (const row of effectiveRows) {
    if (!isObj(row)) continue;
    for (const k of Object.keys(row)) {
      if (!seen.has(k)) { seen.add(k); cols.push(k); }
    }
  }
  return cols;
}

function columnLabel(col) {
  const dot = col.lastIndexOf('.');
  return dot === -1 ? (col || '值') : col.slice(dot + 1);
}

function columnParent(col) {
  const dot = col.lastIndexOf('.');
  return dot === -1 ? '顶层字段' : col.slice(0, dot);
}

/* 相邻同层级列合并为一格：层级在上、字段名在下，避免每列重复完整路径。 */
function pathHeaderHTML(cols) {
  let html = '<tr class="path-row"><th class="idx" aria-label="行号"></th>';
  for (let i = 0; i < cols.length;) {
    const parent = columnParent(cols[i]);
    let end = i + 1;
    while (end < cols.length && columnParent(cols[end]) === parent) end++;
    html += `<th colspan="${end - i}" title="${escAttr(parent)}">${esc(parent)}</th>`;
    i = end;
  }
  return html + '</tr>';
}

function describeError(e, text) {
  let loc = '';
  const m = /position\s+(\d+)/i.exec(e.message);
  if (m) {
    const pos = Math.min(+m[1], text.length);
    const before = text.slice(0, pos);
    const line = before.split('\n').length;
    const col = pos - before.lastIndexOf('\n');
    loc = `（第 ${line} 行第 ${col} 列）`;
  }
  return e.message + loc;
}

function searchText(v) {
  if (v === undefined || v === null) return '';
  if (isObj(v) || Array.isArray(v)) return JSON.stringify(v);
  return String(v);
}

function cmpValues(a, b) {
  let x = a, y = b;
  if (isObj(x) || Array.isArray(x)) x = JSON.stringify(x);
  if (isObj(y) || Array.isArray(y)) y = JSON.stringify(y);
  if (typeof x === 'number' && typeof y === 'number') return x - y;
  return String(x).localeCompare(String(y), 'zh-Hans-CN', { numeric: true, sensitivity: 'base' });
}

function cellText(v) {
  if (v === undefined) return '';
  if (v === null) return 'null';
  if (isObj(v) || Array.isArray(v)) return JSON.stringify(v);
  return String(v);
}

function buildTsv(view) {
  const lines = [view.cols.join('\t')];
  for (const i of view.idxs) lines.push(view.cols.map(c => cellText(getVal(i, c))).join('\t'));
  return lines.join('\n');
}

function buildMarkdown(view) {
  const clean = s => String(s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
  const lines = ['| ' + view.cols.map(clean).join(' | ') + ' |',
                 '| ' + view.cols.map(() => '---').join(' | ') + ' |'];
  for (const i of view.idxs) {
    lines.push('| ' + view.cols.map(c => clean(cellText(getVal(i, c)))).join(' | ') + ' |');
  }
  return lines.join('\n');
}

function buildCsv(view) {
  const q = s => {
    const v = String(s);
    return /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  };
  const lines = [view.cols.map(q).join(',')];
  for (const i of view.idxs) lines.push(view.cols.map(c => q(cellText(getVal(i, c)))).join(','));
  return lines.join('\r\n');
}
