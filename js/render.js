'use strict';

/* 渲染层：编辑器高亮/行号/折叠 · 视图计算（过滤排序） · 转换入口 · 表格渲染 · 浮层 · 单元格框选复制 */

/* ══════════════ 编辑器：高亮 / 行号 / 折叠 ══════════════ */
const HL_PLAIN_LIMIT = 300000;   // 超大文本放弃着色，避免输入卡顿
let hlLast = null;
const foldedLines = new Set();

/* 找出跨行的 {…} / […]，只在 JSON 字符串外识别括号。 */
function foldRanges(text) {
  const ranges = new Map(), stack = [];
  let inString = false, escaped = false, line = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
    } else if (ch === '{' || ch === '[') {
      stack.push({ open: ch, line });
    } else if (ch === '}' || ch === ']') {
      const expected = ch === '}' ? '{' : '[';
      const open = stack.pop();
      if (open && open.open === expected && open.line < line) ranges.set(open.line, { end: line, close: ch });
    }
    if (ch === '\n') line++;
  }
  return ranges;
}

function syncGutter(scrollTop) {
  // textarea 出现横向滚动条时，实际可视高度会略小于 gutter。
  // 行号的位移不能超过自身内容高度，否则末行会提前上移、被截断。
  const gutter = $('gutter');
  const gutterScrollTop = Math.min(scrollTop, Math.max(0, gutter.scrollHeight - gutter.clientHeight));
  $('gutterInner').style.transform = `translateY(${-gutterScrollTop}px)`;
}

function refreshHighlight(force = false) {
  const ta = $('jsonInput'), code = $('hlCode'), editor = $('jsonEditor');
  const text = ta.value;
  if (!force && text === hlLast) return;
  if (text !== hlLast) foldedLines.clear();
  hlLast = text;

  const lines = text ? text.split('\n') : [''];
  const ranges = text.length <= HL_PLAIN_LIMIT ? foldRanges(text) : new Map();
  for (const start of [...foldedLines]) if (!ranges.has(start)) foldedLines.delete(start);

  const codeLines = [], gutterLines = [];
  for (let line = 0; line < lines.length;) {
    const range = ranges.get(line);
    const folded = !!range && foldedLines.has(line);
    const shown = folded ? lines[line].replace(/[ \t]+$/, '') + ' … ' + range.close : lines[line];
    codeLines.push(`<span class="code-line">${text.length > HL_PLAIN_LIMIT ? esc(shown) : highlightJson(shown) || ' '}</span>`);
    const control = range
      ? `<button class="fold-toggle" data-fold-line="${line}" title="${folded ? '展开此层级' : '收起此层级'}" aria-label="${folded ? '展开' : '收起'}第 ${line + 1} 行">${folded ? '▸' : '▾'}</button>`
      : '<span class="fold-placeholder"></span>';
    gutterLines.push(`<div class="gutter-line">${control}<span class="line-num">${line + 1}</span></div>`);
    line = folded ? range.end + 1 : line + 1;
  }
  code.innerHTML = codeLines.join('');
  $('gutterInner').innerHTML = gutterLines.join('');
  editor.classList.toggle('is-folded', foldedLines.size > 0);
  syncGutter(editor.classList.contains('is-folded') ? $('hl').scrollTop : ta.scrollTop);
}

function effectiveRows() {
  if (state.mode === 'layered' || state.mode === 'flatten') return state.flatRows;
  return state.rows;
}
function effectiveRow(i) { return effectiveRows()[i]; }

function getVal(i, col) {
  const r = effectiveRow(i);
  if (r === undefined || r === null) return undefined;
  return Object.prototype.hasOwnProperty.call(r, col) ? r[col] : undefined;
}

