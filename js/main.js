'use strict';

/* 应用入口：共享状态 · 事件绑定 · 示例数据 · 复制导出 · 主题 · 分栏拖拽 · 初始化 */

/* ══════════════ 状态 ══════════════ */
const state = {
  rows: [],        // 规范化后的行（全部为对象）
  flatRows: [],    // 拍平后的行（拍平模式下使用）
  columns: [],     // 当前列（普通模式为顶层键，拍平模式为 a.b.c 路径）
  error: null,
  hasData: false,
  sort: { col: null, dir: 0 },   // dir: 1 升 / -1 降 / 0 无
  search: '',
  hiddenCols: new Set(),
  mode: 'layered',   // layered=分层展开（行下方独立子表）| flatten=拍平列 | badge=徽标紧凑
  autoConvert: true,
};
let convertTimer = null;

const $ = id => document.getElementById(id);
const grid = $('grid');
const popovers = [];   // 浮层栈（嵌套子表 / 列菜单）

/* ══════════════ 事件绑定 ══════════════ */
// 主表：badge 展开 + 列头排序（事件委托；点中徽标所在单元格同样生效）
grid.addEventListener('click', e => {
  let badge = e.target.closest('.badge[data-path]');
  if (!badge && e.target.querySelector) badge = e.target.querySelector('.badge[data-path]');
  if (badge) {
    const [rowIdx, colName] = JSON.parse(badge.dataset.path);
    const rowSrc = state.mode === 'flatten' ? state.flatRows : state.rows;
    const v = resolvePath(rowSrc, [rowIdx, colName]);
    openPopover(badge, String(colName), v, buildValueBody);
    return;
  }
  const th = e.target.closest('thead th[data-col]');
  if (th) {
    const col = th.dataset.col;
    if (state.sort.col !== col) state.sort = { col, dir: 1 };
    else if (state.sort.dir === 1) state.sort.dir = -1;
    else state.sort = { col: null, dir: 0 };
    renderTable();
    updateFooters();
  }
});

// 点击浮层外部：关闭最外层未点中的浮层
document.addEventListener('mousedown', () => {
  while (popovers.length) {
    const top = popovers[popovers.length - 1];
    // pop 自身 mousedown 已 stopPropagation，能到这里说明点在外面
    closePopover(top);
  }
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    clearSelection();
    if (!$('helpModal').hidden) { $('helpModal').hidden = true; return; }
    if (popovers.length) closePopover(popovers[popovers.length - 1]);
  }
});

// 输入：防抖自动转换 + 字符统计
$('jsonInput').addEventListener('input', () => {
  updateFooters();
  if (!state.autoConvert) return;
  clearTimeout(convertTimer);
  convertTimer = setTimeout(convert, 300);
});

// 高亮层与输入框滚动同步
$('jsonInput').addEventListener('scroll', () => {
  const ta = $('jsonInput'), hl = $('hl');
  hl.scrollTop = ta.scrollTop;
  hl.scrollLeft = ta.scrollLeft;
  syncGutter(ta.scrollTop);
});

// JSON gutter：单层收起 / 展开，以及全量操作。
$('gutter').addEventListener('click', e => {
  const btn = e.target.closest('.fold-toggle[data-fold-line]');
  if (!btn) return;
  const line = +btn.dataset.foldLine;
  if (foldedLines.has(line)) foldedLines.delete(line); else foldedLines.add(line);
  refreshHighlight(true);
});
$('btnFoldAll').addEventListener('click', () => {
  for (const line of foldRanges($('jsonInput').value).keys()) foldedLines.add(line);
  refreshHighlight(true);
});
$('btnUnfoldAll').addEventListener('click', () => {
  foldedLines.clear();
  refreshHighlight(true);
  $('jsonInput').focus();
});
$('hl').addEventListener('scroll', () => {
  if ($('jsonEditor').classList.contains('is-folded')) syncGutter($('hl').scrollTop);
});

// 搜索
$('searchInput').addEventListener('input', e => {
  state.search = e.target.value;
  if (state.hasData) { renderTable(); updateFooters(); }
});

