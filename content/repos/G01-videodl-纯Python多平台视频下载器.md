---
id: G01
title: "videodl：纯 Python 的多平台视频下载器"
kind: repo
repo: "CharlesPikachu/videodl"
url: "https://github.com/CharlesPikachu/videodl"
homepage: "https://videofetch.readthedocs.io/"
author: "CharlesPikachu"
language: Python
license: "PolyForm-Noncommercial-1.0.0（禁止商用）"
stars: "3312"
forks: 537
pushed: 2026-11-25
stars_on: 2026-11-25
nodes: [F1, C5]
direction: "工具与开源"
created: 2026-11-25
updated: 2026-11-25
---

## 30 秒摘要

videodl 把七十个平台专用客户端和三十六个通用解析器收在同一个 VideoClient 后面，调用方只管给 URL、拿回一组 VideoInfo。值得看的是分层：解析与下载分开，平台差异封在 sources 目录，外部工具按开关接入，扩一个平台不用碰核心流程。许可证是 PolyForm 非商用，设计能读，代码不能搬进商业项目。

## 它做什么

一个纯 Python 的轻量下载器，目标是「优先高清无水印」。它不自己实现每个站点的协议，而是把差异封成一个个客户端。

| 类别 | 数量 | 目录 | 例子 |
|---|---|---|---|
| 平台专用 client | 70（国内 48 / 海外 22） | `videodl/modules/sources/` | 抖音、快手、B站、爱奇艺、TikTok、YouTube |
| 通用解析器 | 36 | `videodl/modules/common/` | 第三方在线解析接口 |

默认顺序是先跑专用 client，失败再逐个试通用解析器。两类返回同一种结果对象 `VideoInfo`，字段有 `source` / `title` / `download_url` / `save_path` / `ext` / `err_msg`。

下载阶段不绑死一种工具，可以切 ffmpeg、aria2c、N_m3u8DL-RE。YouTube、CCTV、腾讯的某些解析步骤要 Node.js 跑一段 JS，加密流会用到 Bento4 的 `mp4decrypt`。`scripts/ffmpeg_segment_remover.py` 是 README 给的裁剪广告示例。

## 怎么用

安装走 PyPI，包名是 videofetch，命令行才叫 videodl：

```bash
pip install videofetch
videodl -i "https://www.acfun.cn/v/ac36491489"
```

`-a` 限定用哪几个 client，`-g` 只用通用解析器，`-c` 配每个 client 的工作目录，`-r` 传 headers 和代理。不写 `-i` 会进交互式命令行。

Python 侧三步：`VideoClient` → `parsefromurl` → `download`。

```python
from videodl import videodl

video_client = videodl.VideoClient(
    allowed_video_sources=["BilibiliVideoClient"],
    init_video_clients_cfg={"BilibiliVideoClient": {"work_dir": "downloads"}},
)
infos = video_client.parsefromurl("https://www.bilibili.com/video/BV13x41117TL")
for info in infos:
    print(info["source"], info["title"], info["download_url"])
    info["download_with_ffmpeg"] = True
video_client.download(infos)
```

解析和下载拆开，能先看 `err_msg` 再决定下不下。`VideoInfo` 同时支持属性访问和字典下标，`info.title` 与 `info["title"]` 都能用。

## 设计上值得看的

**把不稳定性关进边界。** 七十个 client 各自消化一个站点的页面结构和签名算法，核心流程只认统一的 `VideoInfo`。新增平台就是往 `sources/` 加一个文件，调度逻辑不动——适配器模式放在真实项目里比教科书例子清楚得多。

**降级顺序是显式策略。** 专用优先、通用兜底，还能用 `-a` 和 `-g` 改顺序。支付渠道路由也在做类似的事，两边有个关键差别：视频下载挨个试没有副作用，支付重试一次就可能重复扣款，所以支付侧得先查单，确认渠道单据状态再决定能不能推。

**把接口腐化做成流水线。** 仓库有 `daily_test_results/` 和每日 GitHub Actions，天天跑一遍可用性。README 的更新记录里能看到「修复所有坏掉的 client」「移除不再提供免费解析的 API」。爬虫类项目最怕悄悄坏掉，这套日检比堆单元测试实在。

代价也摆在明处：106 个 client 的上游一改就坏，维护量随平台数线性涨；通用解析器依赖第三方在线服务，稳定性不在自己手里。

## 我的判断

许可证是硬边界：PolyForm-Noncommercial-1.0.0，README 写明仅供学习、禁止商用。设计思路可以拿来讲，代码不能复制进公司的项目。

我存疑的是「成功率」的来源。README 承认通用解析接口会往视频里插广告，还得用 ffmpeg 剪掉；这说明相当一部分解析能力是拿外部不确定服务换来的，不算项目自身的技术积累。那些服务一关，36 个通用 client 会同时失效——从 2026-06-26 那次批量移除失效 API 的提交看，这不是假设。

还有一处缺口：项目只管下载，不处理「解析成功但下载中途失败」「分片缺失」这类状态，`VideoInfo` 里只有一个 `err_msg`。真要拿它做数据管线，得自己补重试和完整性校验。

## 落到我这里

拿它讲系统设计别背平台清单，四个词就够：统一接口、策略路由、结果对象、外部工具开关。对上 `F1-01 系统设计题的四步答题框架（白板题不慌）` 里的「定边界」那一步。

分层这条接到 `C5-02 分层与防腐层：依赖箭头为什么只能往里指`：站点差异封在 `sources/`，核心只依赖 `VideoInfo`，依赖箭头朝内。

降级顺序要跟 `C6-01 服务治理：超时、重试、熔断、限流` 对照着讲。视频下载可以挨个试，支付链路重试前必须先确认渠道单据状态——这个差别才是我能拿出来的业务纵深，别讲成通用的「重试机制」。

仓库收藏不进复习队列，是随手可查的参考。
