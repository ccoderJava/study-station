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
updated: 2026-11-04
---

## 30 秒简述

ThreadLocal 提供的是「每个线程一份副本」，但数据并不在 ThreadLocal 对象里，而在 Thread 自己的 `threadLocals`（ThreadLocalMap）里：key 是 ThreadLocal 的弱引用，value 是业务对象的强引用。弱引用只保证 ThreadLocal 对象本身能被回收，value 必须靠 `remove()` 主动断开；而线程池的线程不退出，value 就一直可达 → 内存泄漏。更严重的是线程被复用后还会读到上一个请求的值 → 数据串号、跨租户越权。所以规范是：`private static final` 声明、只存轻量不可变对象、入口 set、最外层出口 `finally { remove(); }`；跨线程用 TTL 或 TaskDecorator，InheritableThreadLocal 在线程池里等于失效。它最典型的用途是上下文传递、链路追踪和数据采集。

## 是什么

一句话：**ThreadLocal 不是「线程本地变量」，而是「以线程为作用域的隐式参数」**——它省掉的是方法签名上的层层传参，代价是把数据的生命周期交给了线程。

- 数据结构：`Thread` → `threadLocals`（`ThreadLocalMap`）→ `Entry[] table`；`Entry extends WeakReference<ThreadLocal<?>>`，另有一个 `Object value` 字段强引用业务对象。
- 一个 ThreadLocal 实例对应每个线程里的一个槽位，所以「同一个 ThreadLocal，不同线程读到不同的值」。
- 三个 API 的语义：`set` 写入当前线程的 map、`get` 读当前线程的 map（没存过就 `setInitialValue()`）、`remove` 删掉当前线程的这个槽位并把 value 置 null。
- 泄漏的本质不是「弱引用不管用」，而是 **Entry 数组随线程存活，而清理只发生在下一次读写时**。

![ThreadLocal 的引用链：key 是弱引用、value 是强引用，泄漏与否取决于线程活多久](img/threadlocal-ref-chain.svg)

读图要点：图上半部分是「谁持有谁」，下半部分是「一个槽位里到底存了什么」。真正让对象活下来的是右侧那条 value 强引用——key 被 GC 后 Entry 变成 `key == null` 的僵尸槽，value 还挂着；而清理动作（`expungeStaleEntry`）只在线程**下一次**碰这个 map 时才发生。

## 为什么这么设计

- **key 用弱引用**：如果 key 也是强引用，那么每次 `new ThreadLocal()` 用完丢掉后，ThreadLocal 对象会被线程的 map 一直引用，无法回收。弱引用让「ThreadLocal 对象」这件事可以被 GC 掉，只是漏下了 value。
- **value 用强引用**：如果 value 也弱引用，业务对象在别处没有强引用时会被误回收，`get()` 突然返回 null——线程本地存储的语义就没了。JDK 选择了「保证可用性，把清理责任交给使用者」。
- **为什么不做自动清理**：Map 无法知道「这个值用完了」。`get/set/remove` 是它唯一能观察到的时机，所以只能在探测时顺手清（启发式清理 `cleanSomeSlots` + 全量清理 `expungeStaleEntries`）。
- **为什么用开放寻址而不是链表**：每个线程里的 ThreadLocal 通常只有几个，`Entry` 数量极少，链表节点（Node + next 指针）的对象头开销反而更大；而且数组紧凑、缓存友好。代价是删除要用 `expungeStaleEntry` 做连续段 rehash，不能像链表那样摘节点。
- **为什么 hash 用黄金分割递增**（`0x61c88647`）：让同一线程里连续创建的多个 ThreadLocal 均匀散开，减少线性探测距离。这是个很小但很讲究的细节，面试能说出来是加分项。

## 不用会怎么样

