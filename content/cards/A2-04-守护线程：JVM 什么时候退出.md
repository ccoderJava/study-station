---
id: A2-04
title: "守护线程：JVM 到底什么时候退出"
kind: card
nodes: [A2, A3]
primary: A2
direction: "Java 并发"
event: "项目实践"
project: "某支付公司支付网关数据源热更新、某银行对账批处理"
level: normal
status: draft
created: 2026-11-04
updated: 2026-11-04
---

## 30 秒简述

守护线程是给 **JVM** 看的标记，不是给业务用的。JVM 判断能不能退出，只数**非守护线程**：`main` 返回后主线程进入 `DestroyJavaVM`，等所有非守护线程结束、跑完 shutdown hook 就真正退出；这时守护线程会在任意一行代码上被直接停掉，**`finally` 都不保证执行**。

三个必须记住的点：`setDaemon(true)` 必须在 `start()` **之前**，否则抛 `IllegalThreadStateException`；守护状态在**构造时从父线程继承**，所以守护线程里 new 出来的线程池默认也是守护的；它只适合「进程活着才有意义、退出时不需要收尾」的活——配置刷新、心跳续约、监控上报，不适合刷盘、提交事务。

最需要提防的不是「被杀」，而是**退出期的数据真空**：Pod 关停时连接池先被 `close()`，守护线程还在跑 mapper 查询，查不到数据；如果代码把空结果当成最新配置，内存就被刷成空的，进程还活着，继续用空配置接流量。

## 是什么

### 一、唯一的语义：不阻止 JVM 退出

线程对象上只有一个 `boolean daemon` 字段，它不改变调度、不改变优先级、不影响锁，**只影响 JVM 的退出判定**。

| | 非守护线程 | 守护线程 |
|---|---|---|
| 是否计入「还有活没干完」 | 是 | 否 |
| JVM 退出时 | 等它跑完 | 直接停掉，不等 |
| `finally` | 正常执行 | **不保证执行** |
| 典型身份 | `main`、请求处理、批处理 | GC、心跳、配置刷新 |

```java
public class DaemonExit {
    public static void main(String[] args) {
        Thread t = new Thread(() -> {
            try {
                while (true) {
                    System.out.println("daemon tick");
                    Thread.sleep(300);
                }
            } finally {
                System.out.println("这行大概率不会打印");
            }
        });
        t.setDaemon(true);   // 必须在 start 之前
        t.start();
        System.out.println("main done");
    }
}
```

进程只会打印 `main done` 和零到一条 `daemon tick` 就退出——守护线程连一次完整的循环都不保证跑完，`finally` 也不保证进。

### 二、三个容易记错的机制细节

**1）只能在启动前设置。** `Thread.setDaemon` 的实现就是先检查再赋值：

```java
public final void setDaemon(boolean on) {
    checkAccess();
    if (isAlive()) {
        throw new IllegalThreadStateException();
    }
    daemon = on;
}
```

线程一旦 `start`，`isAlive()` 为 true，再调用直接抛异常。**没有运行时切换守护状态这种操作**，这是面试官很爱追问的点。

**2）守护状态是继承来的。** `Thread` 在构造时走 `init()`，里面有一行 `this.daemon = parent.isDaemon()`，父线程是「创建这个 Thread 对象的线程」，不是「调用 start 的线程」。所以：

```java
// 在一个 daemon 线程里
ExecutorService pool = Executors.newFixedThreadPool(4);  // 池里 4 个线程全是 daemon
```

这是最容易踩的隐式行为——线程池不会提示你，任务跑到一半 JVM 退出就没了。

**3）守护线程被杀时没有任何通知。** 没有中断、没有回调、没有 `Thread.onSpinWait` 之类的钩子，就是停在原地。要收尾只有两条路：shutdown hook，或者在非守护线程里显式关闭。

### 三、JVM 里哪些线程是守护线程

`jstack` 打开任何一个 Java 进程，`Daemon` 那一列标着 `true` 的就是：

| 线程 | 是否守护 | 作用 |
|---|---|---|
| `main` | 否 | 启动入口 |
| `Reference Handler`、`Finalizer`（JDK 8）、`Common-Cleaner`（JDK 9+） | 是 | 引用与对象清理 |
| `Signal Dispatcher` | 是 | 处理 `SIGTERM` 等信号，转发给 shutdown hook |
| `Attach Listener` | 是 | `jstack` / Arthas 挂载用 |
| HikariCP 的 `HouseKeeper`、Druid 的 `CreateConnectionThread` / `DestroyConnectionThread` | 是 | 连接池后台维护 |
| Tomcat NIO 的 `Acceptor` / `Poller` | 是 | 纯 I/O 调度 |

