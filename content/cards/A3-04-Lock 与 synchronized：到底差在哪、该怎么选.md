---
id: A3-04
title: "Lock 与 synchronized：到底差在哪、该怎么选"
kind: card
nodes: [A3, A2]
primary: A3
direction: "Java 并发"
event: "面试高频"
project: "某银行资金安全双层锁、某支付公司结算批次串行、配置中心读写分离"
level: core
status: draft
created: 2026-11-03
updated: 2026-11-03
---

## 30 秒简述

**它们不是「新旧」关系，是「关键字 vs 类」的关系。**

`synchronized` 是 JVM 层的**内置锁**：加锁解锁由字节码 `monitorenter/monitorexit` 完成，异常自动释放，锁状态存在对象头 `Mark Word` 里。`Lock` 是 JDK 层的**接口**，`ReentrantLock` 基于 AQS，用 `volatile int state` 记录状态，**必须手动 `unlock`**。

真正的差异只有四条能力：**可中断、可超时、可公平、多条件队列**。这四条 `synchronized` 一个都没有。

性能不是选型理由——**JDK 6 引入锁升级后，低竞争下 `synchronized` 往往更快**（有锁消除、偏向锁），而且不用手动释放，不会漏。所以正确答法是：**默认用 `synchronized`，需要那四个能力时才用 `ReentrantLock`**。

## 是什么

### 一、七维对比（面试就按这个结构答）

| 维度 | `synchronized` | `ReentrantLock` |
|---|---|---|
| **层级** | JVM 关键字，字节码指令 | JDK 类，`java.util.concurrent.locks` |
| **锁的载体** | 对象头 Mark Word | AQS 的 `volatile int state` |
| **获取/释放** | 隐式，代码块进出自动 | 显式，必须 `unlock()` |
| **异常安全** | 自动释放（编译器插异常处理器） | 靠 `finally`，漏写就是死锁 |
| **可中断** | 不支持，等锁线程不能被中断打断 | `lockInterruptibly()` 支持 |
| **超时** | 不支持，只能一直等 | `tryLock(timeout, unit)` 支持 |
| **公平性** | 非公平（无公平选项） | 可选公平/非公平 |
| **条件队列** | 1 个（`wait/notify` 绑在 monitor 上） | **N 个**（`newCondition()` 各一条） |
| **可重入** | 支持（monitor 的 `_recursions`） | 支持（AQS state 计数 + 持有线程判断） |
| **锁升级** | 有（偏向 → 轻量 → 重量） | 没有，一直是 CAS + park |
| **跨方法传递** | 不能（作用域固定） | 能（锁对象可以传参） |

**记忆法**：能力上 `Lock` 是 `synchronized` 的超集，**唯一不如它的是「不能自动释放」**。所以面试说「Lock 更灵活但更危险」是准确的。

### 二、四个独有能力，各自解决什么问题

#### 1. 可中断：`lockInterruptibly()`

`synchronized` 的等待**不可中断**——线程卡在等锁上，`interrupt()` 只能置个标志，它还是得等锁。这意味着**服务关闭时无法优雅退出**：正在排队的线程只能等前面的跑完。

```java
lock.lockInterruptibly();   // 等待期间可被 interrupt 打断，抛 InterruptedException
```

典型场景：批量任务取消。用户点了「取消」，线程池里的任务如果卡在 `synchronized` 上，只能等它自己跑完；用 `lockInterruptibly` 就能立刻响应。

#### 2. 超时：`tryLock(timeout, unit)`

```java
if (lock.tryLock(3, TimeUnit.SECONDS)) {
    try { /* 干活 */ } finally { lock.unlock(); }
} else {
    // 抢不到 → 降级、转异步、快速失败
}
```

**这是资金系统里最常用的能力**。抢锁等 3 秒还拿不到，说明冲突严重或有人卡死，继续等只会积压线程、耗尽连接池。**快速失败 + 转补偿队列**远比无限等待安全。

`synchronized` 做不到——它没有「放弃」这个选项。

#### 3. 公平锁

```java
new ReentrantLock(true);   // 公平：按排队顺序拿锁
```

