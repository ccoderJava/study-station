---
id: C4-01
title: "MyBatis 插件与 SQL 拦截"
kind: card
nodes: [C4, B1, C1]
primary: C4
direction: "Spring"
event: "项目实践"
project: "shopline 数据合规改造 / 招银云创资金安全加固"
level: core
status: draft
created: 2026-11-03
updated: 2026-11-03
---

## 30 秒简述

MyBatis 插件是**基于 JDK 动态代理的责任链**：`InterceptorChain.pluginAll()` 用 `Plugin.wrap()` 把四大核心对象（`Executor` / `StatementHandler` / `ParameterHandler` / `ResultSetHandler`）逐层包成代理，每个 `Interceptor` 用 `@Intercepts` + `@Signature` 声明要拦哪个对象的哪个方法。它让「加解密、脱敏、租户隔离、分页、慢 SQL 采集」这类横切逻辑不用改一行业务 SQL。代价是**SQL 语义被隐式改写**：count 语句、分页方言、参数类型都得自己兜住，出问题只能翻代理链。

## 是什么

- 四大拦截点，按执行顺序：
  1. `Executor`（`update` / `query` / `flushStatements`）—— 最外层，能拿到 `MappedStatement` 和参数，适合分页、租户条件、SQL 改写。
  2. `StatementHandler`（`prepare` / `parameterize` / `batch`）—— 拿得到最终 SQL 和 `BoundSql`，适合改写 SQL、设置超时、计时。
  3. `ParameterHandler`（`setParameters`）—— 参数写入 `PreparedStatement` 前，适合参数加密。
  4. `ResultSetHandler`（`handleResultSets`）—— 结果集映射后，适合字段脱敏。
- 注册方式：`@Intercepts(@Signature(type = Executor.class, method = "query", args = {MappedStatement.class, Object.class, RowBounds.class, ResultHandler.class}))`，`args` 必须与目标方法签名**完全一致**，差一个类型就不生效。
- 代理链：`Configuration` 里维护 `InterceptorChain`，`pluginAll` 遍历所有插件依次 `wrap`，所以**后注册的在外层、先执行**。分页插件通常要求配置在最后，就是为了让它处于最外层、改写后的 SQL 能被后续插件看到。
- 改写 SQL 的手段：反射替换 `BoundSql.sql`，或替换 `MappedStatement`（分页 count 的常用做法：复制一个 `MappedStatement`，id 加 `_COUNT` 后缀）。

## 为什么这么设计

MyBatis 把「SQL 执行」拆成四段可替换的组件，插件就是给每段留的钩子。好处是横切能力与业务 SQL 彻底解耦：加解密、脱敏、租户过滤统一在一处，业务方无感知，也不会漏。

代价集中在三点：**一是隐式**，你看到的 SQL 和数据库实际执行的可能不是一条；**二是顺序敏感**，插件顺序变了行为就变（分页和租户条件谁先加，结果不同）；**三是性能**，每个语句都要过代理链和反射，量大时开销不可忽略。所以规范是：能在 `TypeHandler` 层解决的（字段级加解密），不要放到插件层。

## 不用会怎么样

- **合规事故**：shopline 改造前，卡号、证件号明文落库，DBA 一条 `select *` 就能导出全量敏感信息；改造要覆盖 200+ 张表、上千个字段，靠人肉改 SQL 必然漏。
- **脱敏遗漏**：导出、日志、下游接口各写一套脱敏逻辑，新加一个字段就漏一处，等安全扫描发现已经上线。
- **租户越权**：多租户系统靠每个 mapper 手写 `and tenant_id = ?`，漏写一条就是跨租户数据泄露。
- **慢 SQL 失控**：没有统一采集，线上慢查询只能等 DBA 告警，定位不到具体 mapper 方法。

## 替代方案

| 方案 | 适用 | 说明 |
|---|---|---|
| `TypeHandler`（字段级） | 单字段加解密、枚举转换 | 最精准，无 SQL 改写风险；缺点是查询条件也要用同一 Handler，且无法做模糊查询 |
| MyBatis 插件（拦截器） | 跨表横切：脱敏、租户、分页、采集 | 统一但隐式，改 SQL 要自己保证语义正确 |
| MyBatis-Plus 内置插件 | 新项目、标准 CRUD | 多租户/分页开箱可用，深度定制仍要写 `InnerInterceptor` |
| AOP 切 Service 层 | 结果集脱敏、审计 | 拿不到 SQL，只适合对象级处理 |
| 数据库层（视图 / 行级权限 / TDE） | 强合规、DBA 主导 | 应用无感，但灵活性和可移植性差 |

## 项目中如何使用

- **shopline 数据合规改造（加解密 SDK 2.0）**：主路径用 `TypeHandler`——`@TableField(typeHandler = CryptoTypeHandler.class)` 让敏感字段写库加密、读库解密，业务代码不改；插件只做 TypeHandler 覆盖不到的两件事：一是查询条件的等值匹配（`where card_no = ?` 要在 `ParameterHandler` 里先加密再绑定，否则查不到），二是批量插入时的参数预处理。灰度方案是新老算法双写、读取按版本号解密，用配置开关控制。
- **招银云创资金安全加固**：`ResultSetHandler` 拦截做导出与日志的字段脱敏（户名、账号、证件号保留前 3 后 4），保证「页面能看到、导出看不到全量」；`StatementHandler.prepare` 计时，超过 500ms 的语句带 `MappedStatement.id` 上报监控，定位到具体 mapper 方法而不是只报一条慢日志。
- **踩过的坑**：早期把脱敏写在 `Executor.query` 里，返回的是 `List<Map>` 的导出场景拿不到实体注解，改成 `ResultSetHandler` 后统一；另外插件里再执行 SQL 会再次进入代理链导致递归，必须用 `@ConditionalOnProperty` 关闭自身或用独立 `SqlSession` 规避。

## 常见陷阱

- `@Signature` 的 `args` 写成父类或接口类型，插件静默不生效——这是最常见的「装了没用」。
- 改 SQL 只改 `BoundSql` 不处理 count，分页总数永远等于当页条数。
- 在 `Executor.query` 里重新 `new` 一个查询做数据补全，触发递归调用直到栈溢出。
- 面试官会接着问：「插件和 TypeHandler 怎么选」——按「是否跨表/跨字段」分：单字段语义用 TypeHandler，表级或语句级横切用插件；再问「插件顺序为什么重要」——后注册在外层，分页必须在最外层才能改写最终 SQL。

## 三层追问

1. `Plugin.wrap` 为什么能拦截接口方法？——JDK 动态代理只对接口生效，四大对象都是接口；`Plugin` 的 `InvocationHandler` 在 `invoke` 里比对 `@Signature`，命中就调 `intercept`，否则放行。
2. 多个插件同时改同一条 SQL，谁生效？——按代理链由外到内依次改写，每层拿到的是上一层改写后的 `BoundSql`，所以顺序决定结果。
3. 插件能不能拿到 mapper 方法名和注解？——能，`MappedStatement.getId()` 是全限定方法名，需要自定义注解时通过 `ms.getId()` 反射取方法再读注解。

## 我的口述记录

（首次复述后填写）