// 展示模式切换（分层展开 / 拍平列 / 徽标）
(() => {
  const seg = $('viewModeSeg');
  const sync = () => seg.querySelectorAll('label').forEach(l =>
    l.classList.toggle('on', l.dataset.mode === state.mode));
  seg.addEventListener('change', e => {
    const radio = e.target.closest('input[name="viewMode"]');
    if (!radio || !radio.checked) return;
    state.mode = radio.value;
    sync();
    closeAllPopovers(false);   // 列集合已变化，菜单与浮层内容失效
    if (state.hasData) {
      resetSortAndCols();
      recomputeDerived();
    }
    render();
  });
  sync();
})();

// 自动转换开关
$('autoConvert').addEventListener('change', e => {
  state.autoConvert = e.target.checked;
  $('btnConvert').hidden = state.autoConvert;
  if (state.autoConvert) convert();
});
$('btnConvert').addEventListener('click', convert);

// 示例 / 格式化 / 清空
const SAMPLE = [
  { "名称": "张三", "年龄": 28, "在职": true, "部门": "仓储部",
    "地址": { "省份": "广东省", "城市": "深圳市", "邮编": "518000" },
    "标签": ["FBA", "加急"], "备注": null },
  { "名称": "李四", "年龄": 35, "在职": false, "部门": "运输部",
    "地址": { "省份": "浙江省", "城市": "杭州市", "邮编": "310000" },
    "标签": ["海运"], "备注": "周五前送达" },
  { "名称": "王五", "年龄": 42, "部门": "仓储部", "入职时间": "2021-03-15",
    "标签": ["FBA", "正常", "优先"] },
  { "名称": "赵六", "部门": "客服部", "地址": { "省份": "上海市", "城市": "上海市" },
    "标签": [], "在职": true },
  { "名称": "EXT01 分拨中心", "库存": { "可用": 1204, "在途": 88, "滞销": { "天数": 45, "数量": 17 } },
    "站点": ["US", "DE", "JP"], "更新时间": "2026-09-01 08:30", "启用": true },
  { "名称": "EXT02 分拨中心", "库存": { "可用": 376, "在途": 12 }, "站点": ["UK"],
    "更新时间": "2026-09-08 16:00", "启用": false },
  { "名称": "SO-2026 批次", "日期": "2026-09-10",
    "订单": [
      { "单号": "SO-1001", "币种": "USD",
        "明细": [ { "SKU": "A-1001", "数量": 2, "单价": 19.9 }, { "SKU": "B-2002", "数量": 1, "单价": 45.0 } ] },
      { "单号": "SO-1002", "币种": "USD",
        "明细": [ { "SKU": "C-3003", "数量": 5, "单价": 8.8 } ] }
    ] }
];

function fillSample() {
  $('jsonInput').value = JSON.stringify(SAMPLE, null, 2);
  convert();
}
$('btnSample').addEventListener('click', fillSample);
$('btnSample2').addEventListener('click', fillSample);

$('btnFormat').addEventListener('click', () => {
  const text = $('jsonInput').value.trim();
  if (!text) return;
  try {
    $('jsonInput').value = JSON.stringify(JSON.parse(text), null, 2);
    if (state.autoConvert) convert(); else updateFooters();
  } catch (e) {
    toast('JSON 有误，无法格式化：' + describeError(e, text));
  }
});

$('btnClear').addEventListener('click', () => {
  $('jsonInput').value = '';
  $('searchInput').value = '';
  state.search = '';
  convert();
  $('jsonInput').focus();
});