规律很清楚：**「它挂了业务也照样能收尾」的线程，都是守护线程**。

### 四、常见使用场景

四类，判断标准只有一条：**这个线程停掉时，会不会有用户可见的结果丢失或者数据不一致**。不会，才用守护线程。

**1）配置热刷新（最典型）**

数据源连接串、限流阈值、开关这类配置变了，不想重启进程，就在进程内起一个后台线程定期拉版本号。它是纯辅助：进程都退出了，刷新配置毫无意义，所以必须是守护线程。

**2）注册中心心跳 / 续约**

Eureka、Nacos 客户端的心跳线程都是后台线程。客户端进程没了，心跳本来也该停，让它拖住 JVM 不退出反而是故障。

**3）监控指标上报、日志采样**

每秒把计数器推到 Prometheus 或者日志系统。丢最后一个周期可以接受，但不能因为「上报线程还没跑完」把进程卡住。

**4）本地缓存的过期清理**

`ConcurrentHashMap` 里的本地缓存靠一个后台线程扫过期 key。缓存本来就是可重建的，JVM 退出时被砍掉没有任何后果。

反过来的例子更值得记：**流水落盘、事务提交、消息发送确认，绝对不能放守护线程**——这几件事的共同点是「丢了要赔钱」。

### 五、退出期与启动期：两个最容易踩空的时序窗口

这是守护线程做配置刷新时最容易忽略的两段。**daemon 只保证「不被等」，不保证「被正确停止」**——它不会收到任何关闭通知，完全可能在连接池已经关掉之后还在跑；反过来，它启动得太早，又可能在依赖就绪之前就去查库。先看关停这一段。

Pod 滚动发布或重启时的真实时序：

| 时刻 | 发生了什么 | 守护线程知道吗 |
|---|---|---|
| T0 | API Server 标记 Pod `Terminating`，同时从 Endpoints 摘除 | 不知道，还在 `sleep` |
| T0+ | 容器 runtime 发 `SIGTERM`，Spring 收到 `ContextClosedEvent` | 不知道 |
| T0+ | 停止接新请求，等在途请求跑完（`server.shutdown=graceful`） | 不知道 |
| T0+ | 销毁单例 bean，`DataSource.close()`，连接池关闭 | 不知道 |
| T0+ | 这一轮醒来，执行 `mapper.selectAll()` | **池已经关了，抛异常或拿不到数据** |
| T0+30s | `terminationGracePeriodSeconds` 到期，`SIGKILL` | 直接消失 |

报错长这样，看到就应该反应过来是关停时序问题，而不是 SQL 写错了：

- `SQLException: HikariDataSource xxx has been closed`
- `HikariPool-1 - Connection is not available, request timed out after 30000ms`
- MyBatis 包一层：`CannotGetJdbcConnectionException: Failed to obtain JDBC Connection`
- Druid：`dataSource already closed`

**真正危险的不是这一轮失败，而是失败之后代码怎么写的。** 很多人是这么写的：

```java
// 危险写法：查询结果为空时，把上一版有效配置覆盖掉
@Scheduled(fixedDelay = 30_000)
public void refresh() {
    Map<String, String> next = new HashMap<>();
    for (ConfigItem c : configMapper.selectAll()) {   // 返回空集合，不报错，循环 0 次
        next.put(c.getKey(), c.getValue());
    }
    this.cache = next;                                // 内存配置变成空 Map，进程还在跑
}
```

`selectAll()` 返回空 list 时**不会抛异常**，循环零次，`next` 是空 Map，然后被赋值。结果就是：进程没死、Pod 还是 Ready、但所有配置全没了——限流阈值变 0、路由表变空、白名单变空。这比抛异常严重得多，因为异常至少会打日志，空覆盖连日志都没有。

所以这段代码必须满足两个条件：**失败和空结果都不覆盖，只有完整加载成功才替换**。

```java
private final AtomicReference<Map<String, String>> cache = new AtomicReference<>(Collections.emptyMap());

public void refresh() {
    Map<String, String> next;
    try {
        List<ConfigItem> list = configMapper.selectAll();
        if (list == null || list.isEmpty()) {
            log.warn("配置查询返回空，保留上一版，本轮跳过");   // 空 ≠ 配置被删光
            return;
        }
        next = list.stream().collect(Collectors.toMap(ConfigItem::getKey, ConfigItem::getValue));
    } catch (Exception e) {
        log.error("配置刷新失败，保留上一版，下轮重试", e);      // 连接池关闭、连接超时都会走到这里
        return;
    }
    cache.set(next);                                          // 只有完整结果才原子替换
}
```

还有两个对称的坑：

