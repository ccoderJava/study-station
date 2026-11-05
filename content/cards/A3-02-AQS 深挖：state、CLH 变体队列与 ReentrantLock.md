---
id: A3-02
title: "AQS 深挖：state、CLH 变体队列与 ReentrantLock"
kind: card
nodes: [A3, A2]
primary: A3
direction: "Java 并发"
event: "面试高频"
project: "某银行资金安全双层锁、账户流水更新串行化、某支付公司单据状态机"
level: core
status: draft
created: 2026-11-03
updated: 2026-11-03
---

## 30 秒简述

AQS（`AbstractQueuedSynchronizer`）是 JUC 的**地基**：它用**一个 `volatile int state`** 表示同步状态，用**一条双向队列**存放排队线程，用 **`LockSupport.park/unpark`** 挂起和唤醒。

整个模型只有一句话：**抢到了就改 state，抢不到就入队等，前驱释放时只唤醒后继**。

它是**模板方法**：把「排队、阻塞、唤醒、取消」这些复杂逻辑写死，只把「state 该怎么判断能不能拿」抽成 `tryAcquire/tryRelease` 交给子类。所以 ReentrantLock、Semaphore、CountDownLatch、ReentrantReadWriteLock 全是它的子类，各自只改那几行判断。

面试最容易被追问的两点：**为什么队列必须是双向链表**（因为取消节点、唤醒后继都需要反向查找，`next` 指针还不可靠），**为什么用 park 不用自旋或 wait**（park 不烧 CPU，且有「许可」语义，不会丢信号）。

## 是什么

### 一、三个核心构件

| 构件 | 作用 | 关键细节 |
|---|---|---|
| `volatile int state` | 同步状态 | 独占：0 空闲 / N 重入次数；共享：剩余许可数 |
| 双向队列（CLH 变体） | 存放等待线程 | `head` 是**已拿到锁的哨兵节点**，真正排队的是 `head.next` 之后 |
| `LockSupport.park/unpark` | 挂起/唤醒 | 基于 `Unsafe.park`，底层是 `Parker`（mutex + cond） |

```java
public abstract class AbstractQueuedSynchronizer {
    private volatile int state;          // 核心状态，子类靠它表达语义
    private transient volatile Node head; // 哑节点，代表持有锁的线程
    private transient volatile Node tail; // 队尾，新节点 CAS 插入这里
}
```

### 二、Node 的结构与 waitStatus

```java
static final class Node {
    volatile Node prev;
    volatile Node next;
    volatile Thread thread;
    Node nextWaiter;          // 两种用途：条件队列的后继 或 SHARED 标记
    volatile int waitStatus;
}
```

`waitStatus` 是理解 AQS 的**钥匙**，四个值各有明确语义：

| 值 | 常量 | 含义 |
|---|---|---|
| `1` | `CANCELLED` | 线程已取消（超时/中断），节点需要被清理 |
| `-1` | `SIGNAL` | **后继节点需要被唤醒**，当前节点释放时必须 unpark 它 |
| `-2` | `CONDITION` | 节点在**条件队列**里等待（不在同步队列） |
| `-3` | `PROPAGATE` | 共享模式下，释放需要向后传播（一次唤醒要传递下去） |
| `0` | 默认 | 初始状态 |

**关键点：链表中节点的 `waitStatus` 表达的是「我对后继的承诺」，不是「我自己想要什么」。** `SIGNAL` 是前驱给后继立的 flag——「我释放的时候会叫你」。所以 `shouldParkAfterFailedAcquire` 里，线程先把自己的**前驱**置为 `SIGNAL`，然后才敢 park。这个方向搞反是面试最常见的错误。

### 三、acquire：拿锁的完整路径

```java
public final void acquire(int arg) {
    if (!tryAcquire(arg) &&                              // ① 先试一次
        acquireQueued(addWaiter(Node.EXCLUSIVE), arg))   // ② 失败就入队排队
        selfInterrupt();                                  // ③ 补一次中断
}
```

**第一步 `addWaiter`：入队**

```java
private Node addWaiter(Node mode) {
    Node node = new Node(Thread.currentThread(), mode);
    Node pred = tail;
    if (pred != null) {
        node.prev = pred;
        if (compareAndSetTail(pred, node)) {   // 原子地把 tail 指向自己
            pred.next = node;                  // 注意：这一步不是原子的！
            return node;
        }
    }
    enq(node);   // 队列空 or CAS 失败，进自旋入队
    return node;
}
```