// 列显示菜单
$('btnCols').addEventListener('click', e => {
  const existed = popovers.some(p => p._keep);
  if (existed) { closeAllPopovers(false); return; }
  closeAllPopovers(false);
  if (!state.hasData || state.columns.length === 0) { toast('暂无数据，先在左侧粘贴 JSON'); return; }
  openPopover(e.currentTarget, `列显示（${state.columns.length}）`, null, body => {
    body.innerHTML =
      `<div class="menu-actions"><button data-act="all">全选</button><button data-act="none">全不选</button></div>` +
      state.columns.map((c, i) =>
        `<label class="menu-item"><input type="checkbox" data-ci="${i}" ${state.hiddenCols.has(c) ? '' : 'checked'}><span class="mono">${esc(c)}</span></label>`
      ).join('');
    body.addEventListener('change', ev => {
      const cb = ev.target.closest('input[data-ci]');
      if (!cb) return;
      const col = state.columns[+cb.dataset.ci];
      if (cb.checked) state.hiddenCols.delete(col); else state.hiddenCols.add(col);
      renderTable(); updateFooters();
    });
    body.addEventListener('click', ev => {
      const btn = ev.target.closest('button[data-act]');
      if (!btn) return;
      if (btn.dataset.act === 'all') state.hiddenCols.clear();
      else state.columns.forEach(c => state.hiddenCols.add(c));
      body.querySelectorAll('input[data-ci]').forEach(cb => {
        cb.checked = btn.dataset.act === 'all';
      });
      renderTable(); updateFooters();
    });
  }, true);
});

// 复制 / 导出
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => t.classList.remove('show'), 1800);
}

function copyText(text, okMsg) {
  const done = () => toast(okMsg);
  const fail = () => {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); done(); }
    catch (e) { toast('复制失败，请手动复制'); }
    ta.remove();
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done, fail);
  } else fail();
}

function requireView() {
  if (!state.hasData || state.rows.length === 0) { toast('暂无数据可导出'); return null; }
  return currentView();
}

$('btnCopyTsv').addEventListener('click', () => {
  const view = requireView(); if (!view) return;
  copyText(buildTsv(view), `已复制 TSV（${view.idxs.length} 行），可直接粘贴进 Excel / 飞书表格`);
});
$('btnCopyMd').addEventListener('click', () => {
  const view = requireView(); if (!view) return;
  copyText(buildMarkdown(view), `已复制 Markdown 表格（${view.idxs.length} 行）`);
});
$('btnCsv').addEventListener('click', () => {
  const view = requireView(); if (!view) return;
  const blob = new Blob(['\uFEFF' + buildCsv(view)], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  const ts = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
  a.href = URL.createObjectURL(blob);
  a.download = `json-table-${ts}.csv`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
  toast(`已导出 CSV（${view.idxs.length} 行）`);
});

// 主题
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  $('btnTheme').textContent = t === 'dark' ? '☀️' : '🌙';
  try { localStorage.setItem('jt-theme', t); } catch (e) { /* 忽略 */ }
}
$('btnTheme').addEventListener('click', () => {
  applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
});

// 帮助
$('btnHelp').addEventListener('click', () => { $('helpModal').hidden = false; });
$('btnHelpClose').addEventListener('click', () => { $('helpModal').hidden = true; });
$('helpModal').addEventListener('click', e => {
  if (e.target === $('helpModal')) $('helpModal').hidden = true;
});

// 分栏拖拽
(() => {
  const divider = $('divider'), paneLeft = $('paneLeft'), main = $('main');
  let dragging = false;
  divider.addEventListener('mousedown', e => {
    e.preventDefault();
    dragging = true;
    divider.classList.add('active');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  });
  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    const rect = main.getBoundingClientRect();
    const pct = Math.min(78, Math.max(22, (e.clientX - rect.left) / rect.width * 100));
    paneLeft.style.width = pct + '%';
  });
  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    divider.classList.remove('active');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });
})();

// 拖入 .json 文件
(() => {
  const pane = $('paneLeft'), input = $('jsonInput');
  pane.addEventListener('dragover', e => { e.preventDefault(); pane.classList.add('dragover'); });
  pane.addEventListener('dragleave', () => pane.classList.remove('dragover'));
  pane.addEventListener('drop', e => {
    e.preventDefault();
    pane.classList.remove('dragover');
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      input.value = String(reader.result);
      if (state.autoConvert) convert(); else updateFooters();
      toast(`已载入 ${file.name}`);
    };
    reader.readAsText(file);
  });
})();

// 初始化
(() => {
  let theme = null;
  try { theme = localStorage.getItem('jt-theme'); } catch (e) { /* 忽略 */ }
  if (!theme) theme = 'dark';   // 默认深色，用户手动切换后记住选择
  applyTheme(theme);
  updateFooters();
})();