- **首轮刷新不能放在 `@PostConstruct`。** 这时只有本 bean 的依赖是就绪的，容器里其他组件可能还没初始化完，第一轮大概率查不到数据。
- **`@Scheduled` 默认线程不是守护线程，但也不受关闭顺序保护。** 它归 `TaskScheduler` 管，容器关闭时会 `shutdown`，可如果这一轮正在查库，同样会和 `DataSource.close()` 抢时序。守护与否解决不了这个问题，真正解决它的是**生命周期顺序**（见下一节的 `SmartLifecycle` phase）。

**首轮到底该放哪：`@PostConstruct` 太早，`ApplicationRunner` 太晚。**

`@PostConstruct` 只保证**本 bean 的依赖**注入完成，不保证**容器里其他组件**就绪。首轮加载要用的 mapper、动态数据源、加解密组件、配置元数据，只要有一个是通过 `ObjectProvider`、事件监听或后置处理器延后初始化的，就会踩空——这就是「程序刚起来那一下查不到东西」的真正来源。而且它跑在 refresh 过程中，一个组件抛异常会把整个上下文带崩。

`ApplicationRunner` 又晚了一步：它在 `refresh()` 之后执行，**web 服务器已经在监听端口**，readiness 一通过流量就进来了。这时候首轮加载失败再退出，等于已经放进来一批请求，它们用的是空配置。

| 阶段 | 回调 | 此刻什么已就绪 | 端口 |
|---|---|---|---|
| 单例创建 | 构造 → 注入 → `@PostConstruct` | 只有本 bean 的依赖 | 未监听 |
| 所有单例创建完 | `SmartInitializingSingleton` | 全部单例：mapper、数据源、配置客户端 | 未监听 |
| refresh 收尾 | `Lifecycle.start()` → `ContextRefreshedEvent` | 生命周期组件（含 web 服务器） | **开始监听** |
| `run()` 结尾 | `ApplicationRunner` / `CommandLineRunner` | 全部就绪 | 已监听，可能已接流量 |

正确的落点是 `SmartInitializingSingleton.afterSingletonsInstantiated()`：所有单例都实例化完才回调，依赖全部就绪；又早于 web 服务器启动，抛异常会让 refresh 失败、进程根本起不来，交给 K8s 重试。这才是「要么带着配置起来，要么别起来」。

注意它的边界：只对**非懒加载的单例**生效——`@Lazy` 的 bean 不在预实例化范围内，这时候要显式 `getBean()` 触发一次。另外这个回调是同步的，跑多久启动就慢多久；首轮加载本来就该等，但别在这里做全量预热之类的大活。

`@PostConstruct` 不是不用，而是**分工**：它负责本组件自己的初始化（建缓存容器、建调度器但不启动、校验参数），首轮查库放 `afterSingletonsInstantiated()`。

```java
@Component
public class ConfigRefresher implements SmartInitializingSingleton {

    private final ConfigMapper configMapper;
    private final AtomicReference<Map<String, String>> cache = new AtomicReference<>();

    @PostConstruct
    void init() {
        // 只做本组件的事：校验依赖、建好空容器，不查库
    }

    @Override
    public void afterSingletonsInstantiated() {
        loadOnce();          // 所有单例就绪，这里查库才是安全的
    }

    private void loadOnce() {
        Map<String, String> next = loadFromDb();
        if (next == null || next.isEmpty()) {
            throw new IllegalStateException("首轮配置为空，拒绝启动");   // fail-fast，交给 K8s 重试
        }
        cache.set(next);     // 成功才替换，后面再交给守护线程定期刷新
    }
}
```

### 六、把整条链路画出来：启动 / 运行 / 关停三张图

上面五节是拆开讲的，实际出事时是**三段时序连在一起**：启动期没起来、运行期刷空了、关停期查不到。这三段各对应一个 Spring 扩展点，也各有各的坑。先看图，再看后面的坑清单。

**图 1：启动期——首轮加载到底卡在哪一步**

```text
启动期
 │
 ├─ new ConfigRefresher()
 │    └─ @PostConstruct
 │         只做本组件的事：建容器、建调度器（不 start）、校验参数
 │
 ├─ 容器内所有单例创建完毕
 │    └─ mapper / 动态数据源 / 配置客户端 / 加解密 都在这一步完成
 │
 ├─ SmartInitializingSingleton.afterSingletonsInstantiated()   ◀── 首轮加载放这里
 │    │
 │    ├─ loadOnce() 查库
 │    │    ├─ 拿到完整数据  →  AtomicReference.set(配置)
 │    │    ├─ 空结果        →  throw IllegalStateException
 │    │    └─ 抛异常        →  不 catch，继续向上抛
 │    │
 │    └─ 一旦抛出 → refresh() 失败 → 进程退出 → Pod 启动失败 → K8s 重试
 │
 ├─ Lifecycle.start() / ContextRefreshedEvent
 │    └─ web 服务器此刻才开始监听端口   ◀── 流量从这里起可以进来
 │
 └─ ApplicationRunner（refresh 之后执行）
      └─ 放这里 = 首轮失败时，已经接进了一批用空配置处理的请求
```