- **内存泄漏**：线程池线程长期存活，value 随线程常驻，老年代缓慢上涨 → Full GC 频繁 → 接口 P99 抖动。这类泄漏增长慢，往往上线几天才暴露，排查成本高。
- **数据串号（更危险）**：上一个请求的租户 ID 留在池化线程上，下一个请求 `get()` 到别人的租户 → 查询/写入落到错误租户。多租户 SaaS 里这是**越权事故**，不是性能问题。
- **类加载器泄漏**：Tomcat 热部署时，容器线程持有 webapp 里的 ThreadLocal 类 → 整个 webapp 的 ClassLoader 无法卸载 → Metaspace 只涨不降，重启几次就 OOM。
- **隐性错误**：`get()` 返回 null 导致 NPE，或者读到一个「看起来合理但其实是别人」的值——后者不报错，最难查。

## 替代方案

| 方案 | 适用 | 说明 |
|---|---|---|
| 方法参数显式传递 | 链路短、调用层级少 | 最安全、最可测，但侵入性强，跨十几层就没人愿意写 |
| Context 门面 + 拦截器统一清理 | Web 请求内 | 主流做法：入口 set，最外层 Filter 出口 remove，业务只读 |
| InheritableThreadLocal | 真的 new Thread 的场景 | 只在 `Thread` 构造时浅拷贝父线程快照，之后父线程再改不影响子线程；线程池下等于失效 |
| TransmittableThreadLocal（TTL） | 线程池、异步编排 | 提交任务时 capture 快照、执行前 replay、执行后 restore；需要包装 Executor 或用 agent |
| TaskDecorator / ContextPropagatingTaskDecorator | Spring 的 `@Async`、`ThreadPoolTaskExecutor` | 只覆盖 Spring 托管的线程池，自建线程池和 `CompletableFuture` 默认池管不到 |

## 项目中如何使用

**某银行的多租户财资系统**：租户 ID 由网关签发，Filter 里写进 `TenantContextHolder`（内部是 `static final ThreadLocal`），DAO 拦截器统一给 SQL 拼 `tenant_id` 条件，业务代码完全无感。

```java
public final class TenantContextHolder {
    private static final ThreadLocal<TenantContext> CTX = new ThreadLocal<>();

    public static void set(TenantContext c) { CTX.set(c); }
    public static TenantContext get() { return CTX.get(); }
    public static void clear() { CTX.remove(); }   // 对外只暴露 clear，不暴露 set(null)
}

// 最外层 Filter：set 和 clear 必须在同一个方法里成对出现
try {
    TenantContextHolder.set(parseTenant(request));
    chain.doFilter(request, response);
} finally {
    TenantContextHolder.clear();     // 抛异常、提前 return 都会走到这里
}
```

**某支付公司的清结算对账批处理**：一晚上几百万笔，不能每条都打监控。用 ThreadLocal 在批内累计「处理条数 / 失败条数 / 慢记录」，每个分片线程结束前统一上报一次——这就是最典型的数据采集场景。

**某跨境电商的支付中台**：`traceId` 放 ThreadLocal 并同步到 MDC，异步对账任务用 TTL 包装的线程池提交，保证整条链路的日志能串起来。回放环境里必须显式重置上下文，否则回放流量会带着生产的租户/渠道信息写进回放库。

## 常见陷阱

- **只会说「会内存泄漏」，讲不出 key 弱引用、value 强引用**——这是八股的第一层，答到这里只能算及格。
- **不知道弱引用是为了什么**：很多人以为弱引用 key 是「防止 value 泄漏」的，其实它是为了让 ThreadLocal 实例本身可回收；value 泄漏是设计上的必然取舍。
- **把 InheritableThreadLocal 当线程池方案**：线程池的线程只创建一次，继承的是「创建那一刻」的快照。之后所有请求都读同一个旧值——比读不到更可怕，因为它看起来有值。
- **忽略「数据串号」比泄漏更严重**：面试官常问「漏内存要紧还是脏数据要紧」，答脏数据，并说清跨租户越权的后果。
- **面试官会接着问**：「你怎么知道线上这次 OOM 是 ThreadLocal 引起的？」——答 heap dump 里搜 `ThreadLocalMap$Entry`，看 value 的引用链是否指向业务对象、GC Root 是否是池化线程；再看哪些业务类的 value 数量异常多。

