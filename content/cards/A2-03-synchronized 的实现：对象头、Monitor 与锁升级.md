---
id: A2-03
title: "synchronized 的实现：对象头、Monitor 与锁升级"
kind: card
nodes: [A2, A1]
primary: A2
direction: "Java 并发"
event: "面试高频"
project: "某银行账户余额与单据状态机、某支付公司单例初始化、批量任务计数"
level: core
status: draft
created: 2026-11-03
updated: 2026-11-03
---

## 30 秒简述

`synchronized` 锁的是**对象**，不是代码块。每个对象有个**对象头 Mark Word**，锁状态就记录在里面——这是它和 ReentrantLock（用一个 `volatile int state` 记录）最本质的区别。

一句话记住整条链：**字节码是 `monitorenter/monitorexit`，实现是 `ObjectMonitor`，状态存在 `Mark Word`，优化靠「锁升级」把竞争从 CAS 逐级升到内核互斥量**。四个状态：无锁 → 偏向锁 → 轻量级锁 → 重量级锁，**只能升不能降**（除 GC 时的特殊情况）。

面试的关键差异点：**偏向锁是为「同一个线程反复进入」优化的，一旦有第二个线程来竞争就要撤销，撤销必须停在安全点，成本很高**——这就是 JDK 15 默认禁用、JDK 18 彻底移除偏向锁的原因。

## 是什么

### 一、对象在内存里长什么样

```
| 对象头 (12/16 字节)          | 实例数据 | 对齐填充 |
|  Mark Word(8) | Klass(4/8)   |          |          |
```

`Mark Word` 在 64 位 HotSpot 下是 8 字节，**同一块内存，在不同锁状态下存不同的东西**——这是 synchronized 能「零成本」表示不同锁状态的根本技巧。

| 状态 | 锁标志位 | Mark Word 内容（64 位） |
|---|---|---|
| 无锁 | `01` | unused:25 \| hashCode:31 \| unused:1 \| 分代年龄:4 \| biased:0 \| 01 |
| 偏向锁 | `01` | **线程ID:54** \| epoch:2 \| unused:1 \| 分代年龄:4 \| biased:1 \| 01 |
| 轻量级锁 | `00` | **指向栈中 Lock Record 的指针:62** \| 00 |
| 重量级锁 | `10` | **指向 ObjectMonitor 的指针:62** \| 10 |
| GC 标记 | `11` | 空（GC 期间复用） |

注意：**一旦调用过 `hashCode()`，偏向锁就装不下了**（hashCode 占 31 位，和线程 ID 冲突），对象会直接进入无锁不可偏向状态。这个细节经常被问。

### 二、Monitor：重量级锁的真身

`ObjectMonitor` 是 C++ 对象，核心字段：

| 字段 | 作用 |
|---|---|
| `_owner` | 当前持有锁的线程 |
| `_recursions` | **重入次数**（这就是可重入的实现） |
| `_count` | 重入计数（近似） |
| `_EntryList` | 阻塞等待锁的线程队列 |
| `_WaitSet` | 调用了 `wait()` 的线程集合 |
| `_cxq` | 新到达的竞争线程先塞这里（减少竞争） |

一次完整的重量级加锁：

1. 线程尝试 CAS 把 `_owner` 设为自己，成功就是拿到锁，`_recursions = 1`。
2. 失败 → 包装成 `ObjectWaiter` 塞进 `_cxq` → 调 `park()` 挂起（**系统调用，进内核**）。
3. 持有者 `monitorexit` 时，从 `_EntryList`/`_cxq` 里挑一个 `unpark()` 唤醒。

**「重量」重在哪**：`park/unpark` 是操作系统线程调度，涉及用户态/内核态切换，一次几十微秒。相比之下 CAS 是纳秒级。这是它慢的唯一原因，跟「锁代码多」无关。

### 三、四种锁状态与升级路径

#### 1. 偏向锁（Biased Locking）

**动机**：统计发现绝大多数同步块**永远只有一个线程进入**（比如单线程环境、或锁保护的是线程私有的对象），每次都要 CAS 一遍太浪费。

**做法**：第一个线程来的时候，用 CAS 把自己的**线程 ID 写进 Mark Word**。之后这个线程再进来，只需比较一下 ID 相等就直接放行——**连 CAS 都不用，一次比较即可**。

