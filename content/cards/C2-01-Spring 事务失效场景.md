---
id: C2-01
title: "Spring 事务失效场景"
kind: card
nodes: [C2, C1]
primary: C2
direction: "Spring"
event: "项目实践"
project: "账户与流水同事务写入"
level: core
status: draft
created: 2026-11-03
updated: 2026-11-03
---

## 30 秒简述

结论：Spring 声明式事务是 AOP 代理实现的，**只有经过代理的外部调用才会真正开事务**，这是它无侵入的代价。失效场景要能一口气列：方法非 public、同类自调用、异常被 catch 吞掉、受检异常没配 rollbackFor、类没被 Spring 管理、数据库引擎不支持事务、传播行为配成 NOT_SUPPORTED、以及事务不跨线程。**默认只回滚 RuntimeException 和 Error**，受检异常必须显式配。线上最典型的是扣款成功、流水没写，账实不符只能靠对账修。工程规范就三条：**事务方法 public 且由外部调用**、**资金类统一 rollbackFor**、catch 后补 setRollbackOnly 或干脆别吞异常。

## 是什么

- 代理方式：JDK 动态代理（接口）或 CGLIB（子类），自调用 `this.method()` 绕开代理 → 无事务。
- 回滚规则：默认只对 RuntimeException 和 Error 回滚，受检异常需 `@Transactional(rollbackFor = Exception.class)`。
- 传播行为：REQUIRED（默认，加入或新建）、REQUIRES_NEW（挂起外层，独立事务，适合记日志）、NESTED（保存点）。
- 只读事务：`readOnly=true` 只是提示，不影响回滚。

## 为什么这么设计

用代理实现事务是"无侵入"的代价——业务代码干净，但对调用方式有隐式要求。这也是为什么团队规范里要写"事务方法必须 public、不得自调用"。

## 不用会怎么样

最典型的线上事故：扣款成功但流水没写、或状态更新成功但明细回滚——账实不符，只能靠对账修复。如果异常被 catch 又没手动 `setRollbackOnly()`，事务会正常提交，问题更隐蔽。

## 替代方案

| 方案 | 适用 | 说明 |
|---|---|---|
| @Transactional | CRUD、短事务 | 简单，注意失效场景 |
| TransactionTemplate | 需精确控制边界 | 编程式，可嵌在复杂逻辑里 |
| 手动 setRollbackOnly | catch 后仍需回滚 | 补 @Transactional 的坑 |
| 分布式事务（TCC/Saga） | 跨服务 | 见《05/03》 |

## 项目中如何使用

- 账户更新 + 流水写入 + 单据状态变更放在同一个事务方法，且方法必须是 public、由外部服务调用，禁止同类自调用。
- 批量结算按批提交（每批 200~500 笔一个事务），既控制锁持有时间，也避免大事务导致 undo 膨胀。
- 资金类统一 `rollbackFor = Exception.class`，并在切面里捕获异常打点，防止"静默提交"。

## 常见陷阱

- 只答"异常被吞了"，列不出其他 5 种。
- 不知道受检异常默认不回滚。

## 三层追问

1. 自调用怎么解决？——注入自身代理（AopContext.currentProxy()）、拆到另一个 Bean、或用 TransactionTemplate。
2. REQUIRES_NEW 什么场景用？——审计日志/失败记录必须落库，不随主事务回滚。
3. 事务里调用远程接口有什么问题？——长事务 + 网络不可控，应把远程调用移出事务，改为"本地事务 + 消息/补偿"。

## 我的口述记录

（首次复述后填写）