读图要点：三条横线把启动期切成四段。`@PostConstruct` 只保证**本组件**就绪；`afterSingletonsInstantiated` 才保证**整个容器**就绪，而且端口还没开；`Lifecycle.start` 之后端口才监听。**首轮加载只能放第二条线**——早一步依赖没齐，晚一步流量已进。

**图 2：运行期——一次刷新的决策流**

```text
守护线程每 30s 醒来（daemon = true，不阻止退出）
 │
 ├─ 拉版本号（长轮询，超时 5s）
 │    ├─ 超时 / 网络失败 ─────────  计一次失败，本轮结束（不动缓存）
 │    └─ 版本号没变 ─────────────  直接返回，不拉全量
 │
 ├─ 版本号变了 → 拉全量配置
 │    ├─ 结果为空 ───────────────  log.warn + 保留上一版（空 ≠ 配置被删光）
 │    └─ 抛异常 ─────────────────  log.error + 保留上一版 + 计数
 │
 ├─ 用新参数新建连接池 → 预热 1 个连接探活
 │    ├─ 预热失败 ───────────────  关掉新池、保留旧池、告警、下轮重试
 │    └─ 预热成功
 │
 ├─ AtomicReference.set(新池)     ◀── 原子切换点，读侧只会看到完整的池
 │
 └─ 旧池延迟 5 分钟关闭 ─────────  等在途事务自然结束（双缓冲）
```

三个「不写就出事」的判断点：**空结果、异常、预热失败**。三者都必须走「保留上一版」，只有跑完整条链路才允许 `set`。

**图 3：关停期——谁先停、谁后停**

```text
T0        Pod 标记 Terminating
 │         ├─ Endpoints 摘除：新流量不再进来（在途请求还在跑）
 │         └─ preStop: sleep 8   ← 给摘流量和连接归还留时间
 ▼
T0+8s     SIGTERM → Spring 收到 ContextClosedEvent
 │         ├─ server.shutdown=graceful：停收新请求，等在途请求跑完
 │         ├─ SmartLifecycle.stop()   按 phase 降序执行
 │         │    └─ phase = MAX-100 的刷新线程先停：shutdownNow + awaitTermination(5s)
 │         ├─ @PreDestroy：关闭新旧两个连接池
 │         └─ 进程正常退出
 ▼
T0+30s    terminationGracePeriodSeconds 到期 → SIGKILL（兜底，不触发任何 hook）
```

反面就是上一节的报错表：如果刷新线程只是 `setDaemon(true)`、没进关闭序列，`SmartLifecycle.stop()` 那一步根本不存在，实际顺序变成「先关连接池、线程还在跑」，下一秒就去查库。

三张图串成一句话：**启动期保证「起来就有配置」，运行期保证「刷新失败不降级」，关停期保证「停的时候不查库」。**

### 七、分阶段坑清单（发布前对着过一遍）

「常见陷阱」那一节讲的是守护线程本身的通用坑，这张清单只针对**配置热更新**这一个场景，按阶段列，每条一行，方便上线前扫一遍。

**启动期**

| 坑 | 现象 | 根因 | 修法 |
|---|---|---|---|
| 首轮放 `@PostConstruct` | 启动日志一条「配置为空 / 连接失败」，之后靠定时任务慢慢补 | 此时只有本 bean 的依赖就绪，动态数据源、mapper 可能还没好 | 挪到 `SmartInitializingSingleton` |
| 首轮放 `ApplicationRunner` | 发布后几秒内报「无可用通道」「限流不生效」 | 它执行时 refresh 已完成、端口已在监听 | 同上 |
| 首轮失败只打日志 | 应用正常起来，但跑的是默认值 | 没有 fail-fast，K8s 以为启动成功 | 抛异常让 Pod 起不来，交给 K8s 重试 |
| `@PostConstruct` 里就 `scheduler.start()` | 第一次刷新必然失败，之后偶发失败 | 线程先于容器就绪 | `@PostConstruct` 只建不启，`afterSingletonsInstantiated` 末尾再 start |
| 首轮查询没设超时 | 数据库慢时启动卡住，readiness 探针超时，Pod 被反复重启 | 同步调用无限等 | 首轮单独设 2~3s 超时，超时即 fail-fast |

