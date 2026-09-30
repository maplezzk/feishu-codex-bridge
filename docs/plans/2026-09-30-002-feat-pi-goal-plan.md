# Pi Goal 插件接入执行计划

Mode: lightweight
Status: complete
Worktree: /Users/zzk/GitWorktree/pi-backend/feishu-codex-bridge
Branch: codex/pi-backend
Base: a384e84975c924b46cf5e8d3d18df8629070cab5
Grill: docs/grills/2026-09-30-pi-goal-grill.md
Goal: 复用 narumitw 0.54.8，让 bridge 的 Pi 后端可执行持续 Goal，并交付到现有 PR。

## Terms

- Goal：插件保存的单目标，goalId 指当前实例，状态存于原生 bridge-goal-state entry。
- Managed run：bridge 管理的一次 Goal，runId 防止旧控制影响新运行。
- Turn：Pi 一次 agent run，只有 agent_settled 才收敛；同一个 Goal 可包含多个 Turn。
- 结束目标：clear 持久目标，当前 Turn 收尾后不继续。终止：clear 后 abort。

## Requirements

| ID | 可观察验收 | 来源 |
|---|---|---|
| R-1 | 固定复用 narumitw 0.54.8，许可证和 provenance 随发布包保留，打包后扩展可加载 | 用户复用要求 |
| R-2 | /goal 启动并自动续跑，正确映射 active/complete/blocked/paused/预算状态及累计用量；一轮 settled 不提前结束 Goal | Goal 契约 |
| R-3 | 精确 runId 控制；结束目标保留当前轮；终止有界取消；之后普通消息可继续 | 既有按钮语义 |
| R-4 | 插件错误、失败、等待状态明确可见；消费者早退和进程退出不会遗留续跑 | 运行生命周期 |
| R-5 | Goal 持久化到真实原生会话文件；恢复遗留 active 目标先暂停，重新 /goal 保留历史并创建新 managed run | 调研边界 |
| R-6 | 全局 Pi 配置及认证不变；bridge 的 Goal 命令/工具/状态/事件使用独立名字，不操作用户已有 Goal；full-only 保留；普通对话和 Codex/Claude 回归通过 | 既有约束 |

## Simple Design

- expected_behavior: Pi 的多轮目标可被同一套 Goal 卡片控制。
- concepts: Goal 与单 Turn 是不同生命周期；vendor 负责目标，PiThread 负责 RPC 运行与事件。
- reuse_decisions: narumitw Goal 状态机→same_concept；现有 PiThread 队列/UI/工具映射→shared_mechanism；Codex 原生 Goal RPC→different_concept，不复制。
- prefactor: PiThread 分离目标级终止和轮级 settled，仅触达 Pi 模块。
- constraints: 转发协议有 requestId/runId；插件启动错误不得降级为普通 prompt；无需新增 npm 依赖。

## TASK-pi-goal-controls