/* 当前视图：可见列 + 过滤排序后的行索引（与界面显示一致，导出/复制复用） */
function currentView() {
  const cols = state.columns.filter(c => !state.hiddenCols.has(c));
  const term = state.search.trim().toLowerCase();
  let idxs = effectiveRows().map((_, i) => i);
  if (term) {
    idxs = idxs.filter(i => cols.some(c => searchText(getVal(i, c)).toLowerCase().includes(term)));
  }
  if (state.sort.col && state.sort.dir) {
    const col = state.sort.col, dir = state.sort.dir;
    idxs.sort((i1, i2) => {
      const a = getVal(i1, col), b = getVal(i2, col);
      const aN = a === undefined || a === null, bN = b === undefined || b === null;
      if (aN && bN) return 0;
      if (aN) return 1;          // 空值恒排最后，不受升降序影响
      if (bN) return -1;
      return dir * cmpValues(a, b);
    });
  }
  return { cols, idxs, term };
}

/* ══════════════ 转换入口 ══════════════ */
function convert() {
  closeAllPopovers(false);   // 数据已变化，列菜单与子表浮层全部失效
  const text = $('jsonInput').value.trim();
  if (!text) {
    state.hasData = false; state.rows = []; state.flatRows = []; state.columns = [];
    state.error = null; resetSortAndCols();
    render(); return;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    state.hasData = false; state.rows = []; state.flatRows = []; state.columns = [];
    state.error = describeError(e, text);
    resetSortAndCols();
    render(); return;
  }
  state.error = null;
  state.rows = normalizeRows(parsed);
  state.hasData = true;
  resetSortAndCols();
  recomputeDerived();
  render();
}

function resetSortAndCols() {
  state.sort = { col: null, dir: 0 };
  state.hiddenCols.clear();
}

function recomputeDerived() {
  state.flatRows = state.rows.map(flattenRow);
  state.columns = buildColumns(effectiveRows());
}

/* ══════════════ 渲染 ══════════════ */
function render() {
  updateStatus();
  renderTable();
  updateFooters();
}

function updateStatus() {
  const el = $('status');
  if (state.error) {
    el.className = 'status error';
    $('statusText').textContent = 'JSON 解析失败：' + state.error;
  } else if (!state.hasData) {
    el.className = 'status';
    $('statusText').textContent = '等待输入 JSON…';
  } else {
    el.className = 'status ok';
    let msg = `有效 JSON · ${state.rows.length} 条记录 · ${state.columns.length} 列`;
    if (state.mode === 'layered') {
      const countArrays = v => Array.isArray(v)
        ? (v.length ? 1 : 0) + v.reduce((n, el) => n + countArrays(el), 0)
        : (isObj(v) ? Object.values(v).reduce((n, el) => n + countArrays(el), 0) : 0);
      const subs = state.rows.reduce((n, r) => n + countArrays(r), 0);
      if (subs) msg += ` · ${subs} 个嵌套子表`;
    }
    $('statusText').textContent = msg;
  }
}

function badgeHTML(path, v) {
  const p = escAttr(JSON.stringify(path));
  if (isObj(v)) {
    const n = Object.keys(v).length;
    return `<span class="badge" data-path="${p}" title="点击展开">${n ? `{ } ${n} 字段` : '{ } 空对象'}</span>`;
  }
  return `<span class="badge" data-path="${p}" title="点击展开">[•] ${v.length} 项</span>`;
}

/* 基础类型单元格（undefined/null/布尔/数字/字符串），徽标与分层模式共用。
   data-copy 为复制用的原始文本，是双击复制与选区复制的数据源 */
function primitiveCellHTML(v, term) {
  const dc = ` data-copy="${escAttr(cellText(v))}"`;
  if (v === undefined) return `<td${dc}><span class="missing">—</span></td>`;
  if (v === null) return `<td${dc}><span class="null">null</span></td>`;
  if (typeof v === 'boolean') return `<td class="${v ? 'bool-true' : 'bool-false'}"${dc}>${v}</td>`;
  if (typeof v === 'number') return `<td class="num-cell"${dc}>${v}</td>`;
  const s = String(v);
  const text = s === '' ? '<span class="missing">""</span>' : highlight(s, term);
  return `<td class="mono"${dc}><span class="celltext" title="${escAttr(s)}">${text}</span></td>`;
}

