---
id: A2-02
title: "CAS 与原子类：无锁的代价"
kind: card
nodes: [A2, A3]
primary: A2
direction: "Java 并发"
event: "面试高频"
project: "某银行单号生成与状态机推进、某支付公司限额计数、某跨境电商密钥版本号"
level: core
status: draft
created: 2026-11-03
updated: 2026-11-03
---

## 30 秒简述

CAS 是「**比较并交换**」：给我内存值 V、预期旧值 A、新值 B，只有当 `V == A` 时才把 V 改成 B，否则什么都不做并返回失败。它是**乐观**的——先假设没人动，动了再重试；锁是**悲观**的——先占住再说。

Java 里的一次 CAS 最终落到 CPU 的一条 `cmpxchg` 指令加 `lock` 前缀，`lock` 保证这条指令的**原子性**（总线锁或缓存锁）和**可见性**（写回并让其他核的缓存行失效）。所以 CAS 不需要操作系统介入，是用户态的，这是它比重量级锁快的根本原因。

三个必须说清的局限：**只能保一个变量**的原子性、**有 ABA 问题**、**高竞争下自旋空转会拖垮 CPU**。原子类、AQS 的入队、ConcurrentHashMap 的空桶插入、LongAdder，全部建立在 CAS 之上。

## 是什么

### 一、CAS 的三要素与执行过程

```java
// 语义：如果当前值等于 expect，就更新为 update 并返回 true
boolean cas(int expect, int update) {
    if (memoryValue == expect) {   // 比较
        memoryValue = update;      // 交换
        return true;               // 以上两步必须原子
    }
    return false;
}
```

「比较」和「交换」之间不能被打断——**这就是整个机制的全部难点**。软件层面无法保证，只能靠硬件指令：

- x86：`cmpxchg`（比较并交换）+ `lock` 前缀。`lock` 在早期锁总线，现代 CPU 用**缓存锁**（只锁住这条缓存行），开销小得多。
- ARM：`ldrex/strex`（LL/SC 配对），语义更强，天然规避 ABA。

`lock` 前缀顺带完成两件事：把写操作刷回主内存、让其他核对应的缓存行失效。**所以 CAS 天然带可见性**，不需要额外的内存屏障。

### 二、Java 层怎么用上它

三条路径，本质都是同一个 native 方法：

| 层次 | 入口 | 说明 |
|---|---|---|
| 原子类 | `AtomicInteger.compareAndSet` | 最常用，基于 `Unsafe` |
| 直接调 | `Unsafe.compareAndSwapInt` | JDK 9 后被封装，不推荐直接用 |
| 新 API | `VarHandle.compareAndSet` | JDK 9 引入，替代 Unsafe，有类型检查 |

原子类的标准套路只有四行：

```java
public class AtomicInteger {
    private volatile int value;                        // ① 值必须 volatile
    private static final long valueOffset;             // ② 字段在对象里的内存偏移
    static { valueOffset = unsafe.objectFieldOffset(...); }
    public final boolean compareAndSet(int e, int u) {
        return unsafe.compareAndSwapInt(this, valueOffset, e, u);  // ③ 靠偏移直接操作内存
    }
}
```

**为什么要 `valueOffset`**：Unsafe 是绕过 JVM 直接操作内存的，必须告诉它「改这个对象的哪个字节位置」。偏移量在类加载时就固定了，所以能缓存成 static final。

**为什么 `value` 要 `volatile`**：CAS 本身保证了「比较+交换」的原子性，但保证不了「**你读到 expect 的那一刻**」值是最新的。`get()` 走的是普通读，没有 volatile 就可能读到 CPU 缓存里的旧值，拿去当 expect 就会不断失败。

### 三、自旋：失败之后怎么办

CAS 只告诉你成功或失败，**重试逻辑要自己写**，这就是「自旋」：

```java
public final int getAndIncrement() {
    for (;;) {                          // 经典无限循环
        int current = get();
        int next = current + 1;
        if (compareAndSet(current, next)) return current;
        // 失败说明被别人改了，回到循环开头重新读
    }
}
```

这段 for 循环有三个特点，面试常问：**不阻塞**（不放弃 CPU）、**无锁**（不涉及内核）、**可能饿死**（一直抢不到就一直转）。

### 四、原子类家族

| 类别 | 代表 | 适用 |
|---|---|---|
| 基本类型 | `AtomicInteger` / `AtomicLong` / `AtomicBoolean` | 计数、标志位、状态 |
| 引用类型 | `AtomicReference<V>` | 整体替换不可变对象（最推荐） |
| 带版本号引用 | `AtomicStampedReference<V>` | **解决 ABA**，多一个 int 版本戳 |
| 带标记引用 | `AtomicMarkableReference<V>` | 只关心「有没有被改过」，一个 boolean |
| 数组 | `AtomicIntegerArray` | 按下标独立更新，不用锁整个数组 |
| 字段更新器 | `AtomicIntegerFieldUpdater` | 让已有类的 volatile 字段获得原子操作，省对象开销 |
| 累加器 | `LongAdder` / `LongAccumulator` | **高并发计数**，比 AtomicLong 快一个量级 |

