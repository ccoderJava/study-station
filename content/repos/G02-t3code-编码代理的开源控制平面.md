---
id: G02
title: "T3 Code：把编码代理收进一个控制平面"
kind: repo
repo: "pingdotgg/t3code"
url: "https://github.com/pingdotgg/t3code"
homepage: "https://t3.codes"
author: "pingdotgg"
language: TypeScript
license: "MIT（只覆盖源码，商标与品牌另算）"
stars: "77999"
forks: 13407
pushed: 2026-11-25
stars_on: 2026-11-25
nodes: [C5, D5, E5]
direction: "工具与开源"
created: 2026-11-25
updated: 2026-11-25
---

## 30 秒摘要

T3 Code 把跑在自己机器上的编码代理收进一个控制平面，桌面、网页、手机连同一台 server 看同一批线程，还能从手机审批下一步。值得看的是三处：不转售 token，沿用你已有的订阅；用 ACP 协议加专有适配接住多家代理；每个线程独占一份 worktree，并行改动不互相踩。MIT 只覆盖源码，品牌另算；远程审批的权限边界 README 没展开，要在生产机器上用得先翻权限文档。

## 它做什么

一句话定位是「The open-source control plane for coding agents」。代理跑在用户自己的机器上，T3 Code 负责编排和界面，不在中间转卖 token。

| 维度 | 覆盖范围 |
|---|---|
| 可接管代理 | Claude Code、Codex、Cursor、OpenCode、Grok Build、Antigravity、Kiro、Pi、Muse Code、fx，以及任意 ACP agent |
| 客户端 | 桌面 app（macOS / Windows / Linux）、Web、iOS、Android，同一个 server 看到同一批 threads |
| 接入方式 | 本机局域网、Tailscale、项目自带的 T3 Connect |
| 版本控制 | 每个 thread 可独占一份 git worktree，看 diff 后一键 commit、push、开 PR |

典型场景是在工位上起一个线程，离开后在手机上批准代理的下一步动作。线程中途可以换模型，也可以让一个代理把任务交给另一个。

从仓库文件看，主体是 pnpm workspace 下的 TypeScript 项目，`apps/` 与 `packages/` 放应用和共享包，`native/` 是原生组件，`docs/`、`evals/`、`infra/` 分别是文档、评测与基础设施；配置里能看到 Vite、Effect 和 Cargo 的痕迹。README 把性能列为特性，写明掉帧按 bug 处理。

抓取时的元数据：77999 star、13407 fork、3654 个未关闭 issue、13698 次提交，最近推送 2026-11-25。star / fork 是当日快照，不是实时值。

## 怎么用

桌面端可以从官网下载，也可以走包管理器：

```bash
brew install --cask t3-code                                      # macOS
winget install T3Tools.T3Code                                   # Windows
scoop install extras/t3code                                     # Windows
yay -S t3code-bin                                               # Arch Linux
nix profile add github:NixOS/nixpkgs/nixos-unstable#t3code      # Nix
```

命令行装完得到 `t3`，运行后启动 server 并打开 Web 界面。不想安装可以直接试跑：

```bash
curl -fsSL https://t3.codes/install.sh | sh
t3
npx t3@latest
```

Windows 用 PowerShell：

```powershell
irm https://t3.codes/install.ps1 | iex
```

T3 Code 本身不提供模型凭证，需要机器上先装好并登录至少一个代理：

```bash
claude auth login
codex login
```

手机端从 App Store 或 Google Play 安装，按 remote access 文档连到电脑。远程还涉及权限模式和 MCP 接入外部代理，README 只给了文档入口，没有展开配置。

## 设计上值得看的

**控制面和执行面分开。** 编码代理留在用户机器上跑，T3 Code 只做线程编排、界面分发和审批入口。好处是凭证不用交给控制面，坏处是多端一接进来，会话一致性和权限边界全压到那一台 server 上。

**先定协议，再补特例。** 它用 ACP 接住任意兼容代理，对 Claude Code、Codex 这些再做专有适配。跟 videodl 那种「一个站点一个 client、逐个消化差异」的路子正好反过来：一个先把接口立住，一个先把实现铺开。两条路都能扩，但出错的位置不同——前者卡在协议版本，后者卡在上游页面改动。

**worktree 当并发边界。** 每个线程可以有自己的工作区，代理并行改代码时不共用一个目录。这是很实在的隔离手段，代价是磁盘占用和分支清理都得有人管。

**把性能当功能测。** README 明说「We measure it, and we treat a dropped frame as a bug」，最近提交里能看到 Web、原生组件、iOS 多个方向在同一天修体验问题。跑得快也有另一面：3654 个未关闭 issue 说明维护压力不小，外部代理一升级，适配层最先受压。

## 我的判断

远程审批这块我不放心。README 把「在手机上批准下一步」当卖点，但没说谁能连进这台 server、不同客户端的权限是否一致、审批动作留不留痕。权限模式和远程接入各有文档，值得在真机上用之前把这两篇读完；只照 README 部署，等于把执行确认权放到了一个边界没写清的入口上。

「不转售 token」是真的省事，也说明它不靠中间层吃差价。但控制面能看到所有会话和 diff，前提一直是数据留在自己机器；一旦接官方远程服务，这个前提要重新算，不能因为源码是 MIT 就默认数据路径也完全自主。

许可证跟 videodl 的非商用不一样：MIT 覆盖源码，但 T3 Tools 的名称、标识和图标被 `TRADEMARK.md` 单独留着，公开 fork 必须换品牌并声明非官方。代码可以读可以改，品牌不能顺手带走。

还有一个上限问题：它能控制什么，取决于外部代理暴露什么。项目自己不产出模型能力，代理接口一变，适配层要跟着改。13698 次提交既是迭代速度，也是这块不稳的证据。

## 落到我这里

控制面和执行面分开这条，接到 `C5-02 分层与防腐层：依赖箭头为什么只能往里指`。代理的不稳定性被 ACP 和专有适配关在边界内，核心只认统一的线程模型，跟站点差异封在 `sources/` 是同一个方向。

一个 server 对多端、再加上 MCP 接外部代理，是 `D5-01 可观测性与发布：出事时你能不能在三十分钟内说清原因` 里「多入口之后怎么把状态说清」的另一份样本。他们把掉帧当 bug，我把排查超时当事故，度量对象不同，但都得先有埋点和统一视图。

最值得对照的是 `E5-01 支付状态机与超时补偿`。手机上点一下「批准」可以作为风控卡点，不能当资金终态的事实来源——支付侧的状态只能靠渠道回盘或主动查询确认，中间态要靠定时任务继续同步。把代理工作流的人工审批直接套到资金链路上，会把「谁确认了这笔钱」这个要件弄丢。

我那篇讲 AI 写代码谁来证明其正确性的精读，说的是生成之后的验证缺口。T3 Code 解决的是「怎么驱动代理」，不解决「怎么证明改对了」；测试、对账和状态机这些活还在自己手里。

仓库收藏不进复习队列，需要查的时候按仓库名搜就行。