**运行期**

| 坑 | 现象 | 根因 | 修法 |
|---|---|---|---|
| 空结果覆盖 | 发布窗口内限流失效、白名单全放开 | `selectAll()` 返回空集合不抛异常，循环零次 | 空也要 `return`，保留上一版 |
| `catch` 后只打 debug | 故障期间日志干净，事后查不到 | 异常被吞 | error + 计数 + 告警，失败率超阈值就报 |
| 每次刷新 new 连接池但不关旧池 | 跑几天后连接数打满、句柄耗尽 | 只做了 `set`，没做延迟关闭 | 记录旧池引用，延迟 5 分钟 `close()` |
| 只换 `DataSource` 引用，mapper 还用旧的 | 配置改了不生效，重启才好 | `SqlSessionFactory` / `JdbcTemplate` 启动时就固化了数据源 | 换持有数据源的工厂，或用 `AbstractRoutingDataSource` 包一层做切换 |
| 版本号用普通 `long` | 偶发不刷新，或重复拉全量 | 多线程可见性 | `volatile long` 或 `AtomicLong` |
| 用 `Timer` 做刷新 | 抛一次异常后线程静默死掉，此后再也不刷新 | `Timer` 单线程，任务抛异常即终止整个 Timer | 用 `ScheduledExecutorService`，异常在任务内自己 catch |
| 没设 `UncaughtExceptionHandler` | 线程死了没人知道 | 默认只打到 stderr，容器里未必收 | 显式 set，打 error 并上报 |
| 新配置用 `putAll` 合并进旧 Map | 配置中心删掉的 key 还在生效 | 合并而非整体替换 | 每轮构造全新 Map，再整体 `set` |

**关停期**

| 坑 | 现象 | 根因 | 修法 |
|---|---|---|---|
| 刷新线程没进关闭序列 | 发布时偶发 `HikariDataSource has been closed`，发布完自愈 | daemon 不受 Spring 生命周期管理 | 实现 `SmartLifecycle`，phase 给大值 |
| `awaitTermination` 没设上限 | Pod 卡满 30s 被 SIGKILL，日志截断在半句 | 无界等待 | 给 5s 上限，超时就放弃 |
| 靠 `finally` 收尾 | 收尾代码时灵时不灵，90% 的发布正常 | 守护线程不保证执行 `finally` | 用显式 `stop()` / `@PreDestroy` |
| 没配 `preStop` | 摘流量和关进程几乎同时，必然有一批请求失败 | Endpoints 摘除是异步的，有秒级延迟 | `preStop: sleep 8` |
| 关停顺序靠「代码里先写谁」 | 换个容器或框架顺序就乱 | 隐式约定 | 用 phase 显式声明先后 |
| `stop()` 里不打日志 | 出问题只能靠猜「到底停到哪一步了」 | 无状态输出 | 打一行「刷新线程已停，剩余任务 N，耗时 X ms」 |

三条优先级最高：**首轮放对位置（`SmartInitializingSingleton`）、空结果不覆盖、刷新线程进关闭序列（`SmartLifecycle` 大 phase）**。这三件事做到，滚动发布时那类「偶发、重启后自愈、日志里只有一条连接异常」的故障基本就绝迹了。

## 为什么这么设计

设计者要解决的是一个很具体的问题：**JVM 需要一个「进程还活着」的明确定义**。

如果所有线程地位平等，那么任何一个死循环的后台线程都会让进程永远退不出去，`kill` 之外没有正常退出路径。Java 把这个判定权交给程序员，用「谁产生最终结果」来划线：非守护线程代表「还有没干完的活」，守护线程代表「服务性工作」。

代价有三个，都很实在：

- **没有退出契约。** 守护线程拿不到「我要被杀了」的通知，`finally` 不保证执行。语言层面不给你优雅退出的能力，你得自己在业务代码里放 `volatile boolean running` 开关，或者在 shutdown hook 里显式关。
- **语义是「随时可杀」。** 所以放进去的任务必须幂等、可丢、可重建。一旦有人往守护线程里塞了「必须执行完」的逻辑，就埋了一个只在发布时才炸的雷。
- **继承性放大了误用。** 守护线程里 new 出来的 `Thread` 和 `ExecutorService`，线程默认都是守护的——线程池不预创建线程，Worker 是在提交任务时由调用线程创建的，于是把父线程的 `daemon` 标志继承了去。`CompletableFuture` 默认使用的 `ForkJoinPool.commonPool` 更是天生就是守护池。这个隐式传播没有任何提示，是线上「任务莫名其妙没跑完」的常见来源。

还有一点要分清：**守护线程不负责收尾，shutdown hook 才负责收尾**。两者是分工不是替代。守护线程保证「不捣乱」，hook 保证「把该做的做完」，两个都得有。

