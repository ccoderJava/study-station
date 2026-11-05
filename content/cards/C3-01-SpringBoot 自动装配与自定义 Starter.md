---
id: C3-01
title: "SpringBoot 自动装配与自定义 Starter"
kind: card
nodes: [C3, C1]
primary: C3
direction: "Spring"
event: "项目实践"
project: "某银行多渠道接入层 / 某跨境电商加解密 SDK 2.0"
level: core
status: draft
created: 2026-11-03
updated: 2026-11-03
---

## 30 秒简述

结论：自动装配的本质是「**条件的集合加约定的路径**」，核心价值是**把装配决策从代码搬到条件表达式**。`@EnableAutoConfiguration` 通过 `AutoConfigurationImportSelector` 读类路径下的 AutoConfiguration.imports（Boot 2.7 之前是 spring.factories），拿到一批配置类，再用 `@ConditionalOnClass`、`@ConditionalOnMissingBean`、`@ConditionalOnProperty` **逐个判断该不该生效**，最后用 `@ConfigurationProperties` 绑定外部配置。自定义 Starter 就是把这套机制封成「引依赖加写配置就能用」的能力包，业务方零代码接入。代价是**装配过程隐式**，出问题得靠启动参数 --debug 看条件评估报告，或 actuator 的 conditions 端点反查；同一份依赖在不同环境或不同渠道下能装配出不同实现，这也是它的价值所在。

## 是什么

- 入口三件套：`@SpringBootApplication` = `@SpringBootConfiguration` + `@EnableAutoConfiguration` + `@ComponentScan`。自动装配只认 `@EnableAutoConfiguration`。
- 装配清单：Boot 3.x 在 `META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports`，一行一个配置类全限定名；老版本在 `spring.factories` 的 `EnableAutoConfiguration` 键下。
- 条件注解四件套：
  - `@ConditionalOnClass` —— 类路径存在某个类才生效（判断依赖是否引入）。
  - `@ConditionalOnMissingBean` —— 容器里没有这个 Bean 才注册，给业务方留覆盖口子。
  - `@ConditionalOnProperty` —— 配置开关，做灰度与多实现切换。
  - `@ConditionalOnBean` —— 依赖别的 Bean 先就绪，顺序敏感。
- 顺序控制：`@AutoConfigureBefore/After` 声明相对顺序；同一配置类内部 `@Bean` 方法**不保证顺序**。
- 配置绑定：`@ConfigurationProperties(prefix="x")` + `@EnableConfigurationProperties`，配合 `spring-boot-configuration-processor` 生成 IDE 元数据。
- 自定义 Starter 的正确形态：`xxx-spring-boot-autoconfigure`（装配逻辑）+ `xxx-spring-boot-starter`（只做依赖聚合），`spring-configuration-metadata.json` 提供配置提示。

## 为什么这么设计

核心是**把「装配决策」从代码搬到条件表达式**。传统 XML/JavaConfig 里「用哪个实现」是写死的，而 Starter 里是「类路径有什么、配置开了什么，就装配什么」，于是同一份依赖能在不同环境/不同渠道下装配出不同实现。

代价有三：一是隐式，启动时发生了什么不看 condition report 根本不知道；二是冲突排查成本高，两个 Starter 抢同一个 Bean 时只会报 `BeanDefinitionOverrideException` 或悄悄覆盖；三是版本耦合，Starter 内部依赖升级可能改变条件判断结果，属于「改依赖就改行为」。

## 不用会怎么样

- 每个接入方抄一遍配置类：某银行对接 10 家银行，10 份几乎相同的 HTTP 客户端、签名器、报文转换器配置，改一处要改 10 个工程。
- 配置项散落：密钥、超时、地址写在各自的 `application.yml`，命名不规范，运维排查时找不到。
- 依赖版本漂移：A 工程用 okhttp 3，B 工程用 4，同一个渠道 SDK 行为不一致，故障无法复现。
- 灰度能力缺失：新老实现切换只能改代码发版，不能靠配置开关回滚。

## 替代方案

| 方案 | 适用 | 说明 |
|---|---|---|
| 自定义 Starter（自动装配） | 多工程复用的基础能力 | 引依赖即用，但要维护条件矩阵 |
| `@Import` 手动导入配置类 | 单工程内模块化 | 显式、可控，跨工程要各自写一行 |
| SPI（`ServiceLoader` / Dubbo SPI） | 运行时按需加载实现 | 适合多实现路由，配置能力弱，不支持条件装配 |
| 只发 SDK，业务方自己 `new` | 极简工具类 | 无容器集成，拿不到 Spring 的生命周期与配置绑定 |
| Spring Cloud Starter 体系 | 已有生态组件 | 遵循同样的装配协议，注意版本对齐 |

## 项目中如何使用

- **某跨境电商加解密 SDK 2.0（数据合规改造）**：把加解密能力抽成 `crypto-spring-boot-starter`。用 `@ConditionalOnProperty(prefix="crypto", name="version", havingValue="2")` 控制新老算法并存，灰度期间双写双读；密钥由 `CryptoProperties` 从配置中心绑定，`@ConditionalOnMissingBean` 允许业务方注入自定义实现（测试环境用 Mock 加解密器）；`@ConditionalOnClass` 保证老工程没引 BouncyCastle 时不装配国密实现，不会启动失败。
- **某银行多渠道接入层（C9→C10 重构）**：把「渠道适配」做成内部 Starter，每个银行渠道一个配置类，靠 `@ConditionalOnProperty(channel.xxx.enabled)` 决定装配哪些渠道；重构时用流量回放验证，回放环境只打开被测渠道的开关，避免真实报文打到生产银行。
- 经验：Starter 里**绝不放 `@ComponentScan`**。早期版本扫了 `com.bank.*`，结果把业务工程的同名包一起扫进来，出现了两个 `BankClient` Bean，排查了半天。

## 常见陷阱

- 把 Starter 当「工具包」：写一堆 `@Component` 让业务方去 `scan`，失去自动装配的意义。
- `@ConditionalOnMissingBean` 写在和 `@Bean` 同一个配置类里，以为能挡住自己——实际判断时机在方法注册前，容易误判；需要拆分配置类。
- Spring Boot 3 迁移时还在改 `spring.factories`，装配直接不生效（Boot 3 只认 `AutoConfiguration.imports`）。
- 面试官紧接着会问：「自动装配的失效怎么排查」——答 `--debug` 看 `ConditionEvaluationReport`（CONDITIONS EVALUATION REPORT），或 `/actuator/conditions` 端点，要能说出「Positive matches / Negative matches 分别看什么」。

## 三层追问

1. 自动装配和 `@ComponentScan` 有什么区别？——扫描是「按包路径找 Bean」，自动装配是「按条件从类路径清单里挑配置类」，前者依赖包结构，后者依赖依赖存在与否。
2. 两个 Starter 都注册了同名 Bean 怎么办？——默认后加载的覆盖（Boot 2.1+ 默认禁止覆盖，需 `spring.main.allow-bean-definition-overriding=true`），正确做法是各自加 `@ConditionalOnMissingBean` 或用 `@AutoConfigureOrder` 明确优先级。
3. 怎么保证 Starter 的条件判断在业务自定义 Bean 之后？——用户配置类先于自动配置类注册，这是 Boot 的固定顺序；所以 `@ConditionalOnMissingBean` 在自动配置里总能看见用户的定义。

## 我的口述记录

（首次复述后填写）
