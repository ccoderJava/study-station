---
id: A1-01
title: "HashMap 与 ConcurrentHashMap"
kind: card
nodes: [A1]
primary: A1
direction: "Java 并发"
event: "面试高频"
project: "某银行渠道路由表本地缓存、限额计数、某跨境电商密钥缓存"
level: core
status: draft
created: 2026-11-03
updated: 2026-11-03
---

## 30 秒简述

HashMap 是**数组 + 链表 + 红黑树**：容量固定为 2 的幂，索引用 `(n-1) & hash`，扰动函数把高 16 位异或到低位减少碰撞；负载因子 0.75，扩容翻倍并把节点按 `hash & oldCap` 拆成高低位两条链；单桶链表长度到 8 **且**容量 ≥ 64 才树化，退化阈值 6。ConcurrentHashMap 在 JDK 8 放弃了 Segment 分段锁，改成**桶级 `synchronized` + 空桶 CAS**，并发度从固定的 16 提升到桶数量级；size 用 `baseCount + CounterCell[]` 分散累加，因此是弱一致的。

## 是什么

**HashMap（JDK 8）**

- 结构：`Node[] table`，Node 是链表节点，冲突严重时转 `TreeNode`（红黑树）。
- 寻址：`hash = h ^ (h >>> 16)`，下标 `(n-1) & hash`。
- put 主流程：表为空先 `resize()` → 桶为空直接放 → 桶首节点 key 相同则覆盖 → 树节点走 `putTreeVal` → 否则尾插链表，`binCount ≥ 7`（即第 8 个节点）时调 `treeifyBin`，但表容量 < 64 时**先扩容不树化**。
- 扩容：`resize()` 容量翻倍，遍历旧桶时用 `(e.hash & oldCap) == 0` 判断留在原下标还是 `下标 + oldCap`，无需重算 hash；JDK 8 用尾插，避免了 JDK 7 头插在并发扩容下成环。
- 树化/退化：树节点约为链表节点 2 倍空间，退化阈值 6 与树化阈值 8 之间留缓冲，避免来回转换。

**ConcurrentHashMap（JDK 8）**

- 结构：同样是 `Node[]`，没有 Segment；用 `sizeCtl` 一个 volatile 字段兼做「未初始化容量 / 初始化中标记 / 扩容阈值 / 扩容中标记」。
- 初始化：CAS 抢 `sizeCtl`，只有一个线程真正 new 数组。
- put：桶空 → CAS 放入；桶非空 → `synchronized (f)` 锁住**头节点**后遍历；遇到 `ForwardingNode`（hash = MOVED）说明正在扩容，当前线程去 `helpTransfer` 帮忙搬迁。
- get：全程无锁，靠 Node 的 `val` / `next` 是 volatile 保证可见性。
- size：`baseCount` 无竞争时 CAS 累加，竞争时落到 `CounterCell[]`（思想同 LongAdder），`sumCount()` 求和，**结果是弱一致的近似值**。
- 约束：key/value 都**不允许 null**；迭代器弱一致，不抛 ConcurrentModificationException。

## 为什么这么设计

**容量必须是 2 的幂**：`(n-1) & hash` 比取模快，且 n 为 2 的幂时等价于取模；扩容时才能用一位掩码判断高低位，省掉全量 rehash。代价是 hash 只有低位参与索引，所以必须有扰动函数把高位异或下来，否则连续整数 key 会全部撞在同一个桶。

**0.75 与 8/6 阈值**：0.75 是空间与冲突概率的折中（泊松分布下，负载 0.75 时单桶 8 个节点的概率约千万分之一）。树节点占两倍空间，所以树化阈值取在「链表已经明显劣化」的 8，退化为 6 是为了防止阈值附近抖动。

**CHM 为什么扔掉分段锁**：Segment 把并发度写死成 16，16 个线程以上就退化成争抢同一把锁，且每个 Segment 都是一把 ReentrantLock + 独立计数，内存开销大。改成锁单个桶后并发度≈桶数量，空桶用 CAS 连锁都不加。代价是复合操作不再原子——`get` 再 `put` 依然可能被插队。

