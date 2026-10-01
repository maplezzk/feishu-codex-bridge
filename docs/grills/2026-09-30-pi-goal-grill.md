# Pi Goal 需求与边界检查

Status: completed
日期：2026-09-30；worktree：/Users/zzk/GitWorktree/pi-backend/feishu-codex-bridge；基线 a384e84。

用户先要求查找契合的 Goal 插件，随后明确“改吧”。采用已验证能在 Pi 0.99.1 加载和程序控制的 @narumitw/pi-goal 0.54.8，保留上游状态机，bridge 增加跨进程适配。本次按 Auto 完成代码、验证、审查、证据报告、commit/push 和现有 PR 更新；合并、部署和 DeepSeek 接入不在范围内。

已定边界：
- runGoal 是同一会话持续执行一个目标，agent_settled 只结束当前轮，canonical Goal 终态才结束整个运行。
- 用户“结束目标”清掉持久目标和续跑，允许当前轮完成；“终止”先清掉目标，再 abort 当前运行。来自旧 runId 的动作不能影响新运行。
- 普通恢复会话先暂停遗留 active Goal，避免普通消息触发未授权的后台续跑。用户重新发 /goal 时建立新 managed run，保留原生会话历史。
- Goal 生命周期使用插件的完成/阻塞/等待工具和默认 25 次自动响应、3 次重复无进展限制，绝不靠回答文本匹配判断完成。
- 不改用户全局配置，不读写认证；bridge 子进程显式加载随包扩展，采用私有 Goal 设置。插件清理旧全局目标状态的迁移逻辑在 bridge 副本中关闭。
- 首条对话前 session custom entries 不落盘；需要确认会话文件真实存在，保障开始即取消可恢复。
- 现有 full-only、引导、取消、模型选择、普通对话以及 Codex/Claude 行为保留。

证据：src/agent/types.ts AgentThread.runGoal/clearGoal；src/bot/handle-message.ts runGoal 的停止/结束控制；src/agent/pi-rpc/thread.ts 现有一轮收敛；插件 runtime.clearActiveGoal 不 abort，managed-run cancel 会 pause/abort；调研文档已记录真实 Pi 0.99.1 控制验证。

术语：Goal=持续目标；runId=bridge 一次 Goal 运行身份；turnId=运行中的一轮；goalId=插件目标身份；settled=Pi 当前轮及原生队列收敛。术语已有对应代码，不创建新的 CONTEXT 文件。

无需要用户补充的决定；没有难撤销的新架构决策，ADR not_required。许可证和固定版本 provenance 随 vendor 保存。