## 常见使用场景

ThreadLocal 的定位是「**一次请求内，随处可取，且不想改方法签名**」。凡是符合这个描述的都适合，凡是「跨线程共享」或「长期缓存」的都不适合。

| 场景 | 存什么 | 为什么适合 | 注意 |
|---|---|---|---|
| 上下文传递 | 租户 ID、用户 ID、语言/时区、灰度标记 | 一次注入，DAO/日志/校验处处可取 | 跨线程会丢；出口必须 remove |
| 链路追踪 | traceId、spanId、采样标记 | 框架统一注入，日志 MDC 直接带出去 | 异步任务和 MQ 消息要显式透传 |
| 数据采集与埋点 | 请求内累计计数、慢调用耗时、SQL 次数 | 避免每条都打点，出口统一上报一次 | 只存计数和小对象，别存明细大 List |
| 事务与资源绑定 | ConnectionHolder、SqlSession | Spring 事务靠它保证「同一线程同一连接」 | 事务不跨线程，`@Async` 里 `@Transactional` 直接失效 |
| 多租户与数据权限 | tenantId、数据范围 | DAO 拦截器统一拼条件，业务零侵入 | 漏拼一次就是越权，必须有单测兜底 |
| 非线程安全对象复用 | `SimpleDateFormat`、StringBuilder | 每线程一个实例，既不用加锁也不用每次 new | 实例跟着线程常驻；JDK8+ 优先 `DateTimeFormatter` |

三个明确的反例，面试时主动说出来会加分：

- **当全局变量用**：想用它在线程之间共享数据——它压根不是共享容器，每个线程看到的是各自的副本。
- **当本地缓存用**：以为「同一个线程里 get 两次就是缓存」，结果改了库读不到新值；它的生命周期挂在线程上，不是请求上。
- **当跨线程通信手段用**：把值塞进 ThreadLocal 然后起个线程去读——读到的只会是 null 或线程自己上次留下的残留。

## 实现原理：一次 get / set 到底做了什么

![ThreadLocalMap 的探测流程：定位、空槽、命中、陈旧槽清理、线性探测](img/threadlocal-probe-flow.svg)

核心只有一个方法：**从 hash 定位的槽开始线性往后找，遇到空槽、命中、陈旧槽三种情况分别处理**。

```java
// set(key, value) 的骨架
Entry[] tab = table;
int len = tab.length;
int i = key.threadLocalHashCode & (len - 1);         // ① 定位
for (Entry e = tab[i]; e != null; e = tab[i = nextIndex(i, len)]) {
    ThreadLocal<?> k = e.get();
    if (k == key)  { e.value = value; return; }       // ③ 命中，覆盖
    if (k == null) { replaceStaleEntry(key, value, i); return; }  // ④ 陈旧槽，替换
}
tab[i] = new Entry(key, value);                       // ② 空槽，放入
if (!cleanSomeSlots(i, ++size) && size >= threshold) rehash();  // 顺带清理 + 扩容判断
```

三件事值得记住：

1. **`threadLocalHashCode` 是递增的**：每 new 一个 ThreadLocal 就加 `0x61c88647`，不是对象 hash。
2. **清理是「顺手」的**：`expungeStaleEntry` 把僵尸槽的 value 置 null，并把后面连续的非空段重新 rehash 一遍；`cleanSomeSlots` 是带概率的抽样清理（`n >>>= 1`），避免每次 set 都全表扫。所以**泄漏不会立刻显现，要等到下一次读写**。
3. **扩容阈值是 `len * 2 / 3`**：初始 16 个槽，放满 10 个就 rehash——先清旧槽，再翻倍。这也解释了为什么「把 ThreadLocal 声明成非 static」会放大问题：每个实例占一个槽，很快撑大数组。