**代价**：一旦出现第二个线程，必须**撤销偏向锁**，而这需要**在安全点（Safepoint）停下来**，检查持有线程是否还活着、是否还在同步块里。如果对象在线程栈里被使用，还要遍历栈帧改写锁记录——这是**Stop-The-World 级别的操作**。

**批量优化**：HotSpot 发现「撤销次数过多」时会批量处理：

- 一个类的对象撤销达 **20** 次 → 批量重偏向（bulk rebias），把该类新对象的偏向目标改成新线程。
- 达 **40** 次 → 批量撤销（bulk revoke），该类彻底禁用偏向。

这类参数（`-XX:BiasedLockingBulkRebiasThreshold`）面试问到能说清"为什么撤销贵、为什么要批量"就够了，不用背数字。

**为什么被废弃**：JDK 15（JEP 374）默认关闭，JDK 18 彻底移除。理由是——现代应用大量用线程池，同一个锁被不同工作线程轮流拿，**偏向锁几乎必然被撤销**，撤销的 safepoint 开销反而拖累吞吐；而锁消除、轻量级锁已经把「无竞争」场景覆盖得差不多。

#### 2. 轻量级锁（Lightweight Locking）

**动机**：有竞争，但**竞争时间极短**（另一个线程几纳秒后就释放了）。与其让线程阻塞进内核，不如原地自旋等一会。

**做法**（加锁）：

1. 在当前线程栈帧里划一块 **Lock Record**，把对象 Mark Word 拷贝进去（叫做 Displaced Mark Word）。
2. 用 CAS 把对象 Mark Word 改成「指向这个 Lock Record 的指针」：
   - 成功 → 拿到锁，标志位变 `00`。
   - 失败 → 说明有竞争，**自旋**重试。
3. 自旋超过阈值（自适应自旋：根据上次成功率动态调整，不是固定 10 次）→ **膨胀成重量级锁**。

**解锁**：CAS 把 Mark Word 还原回去。如果发现已经不是自己指向的 Lock Record（说明别人膨胀过了），就走重量级解锁。

**关键点**：轻量级锁的自旋是**在用户态空转**，不放弃 CPU、不进内核。所以它适合「锁持有时间 < 线程切换时间」的场景——一旦超过，自旋就是纯浪费。

#### 3. 重量级锁

就是前面说的 `ObjectMonitor` + `park/unpark`。竞争激烈、持有时间长时，这是唯一正确的选择：**让等待的线程真正让出 CPU**。

### 四、两个编译期优化

这两个是 JIT 做的，源码里完全看不见，但面试常问「为什么我的代码没加锁却安全」：

**锁消除（Lock Elision）**：逃逸分析发现锁对象不会逃出当前方法（其他线程根本拿不到），直接把 `monitorenter/monitorexit` 删掉。经典例子：

```java
public String concat(String a, String b) {
    StringBuffer sb = new StringBuffer();  // 局部变量，不逃逸
    sb.append(a).append(b);                // append 是 synchronized，但会被消除
    return sb.toString();
}
```

**锁粗化（Lock Coarsening）**：JIT 发现对同一个对象的连续加解锁，合并成一次大锁。

```java
for (int i = 0; i < 1000; i++) {
    synchronized (lock) { count++; }   // 1000 次加解锁
}
// JIT 可能粗化成：synchronized (lock) { for (...) count++; }
```

### 五、字节码层面

```java
synchronized (obj) { doSomething(); }
```

编译成：

```
monitorenter       ← 尝试获取 obj 的 monitor
  ... 业务代码 ...
monitorexit        ← 正常路径释放
  goto end
异常处理器：
monitorexit        ← 异常路径也必须释放
  athrow
```

**为什么有两段 monitorexit**：编译器自动生成了异常处理器，保证**抛异常时锁也能释放**。这就是「synchronized 不用手动 unlock」的实现原理——不是魔法，是编译期插了两条指令加一个 handler。

方法级的 synchronized 不是这样：它在方法访问标志里加 `ACC_SYNCHRONIZED`，由 JVM 在方法调用/返回时隐式加解锁，字节码里看不到 monitorenter。

### 六、锁的到底是什么对象

