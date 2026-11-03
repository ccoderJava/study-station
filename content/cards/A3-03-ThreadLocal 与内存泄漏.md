---
id: A3-03
title: "ThreadLocal 与内存泄漏"
kind: card
nodes: [A3]
primary: A3
direction: "Java 并发"
event: "面试高频"
project: "多租户上下文 / 链路追踪"
level: core
status: draft
created: 2026-11-03
updated: 2026-11-03
---

## 30 秒简述

ThreadLocal 给每个线程一份独立副本，数据存在 **Thread.threadLocals（ThreadLocalMap）** 里，key 是 ThreadLocal 的弱引用，value 是强引用。线程池复用线程时，如果不 remove，value 会随线程一直存活，造成**内存泄漏 + 数据串号**；所以必须 try-finally 里 remove。父子线程传递用 InheritableThreadLocal，线程池场景要用 TransmittableThreadLocal（阿里 TTL）。

## 是什么

- 每个 Thread 持有 ThreadLocalMap，Entry 的 key 为 WeakReference<ThreadLocal>。
- key 被 GC 后变成 null，但 value 仍被 Entry 强引用，形成"key 为 null 的僵尸 entry"，只有在下一次 get/set/remove 触发探测式清理时才可能被回收。
- 所以泄漏的本质是 **Entry 数组随线程存活 + 清理不及时**。

## 为什么这么设计

用弱引用 key 是为了让 ThreadLocal 对象本身能被回收（否则 ThreadLocal 常驻）；但 value 不能也弱引用，因为业务数据可能在别处没有强引用，弱引用会被误回收。这个折中把"清理责任"交给了使用者。

## 不用会怎么样

- 内存泄漏：线程池线程长期存活，大量 value 堆积 → 老年代上涨 → Full GC → 服务抖动。
- 数据串号（更危险）：上一个请求的租户 ID 留在 threadLocal，下一个请求读到别人的租户数据 → **跨租户数据越权**，在 ToB SaaS 财资系统里是重大事故。

## 替代方案

| 方案 | 适用 | 说明 |
|---|---|---|
| 方法参数显式传递 | 链路短、可控 | 最安全，但侵入性强 |
| RequestContext + 拦截器统一清理 | Web 请求场景 | 主流做法 |
| InheritableThreadLocal | 父子线程 | 线程池不生效 |
| TransmittableThreadLocal | 线程池/异步编排 | 需要 TTL agent 或包装 Executor |

## 项目中如何使用

- 财资系统多租户：租户 ID 放 ThreadLocal，由网关/拦截器注入，DAO 层拦截器强制拼租户条件，请求结束时 finally remove。
- 回放环境中必须显式重置上下文，否则回放流量会携带生产的租户上下文，把数据写进错误租户（回放库隔离的前提）。

## 常见陷阱

- 只说"会内存泄漏"但讲不出 key 是弱引用、value 是强引用。
- 忽略"数据串号"这个更严重的后果——面试官问"漏内存要紧还是脏数据要紧"，答脏数据。

## 三层追问

1. 为什么 key 用弱引用 value 不用？——见上，回收语义与可用性的折中。
2. 线程池里怎么传递上下文？——TTL 的装饰 Executor 或手动传递；Spring 的 @Async 需要 TaskDecorator。
3. 哈希冲突怎么解决？——开放寻址（线性探测），不是链表，因为 Entry 数量少且生命周期与线程绑定。

## 我的口述记录

（首次复述后填写）