这里有个**极重要的细节**：`pred.next = node` **不是原子操作**。可能出现「`node.prev` 已经指向 pred，但 `pred.next` 还是 null」的中间状态——这就是后面「为什么必须双向」的第一个原因。

**第二步 `acquireQueued`：排队 + 自旋 + park**

```java
final boolean acquireQueued(final Node node, int arg) {
    for (;;) {
        final Node p = node.predecessor();          // 取 prev，不是 next
        if (p == head && tryAcquire(arg)) {         // 只有前驱是 head 才有资格抢
            setHead(node);                          // 自己变成新的哑节点
            p.next = null;                          // 断开，帮助 GC
            return interrupted;
        }
        if (shouldParkAfterFailedAcquire(p, node) && parkAndCheckInterrupt())
            interrupted = true;                     // 记录中断，先不响应
    }
}

private static boolean shouldParkAfterFailedAcquire(Node pred, Node node) {
    int ws = pred.waitStatus;
    if (ws == Node.SIGNAL) return true;            // 前驱已承诺唤醒我 → 可以睡
    if (ws > 0) {                                   // 前驱是取消状态
        do { node.prev = pred = pred.prev; }        // ← 向前跳过所有取消节点
        while (pred.waitStatus > 0);
        pred.next = node;
    } else {
        compareAndSetWaitStatus(pred, ws, Node.SIGNAL); // 给前驱立 flag
    }
    return false;
}
```

三个必须记住的设计：

1. **只有 `p == head` 才尝试拿锁**。因为 head 代表「正在持有锁的线程」，它的后继才是队列里第一个有资格的人。**这就是公平性的来源**（先在队列里，才有资格）。
2. **先把前驱置为 SIGNAL 再 park**，且**置完不立刻睡，要再循环一次**。因为置 flag 和 park 之间可能发生释放——多转一圈能避免「释放了但没人醒」。
3. **中断只记录不抛出**。`acquireQueued` 返回 true 后由 `selfInterrupt()` 补上中断标志——这样锁的获取语义（不可中断）和中断状态都不丢。想响应中断用 `acquireInterruptibly`，它会抛 `InterruptedException`。

**第三步 `selfInterrupt`**：

```java
static void selfInterrupt() { Thread.currentThread().interrupt(); }
```

因为 `parkAndCheckInterrupt` 返回时会**清掉**中断标志，所以要手动补回来。

### 四、release：释放与唤醒后继

```java
public final boolean release(int arg) {
    if (tryRelease(arg)) {              // 子类决定是否真的释放（重入时可能还没释放）
        Node h = head;
        if (h != null && h.waitStatus != 0)
            unparkSuccessor(h);         // 只唤醒 head 的后继
        return true;
    }
    return false;
}

private void unparkSuccessor(Node node) {
    if (node.waitStatus < 0) compareAndSetWaitStatus(node, 0, 0);
    Node s = node.next;
    if (s == null || s.waitStatus > 0) {            // next 为 null 或已取消
        s = null;
        for (Node t = tail; t != null && t != node; t = t.prev)  // ← 从尾部往前找
            if (t.waitStatus <= 0) s = t;
    }
    if (s != null) LockSupport.unpark(s.thread);
}
```

**注意 `release` 只唤醒一个后继，不唤醒全部**。唤醒的那个醒来后会 `tryAcquire`，成功就把自己设为 head 并（在共享模式下）继续传播。这是「链式唤醒」——一次只推一个，避免惊群。

### 五、为什么必须是双向链表（重点）

这是 AQS 最经典的追问。答案有**三层**，由浅入深：

**① 入队时 `next` 指针可能还没建立**

`addWaiter` 里 `node.prev = pred` 先执行，`pred.next = node` 后执行且**不是原子操作**。如果这时另一个线程正好在做 `unparkSuccessor`，它读到的 `node.next` 可能就是 `null`。**只有 `prev` 是可靠的**（它在 CAS 之前就设好了），所以唤醒逻辑必须能「从尾部沿着 prev 往前找」。

源码注释里明确写了：`next` 链接主要用于优化，`prev` 才是主链接。

**② 取消节点必须能反向找有效前驱**

线程超时或中断取消时，节点被标记 `CANCELLED`，要把它从队列摘掉：

