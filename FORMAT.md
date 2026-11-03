# 复习站 · 内容格式规范

这个站点的一切内容都是 markdown 文件。**改内容只需要改 markdown，然后跑一次构建。**
知识路线、知识点图谱、覆盖率、检索索引，全部从这些文件里解析出来，没有任何硬编码。

---

## 1. 目录结构

```
pay-review-station/
├── content/
│   ├── layers/       S1.md ~ S6.md      六层能力模型（决定路线图的层）
│   ├── nodes/        A1.md ~ F4.md      33 个知识点节点（决定图谱的节点）
│   ├── cards/        A3-01-xxx.md       知识卡片（一个知识点一篇）
│   └── scenarios/    S01-xxx.md         场景题（一道题串多个知识点）
├── theme/            index.html / app.js / style.css   站点模板
├── build.py          构建器（零依赖，Python 标准库）
├── index.html        ← 构建产物，双击即用
└── assets/           ← 构建产物（data.js / app.js / style.css）
```

**只改 `content/`，不要改 `index.html` 和 `assets/`**——它们每次构建都会被覆盖。

---

## 2. 四种文件的 front-matter

所有文件都以 `---` 包裹的元数据开头，正文从第二个 `---` 之后开始。

### 2.1 层 `content/layers/S1.md`

```yaml
---
id: S1
name: "语言与并发内核"
role: "资格层"
desc: "能不能写出正确的代码"
order: 1
---
```

| 字段 | 必填 | 说明 |
|---|---|---|
| id | 是 | `S1`~`S6`，全局唯一 |
| name | 是 | 层名称，显示在路线图和图谱里 |
| role | 否 | 资格层 / 护城河 / 分水岭 |
| desc | 否 | 一句话说明这一层考什么 |
| order | 是 | 排序，数字小的在上 |

### 2.2 知识点 `content/nodes/A3.md`

```yaml
---
id: A3
layer: S1
name: "并发工具"
keywords: ["线程池", "AQS", "ReentrantLock", "ThreadLocal"]
---
```

| 字段 | 必填 | 说明 |
|---|---|---|
| id | 是 | `A1`~`F4`，全局唯一。**卡片通过这个 id 关联到你** |
| layer | 是 | 必须等于某个已存在的层 id |
| name | 是 | 知识点名称 |
| keywords | 是 | 搜索用的关键词，数组 |

正文写「这个知识点要解决什么」「面试常问角度」，会显示在知识点详情页。

### 2.3 知识卡片 `content/cards/A3-01-线程池参数与拒绝策略.md`

```yaml
---
id: A3-01
title: "线程池参数与拒绝策略"
kind: card
nodes: [A3]
primary: A3
direction: "Java 并发"
event: "生产故障"
project: "招银云创对账批量 / 代发批量"
level: core
status: draft
created: 2026-11-03
updated: 2026-11-03
---
```

| 字段 | 必填 | 说明 |
|---|---|---|
| id | 是 | 建议 `节点id-序号`，全局唯一，也是 URL：`#/card/A3-01` |
| title | 是 | 卡片标题 |
| kind | 是 | 固定 `card` |
| nodes | 是 | 关联的知识点 id 数组。**第一个决定它挂在哪个知识点下**；多个表示这张卡打穿多个知识点 |
| primary | 否 | 主节点，缺省取 nodes[0] |
| direction | 是 | 技术方向，见下方枚举 |
| event | 是 | 事件类型，见下方枚举 |
| project | 否 | 关联的真实项目，面试时用来举例子 |
| level | 否 | `core`（重点）/ `normal`（默认）。core 会显示红色「重点」标记 |
| status | 否 | 内容成熟度：`draft` / `review` / `done` |
| created / updated | 否 | 日期，显示在卡片头部 |

### 2.4 场景题 `content/scenarios/S01-幂等与防重复支付.md`

```yaml
---
id: S01
title: "幂等与防重复支付（一锁二判断三更新）"
kind: scenario
nodes: [E5, D3, A3]
primary: E5
direction: "系统设计"
event: "简历关联"
project: "招银云创资金安全加固"
level: core
---
```

字段与卡片完全相同，只有 `kind` 为 `scenario`，文件放在 `scenarios/`。

**场景题与卡片的区别**：卡片讲一个知识点，场景题是一道题串起多个知识点。
`nodes` 里的多个 id 会在图谱上画成连线——这是图谱最有价值的部分，能看出哪些知识点会组合出现。

---

## 3. 字段枚举（保持统一，否则筛选和分组会散）

### direction 技术方向

`Java 并发` ｜ `JVM` ｜ `MySQL` ｜ `Redis` ｜ `消息队列` ｜ `微服务` ｜ `Spring` ｜ `系统设计` ｜ `支付清算` ｜ `财资业务`

新增方向可以直接写，侧栏会追加到末尾，但顺序建议在上面的列表里注册（改 `theme/app.js` 的 `DIR_ORDER`）。

### event 事件类型（这张卡为什么存在）

| 值 | 含义 | 典型来源 |
|---|---|---|
| `面试高频` | 八股必问，与项目无关也要会 | 面经、CodeTop |
| `生产故障` | 线上真出过的问题 | 你处理过的故障 |
| `项目实践` | 项目里做过、有细节可讲 | 招银云创 / PayBy / shopline |
| `简历关联` | 简历上写了、面试必被追问 | 简历条目 |
| `体系补全` | 为了知识结构完整而补，没有直接经历 | 路线图缺口 |

按 event 排序复习的优先级是：**简历关联 > 生产故障 > 项目实践 > 面试高频 > 体系补全**。
简历上写了但讲不出来的，是最危险的。

---

## 4. 新增一篇内容的标准流程

1. 在 `content/cards/` 或 `content/scenarios/` 新建 md，文件名 `节点id-序号-标题.md`
2. 复制上面的 front-matter 模板，填 `id` / `title` / `nodes` / `direction` / `event`
3. 正文按七段式写：
   - `## 30 秒版`
   - `## 是什么（核心机制）`
   - `## 为什么这么设计（权衡）`
   - `## 不用它会怎样`
   - `## 替代方案对比`
   - `## 项目里怎么用（陈聪）`
   - `## 三层追问`
   - `## 常见陷阱`
   - `## 我的口述记录`
4. 跑构建：

```bash
python3 build.py
```

5. 打开 `index.html` 检查

### 只校验不构建

```bash
python3 build.py --check
```

会检查：必填字段是否缺失、`nodes` 引用的知识点是否存在、`id` 是否重复、`layer` 是否合法。

---

## 5. 构建器做了什么

`build.py` 对每个 md 文件：

1. 解析 front-matter（一个 YAML 子集：`key: value` / `key: "value"` / `key: [a, b]`）
2. 把正文 markdown 渲染成 HTML（支持标题、列表、表格、引用、代码块、行内样式）
3. 建立反向索引：节点 → 关联的卡片和场景题
4. 输出 `assets/data.js`（全部内容 + 索引）和 `index.html`（壳）
5. 打印覆盖率统计

**没有任何第三方依赖**，不需要 npm、不需要装包，Python 3 自带环境就能跑。

---

## 6. 已知约定

- 卡片正文里不要再写 `# 一级标题`，标题由 front-matter 的 `title` 提供
- 一张卡片最多关联 3~4 个知识点，多了说明这张卡该拆
- 节点 id 一旦确定不要改（卡片引用了它）；新增节点用当前层内最大编号 +1
- `status` 是内容成熟度（我写得够不够全），学习进度由站点在浏览器里单独记录，两者不是一回事