## 不用会怎么样

- 用 `Hashtable` 或 `Collections.synchronizedMap`：整表一把锁，QPS 随核数不增反降；读多写少的缓存场景吞吐被锁死。
- 用 `HashMap` 做并发写：JDK 8 虽不再成环，但会**丢节点**（两个线程同时尾插覆盖 next）和 `size` 计数错乱；JDK 7 头插 + 并发扩容会形成环形链表，`get` 死循环把 CPU 打到 100%。
- 用 CHM 但仍写 `if (!map.containsKey(k)) map.put(k, v)`：check-then-act 非原子，限流/计数场景直接超卖。
- 不预设初始容量：对账文件百万级解析时反复扩容，一次 2 倍拷贝，GC 抖动明显。

## 替代方案

| 方案 | 适用 | 说明 / 风险 |
|---|---|---|
| HashMap + 外部锁 | 写极少、读也少 | 简单；锁粒度看人，容易把整张表锁死 |
| Hashtable / synchronizedMap | 遗留代码 | 全表锁，JDK 文档已建议换成 CHM |
| ConcurrentHashMap | 读多写少、并发缓存 | 主流；复合操作要换 `computeIfAbsent` / `merge` |
| Caffeine / Guava Cache | 本地缓存需要淘汰 | 有 LRU/LFU 与过期，比裸 Map 好用；引入第三方包 |
| LongAdder / 分桶计数 | 纯计数场景 | 比 CHM 争抢更低，`sum()` 同样是弱一致 |

## 项目中如何使用

- **某银行渠道路由表**：路由规则（渠道 → 限额、开关、优先级）放在 `volatile Map` 里整体替换，业务线程只读不写。配置推送时构造新 Map 再换引用，避免运行期加锁；一开始用过 `HashMap` + 定时任务原地 put，扩容窗口里业务读到 `null` 导致一笔交易按默认限额放行，改成「不可变副本 + volatile 替换」后再没出过。
- **限额与流量计数**：单渠道 TPS 计数用 `LongAdder`，`sum()` 只用于监控展示，不用于准入判断；准入判断走 Redis 原子计数，本地计数只做兜底。
- **对账文件解析**：解析前按 `expectedSize / 0.75 + 1` 指定初始容量，十万级文件少十几次扩容。
- **某跨境电商加解密 SDK 2.0**：密钥按 `keyId` 缓存在 `ConcurrentHashMap`，轮换时 `computeIfAbsent` 懒加载新密钥、旧密钥保留一个宽限期给存量报文解密，避免轮换瞬间解密失败。

## 常见陷阱

- 说「JDK 8 树化阈值是 8」但漏掉「容量 ≥ 64」，面试官立刻追问 `treeifyBin` 里那个 `MIN_TREEIFY_CAPACITY` 判断。
- 认为 CHM 的 `size()` 精确：并发写入时它只是估计值，做限额判断会算错。
- 用可变对象（如被修改过的 POJO）当 key，`hashCode` 变了就再也 `get` 不到。
- 面试官必问「CHM 1.7 和 1.8 的区别」：分段锁 vs 桶级锁、ReentrantLock vs synchronized+CAS、`Segment` vs `Node` 数组、size 计算方式四处都要说到。

## 三层追问

1. **为什么扩容要 2 倍而不是 1.5 倍？**——2 倍时旧下标要么不动、要么加 oldCap，用一位掩码就能判断；1.5 倍会破坏「容量是 2 的幂」，`(n-1) & hash` 就失效了，必须重新取模。
2. **CHM 扩容时其他线程在干什么？**——不阻塞等待，发现 ForwardingNode 就去帮忙搬迁（每个线程认领一段桶区间），搬完把旧表头指向 ForwardingNode，读线程遇到它能转向新表。
3. **既然有 CHM，为什么还需要分布式锁？**——CHM 只在单 JVM 内有效，多实例部署时各自的内存互不可见；跨进程互斥必须落到 Redis/ZK。

## 我的口述记录

（首次复述后填写）
