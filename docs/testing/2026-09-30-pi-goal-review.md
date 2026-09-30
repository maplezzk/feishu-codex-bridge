# Pi Goal 审查与修复记录

日期：2026-09-30。基线：a384e84。Plan：docs/plans/2026-09-30-002-feat-pi-goal-plan.md。

执行 code-reviewer standard / review_only，入口为 Codex 原生协作。需求、架构和 standards 三层各一轮，Reviewer 只读，主 Agent 处理发现并验证。架构层使用 Plan 中的 simple_design_review：Goal 和 Turn 分开，上游负责目标状态机，wrapper 负责命令与通知，PiThread 消费多轮。未运行 Pi workflow 脚本，也没有宣称 reviewer 执行测试。

## 发现与处理

| ID | 来源 / 严重度 / confidence | 问题 | 处理与验证 |
|---|---|---|---|
| GOAL-ARCH-001 | architecture-review / P1 / 98 | 旧 owned paused 目标无法被下一次 Goal 清理 | 无 runId 只拒绝 active 或 currentRun，允许终止后的遗留目标；cancel→旧目标clear→新start行为测试 |
| GOAL-ARCH-002 | architecture-review / P2 / 98 | 同 active 状态的累计用量和 waiting 更新被过滤 | 持久快照携带完整Goal，managed事件保留快照且同status也转发；真实两轮累计用量/等待通过 |
| GOAL-STD-002 | coding-taste / P1 / 98 | clear reply先到时漏掉最终状态 | 消费clear reply，cleared映射paused；waiting-late-clear回归 |
| GOAL-STD-003 | coding-taste / P1 / 98 | status尚未完成时发送不存在owned run的clear | 未发送start时只本地取消，迟到status不再启动；clear/abort参数化测试锁定wire只有status |
| GOAL-STD-004 | coding-taste / P2 / 97 | summary/reason没有运行时校验 | 校验字符串、非负有限用量、正安全整数预算与runId；malformed协议测试 |
| GOAL-STD-005 | coding-taste / P2 / 95 | wire顺序、身份、恢复和摘要测试不足 | 10项独立协议测试、clear/cancel分开、clear→abort、terminal摘要；原生active夹具真实恢复两次 |
| GOAL-REQ-001 | requirements-review / P1 / 98 | 两轮间隔接受旧turnId | settled后旧steer/abort拒绝，首次start前仍可用runId取消；turn-gap确认第二轮继续 |
| GOAL-REQ-002 | requirements-review / P1 / 97 | managed错误/timeout留下listener和状态 | 统一failRun取消pending、清理owned状态/listener/waiters/runs，stale cancel不新建phantomrun；失败/timeout之后listener=0且新Goal可启动 |

所有确认问题的 owner=main-agent，pre_existing=false，原 disposition=must_fix，现 resolved；autofix_class 为局部代码与行为测试。规则绝对路径：`/Users/zzk/.ai-global/skills/my/code-reviewer/references/requirements-review.md`、同目录 `architecture-review.md`、`/Users/zzk/.ai-global/rules/coding-taste.md`。架构 reviewer 初次返回缺少处置字段，由主 Agent按直接代码证据补齐，没有把缺字段当作零问题。

主 Agent额外修复：完成tool设置terminate=true，未必还有模型最终回复；将插件完成summary作为独立正文块保留。终态queued事件发生时activeGoal已clear，因此从persist时快照获取真实累计用量。初次live失败保留在ignored attempt-01，修复后完整重跑成功。

## 丢弃与保留项

- GOAL-STD-001（历史P1）：要求Thread.abort走插件cancel/pause。Plan明确“终止：clear后abort”，目的是后续普通消息不恢复旧目标；实现符合该契约。Reviewer复核后discarded，未改变产品语义。
- GOAL-STD-006（P2/advisory，confidence91）：结构化reply后仍等待transport ack；现有控制timeout有界。保留client接口，不为此增加取消单个请求能力。
- 上游TUI settings依赖pi-tui-kit；本次只支持RPC，不开放TUI设置菜单，vendor README明确边界。
- 初始active状态可能由notify和start reply重复出现；状态正确且无副作用，保留为advisory。

## 验证与未覆盖

主 Agent执行最终typecheck/build/diff check；完整1580passed、22skipped。34项Goal扩展/协议/执行定向测试通过。真实模型Goal两场景、原生active恢复夹具1项通过；普通Pi live两场景通过。两项requirements发现经原Reviewer只读确认fixed，standards复核F2–F5 resolved、F1discarded、F6advisory。没有未处理must-fix。

预算/阻塞状态映射、等待、错误、timeout和早退有确定性验证；没有真实模型预算耗尽、三轮阻塞或压缩重试交错。未验证生产飞书客户端渲染/投递、merge/deploy、DSH接入。本报告不替代任务E2E发布回读。

报告发布时确定性回归为1577passed；随后追加3项budget/usage/blocked终态回归，完整回归增至1580passed、22skipped，产品源代码未改变。