```java
// cancelAcquire 的核心：往前找第一个非取消的前驱
do {
    node.prev = pred = pred.prev;
} while (pred.waitStatus > 0);
pred.next = node;
```

单向链表做不到——你站在节点上，**根本不知道谁指向你**。而 `prev` 让「向上游回溯」变成 O(1)。

**③ 唤醒时必须能跳过连续的取消节点**

队列里可能有一串 CANCELLED（批量超时）。`unparkSuccessor` 的策略是**从 tail 往前扫，找到最靠近 head 的有效节点**——注意是**从尾往前**，因为要找到「第一个真正该被唤醒的」，而尾部出发能保证拿到最新的队列形态（`next` 可能滞后）。

**④ 为什么不用原始 CLH**

原始 CLH 是**自旋锁**：每个节点自旋观察自己的前驱状态，不需要 `next` 指针。AQS 把它改成了**阻塞式**：park 下去等前驱来唤醒我。要「主动唤醒别人」，就必须有指向别人的指针——于是加了 `next`；而 `next` 因为并发不可靠，又必须有 `prev` 兜底。

**双向前进方向（prev）负责正确性，后向指针（next）负责通知效率。** 原始 CLH 只有「看前驱」，AQS 需要「叫后继」。

### 六、共享模式与 PROPAGATE

Semaphore、CountDownLatch、ReadWriteLock 的读锁都走共享模式。区别在 tryXxx 的语义：`tryAcquireShared` 返回**剩余许可数**，`>= 0` 表示成功。

```java
private void doAcquireShared(int arg) {
    final Node node = addWaiter(Node.SHARED);
    for (;;) {
        final Node p = node.predecessor();
        if (p == head) {
            int r = tryAcquireShared(arg);
            if (r >= 0) {
                setHeadAndPropagate(node, r);   // ← 关键：不仅设 head，还要传播
                return;
            }
        }
        if (shouldParkAfterFailedAcquire(p, node) && parkAndCheckInterrupt()) ...
    }
}
```

`setHeadAndPropagate` 会在「还有剩余许可」或「head 是 PROPAGATE 状态」时，**继续唤醒下一个共享节点**——因为共享锁可以多人同时持有，唤醒一个不够。

**`PROPAGATE` 状态是为了修一个真实 bug**：并发 release 时，线程 A 唤醒 B，B 在被唤醒前 C 也来 release，两次释放可能互相覆盖导致**丢失唤醒**（有许可却没人拿到）。Doug Lea 在 JDK 6 引入 `PROPAGATE` 专门处理这个边界——这是「读源码才能答出来」的那类问题。

### 七、条件队列：`Condition` 怎么实现

每个 `ConditionObject` 有**自己独立的一条单向队列**（用 `nextWaiter` 串起来），和同步队列是两套：

```
同步队列（双向，等锁）   head ⇄ n1 ⇄ n2 ⇄ tail
条件队列（单向，等条件）  firstWaiter → w1 → w2 → lastWaiter
```

**`await()` 三步**：

1. 把当前线程包成 `Node`（`waitStatus = CONDITION`），**加入条件队列尾部**。
2. `fullyRelease(node)` —— **完全释放锁**（不是减一，是直接把 state 归零，并把重入次数保存到 `savedState`）。
3. 自旋 `while (!isOnSyncQueue(node)) park(this)` —— 直到被转移回同步队列。

**`signal()` 三步**：

1. 检查是否持有锁，没有就抛 `IllegalMonitorStateException`（这是 `Condition` 与 `wait/notify` 一致的地方）。
2. 把条件队列的头节点摘下。
3. `transferForSignal`：CAS 把 `waitStatus` 从 `CONDITION` 改成 `0`，**加入同步队列尾部**——注意到这里**还没有唤醒**，只是挪了队。

**`signal()` 不释放锁，也不一定立刻唤醒**。真正的唤醒发生在「原持有者退出同步区、release 时」——和 `notify` 的行为一致，但 `Condition` 允许多条队列，能做到**精确唤醒**（生产者只唤醒消费者，不用 `notifyAll` 全叫醒）。

### 八、park 为什么优于自旋、sleep、wait

| 方案 | 问题 |
|---|---|
| 自旋 | 等待线程全程占着 CPU，竞争越激烈越糟（线程数 > 核数时是灾难） |
| `Thread.sleep(n)` | 必须给固定时长，无法被精确唤醒；睡过头就是延迟，睡不够就空转 |
| `Object.wait` | 必须在 `synchronized` 块里，AQS 不想被 monitor 绑住 |
| `LockSupport.park` | **可以被精确 unpark**，且**先 unpark 后 park 也有效** |

