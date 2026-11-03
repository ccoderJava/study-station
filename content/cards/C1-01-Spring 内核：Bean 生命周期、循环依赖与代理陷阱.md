---
id: C1-01
title: "Spring 内核：Bean 生命周期、循环依赖与代理陷阱"
kind: card
nodes: [C1, C2, C3]
primary: C1
direction: "Spring"
event: "面试高频"
project: "shopline 支付中台 SDK 2.0、招银云创 C9→C10 重构"
level: core
status: draft
created: 2026-11-03
updated: 2026-11-03
---

## 30 秒简述

Spring 内核就三件事：**Bean 怎么被造出来**（生命周期：实例化 → 属性填充 → 初始化前后置 → 初始化方法 → 使用 → 销毁）、**循环依赖怎么被容忍**（三级缓存，只对单例 + setter 注入有效）、**AOP 代理怎么织入**（BeanPostProcessor 在初始化后生成代理对象）。绝大多数「Spring 用的坑」都出在第二和第三件的交叉处：**你拿到的是代理对象，不是原始对象**，所以自调用、final 方法、private 方法上的注解全部失效。

## 是什么

1. **Bean 生命周期（单例，`refresh()` 为主线）**
   - 读 BeanDefinition（XML/注解/`@Bean`）→ 注册到 `beanDefinitionMap`
   - `getBean` → `doCreateBean`
   - **实例化**（推断构造器 → `newInstance`）
   - **属性填充**（`populateBean`，DI 在这里发生）
   - `Aware` 回调（BeanName、BeanFactory、ApplicationContext）
   - `BeanPostProcessor.postProcessBeforeInitialization`
   - `InitializingBean.afterPropertiesSet` / `init-method` / `@PostConstruct`
   - `BeanPostProcessor.postProcessAfterInitialization` ← **AOP 代理在这里生成**
   - 放入单例池，可被使用
   - 容器关闭：`@PreDestroy` / `DisposableBean.destroy` / `destroy-method`
2. **三级缓存解决循环依赖**
   - `singletonObjects`（一级，成品）
   - `earlySingletonObjects`（二级，半成品）
   - `singletonFactories`（三级，能提前暴露引用的工厂，内部就是 `getEarlyBeanReference`）
   - 流程：A 实例化后把「能产出 A 的工厂」放进三级缓存 → 填充属性时发现依赖 B → 造 B，B 依赖 A，从三级缓存拿到 A 的早期引用（必要时生成代理）→ B 完成后，A 继续填充。
   - **为什么需要三级而不是两级**：因为 AOP 代理必须在「提前暴露」这一刻决定要不要生成，否则 B 拿到的可能是原始 A，最终 A 是代理——两者不一致。三级缓存的工厂让「是否提前代理」延迟到真正被依赖时才判断。
3. **AOP 代理**
   - JDK 动态代理（接口）vs CGLIB（子类字节码增强，Spring Boot 2.x 后默认）。
   - 代理对象持有目标对象，方法调用进 `InvocationHandler`/`MethodInterceptor` 链（责任链，`@Order` 决定顺序）。
   - 事务、缓存、异步都是 AOP 的消费者。

## 为什么这么设计

- **三级缓存是为了性能和兼容的折中**：如果一开始就给所有 Bean 生成代理，那没有循环依赖的场景也白付出代理开销；如果用两级，提前暴露时无法区分「要不要代理」。
- **CGLIB 做默认是为了「无接口也能代理」**：业务代码经常没有接口，JDK 代理无法代理类。
- **生命周期分这么多步是为了可扩展**：每一步都有扩展点（`BeanPostProcessor`、`BeanFactoryPostProcessor`、`InitializingBean`），框架本身也靠这些扩展点实现功能（`@Autowired` 靠 `AutowiredAnnotationBeanPostProcessor`）。

## 不用会怎么样

- 不了解代理：在同一个类里 `this.methodB()` 调用带 `@Transactional` 的 `methodB`，事务完全失效——**因为 `this` 是原始对象，没走代理**。这是 C2 那张卡片的核心场景。
- 不了解生命周期：在 `@PostConstruct` 里用 `ApplicationContext` 去取自己，可能拿到未完成初始化的 Bean；或者把耗时操作放在 `@PostConstruct`，启动时间暴涨。
- 不了解循环依赖：以为三级缓存能解决一切，结果构造器注入形成的循环依赖直接启动失败（`BeanCurrentlyInCreationException`），因为实例化阶段就卡住了，还没有对象可以提前暴露。
- 不了解代理类型：CGLIB 代理下 `final` 方法无法增强，`private` 方法注解无效，`protected` 在同包下才有戏。