/* 单元格渲染（徽标 / 拍平列模式的主表）。badge 路径为 [行索引, 列名] */
function renderCellMain(v, colName, rowIdx, isNumCol, term) {
  const dc = ` data-copy="${escAttr(cellText(v))}"`;
  if (isObj(v) || Array.isArray(v)) {
    return `<td${isNumCol ? ' class="num-cell"' : ''}${dc}>${badgeHTML([rowIdx, colName], v)}</td>`;
  }
  if (v === undefined || v === null) {
    return `<td${isNumCol ? ' class="num-cell"' : ''}${dc}><span class="${v === null ? 'null' : 'missing'}">${v === null ? 'null' : '—'}</span></td>`;
  }
  return primitiveCellHTML(v, term);
}

/* 分层模式单元格：数组→提示指向行下方子表；空对象→标记；其余基础类型 */
function renderCellLayered(v, term) {
  const dc = ` data-copy="${escAttr(cellText(v))}"`;
  if (Array.isArray(v)) return `<td${dc}><span class="subhint">↳ ${v.length} 条</span></td>`;
  if (isObj(v)) return `<td${dc}><span class="missing">{ }</span></td>`;
  return primitiveCellHTML(v, term);
}

/* 分层模式：把数组渲染为独立子表（自有表头，可多层递归嵌套） */
function layeredSubTable(arr) {
  const items = arr.map(it => isObj(it) ? flattenRow(it) : { '值': it });
  const cols = buildColumns(items);
  let html = '<table class="grid sub"><thead>' + pathHeaderHTML(cols) + '<tr class="field-row"><th class="idx">#</th>';
  for (const c of cols) html += `<th title="${escAttr(c)}">${esc(columnLabel(c))}</th>`;
  html += '</tr></thead><tbody>';
  items.forEach((item, i) => {
    const val = c => Object.prototype.hasOwnProperty.call(item, c) ? item[c] : undefined;
    html += `<tr><td class="idx">${i + 1}</td>`;
    for (const c of cols) html += renderCellLayered(val(c), '');
    html += '</tr>';
    for (const c of cols) {
      const v = val(c);
      if (Array.isArray(v) && v.length) {
        html += `<tr class="layer-tr"><td class="idx"></td><td colspan="${cols.length}">` +
          `<section class="subsec"><div class="subcap">${esc(c)} · ${v.length} 条</div>${layeredSubTable(v)}</section></td></tr>`;
      }
    }
  });
  return html + '</tbody></table>';
}

/* 浮层内子表的单元格（无高亮需求） */
function renderCellSub(v, path) {
  if (v === undefined) return '<td><span class="missing">—</span></td>';
  if (v === null) return '<td><span class="null">null</span></td>';
  if (typeof v === 'boolean') return `<td class="${v ? 'bool-true' : 'bool-false'}">${v}</td>`;
  if (isObj(v) || Array.isArray(v)) return `<td>${badgeHTML(path, v)}</td>`;
  const s = typeof v === 'number' ? String(v) : String(v);
  const text = s === '' ? '<span class="missing">""</span>' : esc(s);
  return `<td class="${typeof v === 'number' ? 'num-cell' : 'mono'}"><span class="celltext" title="${escAttr(s)}">${text}</span></td>`;
}