最后这条是精髓：`park/unpark` 是**许可（permit）语义**，类似容量为 1 的信号量。`unpark` 在 `park` 之前调用，许可会被记住，随后的 `park` 直接返回——**天然免疫 lost wakeup**。而 `wait/notify` 没有这个特性，必须先持有锁才能保证不漏信号。

`park` 还支持传入 `blocker` 对象，`jstack` 里会显示「waiting on <对象>」，排查死锁时非常有用（AQS 传的是 `this`）。

### 九、公平与非公平只差一行

```java
// 非公平锁 NonfairSync
final void lock() {
    if (compareAndSetState(0, 1))    // ← 上来直接抢，不管有没有人排队
        setExclusiveOwnerThread(Thread.currentThread());
    else acquire(1);
}

// 公平锁 FairSync
final void lock() { acquire(1); }     // 老实排队

// FairSync.tryAcquire 里多一个判断
protected final boolean tryAcquire(int acquires) {
    ...
    if (c == 0) {
        if (!hasQueuedPredecessors() &&    // ← 队列里有人就不抢
            compareAndSetState(0, acquires)) { ... }
    }
}
```

**非公平锁吞吐更高**：允许「刚到的线程」插队，减少了线程唤醒的开销（被唤醒的线程从 park 恢复到真正抢到锁有延迟，这期间锁空着就是浪费）。代价是**可能饿死**——队列里的线程一直等不到。

## 为什么这么设计

**为什么用一个 int 而不是布尔或对象**：一个字段能表达三种语义——独占的 0/1、重入的 N、共享的剩余许可数。Semaphore 用它存许可、CountDownLatch 用它存倒计数、ReentrantReadWriteLock 把高低 16 位拆成读锁和写锁计数。**一个字段撑起整个 JUC**，这是设计的核心取舍：牺牲可读性，换取统一和极低开销。

**为什么用模板方法**：同步器的骨架（排队、park、唤醒、取消、中断处理）极其复杂且**每个实现都一样**，而差异只有「什么条件下算拿到」。如果每个类自己写队列，JUC 就是一堆重复且各带 bug 的实现。模板方法把复杂度收敛到一处，也让 `acquire` 这类方法是 `final` 的——子类改不了骨架。

**为什么队列要 CAS 入队而不是用锁**：AQS 是「锁的实现」，它自己不能用锁（会形成递归依赖）。只能靠 CAS 操作 tail。

**为什么只唤醒一个后继**：全部唤醒（惊群）会让 N 个线程同时抢一把锁，N-1 个抢不到又回去睡，白白产生大量上下文切换。链式唤醒保证「每次只有一个人被叫醒，他拿不到再叫下一个」。

## 不用会怎么样

- **自己实现阻塞锁**：要么用自旋（CPU 打满），要么用 `wait/notify`（必须绑 `synchronized`，且多条件时唤醒不精确）。AQS 把这两条路都避开了。
- **用 `synchronized` 替代 `ReentrantLock` 的 `tryLock`**：`tryLock(timeout)` 是「拿不到就降级/放弃」，`synchronized` 没有对应能力，只能无限等。资金系统里「抢锁 3 秒失败就转异步补偿」这个逻辑，`synchronized` 根本写不出来。
- **用 `synchronized` 实现多条件等待**：只有一条等待集，生产者消费者混在一起，只能用 `notifyAll` 全叫醒，效率低且容易误唤醒。
- **不理解 state 就自定义同步器**：把 `tryAcquire` 写成「判断后 setState」而不是「CAS 改 state」，并发下直接失效——这是自己写同步器最常见的 bug。

## 替代方案

| 方案 | 适用 | 差异 |
|---|---|---|
| `synchronized` | 简单临界区 | JVM 内置、自动释放、有锁升级；无超时/中断/多条件 |
| `ReentrantLock` | 需要超时、中断、公平、多条件 | 基于 AQS，必须 `try-finally` 释放 |
| `StampedLock` | 读远多于写 | **不是 AQS 实现**（自己写的一套），乐观读不加锁，不可重入 |
| `Semaphore` | 限流、资源池 | 共享模式，state = 许可数 |
| `CountDownLatch` | 等一批任务结束 | 共享模式，state = 倒计数，**一次性** |
| `CyclicBarrier` | 分批同步，可重用 | **基于 Condition 实现，不是 AQS 直接子类** |
| 分布式锁（Redis/ZK） | 跨进程 | 解决「多实例内存不共享」，见《Redis 分布式锁》 |