## 不用会怎么样

**场景一：该守护的没守护，进程退不出去。**

一个跑批工具，`main` 里起了一个「每 30 秒刷新一次配置」的线程，忘了 `setDaemon(true)`。批处理跑完，`main` 返回，主线程在 `DestroyJavaVM` 里等这个死循环线程——它永远不会结束。结果：

- 本地跑脚本，命令行不返回，以为卡死；
- 上到 K8s，Job 的 Pod 一直 `Running`，`backoffLimit` 打满，发布流水线超时；
- 运维只能 `kill -9`，而这时可能正好有临时文件写到一半。

**场景二：该非守护的守护了，数据丢了。**

把「交易流水异步落盘」放在守护线程里，以为能「退出时自动刷完」。实际上 JVM 退出时它停在任意一行，缓冲区里最后几百条流水直接没了。对账时借贷不平，查到最后是「进程重启丢了一段」。这类问题的特点是**偶发、只在发布或重启时出现、日志里什么都没有**。

**场景三：以为守护线程会收到通知。**

写了 `try { while (running) {...} } finally { flush(); }`，指望 `finally` 兜底。守护线程不保证进 `finally`，这段收尾代码在 90% 的重启里执行了，剩下 10% 没执行——比完全不写更难查。

**场景四：Pod 滚动发布时，配置被刷成了空。**

守护线程每 30 秒查一次库刷新配置。滚动发布时，`DataSource` 先被 `close()`，守护线程这一轮醒来，`mapper.selectAll()` 拿到空集合（或者抛连接异常被 catch 住）。代码没判空，直接 `cache = next`，内存里的配置变成空 Map。这时候老 Pod 还在处理摘流量之前的最后几个请求，用的是空配置：

- 限流阈值读成 0，所有请求被拒，或者读成默认最大值，限流彻底失效；
- 渠道路由表为空，支付请求找不到通道，直接报「无可用通道」；
- 白名单为空，交易拦截规则全部放开。

现象是**发布窗口内出现一小批报错，发布完成后自动恢复**，日志里只有一条被 catch 住的连接异常。查起来非常费劲，因为「重启后自己好了」——这本身就是关停时序问题的典型特征。

## 替代方案

| 方案 | 适用场景 | 说明 / 风险 |
|---|---|---|
| 守护线程 + `volatile boolean running` | 纯辅助任务：配置刷新、心跳、缓存清理 | 最简单；退出时无收尾，任务必须可丢 |
| 非守护线程 + `CountDownLatch` / `awaitTermination` | 必须跑完的批处理、刷盘 | 忘了 `shutdown()` 或 `countDown()` 会把进程挂死 |
| Spring `@Scheduled` + 容器优雅停机 | 应用内的定时任务 | 生命周期交给容器管，会走 `TaskScheduler` 的 `shutdown`，推荐 |
| `SmartLifecycle` / `@PreDestroy` | 需要明确启动停止顺序的组件 | 多写几十行，但启停可控、能配超时 |
| JVM `shutdown hook` | 退出前统一收尾 | 不保证执行完（强杀不触发），`kill -9` 直接跳过 |
| K8s CronJob / Sidecar | 证书轮换、配置同步等平台级工作 | 进程内彻底无状态，但多一个部署单元和一层运维 |

选型顺序：**优先交给容器或平台（Spring 生命周期、K8s），其次才是自己起线程**。自己起线程时，先问一句「这个线程被杀掉会不会丢数据」，再决定 daemon 与否。

## 项目中如何使用

**某支付公司支付网关：数据源配置热更新。**

网关在 K8s 上多副本部署，数据源（连接串、最大连接数、socket 超时）放在配置中心。变更后**不能重启 Pod**——重启会掐断在途支付请求，所以走进程内热刷新：

1. 起一个守护线程，`ScheduledExecutorService` 每 30 秒拉一次配置版本号（长轮询），版本没变就直接返回，不拉全量。
2. 版本变了才拉完整配置，用新参数**新建一个连接池**并预热一个连接，探活成功后再原子替换 `AtomicReference<DataSource>` 的引用。
3. 旧池不立刻关，延迟 5 分钟关闭，等还在跑的事务自然结束；这 5 分钟内新旧池并存，属于典型的双缓冲切换。
4. 新池预热失败就保留旧池，只打告警，下个周期重试——**宁可配置不生效，也不能让网关没有可用连接池**。

这个线程设成 `setDaemon(true)`，理由有两条：