### 五、ABA 问题

```
线程 1：读到 A，准备把 A 改成 C
线程 2：把 A 改成 B，又把 B 改回 A       ← 这两个动作在线程 1 的两次操作之间完成
线程 1：CAS 检查「当前还是 A」，通过 → 改成 C
```

线程 1 以为「没人动过」，实际上中间经历了一轮变化。**CAS 只看值，不看历史，所以它被骗了。**

**什么时候是真事故**：值背后承载「状态身份」的场景。

- 链表/栈的节点复用：A 被弹出、B 压入、A 又被压入（地址复用），此时 CAS 头节点会通过，但结构已经变了 → 丢节点、成环。这是 JDK 早期无锁栈的经典 bug。
- 账户状态：`待支付 → 已关闭 → 待支付`（人工改单），此时 CAS 推进状态会重复处理。
- 单号/版本号：`1 → 2 → 1` 回绕，CAS 会误判。

**什么时候无害**：纯计数。计数只关心最终总量，不关心中间路径，`1→2→1` 和「一直是 1」对累加结果没有区别。**所以 `AtomicInteger` 的 ABA 不构成问题**，别把这条答反。

**解决**：`AtomicStampedReference`，把「值 + 版本号」打包成一个 Pair 一起 CAS。

```java
AtomicStampedReference<Node> ref = new AtomicStampedReference<>(node, 0);
int[] stamp = new int[1];
Node cur = ref.get(stamp);              // 同时取出值和版本
ref.compareAndSet(cur, newNode, stamp[0], stamp[0] + 1);
```

注意它比较的是**引用相等**（`==`）而不是 `equals`，这又引出一个坑：如果每次 new 新对象，即使内容相同也会失败。

### 六、为什么只能保证一个变量

`i++` 本身是一个变量的读改写，CAS 能救；但 **`a++` 和 `b++` 要一起原子**，CAS 就无能为力了——你没法让两个不同内存地址的更新在一个 `cmpxchg` 里完成。

三个出路：

1. **打包成一个对象**：`AtomicReference<Pair>`，把 a、b 塞进不可变对象整体替换。适合两三个字段。
2. **用锁**：字段多、逻辑复杂时，锁更清晰。别为了「无锁」把代码写成迷宫。
3. **LongAdder 式分解**：把热点拆成多个独立单元，各自 CAS，最后汇总。

### 七、LongAdder 为什么比 AtomicLong 快

`AtomicLong` 的所有线程争抢**同一个** `value`：高并发时 CAS 大量失败，失败就重试，缓存行在核间来回弹（**缓存行乒乓**），CPU 全耗在无效自旋上。

`LongAdder` 拆成 `base + Cell[]`：

- 无竞争：直接 CAS `base`（和 AtomicLong 一样快）。
- 有竞争：每个线程通过 `ThreadLocalRandom` 的 probe 哈希**落到不同的 Cell**，各改各的，几乎没有争抢。
- 求和：`sum() = base + ΣCell.value`，**遍历累加，不是快照**。

代价：`sum()` 是**弱一致的**，遍历期间还有写入就会读到中间状态。所以它适合「统计展示」，**不适合「准入判断」**——用 `sum()` 去做限流判断，可能在并发下算少。

还有一个细节：`Cell` 用 `@sun.misc.Contended` 注解做了**缓存行填充**，防止两个 Cell 恰好落在同一条 64 字节缓存行里互相干扰（**伪共享**）。这是它快的另一半原因。

## 为什么这么设计

**为什么用乐观策略而不是直接加锁**：互斥锁的代价不只在「锁」本身，而在**线程阻塞要进内核**——挂起、恢复、上下文切换，一次几十微秒。CAS 全程用户态，一次失败也就几十纳秒。只要冲突概率不高，重试几次远比切换线程便宜。

**为什么 CPU 要专门提供这条指令**：这是唯一能在硬件层保证「比较并交换」原子的手段。软件方案（如先读再判断）永远有一个窗口，而这个窗口在并发下必然被踩到。

**为什么原子类要用 volatile + 偏移量**：原子性由 CAS 给，可见性由 volatile 给，定位由偏移量给。三者缺一不可，这也是它比 `synchronized` 轻的原因——没有互斥，只有一条指令。

**为什么 LongAdder 要分段**：CAS 的性能拐点在于**竞争强度**。分段把「一个热点」变成「N 个冷点」，本质和 ConcurrentHashMap 用 CounterCell 统计 size、AQS 用队列分散等待是同一个思想：**把一个集中点拆成多个分散点**。

## 不用会怎么样