| 写法 | 锁对象 | 说明 |
|---|---|---|
| `synchronized` 实例方法 | `this` | 同一个对象的调用互斥，不同对象互不影响 |
| `synchronized` 静态方法 | 该类的 `Class` 对象 | 全 JVM 内该类所有实例共享一把锁 |
| `synchronized (obj)` | obj 这个对象 | 最灵活，也最容易写错 |
| `synchronized (Xxx.class)` | Class 对象 | 等价于静态方法 |

**最常见的错误**：用 `synchronized (new Object())` 或 `synchronized (localVar)`——每次都是新对象，锁等于没加。

另一个隐蔽的：**锁 String 常量**。`"abc".intern()` 全局唯一，两个不相干的模块锁同一字符串会互相阻塞。

### 七、wait/notify 为什么必须在 synchronized 里

不在同步块里调用会抛 `IllegalMonitorStateException`。原因有两层：

**表层**：`wait/notify` 操作的是 monitor 的 `_WaitSet`，而 `_WaitSet` 属于某个 monitor。你不持有 monitor，就不知道该操作哪个 `_WaitSet`。

**深层（更重要）**：避免 **lost wakeup 竞态**。假设允许不持锁就 wait：

```
线程 A：检查条件（不满足）→ 【此处线程 B 改了条件并 notify，但 A 还没进入 WaitSet】→ A 执行 wait
结果：A 永远等下去。
```

把「检查条件」和「进入等待」放进同一个临界区，B 的 `notify` 就不可能插在中间。这是 `wait` **必须**在循环里调用的同一个道理：

```java
synchronized (lock) {
    while (!condition) {      // 必须 while，不能 if
        lock.wait();          // 被唤醒后条件可能又不满足了（虚假唤醒 / 被别人抢先）
    }
    // 真正干活
}
```

`wait()` 做的三件事最容易漏答：**① 把线程放进 `_WaitSet`；② 完全释放锁（`_recursions` 归零，不是减一）；③ 挂起**。

`notify()` 只做一件事：把 `_WaitSet` 里一个线程移到 `_EntryList`。**它不释放锁**——锁要等当前线程退出同步块才释放。这是「notify 之后代码还能继续执行」的原因。

## 为什么这么设计

**为什么用对象头而不是独立字段记录锁状态**：不占额外空间。任何 Java 对象天然自带 Mark Word，加锁不需要为它分配任何东西——这就是 `synchronized` 比 `ReentrantLock`「省内存」的地方（后者必须 new 一个对象，内含 AQS 队列）。

**为什么是升级而不是「一开始就用最重的」**：因为竞争强度差异巨大。无竞争时一次 CAS 就够，有短暂竞争自旋比阻塞便宜，只有真打起来才值得进内核。四级状态就是**按竞争烈度逐级付费**的梯度设计。

**为什么偏向锁会失败并被淘汰**：它的假设（"锁总是同一个线程拿"）与现代线程池模型冲突。线程池里任务是随机分给工作线程的，锁大概率被不同线程拿，偏向锁每次都白撤销一遍。**这是「优化假设被现实推翻」的典型案例**，比背参数更有价值。

**为什么重量级锁要用 `_cxq` 和 `_EntryList` 两个队列**：所有线程都往一个队列里 CAS 入队，本身就是新的竞争点。`_cxq` 是无锁的单向栈（CAS 入队，竞争小），锁释放时再批量转移到 `_EntryList`——**用栈的 LIFO 特性让"刚来的线程优先"，提高局部性**（刚来的线程热的概率大）。

## 不用会怎么样

- **`i++` 不加锁**：丢失更新，100 万次并发自增最后只有 60 多万。
- **DCL 单例不加锁**：`getInstance()` 的第二次检查在锁外，必须配 `volatile`，否则可能拿到构造未完成的对象。
- **不给「判断 + 更新」加锁**：`if (balance >= amount) balance -= amount;` 两线程同时通过判断 → 余额变负。这是资金系统最典型的资损 bug。
- **锁粒度失控**：整个方法 `synchronized`，包括了一次 200ms 的 HTTP 调用——并发直接降到 5 TPS，线程全部堆在锁上，连接池耗尽，雪崩。

## 替代方案