function renderTable() {
  closeAllPopovers(true);   // 数据浮层随重渲染关闭，列菜单（_keep）保持打开
  clearSelection();
  grid.classList.toggle('layered', state.mode === 'layered');
  const empty = $('emptyState');
  if (!state.hasData) {
    grid.innerHTML = '';
    $('emptyTitle').textContent = state.error ? 'JSON 有误，请先修正左侧输入' : '在左侧粘贴 JSON，表格将实时生成';
    empty.hidden = false;
    return;
  }
  if (state.rows.length === 0) {
    grid.innerHTML = '';
    $('emptyTitle').textContent = '数组为空，没有可显示的行';
    empty.hidden = false;
    return;
  }
  empty.hidden = true;

  const view = currentView();
  state.filteredCount = view.idxs.length;

  // 全为数字（含空）的列右对齐
  const numCols = new Set(view.cols.filter(c =>
    view.idxs.every(i => { const v = getVal(i, c); return v === undefined || v === null || typeof v === 'number'; })));

  let html = '<thead>' + pathHeaderHTML(view.cols) + '<tr class="field-row"><th class="idx">#</th>';
  for (const c of view.cols) {
    const sorted = state.sort.col === c;
    const arrow = sorted ? `<span class="th-arrow">${state.sort.dir === 1 ? '▲' : '▼'}</span>` : '<span class="th-gap"></span>';
    html += `<th${numCols.has(c) ? ' class="num-cell' + (sorted ? ' sorted' : '') + '"' : (sorted ? ' class="sorted"' : '')} data-col="${escAttr(c)}" title="${escAttr(c)}">${esc(columnLabel(c))}${arrow}</th>`;
  }
  html += '</tr></thead><tbody>';
  if (state.mode === 'layered') {
    view.idxs.forEach((rowIdx, pos) => {
      html += `<tr><td class="idx">${pos + 1}</td>`;
      for (const c of view.cols) html += renderCellLayered(getVal(rowIdx, c), view.term);
      html += '</tr>';
      for (const c of view.cols) {
        const v = getVal(rowIdx, c);
        if (Array.isArray(v) && v.length) {
          html += `<tr class="layer-tr"><td class="idx"></td><td colspan="${view.cols.length}">` +
            `<section class="subsec"><div class="subcap">${esc(c)} · ${v.length} 条</div>${layeredSubTable(v)}</section></td></tr>`;
        }
      }
    });
  } else {
    view.idxs.forEach((rowIdx, pos) => {
      html += `<tr><td class="idx">${pos + 1}</td>`;
      for (const c of view.cols) html += renderCellMain(getVal(rowIdx, c), c, rowIdx, numCols.has(c), view.term);
      html += '</tr>';
    });
  }
  html += '</tbody>';
  grid.innerHTML = html;
}

function updateFooters() {
  refreshHighlight();   // 输入/示例/格式化/拖入/清空等所有改值路径都会经过这里
  $('charCount').textContent = `${$('jsonInput').value.length.toLocaleString()} 字符`;
  if (!state.hasData || state.rows.length === 0) { $('tableStats').textContent = '—'; return; }
  const total = effectiveRows().length;
  const shown = state.filteredCount !== undefined ? state.filteredCount : total;
  const filtered = state.search.trim() ? ` · 过滤出 ${shown} / ${total} 行` : '';
  const sortInfo = state.sort.dir ? ` · 按「${state.sort.col}」${state.sort.dir === 1 ? '升' : '降'}序` : '';
  $('tableStats').textContent = `${total} 行 × ${state.columns.length} 列${filtered}${sortInfo}`;
}

/* ══════════════ 浮层 ══════════════ */
function resolvePath(root, path) {
  let v = root;
  for (const seg of path) v = v == null ? undefined : v[seg];
  return v;
}

function openPopover(anchor, title, root, buildBody, keep) {
  const depth = popovers.length;
  const pop = document.createElement('div');
  pop.className = 'popover';
  pop.innerHTML = `<div class="popover-head"><span class="ptitle"></span><button class="pclose" title="关闭">✕</button></div><div class="popover-body"></div>`;
  pop.querySelector('.ptitle').textContent = title;
  pop._root = root;
  pop._keep = !!keep;
  buildBody(pop.querySelector('.popover-body'), root);
  document.body.appendChild(pop);

  const r = anchor.getBoundingClientRect();
  const pw = pop.offsetWidth, ph = pop.offsetHeight;
  const offset = depth * 16;
  let x = r.left + offset, y = r.bottom + 6 + offset;
  if (x + pw > window.innerWidth - 8) x = Math.max(8, window.innerWidth - pw - 8);
  if (y + ph > window.innerHeight - 8) y = Math.max(8, r.top - ph - 6);
  pop.style.left = x + 'px';
  pop.style.top = y + 'px';

  pop.addEventListener('mousedown', e => e.stopPropagation());
  pop.querySelector('.pclose').addEventListener('click', () => closePopover(pop));
  pop.addEventListener('click', e => {
    let badge = e.target.closest('.badge[data-path]');
    if (!badge && e.target.querySelector) badge = e.target.querySelector('.badge[data-path]');
    if (badge) {
      const path = JSON.parse(badge.dataset.path);
      const v = resolvePath(pop._root, path);
      const label = typeof path[path.length - 1] === 'number' ? `${title} · 第 ${path[path.length - 1] + 1} 项` : String(path[path.length - 1]);
      openPopover(badge, label, v, buildValueBody);
    }
  });
  popovers.push(pop);
  return pop;
}

