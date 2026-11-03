---
id: B2-01
title: "MVCC 与事务隔离级别"
kind: card
nodes: [B2]
primary: B2
direction: "MySQL"
event: "面试高频"
project: "账户余额与流水一致性"
level: core
status: draft
created: 2026-11-03
updated: 2026-11-03
---

## 30 秒简述

MVCC 靠三样东西实现：**隐藏字段（trx_id、roll_pointer）、undo log 版本链、ReadView（m_ids、min_trx_id、max_trx_id、creator_trx_id）**。快照读（普通 select）按 ReadView 可见性规则沿版本链找可见版本，实现读不加锁；当前读（`select ... for update`、update、delete）读最新版本并加锁。RC 每条语句生成新 ReadView，RR 在事务第一次快照读时生成并复用，因此 RR 可重复读且有间隙锁防幻读。

## 是什么

- 可见性判断：trx_id < min_trx_id 可见；≥ max_trx_id 不可见；介于之间看是否在 m_ids（活跃事务列表）中，在则不可见。
- RC：每次 select 都新建 ReadView → 读到别人已提交的修改（不可重复读）。
- RR：事务内首次快照读创建 ReadView → 后续复用 → 可重复读。
- 幻读：快照读靠 MVCC 避免；当前读靠 Next-Key Lock（记录锁 + 间隙锁）避免。

## 为什么这么设计

用版本链换"读不加锁"，让读不阻塞写、写不阻塞读，极大提升并发；代价是 undo log 膨胀（长事务会拖住 purge）、以及需要额外的可见性判断开销。这也是为什么"长事务是 MySQL 性能杀手"。

## 不用会怎么样

没有 MVCC，只能靠读写锁：读要加共享锁、写要加排他锁，支付系统里"查余额"和"扣余额"会互相阻塞，并发度骤降。

## 替代方案

| 隔离级别 | 解决问题 | 代价 |
|---|---|---|
| 读未提交 | 无 | 脏读 |
| 读已提交（RC） | 脏读 | 不可重复读、幻读 |
| 可重复读（RR，默认） | 脏读、不可重复读 | 间隙锁带来死锁概率 |
| 串行化 | 全部 | 并发极差 |

## 项目中如何使用

- 账户扣减用"当前读 + 版本号/乐观锁"：`update account set balance = balance - #{amt}, version = version + 1 where id = ? and version = #{v}`，靠影响行数判断成败。
- 对账与统计类查询固定走快照读，避免同一对账批次内读到不一致的中间状态。
- 长事务是重点治理对象：批量任务拆小事务提交，避免 undo 堆积与大范围间隙锁。

## 常见陷阱

- 把 MVCC 说成"多版本并发控制就是乐观锁"——MVCC 是无锁读机制，不是锁。
- 讲不清 ReadView 的四个字段与判断顺序。

## 三层追问

1. RR 下幻读被完全解决了吗？——快照读不会幻读，当前读靠 Next-Key Lock；但同一事务先快照读再当前读仍可能出现"读到新插入行"的现象，属于实现语义的边界。
2. 为什么 RR 用同一 ReadView？——保证同一事务多次读结果一致，这是"可重复读"的定义要求。
3. 长事务有什么危害？——undo 无法 purge、回滚段膨胀、锁持有时间长、主从延迟。

## 我的口述记录

（首次复述后填写）
