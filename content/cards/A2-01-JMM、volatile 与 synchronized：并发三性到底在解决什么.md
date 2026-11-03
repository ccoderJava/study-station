---
id: A2-01
title: "JMM、volatile 与 synchronized：并发三性到底在解决什么"
kind: card
nodes: [A2, A3, A1]
primary: A2
direction: "Java 并发"
event: "面试高频"
project: "某银行资金安全加固、某支付公司限额计数、某跨境电商配置热更新"
level: core
status: draft
created: 2026-11-03
updated: 2026-11-03
---

## 30 秒简述

并发问题只有三类根因：**原子性**（一步操作被打断）、**可见性**（一个线程改了，另一个看不见）、**有序性**（编译器/CPU 重排指令）。对应的三板斧：**synchronized**（三性全包，锁 + 内存屏障）、**volatile**（只保可见性和有序性，不保原子性）、**CAS/原子类**（保原子性，无锁）。面试的高频陷阱是「volatile 能不能保证 i++ 安全」——**不能**，因为 `i++` 是「读-改-写」三步，volatile 只保证每次读到最新值，不保证三步之间不被打断。

## 是什么

1. **JMM（Java 内存模型）**
   - 每个线程有自己的工作内存（寄存器/CPU 缓存），共享变量在主内存。线程读写要先拷贝到工作内存——这就是可见性问题的物理来源。
   - JMM 定义了 8 种原子操作（read/load/use/assign/store/write/lock/unlock）和 **happens-before** 规则，用来判断「一个写对另一个读是否可见」。
   - 关键 happens-before：程序顺序、监视器锁（unlock 先于后续 lock）、volatile（写先于后续读）、线程启动/终止、传递性。
2. **volatile 的两件事**
   - **可见性**：写 volatile 变量时立即刷回主内存并**使其他 CPU 缓存行失效**（MESI 协议）；读时直接从主内存读。
   - **有序性**：通过**内存屏障**禁止重排（写前 StoreStore、写后 StoreLoad、读后 LoadLoad/LoadStore）。
   - **不保证原子性**：`i++` / `check-then-act` 依然会出错。
3. **synchronized 的三层升级**
   - 无锁 → 偏向锁（JDK 15 后默认废弃）→ 轻量级锁（CAS 自旋）→ 重量级锁（操作系统 mutex）。
   - 锁的是**对象头 Mark Word**，不是代码块。静态方法锁 Class 对象，实例方法锁 this。
   - 同时提供原子性、可见性（unlock 前刷主存）、有序性（临界区不重排）。
4. **CAS 与原子类**
   - 三个操作数：内存值 V、预期值 A、新值 B；`V == A` 才更新为 B，否则重试。
   - 底层是 CPU 的 `cmpxchg` 指令 + `lock` 前缀（保证原子与可见）。
   - **ABA 问题**：值从 A→B→A，CAS 认为没变。解决用 `AtomicStampedReference`（加版本号）。
   - 自旋开销：高竞争下大量空转，LongAdder 用「分段累加」缓解（类似 ConcurrentHashMap 的分段思想）。

## 为什么这么设计

因为**硬件为了性能做了大量优化**：CPU 有缓存（导致可见性问题）、编译器和 CPU 会重排（导致有序性问题）、多核并行执行（导致原子性问题）。这些优化不能关掉（关掉性能会掉一个数量级），只能用**内存屏障和原子指令**在关键点上强制约束。

volatile 之所以「便宜」，就是因为它只加了屏障，不加锁；synchronized 之所以「贵」，是因为它要保证临界区互斥（涉及线程阻塞/唤醒，重量级锁要走内核）。所以选择标准很简单：**只需要可见性用 volatile，需要互斥用锁**。

## 不用会怎么样

- 用普通变量做「停止标志」：`while (!stop) {}` 主线程改了 `stop = true`，工作线程永远看不到（JIT 把它优化成 `while(true)`），程序不退出。**这是最经典的可见性 bug**。
- volatile 做计数器：`count++` 在 100 线程下结果远小于 10000，因为读-改-写不是原子的。
- 双重检查锁（DCL）单例不加 volatile：`instance = new Singleton()` 分三步（分配内存、初始化、赋值引用），重排后可能把「未初始化完成的对象」发布出去，另一个线程拿到半成品。
- 用 `HashMap` 做并发缓存：JDK 7 的头插法在并发扩容时会形成环形链表，CPU 100%（JDK 8 改为尾插，但依然不安全）。

