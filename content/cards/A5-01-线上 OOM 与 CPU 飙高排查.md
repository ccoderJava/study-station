---
id: A5-01
title: "线上 OOM 与 CPU 飙高排查"
kind: card
nodes: [A4, A5]
primary: A5
direction: "JVM"
event: "生产故障"
project: "招银云创探活失败 / 日志队列积压"
level: core
status: draft
created: 2026-11-03
updated: 2026-11-03
---

## 30 秒版
排查分两条线：**CPU 高**看线程栈（top -Hp → printf %x → jstack，找 RUNNABLE 且反复出现在同一方法的线程）；**内存问题**先看 GC 日志与堆曲线，再 dump 分析（jmap / arthas heapdump + MAT 看支配树与 GC Roots 引用链）。容器环境先确认不是探针/限流导致的假象，再定位是业务代码、框架还是外部依赖。

## 是什么（核心机制）
- CPU：`top -Hp <pid>` 找高 CPU 线程 → `printf "%x\n" tid` → `jstack pid | grep -A 30 nid=0x...`；反复出现的栈顶方法就是热点。
- 内存：`jstat -gcutil pid 1000` 看 YGC/FGC 频率与老年代增速；`jmap -histo:live` 看对象直方图；`jmap -dump` 后 MAT 看 dominator tree、retained size、GC Roots 路径。
- 常见 OOM 类型：heap space（对象过多/泄漏）、GC overhead limit（回收效率过低）、Metaspace（动态类生成过多）、Direct buffer memory（NIO）、unable to create new native thread（线程数超限）。

## 为什么这么设计（权衡）
不推荐"先重启再说"：重启会丢失现场，下一次还会复现。正确顺序是**先保现场（dump + 线程栈）→ 再止血（限流/降级/扩容）→ 后根治**。这个顺序是取舍：可用性优先，但必须留下事后分析的证据。

## 不用它会怎样
没有 dump，只能靠猜，同类问题会反复发生；不做线程栈分析，容易把"下游超时导致的线程堆积"误判成"CPU 不足"，加机器后问题依旧。

## 替代方案对比
| 工具 | 场景 | 说明 |
|---|---|---|
| jstack / jmap / jstat | 现场快照 | JDK 自带，容器内需有权限 |
| Arthas | 在线诊断（trace/watch/thread） | 生产首选，可热定位方法耗时 |
| MAT / JProfiler | dump 分析 | MAT 免费且足够 |
| Prometheus + Grafana | 趋势与告警 | 事后复盘与容量规划 |

## 项目里怎么用（陈聪）
真实案例：代发业务日志量过大 → logEvent 在 ArrayBlockingQueue 中堆积 → 线程被阻塞在日志入队 → **K8s 探针超时，Pod 反复重启**。
排查路径：Pod 重启 → 看探针失败时间点与 GC/线程栈 → 发现线程大多阻塞在 log4j 异步队列 put → 队列满且 blocking=true。
处置：临时止血改 `log4j2.asyncLoggerBlocking=false`（队列满丢弃，先保可用）；根治从业务入手——日志主要来自查询逻辑，**把查询剥离为独立服务、读写分离**，从源头降低核心服务的日志与负载。

## 三层追问
1. 为什么不能直接把 blocking 改 false 就完事？——丢弃日志会丢审计记录，金融场景不可接受，只能作为临时止血。
2. 如何判断是内存泄漏还是内存不足？——泄漏的特征是老年代 GC 后仍持续上涨；不足是稳态但峰值不够，看 Full GC 后回收比例。
3. 容器里 jstack 拿不到怎么办？——用 `jcmd`、进入容器 nsenter、或 arthas；也可配置 JVM 在 OOM 时自动 dump（`-XX:+HeapDumpOnOutOfMemoryError`）。

## 常见陷阱
- 一上来就说"加大内存"——没定位根因的扩容只是延后故障。
- 忽略探活/健康检查本身的问题（探针超时时间设太短也会误杀）。

## 我的口述记录
（首次复述后填写）