| 方案 | 适用 | 差异 |
|---|---|---|
| `synchronized` | 简单临界区、代码量少 | JVM 内置，自动释放，有锁升级；不能超时/中断/多条件 |
| `ReentrantLock` | 需要 `tryLock`、超时、可中断、公平、多 Condition | 手动 `unlock`，必须 `try-finally` |
| `StampedLock` | 读远多于写 | 乐观读不加锁，性能最好；不可重入，API 容易用错 |
| `AtomicXxx` | 单变量原子更新 | 无锁无阻塞；不能保多步操作 |
| `ThreadLocal` | 线程私有，根本不需要共享 | 不是锁，是「不共享」；线程池里要 `remove()` |

## 项目中如何使用

- **某银行单据状态机**：状态推进用 `synchronized (this)` 保护本地内存对象，但**真正的兜底是数据库 `UPDATE ... WHERE status = ?`**。这个双层设计是有意为之——锁只防单机并发，多实例部署时靠 DB 的 CAS 语义。上线前做过压测：把锁去掉接口照样正确，只是会多一次失败重试。
- **某支付公司单例初始化**：DCL 写法，`instance` 必须 `volatile`。代码评审时见过有人为了「优化」把 volatile 删掉，理由是"有 synchronized 了"——这是把「互斥」当成了「可见」，属于典型误解。
- **批量任务计数器**：早期用 `synchronized` 包住 `count++`，压测时发现线程都卡在这一个对象上。换成 `LongAdder` 后耗时下降到原来的 1/5，因为计数只用于结尾汇总，弱一致完全可以接受。
- **一次真实的锁粒度过大事故**：对账任务里把「查银行文件 + 解析 + 落库」整个包进 `synchronized`，其中查文件要访问外部 SFTP（超时 30 秒）。结果一个渠道超时，所有渠道全卡住。后来拆成「按渠道分段加锁 + 外部调用移到锁外」。

## 常见陷阱

- **说「synchronized 锁的是代码块」**——锁的是对象，代码块只是它的作用范围。所以「两个不同的 synchronized 方法能否并发」取决于它们锁的是不是同一个对象。
- **认为锁升级可以降级**——正常只能升。唯一例外是 GC 之后可能重置。
- **说「synchronized 性能比 ReentrantLock 差」**——JDK 6 之后差距已很小，低竞争下 `synchronized` 往往更快（有锁消除和偏向）。**选型理由应该是功能，不是性能**。
- **把 `wait()` 当 `sleep()`**——`wait` 释放锁、`sleep` 不释放；`wait` 由 `notify` 唤醒、`sleep` 到点自己醒；`wait` 是 `Object` 的方法、`sleep` 是 `Thread` 的。
- **用 `if` 而不是 `while` 包 `wait()`**——虚假唤醒（spurious wakeup）会导致条件不成立也往下走。
- **`notifyAll` 换成 `notify` 省事**——多个等待条件时，唤醒了错误的线程会造成**信号丢失**，整个系统卡死。除非能证明只有一个条件，否则用 `notifyAll`。
- **锁对象是包装类型**：`synchronized (Integer.valueOf(1))`——缓存范围内是同一个对象，超出范围每次新建，锁时灵时不灵。

## 三层追问

1. **偏向锁为什么撤销成本高？**——它不像其他锁那样改改对象头就完事，必须暂停线程（safepoint），确认偏向线程是否还在同步块中；如果还在，要遍历该线程的栈帧找到 Lock Record 并修复；对象还可能被多个线程引用，得做一次类似「对象图遍历」的检查。这套动作在全站停顿点上执行，对象多时开销可观。
2. **轻量级锁的自旋一定比阻塞快吗？**——只在「锁持有时间 < 一次线程切换时间」时成立。HotSpot 用自适应自旋：上次自旋成功过就多转几次，没成功过就少转甚至直接膨胀。所以不能拍脑袋说自旋好。
3. **既然有锁消除，为什么还要关心 `StringBuffer` 的同步开销？**——锁消除依赖**逃逸分析**，只有对象确定不逃逸时才生效。一旦方法返回了 `sb`、或把它传给别的方法，逃逸分析失败，锁就回来了。而且这是 JIT 优化，解释执行阶段（刚启动）不生效。

## 我的口述记录

（首次复述后填写）