function closePopover(pop) {
  const i = popovers.indexOf(pop);
  if (i !== -1) {
    for (let j = popovers.length - 1; j >= i; j--) popovers[j].remove();
    popovers.length = i;
  } else {
    pop.remove();
  }
}

function closeAllPopovers(keepMenu) {
  for (let j = popovers.length - 1; j >= 0; j--) {
    if (keepMenu && popovers[j]._keep) continue;
    popovers[j].remove();
    popovers.splice(j, 1);
  }
}

/* 把一个对象 / 数组渲染为子表格 HTML */
function valueTableHTML(v) {
  if (isObj(v)) {
    const entries = Object.entries(v);
    if (entries.length === 0) return '<div class="menu-item missing">空对象</div>';
    let html = '<table class="grid"><thead><tr><th>字段</th><th>值</th></tr></thead><tbody>';
    for (const [k, val] of entries) {
      html += `<tr><td class="mono" style="color:var(--muted)">${esc(k)}</td>${renderCellSub(val, [k])}</tr>`;
    }
    return html + '</tbody></table>';
  }
  if (Array.isArray(v)) {
    if (v.length === 0) return '<div class="menu-item missing">空数组</div>';
    const hasObj = v.some(isObj);
    if (!hasObj) {
      let html = '<table class="grid"><thead><tr><th class="idx">#</th><th>值</th></tr></thead><tbody>';
      v.forEach((item, i) => { html += `<tr><td class="idx">${i + 1}</td>${renderCellSub(item, [i])}</tr>`; });
      return html + '</tbody></table>';
    }
    // 含对象：取对象键的并集；非对象项放入「(值)」列
    const cols = [];
    const seen = new Set();
    for (const it of v) if (isObj(it)) for (const k of Object.keys(it)) if (!seen.has(k)) { seen.add(k); cols.push(k); }
    const hasNonObj = v.some(it => !isObj(it));
    let head = '<th class="idx">#</th>' + (hasNonObj ? '<th>(值)</th>' : '');
    for (const c of cols) head += `<th>${esc(c)}</th>`;
    let html = `<table class="grid"><thead><tr>${head}</tr></thead><tbody>`;
    v.forEach((it, i) => {
      html += `<tr><td class="idx">${i + 1}</td>`;
      if (hasNonObj) html += isObj(it) ? '<td><span class="missing">—</span></td>' : renderCellSub(it, [i]);
      for (const c of cols) html += isObj(it) ? renderCellSub(Object.prototype.hasOwnProperty.call(it, c) ? it[c] : undefined, [i, c]) : '<td><span class="missing">—</span></td>';
      html += '</tr>';
    });
    return html + '</tbody></table>';
  }
  return `<div class="menu-item mono">${esc(String(v))}</div>`;
}

function buildValueBody(bodyEl, v) { bodyEl.innerHTML = valueTableHTML(v); }

/* ══════════════ 单元格选择与复制（类 Excel） ══════════════ */
const selState = { table: null, r1: 0, c1: 0, r2: 0, c2: 0, dragging: false, active: false };

function tdAt(x, y) {
  const el = document.elementFromPoint(x, y);
  return el && el.closest ? el.closest('td[data-copy]') : null;
}