## 替代方案

| 需求 | 方案 | 说明 |
|---|---|---|
| 只传信号（停止标志、配置刷新） | `volatile` | 最轻 |
| 计数/累加 | `AtomicLong` / `LongAdder` | 高并发用 LongAdder（分段） |
| 复合操作（检查再更新） | `synchronized` / `ReentrantLock` / `ConcurrentHashMap.compute` | 原子类做不了多变量 |
| 读多写少的共享结构 | `ConcurrentHashMap` / `CopyOnWriteArrayList` | 分段锁 / 写时复制 |
| 线程间传递数据 | `BlockingQueue` | 比共享变量 + wait/notify 可靠 |
| 一次性初始化 | 静态内部类 / 枚举 / DCL + volatile | 枚举最简洁且防反射 |

## 项目中如何使用

- **某银行资金安全加固**：限额校验里有 `if (used + amount > limit) reject;` 这种「检查再更新」，早期用 volatile 修饰 `used`，压测时出现超额放行。改成 `AtomicLong` 的 `compareAndSet` 循环（无锁，性能好），跨 JVM 的场景改用 Redis Lua 原子脚本。**教训：volatile 只能解决「看到最新值」，解决不了「看到之后别人也改了」**。
- **某支付公司限额计数**：单机用 `LongAdder`（比 AtomicLong 高 3~5 倍吞吐），跨机用 Redis 计数，本地只做粗筛（先本地放行 80%，超过再问 Redis），减少 Redis 调用。
- **某跨境电商配置热更新**：配置对象用 `volatile` 引用 + 「整体替换」而不是「逐字段修改」——`volatile Config config` 每次 set 一个新对象，读方拿到的永远是一个完整快照，天然避免「改到一半被读到」。**这是 copy-on-write 的简化版，比加锁简单得多**。
- **DCL 单例**：SDK 里的加解密器是 DCL 单例，`instance` 必须 `volatile`。代码评审时这条被专门列成检查项——因为它不加 volatile 也能跑通 99% 的测试，只在特定 GC/JIT 时机炸。

## 常见陷阱

- **volatile 保证原子性**：最经典的错误认知，`i++`、`check-then-act`、多字段一致性都不行。
- **synchronized 锁错对象**：锁 `String` 常量、锁 `Integer`（缓存对象复用）、锁 `this` 但调用方锁的是另一个实例——等于没锁。
- **锁的粒度太大**：整个方法加锁，包含远程调用/RTO 序列化，锁持有时间从 1ms 变成 200ms，吞吐掉 200 倍。
- **DCL 不加 volatile**：能跑通测试，线上偶发 NPE（拿到未初始化对象）。
- **以为 `ConcurrentHashMap` 所有操作都原子**：`get` 后 `put` 不是原子的，要用 `computeIfAbsent` / `merge`。
- **`ThreadLocal` 用在线程池里**：线程复用导致脏数据 + 内存泄漏（必须 `remove()`，A3-03 有专门一篇）。
- **用 `wait/notify` 不配合 while**：`if (条件) wait()` 会被虚假唤醒打穿，必须 `while`。

## 三层追问

1. **volatile 的底层实现是什么？**——汇编层面是 `lock` 前缀指令（或 `mfence`），它做两件事：把当前处理器缓存行写回内存、使其他处理器对应缓存行失效（MESI 的 invalidate）。同时 `lock` 前缀本身具有内存屏障语义，禁止指令重排。
2. **synchronized 和 ReentrantLock 怎么选？**——优先 synchronized（JVM 内置、自动释放、有锁升级优化）；需要**可中断、超时、公平锁、多条件变量**时才用 ReentrantLock。注意 ReentrantLock 必须在 finally 里 unlock。
3. **为什么 `LongAdder` 比 `AtomicLong` 快？**——AtomicLong 所有线程 CAS 同一个变量，高并发下大量失败重试；LongAdder 把值拆到多个 Cell，线程哈希到不同 Cell 累加，最后 sum。代价是 `sum()` 不是强一致快照（弱一致）。

## 我的口述记录

（首次复述后填写）
