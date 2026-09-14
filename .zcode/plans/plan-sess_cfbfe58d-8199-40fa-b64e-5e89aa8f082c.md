# 项目拆分 + 字体清晰度 + 界面精修

分三个独立阶段实施：**先纯拆分（不改任何代码逻辑）→ 再字体改造 → 最后视觉精修**。每阶段可单独验证、单独回退。

## 阶段 1：拆分为 HTML / CSS / JS 标准结构

目标目录结构：
```
json_to_table/
├── index.html            # 纯结构（约 80 行）
├── css/
│   └── style.css         # 全部样式（现 <style> 块原样迁出，约 335 行）
├── js/
│   ├── util.js           # 纯逻辑函数节：esc / highlight / JSON 规范化 / 拍平（无 DOM 依赖）
│   ├── render.js         # 转换入口 + 渲染 + 浮层 + 单元格选区复制
│   └── main.js           # 状态定义 + 事件绑定 + 初始化
├── assets/
│   ├── json-to-table-icon.svg
│   └── JetBrainsMono-Regular.woff2   （阶段 2 新增）
└── README.md
```

- JS 按现有 `════` 分节注释切分到上述 3 个文件，**只移动不改写**；实现时按实际引用关系微调归属
- 用经典 `<script src>` 按依赖顺序加载（util → render → main，置于 body 末尾）——**不用 ES modules**，保证 file:// 双击打开仍然可用（module 会因 CORS 被浏览器拦截）
- HTML 中的引用路径同步更新（favicon 移入 assets/）
- 拆分完成后先在浏览器全功能回归一遍（转换/折叠/排序/搜索/三种视图/框选复制/主题/拖拽分栏），确认行为与拆分前完全一致

## 阶段 2：字体清晰度（核心）

根因：等宽栈 `"SF Mono", "JetBrains Mono", Menlo…` 前两个字体普通用户机器上不存在，实际回退 Menlo，细且不可控；12.5px 半像素字号易模糊；缺渲染优化属性。

1. 下载 JetBrains Mono Regular woff2（OFL 协议允许本地分发）到 `assets/`，`@font-face` + `font-display: swap`；中文字符自动逐字回退系统字体
2. `--mono` 栈升级：`"JetBrains Mono", ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace`
3. 字号整数化：新增 `--editor-font-size: 13px` 替换编辑器三处（`#jsonInput`、`#hl`、`.editor-gutter`）的 12.5px；`--editor-line-height` 保持 21px 整数行高，行号/高亮/光标对齐不受影响；表格、按钮、输入 12.5px → 13px，次要文字 11.5px → 12px
4. body 加 `-webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; text-rendering: optimizeLegibility`；等宽区加 `font-variant-ligatures: none` 关连字
5. 解除双行表头耦合：path-row 高度与 `field-row th { top: 27px }` 改为同一 `--path-row-h` 变量控制，防止字号调整后 sticky 表头错位

## 阶段 3：界面精修

1. **主题化自定义滚动条**：`::-webkit-scrollbar` 细滚动条（圆角 thumb、hover 加深、透明 track）+ Firefox `scrollbar-width/scrollbar-color`，亮暗主题各一套
2. **设计 token**：`--radius-s/m/l`（6/8/10px）、分层柔和阴影 `--shadow-sm`，统一按钮/面板/浮层/弹窗圆角与阴影
3. **交互状态**：`.btn`/`.icon-btn` hover 加背景 tint + 0.15s transition；primary 按钮 hover 用深一档主色替代 opacity；全局 `:focus-visible` 主色外环（box-shadow 实现，不挤压布局）；搜索框 focus 同款 ring
4. **表格**：单元格 padding 7px → 8px；sticky 首列右侧 1px 分隔阴影
5. **细节**：状态点光晕、统计数字 `tabular-nums`、modal 背景轻微 backdrop blur、logo 字距、暗色主题 `--muted` 对比度提升（#64748b → #8294ad）

## 收尾验证

- `python3 -m http.server` 本地起服务 + 浏览器实测：编辑器行号/高亮/光标逐行对齐（多行 + 横向滚动 + 折叠）、双行 sticky 表头不错位、三种视图、排序/搜索/框选复制、亮暗主题、窄屏 <900px、JetBrains Mono 生效确认
- README 更新：新目录结构说明、字体文件说明
- 不做 git 提交（如需提交请另行说明）