`remove` 的路径最短：定位、找到 key、`e.clear()` 断掉弱引用、`expungeStaleEntry(i)` 清 value 并修整后续段。这就是「唯一能真正断开 value 强引用」的操作。

## 上下文怎么跨线程传递

![一次请求里上下文的生命周期：注入、同线程读取、异步断点、出口清理](img/threadlocal-lifecycle.svg)

图里最重要的不是四个方框，而是**红色那个断点**：请求线程和异步线程是两个 Thread，两个 `threadLocals`，天然不共享。

| 方式 | 能不能覆盖线程池 | 原理 | 代价 |
|---|---|---|---|
| 手动传参 | 能 | 把上下文对象当参数传进任务 | 最可靠，但侵入性强，容易漏 |
| InheritableThreadLocal | **不能** | `Thread` 构造时浅拷贝父线程的 inheritableThreadLocals | 池化线程早创建好了，值永远是出生快照 |
| TTL（`TtlRunnable` / `TtlExecutors`） | 能 | 提交时 capture 快照，执行前 replay，执行后 restore | 要包装到位：自建线程池、定时任务、ForkJoinPool 漏一个就丢 |
| Spring `TaskDecorator` | 能（仅 Spring 托管池） | 包装 `Runnable`，在 run 前后 set/clear | 管不到 `CompletableFuture` 默认池和自建池 |

Spring 项目里最常见的一段：

```java
@Bean
public TaskDecorator contextTaskDecorator() {
    return task -> {
        TenantContext ctx = TenantContextHolder.get();
        Map<String, String> mdc = MDC.getCopyOfContextMap();
        return () -> {
            TenantContextHolder.set(ctx);
            if (mdc != null) MDC.setContextMap(mdc);
            try {
                task.run();
            } finally {
                TenantContextHolder.clear();
                MDC.clear();          // 还原，不是简单丢掉——池线程还会被复用
            }
        };
    };
}
```

MDC 本身也是 ThreadLocal（Logback 的 `LogbackMDCAdapter` 内部就是一个 `ThreadLocal<Map<String,String>>`）。异步 appender 不会丢 MDC（事件创建时已快照），但**跨线程池执行一定会丢**，必须像上面那样手动搬。

## 使用注意事项

1. **一律 `private static final`**：非 static 会导致每个实例占一个槽，弱引用回收后留下僵尸槽，map 越来越大。
2. **set 和 remove 必须成对，且 remove 写在最外层出口**（Filter / `afterCompletion` / 线程池任务的 finally），不要写在业务方法里——业务方法可能被异步分支复用。
3. **只存轻量、不可变的对象**：存 ID 和少量字段，不存用户全量信息、查询结果集、大 List。value 是强引用，存多大就漏多大。
4. **对外只暴露门面，不暴露裸 ThreadLocal**：`ContextHolder.get/set/clear` 比到处 `ThreadLocal` 变量好管，也方便以后换 TTL。
5. **子线程拿到的是引用而不是副本**：InheritableThreadLocal 是浅拷贝，父子线程可能共享同一个可变对象，要么存不可变对象，要么显式深拷贝。
6. **异步之前先快照**：进入线程池/`CompletableFuture`/MQ 之前把值取出来传过去；消费端从消息头重建上下文，不要指望「继承」。
7. **不要在 `get()` 后不做判空**：没 set 过就是 null，用 `withInitial` 给默认值，或者用 `Optional` 包一层。
8. **框架自带的 ThreadLocal 也要管**：`RequestContextHolder`、`TransactionSynchronizationManager`、ShardingSphere 的 `HintManager` 都是线程绑定的，用错线程就会拿到 null 或上一次的残留。
9. **用完即清的代码要能自证**：至少在 Filter 和线程池包装层各留一处 `remove`，并用单测断言「连续两次请求读到的上下文不串」。
10. **容器环境留意类加载器**：webapp 里的 ThreadLocal 被容器线程持有，热部署时会导致整个 ClassLoader 无法卸载。