- 它是「尽力而为」的服务线程，进程退出时刷新到一半没有任何意义，不能被它拖住退出；
- 它是 `while` 循环 + `sleep` 的长任务，写成非守护，任何一次正常退出路径（灰度脚本里的 `System.exit(0)`、容器收到 `SIGTERM` 后 `main` 自然结束）都会挂在这里。

但**真正的收尾不靠 daemon**：`@PreDestroy` 里先 `running = false`，再 `scheduler.shutdown()` 加 `awaitTermination(5, SECONDS)`，最后关闭新旧两个池。daemon 只保证「不捣乱」，关闭顺序由显式的生命周期方法保证。

退出期还要专门防一手「拿不到配置」，四件事缺一件都可能在滚动发布时翻车：

1. **把刷新线程纳入 Spring 的关闭序列。** 实现 `SmartLifecycle`，`getPhase()` 返回一个比较大的值（例如 `Integer.MAX_VALUE - 100`）。Spring 的 `stop()` 按 phase **降序**执行，phase 大就先停，于是「先停刷新线程、再关连接池」的顺序被固定下来；`stop()` 里 `scheduler.shutdownNow()` + `awaitTermination(5, SECONDS)`。
2. **空结果和异常都不覆盖。** 时序再严谨也有窗口——连接可能正在归还、池正在关闭。只有「查到了完整数据」才 `AtomicReference.set`，其余情况保留上一版。
3. **首轮同步加载，失败就起不来。** 用 `SmartInitializingSingleton` 在所有单例就绪后同步查一次，失败抛异常让 refresh 失败、Pod 直接起不来，由 K8s 重试。放 `@PostConstruct` 会踩「依赖还没就绪」，放 `ApplicationRunner` 时端口已经在监听、可能已经接进流量了。
4. **PreStop 先摘流量再关进程。** `preStop: exec: command: ["sleep","8"]`，给 Endpoints 摘除和连接归还留出时间，减少「刷新线程和关闭中的池抢连接」的概率。

还有一条红线：刷新失败**必须打 error 并计数**。只 `catch` 了打个 debug，等于把这次故障藏起来——下次发布照旧复现，而且没人知道。

**某银行对账批处理：反过来，是非守护 + `awaitTermination`。**

对账文件必须全部落盘并核对完才算成功，所以线程池是非守护的，`main` 末尾显式 `shutdown()` 再 `awaitTermination`，超时未完成就返回非 0 退出码让调度系统重跑。这两个项目的选择差异，正好把判据讲清楚了：**丢了要不要赔钱**。

## 常见陷阱

**1）`start()` 之后再 `setDaemon()`，直接抛异常。**

面试官问「线程跑起来了还能不能改成守护线程」，正确答案是**不能**，`isAlive()` 为 true 时 `setDaemon` 抛 `IllegalThreadStateException`。这个问题在考你有没有读过 `Thread` 源码，答「可以」就废了。

**2）在守护线程里创建线程池。**

```java
// 这个 daemon 线程里起的池，4 个工作线程全是 daemon
daemonThread.execute(() -> {
    ExecutorService pool = Executors.newFixedThreadPool(4);
    pool.submit(orderTask);   // JVM 一退，任务静默消失
});
```

要么显式给线程池传一个 `daemon = false` 的 `ThreadFactory`，要么别在守护线程里建池。这个坑在 `CompletableFuture` 的默认 `ForkJoinPool` 上同样存在。

**3）指望 `finally` 做资源释放。**

守护线程被停时不进 `finally`，`try-with-resources` 一样不会 close。文件句柄、数据库连接、临时文件残留，全靠操作系统回收——单机没事，容器里频繁重启会留下垃圾。

**4）用守护线程承载「必须执行」的逻辑。**

典型错误是把「订单超时关单的补偿」放在守护线程里。进程一重启，那一轮补偿直接消失，用户订单永远挂在「支付中」。**补偿类任务必须是持久化的**（消息队列、数据库状态、定时调度系统），不能只靠内存里的线程。

**5）忘了给守护线程设异常处理器。**

守护线程抛出的 `RuntimeException` 不会让 JVM 退出，也不会有人看到——线程静默死掉，配置再也不刷新，直到有人发现「改了配置没生效」。`setUncaughtExceptionHandler` 里至少打一条 error 日志并上报。

**6）把 `main` 当守护线程。**

`main` 是最典型的非守护线程，它的结束才是「程序该退出了」的信号。JVM 启动后除了 `main`，其余框架线程基本都是 daemon。

**7）查询结果为空，直接当成「配置被清空」覆盖内存。**

面试里问「守护线程做配置刷新有什么风险」，只答「退出时线程被杀」是及格，答出「关停阶段连接池先关、mapper 查库失败或返回空，把配置刷成空」才是加分项。要点是：空集合不抛异常，循环零次，覆盖悄无声息；而抛异常的写法至少还有日志。**空结果和异常都必须走到「保留上一版」这条分支**。

