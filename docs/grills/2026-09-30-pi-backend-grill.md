# pi 后端需求检查

状态：completed；模式：persistent。基线：585bb6e。用户要求：两个调研落文档后走 Auto 开发 pi，DeepSeek 暂不接。

## 已定边界与依据

- 本次实现 pi-rpc，DeepSeek 只文档。来源：本次用户明确要求。
- 首版采用先前调研推荐的 full-only，支持现有基本会话功能，goal 不实现。当前 AgentBackend 已提供 capabilities 和 supportedModes，能明确拒绝未支持功能。无新增生产写入或部署授权。
- 独立 RPC 进程负责执行；桥只转换协议、保存绑定和显示卡片。保持默认 Codex 路由和现有 Claude 行为。PI_BIN/PATH/私装支持；不扩大全局默认后端选择。
- 以 agent_settled 为收尾；handled 不等待不存在的运行；失败、重试与扩展交互不能被吞掉。
- 同一 session 的桥进程是唯一当前写入者；不承诺 TUI 与桥并发编辑同一 session。
- 调研文档不写凭据；pi 自己使用已有配置。未知项目不自动信任；读取 AGENTS 与 skills 以原生行为为准。

## 术语与决策结果

backend 是执行适配器；sessionId 是 pi 原生 UUID；run ID 是 bridge 当前操作 ID，不能当 pi 模型内部 turn；settled 是全会话不再自动继续，不等于一次 assistant reply 完成。

这些术语已落在 pi 调研和 Plan 的 Terms，无新领域概念需要单独 CONTEXT。采用既有后端扩展点、明确本次范围，选择可随实现验证调整；不同时满足难逆转和缺上下文难理解，故不新增 ADR。

已定：上述范围。未定：无。Deferred：DSH、真实 OS 沙箱、goal、多客户端同时控制。Blocker：无。验证要求：定向/全量测试、类型检查、构建、真实 pi 本地 E2E、发布并回读证据报告。PR 交付；合并、运行服务升级及生产飞书投递不在本次范围。