## 常见坑清单

| 坑 | 现象 | 根因 | 修法 |
|---|---|---|---|
| remove 只写在正常路径 | 压测几小时后租户串号 | 异常/提前 return 绕过了清理 | 挪到最外层 finally |
| ThreadLocal 不是 static final | 老年代缓慢上涨，dump 里 Entry 极多 | 每次 new 都占一个槽 | 统一 static final 声明 |
| 用 InheritableThreadLocal 传线程池 | 上下文永远是旧值，改了不生效 | 继承只发生在 Thread 构造时 | 换 TTL 或显式传参 |
| `@Async` / `CompletableFuture` / `parallelStream` 里读上下文 | 拿到 null 或别人的值 | 执行线程不是请求线程 | TaskDecorator / TTL 包装 |
| 多个拦截器各 set 各的，只 remove 自己那个 | 其他组件的上下文残留 | 清理与注入不成对 | 统一 Context 门面，一进一出 |
| 把大对象塞进上下文 | 堆涨得快，Full GC 后不回落 | value 强引用 + 线程常驻 | 只存 ID 和轻量 DTO |
| 当缓存用 | 改了库读不到新值 | 生命周期挂在线程上，不是请求上 | 用真正的缓存组件 |
| 存可变对象又被父子线程共享 | 子线程改一半，父线程读到中间态 | 继承是浅拷贝，共享同一引用 | 存不可变对象 |
| MQ 消费线程沿用上游上下文 | 消费者用错租户或 traceId 断链 | 上下文没跟着消息走 | 上下文写进消息头，消费端重建 |
| 热部署后 Metaspace 只涨不降 | 重启几次就 `OutOfMemoryError: Metaspace` | 容器线程持有 webapp 的 ThreadLocal 类 | 卸载前清空，或用容器管理的上下文 |
| 排查时不知道查哪里 | 只知道内存涨，找不到源头 | 不了解 dump 里的结构 | jmap 抓 dump，MAT 搜 `ThreadLocalMap$Entry`，看 value 引用链 |
| remove 之后直接 get | NPE，且难复现 | remove 后回到初始值 | `withInitial` 给默认值或判空 |

## 三层追问

1. **key 弱引用，为什么 value 不弱引用？**——弱引用 key 是为了让 ThreadLocal 实例可回收；value 若也弱引用，业务对象会被误回收，`get()` 随时可能变 null，语义就破了。JDK 选择保证可用性，把清理交给使用者。
2. **弱引用 key 都不能自动清，那 remove 到底清掉了什么？**——清掉的是 value 那条强引用。`e.clear()` 断的是 key（其实已经断了），`expungeStaleEntry` 把 value 置 null 才是真正让业务对象变成不可达的那一下。
3. **线程池里怎么传上下文？InheritableThreadLocal 为什么不行？**——池化线程在第一次提交任务时就创建好了，继承的是当时的父线程快照，后续请求再 set 与它无关。要么提交时快照（TTL / TaskDecorator），要么显式传参。
4. **为什么 ThreadLocalMap 用开放寻址而不是 HashMap？**——每个线程的 entry 通常只有几个，链表节点的对象头和指针开销反而更大；数组紧凑、locality 好。代价是删除后要 rehash 连续段。
5. **线上怎么确认是 ThreadLocal 泄漏？**——`jmap -dump` 后 MAT 搜 `ThreadLocalMap$Entry`，按 class 聚合看哪个 value 数量异常；再看引用链的 GC Root 是不是池化线程。也可以临时加埋点统计各 Context 的 set/remove 次数是否配平。

## 我的口述记录

（首次复述后填写）