## 替代方案

| 问题 | Spring 的做法 | 替代/规避 |
|---|---|---|
| 循环依赖（setter） | 三级缓存 | 重构：抽出第三个 Bean；或用 `@Lazy` 延迟注入 |
| 循环依赖（构造器） | 不支持 | `@Lazy` 参数注入、`ObjectProvider`、`ApplicationContext.getBean` 延迟取 |
| 自调用失效 | 无法解决 | 注入自己（`@Lazy` 自注入）、`AopContext.currentProxy()`（需 `exposeProxy=true`）、拆到另一个 Bean |
| 需要拿到原始对象 | `AopUtils`/`AopProxyUtils` | 一般不要这么做，说明设计有问题 |
| 代理类型选择 | `proxyTargetClass` | 明确 `@EnableAspectJAutoProxy(proxyTargetClass = true)` |

## 项目中如何使用

- **shopline 支付中台加解密 SDK 2.0**：SDK 里用 `@PostConstruct` 初始化密钥缓存和证书链。踩过一次坑：初始化逻辑依赖另一个 Bean 的配置，但那个 Bean 所在的模块用了 `@Lazy`，导致 `@PostConstruct` 执行时配置还是空。后来改成 `ApplicationRunner` 里初始化（容器全就绪后），并在 SDK 内部加了「懒加载 + 双检锁」兜底。
- **招银云创 C9→C10 重构**：老代码大量 `this.xxx()` 调用带事务注解的方法，迁移到新框架后事务大面积失效，出现「部分更新成功」的脏数据。处理方式是**先加告警再改代码**：在事务外侧加「受影响行数校验」，扫出所有自调用场景，然后逐个改成注入代理或拆 Bean。**没有一次性改完**，因为业务逻辑太密，改快了风险更高。
- **AOP 顺序**：支付链路上有「日志、幂等、限流、事务」四个切面，`@Order` 必须明确：**限流在最外层（进不来就别记日志）、幂等其次、事务在业务方法内层、日志记录最外层耗时**。顺序错了会出现「被限流的请求也写了一条幂等记录」这种脏数据。
- **代理类型的坑**：给 `final` 类加 `@Transactional` 不生效且不报错，SDK 对外暴露的类曾经是 `final`，导致接入方事务失效，排查了一整天才发现。

## 常见陷阱

- **构造器注入 + 循环依赖**：启动直接失败，且报错信息指向不明确，很多人以为是配置问题。
- **`@Async` 自调用**：和事务一样失效，且**静默**——方法照常同步执行，只是没异步。
- **`@Transactional` 加在 private 方法**：代理拦截不到，事务不生效。
- **`@PostConstruct` 里做重活**：启动慢、启动期间探针失败被 K8s 杀掉（liveness 探针超时）。
- **`@ConditionalOnMissingBean` 用在自动配置的 `@Bean` 方法上位置错**：多个自动配置互相覆盖，最后生效的和你以为的不是同一个（C3 讲过）。
- **Bean 作用域混用**：单例 Bean 注入 prototype Bean，只会拿到一个实例——prototype 的语义被吃掉。
- **循环依赖 + AOP 同时存在**：B 拿到了早期引用但 A 后来被代理，两边引用不一致，可能出现「事务注解时灵时不灵」。

## 三层追问

1. **三级缓存能解决构造器循环依赖吗？**——不能。构造器注入在「实例化」阶段就要拿到依赖对象，此时对象还没创建，无法提前暴露。只能用 `@Lazy`（注入代理，真正调用时才 getBean）或重构。
2. **为什么 Spring Boot 2.6 之后默认禁止循环依赖？**——因为循环依赖基本都意味着设计有问题（职责不清），允许它会让问题被掩盖到运行时。`spring.main.allow-circular-references=true` 可以放开，但应该当作技术债处理。
3. **`AopContext.currentProxy()` 的原理？**——把当前代理对象放进 `ThreadLocal`，自调用时从 ThreadLocal 取出代理再调，从而经过拦截器。要求 `exposeProxy=true`，且有 ThreadLocal 开销与异步线程丢失问题。

## 我的口述记录

（首次复述后填写）