**8）首轮刷新放在 `@PostConstruct`，或者干脆交给守护线程自己跑第一轮。**

两种错法：`@PostConstruct` 里只有本 bean 的依赖就绪，容器里其他组件可能还没起来，第一次查库就踩空；交给守护线程「自然跑起来」更糟——线程一启动就查库，DataSource 和 mapper 未必初始化完，失败后如果只是打个日志，应用就带着空配置对外服务了。

正确做法是**两层分工**：`@PostConstruct` 只做本组件的初始化（建容器、建调度器但不启动、校验参数），跨组件的首轮加载放 `SmartInitializingSingleton.afterSingletonsInstantiated()`，此时所有单例 bean 都已就绪，又还没监听端口，失败就让 refresh 失败、Pod 起不来。

**不要放 `ApplicationRunner`。** 它执行时 refresh 已完成、web 服务器已绑定端口，readiness 一过就有流量，失败再退出等于已经放进来一批空配置请求。这一点面试里问「Spring Boot 启动后想同步加载一次数据，放哪」时，答 `ApplicationRunner` 是常见但不严谨的答案。

## 三层追问

**Q1：守护线程和普通线程到底差在哪？**
只差一个 `boolean daemon` 字段，作用域仅限于 JVM 的退出判定。调度、锁、优先级、栈大小全都不受影响。差别体现在两处：不会阻止 JVM 退出；退出时不被通知、不保证 `finally`。

**Q2：为什么它不能在自己需要收尾的场景里用？**
因为守护线程的语义就是「随时可以被丢弃」，JVM 退出时不走任何终止流程。设计者假设这类线程不持有需要持久化的状态。一旦你把需要落盘的东西放进去，就是用错了工具，而编译器不会拦你。

**Q3：那进程退出时到底由谁来收尾？**
`shutdown hook`。JVM 收到 `SIGTERM` 或 `System.exit` 后，会并发启动所有 hook 线程，等它们跑完才真正退出——JVM 本身不设超时，超时强杀来自容器或运维层。注意 `kill -9`、断电、OOM Killer 不触发 hook，所以关键数据还是得靠「写成功才算成功」的持久化设计，而不是退出时的最后一刷。

**Q4：Spring 应用里还需要自己管守护线程吗？**
一般不需要。定时任务用 `@Scheduled`，需要启停顺序用 `SmartLifecycle`，容器关闭时会按反序调用 `stop()`/`destroy()`，本身就带了优雅停机。自己 new 线程只在「框架不覆盖的底层组件」里才有必要，比如自定义连接池的探活线程。

**Q5：K8s 里配置刷新为什么不用守护线程，改用 Sidecar？**
两者都行，取舍在职责边界。守护线程实现简单、延迟低（30 秒内生效），但每个进程都要重复实现一遍，还得自己处理失败重试和告警。Sidecar 把这件事收敛成一个镜像，业务进程彻底无状态，代价是多一个容器和一层网络。副本数量少、变更频繁的场景，守护线程更划算。

**Q6：守护线程做配置刷新，除了「退出时被杀」还有什么坑？**
真正难查的是**关停阶段的数据真空**。Pod 收到 `SIGTERM` 后，Spring 会先关 `DataSource`，而守护线程不受关闭序列管理，这一轮查询要么抛 `HikariDataSource has been closed`，要么返回空集合。代码如果直接 `cache = next`，配置就被刷成空，老 Pod 在摘流量的窗口里继续用空配置处理请求。修法是四条：把刷新线程做成 `SmartLifecycle` 并给一个较大的 phase（先停线程、后关池）、空结果和异常一律保留上一版、首轮加载放 `SmartInitializingSingleton` 而不是 `@PostConstruct`、首轮失败直接 fail-fast。

**Q7：为什么首轮加载不能用 `@PostConstruct`，也不能用 `ApplicationRunner`？**
一个太早、一个太晚。`@PostConstruct` 只保证本 bean 的依赖注入完成，容器里其他组件（动态数据源、加解密、配置元数据）可能还没初始化，第一次查库就踩空，而且它跑在 refresh 中间，失败了会把整个上下文带崩。`ApplicationRunner` 在 refresh 之后执行，web 服务器已经绑定端口、readiness 一过就进流量，失败退出时已经放进来一批请求。`SmartInitializingSingleton.afterSingletonsInstantiated()` 正好卡在中间：所有单例就绪、端口还没监听，失败就让进程起不来。`@PostConstruct` 仍有它的位置——只做本组件的初始化。

## 我的口述记录

（首次复述后填写）