Status: done
Depends on: none
Write scope: vendor/pi-goal/**; src/agent/pi-rpc/goal-assets.ts; tsup.config.ts; test/pi-goal-extension.test.ts
Shared effects: none
Requirements: R-1,R-3,R-4,R-5,R-6
Acceptance: 随包运行的扩展接受开始/状态/clear/cancel，原生状态和结构化回复可读，旧 runId 拒绝。
Boundary: 只改此范围；不改变上游自动续跑/完成/预算逻辑；不改全局用户配置；不运行构建测试或 Git。
Steps:
- [x] 1.1 vendor/pi-goal/upstream/index.ts · registerGoalRuntime：最小暴露 runtime/commands，修改记录写入 vendor/pi-goal/README.md；原目标逻辑保留。需求 R-1。
- [x] 1.2 vendor/pi-goal/bridge-extension.mjs · extension：专用命令和结构化通知，start/status/clear/cancel 精确 requestId/runId，状态包含 objective/tokens/time；恢复 active 先暂停、关闭全局旧状态迁移写入。需求 R-3,R-4,R-5,R-6。
- [x] 1.3 src/agent/pi-rpc/goal-assets.ts · piGoalExtensionPath：开发/发布两种路径可定位；tsup.config.ts · onSuccess：复制完整扩展及许可证。需求 R-1。
- [x] 1.4 test/pi-goal-extension.test.ts · 适配控制测试：校验协议拒绝、状态转发、恢复不续跑；verification deferred。需求 R-1,R-3,R-5。
Verification: 主 Agent npm run typecheck/build；定向 extension 测试和真实 RPC 控制。
Result: passed

## TASK-pi-goal-execution

Status: done
Depends on: none（按本 Plan 定义的转发契约实现；集成依赖 TASK-pi-goal-controls）
Write scope: src/agent/pi-rpc/thread.ts; src/agent/pi-rpc/goal-protocol.ts; test/pi-rpc-goal.test.ts; test/fixtures/pi-goal-server.mjs
Shared effects: none
Requirements: R-2,R-3,R-4
Acceptance: 多轮事件持续到 Goal 终态，clear 让当前轮结束，abort 有界停下；错误和旧控制明确拒绝。
Boundary: 不改 vendor、backend、普通事件 mapper；不运行构建测试或 Git；其他 Worker 同时工作。
Steps:
- [x] 2.1 src/agent/pi-rpc/goal-protocol.ts · protocol：以 /bridge-goal <base64url JSON> 发送带 requestId/action/runId 的控制；以 BRIDGE_PI_GOAL_V1: JSON notify 回复，request 关联明确；action=start/status/clear/cancel，消息 kind=reply/state/error。需求 R-2,R-3,R-4。
- [x] 2.2 src/agent/pi-rpc/thread.ts · runGoal：监听先于 start，保留一个 Goal 流、多轮 mapper，每轮 turn_started/done，累计 goal_update；等待不提前 complete；终态等当前轮 settled 后关闭。需求 R-2,R-4。
- [x] 2.3 src/agent/pi-rpc/thread.ts · clearGoal/abort/close：clear 不 abort，abort 先停止 Goal 后有界 abort；早退和退出清理；runId 与当前 turnId 检查。需求 R-3,R-4。
- [x] 2.4 test/pi-rpc-goal.test.ts 和 test/fixtures/pi-goal-server.mjs：续跑晚于 settled、完整末轮、提前终态、旧 runId、clear/abort、等待和失败覆盖；verification deferred。需求 R-2,R-3,R-4。
Verification: 主 Agent npx vitest run test/pi-rpc-goal.test.ts test/pi-rpc-runtime.test.ts。
Result: passed

## TASK-pi-goal-integration

Status: done
Depends on: TASK-pi-goal-controls,TASK-pi-goal-execution
Owner: main Agent
Write scope: src/agent/pi-rpc/backend.ts; src/agent/catalog.ts; README.md; test/pi-rpc-backend.test.ts; test/pi-rpc.live.test.ts; test/pi-rpc-goal.live.test.ts; docs/testing/**
Requirements: R-1..R-6
Steps:
- [x] 3.1 backend.ts · startThread/resumeThread：加载随包扩展、校验协议，确保原生 sessionFile 落盘；capabilities.goal/catalog/README 声明真实能力。需求 R-1,R-5,R-6。
- [x] 3.2 test/pi-rpc-backend.test.ts 与 test/pi-rpc.live.test.ts：更新能力和启动断言，普通对话回归。需求 R-6。
- [x] 3.3 test/pi-rpc-goal.live.test.ts：真实目标工具/文件动作、连续执行、结束/取消、恢复及错误检查；记录结果和卡片。需求 R-2,R-3,R-4,R-5。
- [x] 3.4 docs/testing/*：主 Agent typecheck/build/full tests，standard/review_only（主 Agent 修复），任务 E2E 发布并回读；commit/push 更新 PR 并核对 head/CI。需求 R-1..R-6。
Verification: npm run typecheck; npm run build; npm test; PI_GOAL_LIVE=1 npx vitest run test/pi-rpc-goal.live.test.ts。
Result: passed

## Integration Verification

插件控制测试、Pi 普通 runtime 测试及 backend 测试通过；类型检查/构建/完整回归通过。npm 发布包 dry-run 中有完整 Goal runtime 和 LICENSE。source fingerprint 记录最终 Pi 模块及 vendor SHA。

## E2E

E2E Required: yes
Evidence publication: required
Evidence directory: docs/assets/_local/pi-goal-e2e
Report title: 2026-09-30-002-feat-pi目标执行-E2E测试报告

### SCENARIO-goal-file-completion · 目标执行到文件可回读
- Covers: R-1,R-2,R-4,R-5,R-6
- Kind: main
- Entry: createBackend('pi-rpc').startThread → runGoal。
- Preconditions: 本机 Pi 0.99.1、现有模型配置、临时目录、full。
- Steps: 目标要求创建唯一 marker 文件、read 回读并 goal_complete；消费所有轮次到终态，构造真实 Goal 卡片；关闭恢复同一会话并读取 marker/history。
- Assertions: API：目标 active→complete，无提前终止；文件内容准确，工具结束；UI：实际 buildRunCard JSON 包含结果、目标控制；异步：所有轮次收敛；DB/生产飞书客户端：out_of_scope。
- Evidence: 事件类型/目标状态、文件回读、卡片 JSON、恢复和原生历史。
- Side effects & cleanup: 只写临时 marker；进程关闭、临时 cwd trash；测试会话留存审计。
- Result: passed

### SCENARIO-goal-controls · 活跃目标结束、取消及继续聊天
- Covers: R-3,R-4,R-5,R-6
- Kind: boundary
- Entry: 同一真实 Pi 后端 Goal 流及 clearGoal/abort。
- Preconditions: 独立临时目录，full。
- Steps: 长输出目标执行中 clearGoal，当前轮完成后停止；新目标执行中 abort；确认旧 ID 拒绝，普通消息可继续；关闭后恢复不自动续跑。
- Assertions: API：clear 不切当前轮、abort 收敛、旧 ID 不影响新轮；异步：无孤儿进程/续跑；UI：卡片终态正确；DB/生产飞书客户端：out_of_scope。
- Evidence: 控制前后事件、目标状态、下一轮回答、恢复状态。
- Side effects & cleanup: 所有测试进程关闭；临时 cwd trash。
- Result: passed

预算耗尽/阻塞/等待/重试交错和 malformed 协议由确定性控制测试覆盖；真实大上下文压缩、生产投递、merge/deploy not_requested。

## Delivery

Review: standard/review_only，三个层面完成，所有must-fix已修复/补验，原reviewer确认；见docs/testing/2026-09-30-pi-goal-review.md。
E2E publication/readback: passed；https://ciderglobal.feishu.cn/docx/EobldEN9NoJZVHxQKqhcpbt7n1b，2steps/2images顺序核验通过。
Commit/remote/PR head: 本次Finisher提交到codex/pi-backend并更新现有PR #10；最终head/CI回读见PR与任务交付。
External tickets: not_required
Merge/deploy: not_requested