function selRange() {
  return {
    table: selState.table,
    lo: Math.min(selState.r1, selState.r2), hi: Math.max(selState.r1, selState.r2),
    clo: Math.min(selState.c1, selState.c2), chi: Math.max(selState.c1, selState.c2),
  };
}

function eachSelTd(fn) {
  if (!selState.active || !selState.table) return;
  const { table, lo, hi, clo, chi } = selRange();
  for (const tr of table.rows) {
    if (tr.rowIndex < lo || tr.rowIndex > hi || tr.classList.contains('layer-tr')) continue;
    for (let c = clo; c <= chi; c++) {
      const td = tr.cells[c];
      if (td && td.dataset.copy !== undefined) fn(td);
    }
  }
}

function paintSelection() {
  document.querySelectorAll('td.cell-sel').forEach(td => td.classList.remove('cell-sel'));
  eachSelTd(td => td.classList.add('cell-sel'));
}

function selectionTsv() {
  if (!selState.active || !selState.table) return null;
  const lines = [];
  const { lo, hi, clo, chi } = selRange();
  for (const tr of selState.table.rows) {
    if (tr.rowIndex < lo || tr.rowIndex > hi || tr.classList.contains('layer-tr')) continue;
    const cells = [];
    for (let c = clo; c <= chi; c++) cells.push(tr.cells[c] ? (tr.cells[c].dataset.copy || '') : '');
    lines.push(cells.join('\t'));
  }
  return lines.join('\n');
}

function clearSelection() {
  selState.active = false;
  selState.dragging = false;
  document.querySelectorAll('td.cell-sel').forEach(td => td.classList.remove('cell-sel'));
}

document.addEventListener('mousedown', e => {
  if (e.button !== 0) return;
  const td = e.target.closest ? e.target.closest('td[data-copy]') : null;
  if (!td || td.querySelector('.badge')) {
    // 点到非数据单元格（输入框、列头、空白处、徽标格等）→ 清除选区
    if (!td) clearSelection();
    return;
  }
  const table = td.closest('table.grid');
  if (!table) return;
  e.preventDefault();   // 拦截原生文本选择，改为框选高亮
  const ae = document.activeElement;   // 还原 mousedown 默认行为：离开输入框
  if (ae && (ae.tagName === 'TEXTAREA' || ae.tagName === 'INPUT')) ae.blur();
  selState.table = table;
  selState.r1 = selState.r2 = td.parentElement.rowIndex;
  selState.c1 = selState.c2 = td.cellIndex;
  selState.dragging = true;
  selState.active = true;
  paintSelection();
});

document.addEventListener('mousemove', e => {
  if (!selState.dragging) return;
  const td = tdAt(e.clientX, e.clientY);
  if (!td || td.closest('table.grid') !== selState.table) return;
  selState.r2 = td.parentElement.rowIndex;
  selState.c2 = td.cellIndex;
  paintSelection();
});

document.addEventListener('mouseup', () => {
  selState.dragging = false;
});

// 双击单元格 → 复制其内容
document.addEventListener('dblclick', e => {
  if (e.target.closest && e.target.closest('.badge')) return;   // 徽标保持弹层行为
  const td = e.target.closest ? e.target.closest('td[data-copy]') : null;
  if (!td) return;
  copyText(td.dataset.copy, '已复制单元格内容');
});

// Ctrl / ⌘ + C 复制当前选区（焦点在输入框或存在原生文本选区时不拦截，走原生复制）
document.addEventListener('keydown', e => {
  if (!(e.ctrlKey || e.metaKey) || (e.key !== 'c' && e.key !== 'C') || !selState.active) return;
  const ae = document.activeElement;
  if (ae && (ae.tagName === 'TEXTAREA' || ae.tagName === 'INPUT')) return;
  const native = window.getSelection ? String(window.getSelection()) : '';
  if (native.trim()) return;
  const tsv = selectionTsv();
  if (tsv !== null) {
    e.preventDefault();
    copyText(tsv, '已复制选区，可直接粘贴进 Excel');
  }
});