`synchronized` 永远非公平。公平锁的意义不是「更正确」，而是**避免饿死**。默认非公平的原因是吞吐：新来的线程可以直接抢，而唤醒一个 park 的线程有延迟，那段时间锁空着就是浪费。

**什么时候真需要公平**：任务有严格顺序要求、或排队时间差异必须可控（如对账批次必须按提交顺序执行）。

#### 4. 多条件队列：`Condition`

`synchronized` 只有一个等待集，`notify()` 随机唤醒一个，`notifyAll()` 全叫醒——**生产者消费者共存时必然误唤醒**。

`ReentrantLock` 可以开多条队列，精确唤醒：

```java
ReentrantLock lock = new ReentrantLock();
Condition notFull  = lock.newCondition();   // 生产者在这条队列等
Condition notEmpty = lock.newCondition();   // 消费者在这条队列等

// 生产者
lock.lock();
try {
    while (queue.size() == capacity) notFull.await();   // 只等「不满」
    queue.add(x);
    notEmpty.signal();          // 只叫醒消费者，生产者一个都不动
} finally { lock.unlock(); }

// 消费者
lock.lock();
try {
    while (queue.isEmpty()) notEmpty.await();            // 只等「不空」
    x = queue.remove();
    notFull.signal();
} finally { lock.unlock(); }
```

这就是 `ArrayBlockingQueue` 内部的真实写法——**一把锁 + 两个 Condition**。而 `LinkedBlockingQueue` 更进一步用了**两把锁**（`putLock` / `takeLock`）让生产和消费能真正并行。

### 三、可重入是怎么实现的

两边都支持重入，但机制不同，面试常对比：

| | `synchronized` | `ReentrantLock` |
|---|---|---|
| 记录位置 | monitor 的 `_recursions` | AQS 的 `state` |
| 判定方式 | 当前线程 == `_owner` | `getExclusiveOwnerThread() == current` |
| 重入一次 | `_recursions++` | `state + 1` |
| 释放 | 减到 0 才真正释放 | 减到 0 才真正释放 |

```java
// ReentrantLock.NonfairSync.tryAcquire 的核心
if (c == 0) {                                    // 无人持有
    if (compareAndSetState(0, acquires)) { ... }
} else if (current == getExclusiveOwnerThread()) {  // ← 是自己持有
    setState(c + acquires);                       // 直接累加，无需 CAS
}
```

**注意这里没有 CAS**：能走到这个分支说明当前线程就是持有者，不存在竞争，普通写就行（有 happens-before 保证）。

### 四、锁家族：ReadWriteLock 与 StampedLock

`ReentrantLock` 是**排他锁**——读读也互斥。但很多场景读远多于写，这就有了读写锁。

#### ReentrantReadWriteLock

| 组合 | 是否互斥 | 说明 |
|---|---|---|
| 读 + 读 | **不互斥** | 并发读，这是它存在的意义 |
| 读 + 写 | 互斥 | 读写不能同时 |
| 写 + 写 | 互斥 | 写写串行 |

实现上仍是 AQS，但 `state` **一个 int 拆两半**：高 16 位存读锁持有数，低 16 位存写锁重入数。

**两个必须知道的特性**：

1. **支持锁降级（写 → 读）**：持有写锁时再获取读锁，然后释放写锁，能保证「自己写的数据自己立刻读到」且不被别人插队。这是它的招牌用法。
2. **不支持锁升级（读 → 写）**：持有读锁时去拿写锁会**死锁**（自己等自己释放读锁）。想要原子升级只能先释放读锁再抢写锁，中间留出了窗口。

**写锁可能饿死**：读多写少时，读线程源源不断，写线程一直排不上。公平模式下能缓解，但吞吐会掉。

#### StampedLock（JDK 8）

**它压根不是 AQS 实现的**，自己写了一套 CLH 队列，性能比 `ReentrantReadWriteLock` 高。

三种模式：

| 模式 | 方法 | 特点 |
|---|---|---|
| 悲观读 | `readLock()` | 和写锁互斥，等价于普通读锁 |
| 写 | `writeLock()` | 排他 |
| **乐观读** | `tryOptimisticRead()` | **完全不加锁**，只拿一个版本戳，读完再校验 |

