---
id: A3-02
title: "AQS 与 ReentrantLock"
kind: card
nodes: [A3, A2]
primary: A3
direction: "Java 并发"
event: "面试高频"
project: "资金安全全局锁 / 账户流水更新"
level: core
status: draft
created: 2026-11-03
updated: 2026-11-03
---

## 30 秒简述

AQS 是一个用 **volatile int state + CLH 双向队列** 实现的同步框架：抢锁就是 CAS 改 state，失败就包装成 Node 入队并由 LockSupport.park 挂起，前驱释放时唤醒后继。ReentrantLock 在它之上加了可重入（state 计数 + 持有线程判断）、公平/非公平、可中断、超时、多条件队列。相比 synchronized，它把锁的控制权交给开发者，代价是必须手动 unlock。

## 是什么

- state：0 表示空闲；独占模式下 N 表示重入次数；共享模式下表示剩余许可数（Semaphore/CountDownLatch 都基于它）。
- 入队与唤醒：tryAcquire 失败 → addWaiter 入队 → acquireQueued 自旋 + park；release 时 unpark 后继。
- 非公平锁上来先 CAS 抢一次（插队），公平锁先看队列有没有前驱。
- Condition：每个 Condition 一条条件队列，await 释放锁并转移节点，signal 转移到同步队列。

## 为什么这么设计

用 state + 队列这套"模板方法"把同步语义统一了，子类只需实现 tryAcquire/tryRelease，所以 JUC 整个体系（锁、信号量、闭锁、读写锁）都能复用一套排队机制。代价是 park/unpark 的唤醒时机和队列操作复杂，调试困难，且不自带锁消除/偏向锁优化。

## 不用会怎么样

没有可中断/超时获取能力 → 死锁时线程永久挂起，只能重启；没有 tryLock → 无法实现"拿不到锁就降级"的降级逻辑；没有 Condition 分离 → 生产者消费者只能用一个等待集，唤醒错对象。

## 替代方案

| 方案 | 适用 | 差异 |
|---|---|---|
| synchronized | 简单临界区 | JVM 内置，自动释放，有锁升级优化，但不能超时/中断/多条件 |
| ReentrantLock | 需要超时、可中断、公平、多条件 | 手动 unlock，必须 try-finally |
| StampedLock | 读多写少 | 乐观读性能更好，不可重入 |
| 分布式锁（Redis/ZK） | 跨进程/跨实例 | 见《04-Redis/02-分布式锁与看门狗》 |

## 项目中如何使用

- 某银行资金安全加固：支付提交前用 Redisson 分布式锁（跨实例），进程内再用 ReentrantLock 保护单据状态机推进，形成"一锁二判断三更新"的双层防护。
- 底层兜底不是靠锁，而是 DB 唯一索引 + 状态机前置校验——锁失效也不会二次扣款。

## 常见陷阱

- 说"AQS 就是 CAS"——CAS 只是入队方式，核心是队列 + park/unpark。
- 把 ReentrantLock 说成"性能比 synchronized 好"——JDK6 之后 synchronized 有锁升级，性能差距已不明显，选型理由是功能而非性能。

## 三层追问

1. 公平锁为什么慢？——每次都要判断 hasQueuedPredecessors + 上下文切换，吞吐低于非公平。
2. AQS 为什么用双向队列？——需要从尾部入队、从头部出队，且取消节点时要能反向找有效前驱。
3. 为什么 park 前要再检查一次条件？——防止在检查与 park 之间发生唤醒，丢失信号（经典 lost wakeup）。

## 我的口述记录

（首次复述后填写）
