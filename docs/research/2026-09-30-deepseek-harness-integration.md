# DeepSeek Harness 接入调研（暂不实现）

调研日期：2026-09-30。用户决定：只记录方案，当前不接 DeepSeek Harness。

## 结论

可以增加后端适配，复用 bridge 编排和卡片。推荐先以 `dsh --profile acp` 接基础功能；完整逐字卡片体验需要额外 DSH 插件，不应把 SDK 的持久事件当实时字流。

## 本机验证

dsh 从 0.1.0-rc.7 更新到 npm latest 0.2.0-rc.2。sdk 和 acp 的帮助入口、初始化握手均成功；没有模型调用。SDK 返回 deepseek-harness-sdk-runtime；ACP 返回协议 1 和 close/list/resume 能力。本次 ACP 握手的 image 能力为 false，图片能力取决于实际配置和模型路由。

## ACP 与 SDK 取舍

ACP 提供 session/new、list、resume、close、prompt、cancel、set_config_option 和标准消息/思考/工具/上下文更新。一会话只允许一个 in-flight prompt；新消息需要桥排队。恢复会话不回放历史。原始模型 delta、DSH 专属卡片、交互扩展、命令和手动压缩没有经 ACP 暴露。

SDK 提供 initialize、session/prompt、shutdown，转发 session.event、session.status 和子 Agent 通知。messageId 只是入队凭据；应等待消息被 inbox 接收后对应的 whole-agent idle。没有 prompt cancel/session close、会话列表或明确恢复接口。停止需要关闭整个运行时；因此不适合作为基础接入中取消和重启恢复的唯一方案。

新版 session 持久事件的 assistant/message 内嵌已完成模型 stream；这不是生成中逐个 chunk 的推送。内部 agent/assistant-stream 才是实时 start/chunk/end 事件。SDK server 目前只订阅 session/event 和 agent/status 等事件。

## 后续做法

1. 增加 DeepSeekHarnessBackend，先用 ACP 做消息、工具、停止、模型切换和跨重启续聊。
2. 不支持的 goal/steer/compact/history UI 明确关闭；续聊恢复与历史展示分开验证。
3. 如需要实时输出和完整控制，增加一个 DSH 插件，转发 agent/assistant-stream，调用原生取消、恢复、压缩和存储服务。保留持久消息作为最终权威内容，防止重复显示。
4. 给长时间静默和自动重试制定后端适用规则，不能机械套用 Codex 无通知超时。
5. 首版只开放实际验证过的权限模式；工具沙箱配置不能自动视为项目级文件和网络隔离。

## 版本约束

项目仍是 developer preview，存在破坏性变更。npm dist-tag 不一致：dsh latest 为 0.2.0-rc.2，dsh-sdk-client latest 当时仍为 0.0.1-rc.1，但 0.2.0-rc.2 已发布。采用 SDK 时锁兼容版本，不盲装所有包的 latest。

## 来源与预计工作量

- https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/acp/acp/README.md
- https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/sdk/protocol/README.md
- https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/sdk/client/README.md
- 本机 dsh 0.2.0-rc.2 的 ACP、SDK server 和 Agent 类型声明。

工程估计：ACP 基础适配 2–3 个工作日；补实时流、历史和控制插件额外 3–5 个工作日，不包含生产部署。本次没有新增 DSH 运行代码、依赖或注册项。