```java
long stamp = lock.tryOptimisticRead();   // 不加锁，只读版本号
int cur = value;                          // 直接读（可能被别人改）
if (!lock.validate(stamp)) {              // 校验：期间有没有写操作
    stamp = lock.readLock();              // 有写 → 退化成悲观读，重读
    try { cur = value; } finally { lock.unlockRead(stamp); }
}
```

**代价**：不可重入、不支持 Condition、API 用错（忘记 `validate`）就是数据错误。**只在读极多写极少且能接受重读的场景**用（如统计快照）。

### 五、选型决策

```
需要跨进程互斥？
├─ 是 → 分布式锁（Redis / ZK），本文两类都不够
└─ 否 → 临界区是否只有几行、无外部调用？
        ├─ 是 → synchronized（简单、不会漏释放、有 JIT 优化）
        └─ 否 → 是否需要以下任一能力？
                ├─ 超时放弃       → ReentrantLock.tryLock(timeout)
                ├─ 可被打断       → lockInterruptibly
                ├─ 公平排队       → new ReentrantLock(true)
                ├─ 多条件精确唤醒 → newCondition()
                └─ 需要 → ReentrantLock，且必须 try-finally
        读远多于写？
        ├─ 是，且能接受重读 → StampedLock 乐观读
        ├─ 是，且需要重入/条件 → ReentrantReadWriteLock
        └─ 否 → 普通锁
```

## 为什么这么设计

**为什么 JDK 要另外造一个 Lock**：因为 `synchronized` 的能力边界是**语法层面**固定死的——它没有「放弃等待」和「被打断」的语法位置。而这两条在服务端是刚需（超时降级、优雅停机）。不是 `synchronized` 不好，是它**故意保持简单**。

**为什么 `synchronized` 反而被保留并持续优化**：因为它有两个不可替代的优势——**异常自动释放**（不会因为漏写 `finally` 造成死锁）和**不需要额外对象**（锁状态在对象头里，零内存开销）。JDK 6 之后加锁升级，正是为了把「低竞争场景」的成本压到接近零，让绝大多数代码不需要碰 `Lock`。

**为什么 ReentrantLock 必须手动 unlock**：它把锁做成了**对象**，锁的生命周期与方法调用栈解绑了——可以跨方法传递、可以在 A 方法加锁 B 方法解锁。这种自由带来了责任：编译器无法知道你什么时候不再需要它。

**为什么默认非公平**：唤醒一个 parked 线程涉及上下文切换，从「唤醒」到「真正跑起来」有几十微秒。这段时间锁是空闲的。如果新来的线程（已经在 CPU 上跑着）能直接拿，就等于**用掉了这段空隙**，吞吐自然更高。公平锁把这个空隙优先给排队者，牺牲的就是这段利用率。

## 不用会怎么样

- **`ReentrantLock` 漏写 `finally`**：业务代码抛异常 → 锁永不释放 → 所有后续线程永久阻塞 → 线程池耗尽 → 服务整体不可用。这是 `Lock` 最典型的生产事故，而且**只在异常路径才暴露**，测试很难覆盖。
- **`lock()` 写在 `try` 里面**：

  ```java
  try {
      lock.lock();        // ← 错！如果这里抛异常，finally 会 unlock 一个没拿到的锁
      ...
  } finally { lock.unlock(); }   // 抛 IllegalMonitorStateException，把真实异常吞掉
  ```
  正确写法是 `lock()` 在 `try` **之前**。
- **用 `synchronized` 做「超时降级」**：写不出来，只能无限等，冲突时线程全堆住。
- **用 `synchronized` 实现生产者消费者**：单等待集导致 `notifyAll` 全叫醒，消费线程被生产线程的错误唤醒，空转一轮再睡回去。
- **读写锁解决不了写饥饿**：读多写少时写线程可能长时间拿不到锁，业务上表现为「配置改了但迟迟不生效」。

## 替代方案