## 项目中如何使用

- **某银行资金安全加固**：双层锁——跨实例用 Redisson 分布式锁，进程内用 `ReentrantLock` 保护单据状态机推进。为什么不是只用分布式锁：分布式锁一次往返 1~3ms，高频状态查询扛不住；进程内锁是纯内存操作，纳秒级。两层各管一段，**同实例内的并发靠 AQS，跨实例靠 Redis**。
- **为什么用 `tryLock(3, SECONDS)` 而不是 `lock()`**：抢不到锁说明有并发冲突，与其无限等（积压线程、耗尽连接池），不如快速失败转异步补偿队列。这个决策把「锁等待」从不可控变成了可观测的超时率指标。
- **账户流水更新**：早期用 `synchronized (accountId.intern())` 按账户分段加锁，踩过两个坑——`intern()` 的字符串常量池无限增长；锁对象不可控导致和别处死锁。后来换成 `ReentrantLock` 数组按 `hash(accountId) % N` 分段，锁的生命周期完全可控。
- **一次中断相关的排查**：业务线程被打断后锁没释放，队列里的线程全部卡死。根因是 `lock()` 之后的代码抛异常但没走 `finally`。AQS 自身在 `acquireQueued` 里对中断处理是完备的，**出错的一定是使用方**——这条经验对面试很有用：被问「AQS 会不会死锁」时，答「AQS 的队列设计不会，死锁来自业务层忘记释放或锁顺序不一致」。

## 常见陷阱

- **说「AQS 就是 CAS 队列」**——CAS 只是入队手段。AQS 的核心是「**state + 队列 + park/unpark**」三者配合，缺一个都实现不了阻塞唤醒。
- **把 `waitStatus` 的方向说反**——`SIGNAL` 表示「**我要唤醒后继**」，不是「我在等前驱唤醒我」。前驱置 flag、后继才敢睡。
- **认为 `release` 会唤醒所有等待线程**——只唤醒 head 的后继一个，靠链式传播。
- **混淆同步队列和条件队列**——同步队列双向（等锁），条件队列单向（等条件），`await` 是在两条队列之间搬家。
- **说 `Condition.await` 会释放锁「减一次」**——是**完全释放**（`fullyRelease`，把重入次数整体存起来），否则别的线程永远拿不到。
- **认为公平锁一定更好**——公平锁吞吐更低（每次都要检查队列），只在「必须严格按顺序」的场景才用（如某些对账批次的顺序依赖）。
- **`lock()` 不放在 `try` 外面**：`lock()` 本身抛异常时 `finally` 里的 `unlock` 会抛 `IllegalMonitorStateException`，把真实异常吞掉。正确写法是 `lock(); try { ... } finally { unlock(); }`。

## 三层追问

1. **AQS 为什么用双向链表，单向不行吗？**——三个硬理由：入队时 `pred.next = node` 非原子，`next` 可能为 null，唤醒必须能从 tail 沿 `prev` 反查；取消节点时要找有效前驱，单向无法反向；原始 CLH 只有「看前驱」，AQS 增加了「叫后继」，才需要 `next`，而 `next` 不可靠又必须 `prev` 兜底。核心一句：**`prev` 保正确，`next` 保效率**。
2. **`park` 之前为什么要再检查一次条件？**——防止在「判断该睡」和「真正睡下」之间发生唤醒。`park` 的许可机制能兜住「先 unpark 后 park」的情况，但 `shouldParkAfterFailedAcquire` 返回 true 后仍可能被中断或状态变化，所以 `acquireQueued` 是 `for(;;)` 而不是一次判断——**醒来必须重新验证，不能假设条件还成立**。
3. **AQS 的 state 用 int，那 ReentrantReadWriteLock 两个计数怎么放？**——高低 16 位拆分：高 16 位是读锁持有数，低 16 位是写锁重入数。所以读锁最多 65535 个，写锁最多重入 65535 次——**这是硬上限，超了会怎样面试官很爱问**（读锁超限会阻塞等待，写锁超限抛 `Error`）。

## 我的口述记录

（首次复述后填写）