- **用 `int count++` 做限流计数**：100 个线程各加 100 次，结果往往只有 8000 多。超卖、限额击穿都是这么来的。
- **用 CAS 做「先查再改」的复合逻辑**：`if (stock > 0) stock--` 里两个操作之间有窗口，CAS 只能保证「改」那一步，判断和改之间照样能被插队。**正确做法是把判断折进 CAS 的预期值里**（`compareAndSet(1, 0)`）或改用 `AtomicInteger.getAndUpdate`。
- **高并发下用 AtomicLong 做全站计数**：CAS 失败率随并发度线性上升，QPS 到几万时 CPU 有明显一部分烧在重试上，换成 LongAdder 后耗时能降到几分之一。
- **用 Atomic 做跨字段一致性**：两个字段分别 CAS，中间出错就是脏数据，这种场景必须用锁或数据库事务。

## 替代方案

| 方案 | 适用 | 代价 |
|---|---|---|
| `synchronized` | 临界区有多步操作、要保多字段一致 | 阻塞、可能有上下文切换；低竞争下 JIT 优化后其实不慢 |
| `AtomicInteger` / `AtomicLong` | 单变量计数、低到中并发 | 高竞争时自旋浪费 CPU |
| `LongAdder` | 高并发统计、只求和 | `sum()` 弱一致，不能用于精确判断 |
| `AtomicReference` + 不可变对象 | 整体替换配置/快照 | 每次修改都要新建对象，GC 压力 |
| `AtomicStampedReference` | 需要识别 ABA | 每次多一个版本号，比较用 `==` |
| `VarHandle` | JDK 9+ 新代码 | API 啰嗦，需理解内存语义参数 |

## 项目中如何使用

- **某银行单号生成**：号段模式，`AtomicLong` 在内存里发号，用尽再向 DB 领一段。并发不高（单机几千 TPS），`AtomicLong` 足够；没上 LongAdder 是因为发号必须**严格递增且不重复**，不能容忍弱一致。
- **某支付公司渠道限额计数**：本地 `LongAdder` 只做**监控与告警**（看趋势够用），真正的准入判断走 Redis `INCR` + 过期时间，本地计数永远不参与「能不能放行」的决策——这条是踩过坑之后定的规矩。
- **单据状态机推进**：`UPDATE ... WHERE status = '待处理'` 用数据库的 CAS 语义（乐观锁），而不是内存 CAS。内存 CAS 只适合单实例，多实例部署时各 JVM 的内存互不可见，用 Atomic 反而制造了「以为安全」的假象。
- **某跨境电商密钥轮换**：`AtomicStampedReference` 存「当前密钥 + 版本号」，轮换时版本号自增，解密侧拿到旧版本号能识别出「需要回查历史密钥」，避免 ABA 式误判。

## 常见陷阱

- **说「CAS 保证原子性所以不需要 volatile」**——错。CAS 保证的是「比较并交换」这一步，读 expect 那一步的可见性靠 volatile。
- **把 ABA 当普遍问题**——计数器场景根本不受影响，只有「值代表状态身份」时才致命。答成「所有 CAS 都有 ABA 风险」会被追问。
- **认为 CAS 一定比锁快**——低竞争时确实快；**高竞争时 CAS 会不断失败重试，性能可能不如直接阻塞**（阻塞至少不烧 CPU）。这也是 JDK 8 给 `AtomicLong` 加 `longSupplier` 兜底、并推出 LongAdder 的原因。
- **用 `AtomicReference` 存可变对象**——对象内部字段被改，引用没变，CAS 感知不到。必须存**不可变对象**，每次修改新建。
- **忘记 CAS 只能保一个变量**——「三个字段要一起改」是 CAS 的死角，面试高频追问点。
- **`compareAndSet` 的返回值不看**——失败就静默过去，逻辑直接丢更新。

## 三层追问

1. **CAS 底层到底怎么保证原子？**——CPU 的 `cmpxchg` 指令本身不是原子的（多核下仍可能被打断），必须加 `lock` 前缀。`lock` 会锁住缓存行（或退化为锁总线）直到指令完成，同时使其他核缓存失效。ARM 用 `ldrex/strex` 的 LL/SC 机制实现同样语义。
2. **高并发下 AtomicLong 为什么会退化？**——所有线程争抢同一个缓存行，每次失败都要重新读、重新算、重新 CAS，缓存行在核间反复失效（乒乓），有效吞吐不升反降。LongAdder 用 Cell 数组把热点打散，代价是求和不再精确。
3. **CAS 能替代锁吗？**——不能。CAS 只解决「单变量原子更新」，无法表达「多步操作互斥」。AQS 自己就是「CAS 入队 + park 等待」的组合，纯 CAS 做不到等待语义。所以无锁结构的赛道是「计数器、栈、队列头尾」，不是通用互斥。

## 我的口述记录

（首次复述后填写）