| 方案 | 适用 | 代价 |
|---|---|---|
| `synchronized` | 短临界区、无外部调用、要省心 | 无超时/中断/公平/多条件 |
| `ReentrantLock` | 需要上述任一能力 | 必须 `try-finally`，漏写即死锁 |
| `ReentrantReadWriteLock` | 读多写少、需要锁降级 | 写可能饿死；读写不能同时 |
| `StampedLock` | 读极多写极少、可接受重读 | 不可重入、无 Condition、易用错 |
| `AtomicXxx` / `LongAdder` | 单变量更新 | 不能保多步操作 |
| 分布式锁 | 跨实例 | 有网络开销与租约问题 |

## 项目中如何使用

- **某银行资金安全加固**：跨实例用 Redisson 分布式锁，进程内用 `ReentrantLock` 保护单据状态机。选 `ReentrantLock` 而不是 `synchronized` 的唯一理由是**要 `tryLock(3s)`**——抢不到就转异步补偿，不能把交易线程挂死。
- **某支付公司结算批次串行**：同一个结算日的批次必须按序执行，用了**公平锁**。非公平锁下出现过「后提交的批次先跑」，导致依赖前一批次结果的校验失败。这是少数「必须公平」的真实案例。
- **配置中心读写分离**：配置读远多于写，用 `ReentrantReadWriteLock`。热点配置的读 QPS 高，写只在发布时发生。曾经考虑 `StampedLock`，最后放弃——配置对象是嵌套结构，乐观读要逐字段 `validate`，代码复杂度不值当。
- **一次真实事故**：`ReentrantLock` 加锁后调外部接口，接口超时抛 `SocketTimeoutException`，但 `unlock` 写在了 `catch` 块里而不是 `finally`。异常类型没覆盖全，锁泄漏。之后团队规约：**所有 `lock()` 必须紧跟 `try`，`unlock()` 必须在 `finally` 第一行**，代码评审必查。

## 常见陷阱

- **说「ReentrantLock 性能比 synchronized 好」**——JDK 6 之后不成立。低竞争下 `synchronized` 有锁消除、偏向锁，常常更快；高竞争下两者都要阻塞，差距很小。**选型靠功能，不靠性能**。
- **`lock()` 放进 `try`**：见上文，会吞掉真实异常。
- **忘记 `unlock` 或写在错误的分支**：`return` 提前退出、异常路径都要覆盖，只写 `finally` 才安全。
- **`Condition.await()` 用 `if` 不用 `while`**：虚假唤醒会导致条件不成立就往下走。
- **读写锁里做锁升级**：持读锁去拿写锁 → 自己等自己 → 死锁。只能先放读锁。
- **认为 `synchronized` 不能被中断所以更安全**——恰恰相反：不可中断意味着停机时线程卡住，运维上是负担。
- **`ReentrantLock` 用 `tryLock()` 无参版本轮询**：`while (!lock.tryLock()) {}` 是**自旋**，把 CPU 打满还拿不到锁。要么带超时，要么 `lock()`。

## 三层追问

1. **既然 `ReentrantLock` 功能更强，为什么 JDK 还推荐优先用 `synchronized`？**——因为它把「释放」交给编译器，而 `Lock` 把释放交给开发者。生产事故里「忘记 unlock」的数量远多于「需要公平锁」的数量。加上 JDK 6 的锁升级，性能劣势已经不存在——**用能力换安全性，多数场景不划算**。
2. **公平锁为什么吞吐低？**——每次 `tryAcquire` 都要调 `hasQueuedPredecessors()` 检查队列，多一次 volatile 读和链表遍历；更关键的是它放弃了「新线程插队填补唤醒空窗」的优化，导致锁在「唤醒中」的几十微秒里处于空闲。
3. **`ReentrantReadWriteLock` 的读锁能升级成写锁吗？**——不能，会死锁。因为读锁是共享的，多个线程可能同时持有；A 线程要升级就必须等其他读锁释放，但它自己就持有读锁，形成自己等自己。正确做法是先 `unlock` 读锁，再 `lock` 写锁，然后**重新校验数据是否还被自己期望**（中间可能有别人改过）。

## 我的口述记录

（首次复述后填写）
