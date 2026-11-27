# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 这是什么仓库

「知识工作台」——Java 后端 / 支付清结算方向的面试作战台。内容全部是可版本管理的 markdown，由零依赖的 Python 标准库脚本构建成离线单页站点：双击 `index.html` 即可用，可整体拷进内网。

三份文档的分工，先弄清楚再看代码：

- **`AGENTS.md`** — 项目守则，接手必读。内容写法（九段式、语气机器检查）、归类约定、这个用户的特点，其中很多是硬约束（零依赖、content/ 唯一内容源、id 不可变、全中文）。
- **`FORMAT.md`** — front-matter 字段与段落结构的权威规范，改字段先改它。
- **`README.md`** — 给人类读者：知识点编号总表（`A1`~`F4` 对应哪层哪个点）、站点视图说明。

## 常用命令

```bash
python3 build.py                  # 构建：content/*.md → index.html + assets/
python3 build.py --check          # 只校验：必填字段、节点引用、id 重复、30 秒简述字数、语气配额
python3 build.py --tone           # 列出语气欠账（哪篇 / 哪条规则 / 哪句话）
python3 build.py --tone-baseline  # 清完一批语气问题后收紧基线（只准降）
make build / make check / make tone / make tone-baseline   # 与上面等价
make serve                        # 本地 http.server 8787；localStorage 存进度比 file:// 直开稳定
make pack                         # 构建 + 打包 dist/knowledge-workbench.zip（拷内网用）
```

没有测试套件——`python3 build.py --check` 就是测试，CI 部署前也会先跑它。改完内容的标准自检：

```bash
python3 build.py --check && python3 build.py
```

涉及 UI 改动时用无头 Chrome 截图核对，1440 宽和 390 窄屏都要看（历史上出过窄屏横向溢出）：

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --no-sandbox \
  --allow-file-access-from-files --window-size=1440,1000 \
  --screenshot=/tmp/shot.png --virtual-time-budget=4000 "file://$PWD/index.html#/graph"
```

## 构建管线（改任何东西前先理解这条链）

```
content/*.md（front-matter + markdown 正文）
   │  build.py：解析 front-matter → 校验引用与字数 → 自写 markdown 子集转 HTML → 语气检查 → 聚合
   ▼
assets/data.js              = window.KB = {...}  全部层/节点/条目（正文已渲染成 HTML）
index.html                  ← 原样复制 theme/index.html
assets/app.js、style.css    ← 原样复制 theme/ 同名文件
assets/img/*                ← 原样复制 theme/img/
```

- `theme/` 是模板源，`index.html` 与 `assets/` 是产物：**改产物没用，每次构建都会覆盖**。产物为内网分发仍提交进版本库，所以改完 content 必须构建并一起提交。
- `build.py`（约 950 行）只用 `re/json/os/html/sys/datetime`，markdown 解析是自写的子集（标题、列表、表格、引用、代码块、行内样式），不要为兼容 CommonMark 引入解析库。
- 代码高亮在构建期完成：`CODE_LANGS` 是各语言关键字表，加语言就往里加一条，不要引高亮库。
- `pack.py` 必须用 `zipfile` 不用 `zip` 命令：Python 会给中文文件名写 UTF-8 标记（flag 0x800），macOS 的 `zip` 不写，内网 Windows 解压会乱码。

## 前端架构（theme/app.js，约 2000 行单文件，无框架零依赖）

- **hash 路由**：`route()` 按 `location.hash` 分发到各 `view*()`——`#/` 总览、`#/review` 复习队列、`#/roadmap`、`#/graph`、`#/cards`、`#/reads`、`#/interviews`、`#/repos`、`#/card/<id>`、`#/node/<id>`。全部数据来自 `assets/data.js` 的 `window.KB`，不 fetch，file:// 直开可用。
- 学习进度与 UI 状态（侧栏折叠、宽度、代码配色）存 localStorage 的若干 key；顶栏「数据」按钮导出/导入 JSON。复习队列按遗忘曲线 1/3/7/15/30/60 天推进；`isLearnable()` 把精读/面试/仓库三类内容过滤出复习统计，别给它们加掌握度按钮。
- 图谱是自写的力导向布局：`graphModel → graphLayout → graphSvg → bindGraph`（斥力 + 弹簧 + 层锚点 + 去重叠）。调参只动 `GF` 和布局末尾的 `sx/sy` 横纵比；**不要改回固定泳道布局**——数据量上来后跨层连线横穿画面，方案已被用户否决过一次。
- 插图（`theme/img/`，正文 `![](img/xxx.svg)` 引用）单独成段会渲染成 `<figure>`，灯箱放大走 `initFigure`。图必须落进 `theme/img/` 并插进对应卡片正文，只在对话里回一张图等于没交付。

## 雷区（细节在 AGENTS.md，这里只列最容易被踩的）

- 零第三方依赖：不引 npm、框架、CDN、网络字体、外部图片；新增能力写原生 JS/CSS。
- `content/` 是唯一内容来源，别在 theme/HTML 里硬编码卡片、节点、分类名。
- 节点 id 不可变（字母 = 第几层，数字 = 层内序号）：卡片靠 id 引用节点，改 id 断链；新增节点用该层当前最大编号 +1。
- 卡片固定九段（七段 + 三层追问 + 我的口述记录），`30 秒简述` 150~250 汉字；语气检查是 `--check` 里的正则硬卡，`tone-baseline.json` 是生成的，只许用 `--tone-baseline` 收紧，不许手改。
- 文档、注释、提交信息全部用中文。
- 新增内容时归类、挂节点、`direction`/`event` 由 agent 自己判断，不要问用户；`event` 按「简历关联 > 生产故障 > 项目实践 > 面试高频 > 体系补全」排序。
- 新增内容后同步 `AGENTS.md`「当前进度」和 `README.md`「当前状态」里的统计行。

## 部署

push 到 `main` 触发 `.github/workflows/pages.yml`：`--check` + 构建 → 把 `index.html`、`assets/`、`CNAME` 收进 `_site/`（加 `.nojekyll`）→ GitHub Pages 发布到自定义域名 `study-station.ccoder.cc`（仓库根 `CNAME` 与发布目录各一份）。在其他分支上的改动要合并进 main 才会更新线上。
