# pi 后端执行计划

Mode: lightweight
Goal: pi 作为可选择的 bridge 后端，交付两份调研、可用会话链路和 PR。
Worktree: /Users/zzk/GitWorktree/pi-backend/feishu-codex-bridge
Branch: codex/pi-backend
Base: 585bb6e
Grill: docs/grills/2026-09-30-pi-backend-grill.md（completed，无 blocker）

## Terms

| 术语 | 指什么与代码落点 |
|---|---|
| backend | AgentBackend 适配器；src/agent/pi-rpc/backend.ts |
| sessionId | pi 原生 UUID；持久 SessionRecord.sessionId |
| run ID | bridge 本轮随机 ID；PiThread.runStreamed/steer/abort |
| settled | agent_settled；重试、压缩、队列全部收敛 |
| full | PermissionMode.full，非沙箱；permission.ts 拒绝 qa/write |
| 历史 | pi 原生 JSONL 当前 parentId 分支的对话；history.ts |

## Requirements

| ID | 可观察要求 | 来源 |
|---|---|---|
| R-1 | pi 与 DSH 调研分别落盘，DSH 不注册、不实现 | 用户 |
| R-2 | 已安装 pi 可在 full 项目中选择；Codex 默认保持；qa/write 不提供 pi，直接启动亦拒绝 | 用户接入目标、既有权限契约 |
| R-3 | 文本/图片经过 pi 后转换为卡片文本/思考/工具/用量；终态只在 settled 或明确传输失败 | 接入方案 |
| R-4 | 当前轮支持 steer/abort，旧 run ID 和并发 run 拒绝；重试期间卡片不提前结束 | 接入方案 |
| R-5 | 会话按 cwd 正确列表、历史显示、关闭后恢复；缺失会话不伪造恢复 | 接入方案 |
| R-6 | 模型完整 provider/id、动态 effort、手动/自动压缩生效；未知模型/effort 可见失败 | 接入方案 |
| R-7 | 进程退出、协议错误、扩展问题可见且 pending 请求收敛，退出回收受管进程组 | 既有 bridge 稳定性契约 |
| R-8 | goal 不支持明确关闭；现有 Codex/Claude 全量回归通过；无 DSH 接入、合并和生产部署 | 用户与本次边界 |

## TASK-pi-execution

Status: completed
Requirements: R-2,R-3,R-4,R-5,R-6,R-7,R-8
Depends on: none
Write scope: src/agent/pi-rpc/client.ts; src/agent/pi-rpc/locate.ts; src/agent/pi-rpc/backend.ts; src/agent/pi-rpc/thread.ts; src/agent/pi-rpc/permission.ts; test/pi-rpc-runtime.test.ts; test/fixtures/pi-rpc-server.mjs
Shared effects: none
Acceptance: 独立 JSONL 子进程驱动会话，支持请求关联、恢复和正确收尾；异常不挂起。
Boundary: 不改其他任务文件，不安装依赖，不操作 Git，不编译测试；只支持 full；不实现 goal。
Verification: npm test -- test/pi-rpc-runtime.test.ts；协议/生命周期/权限断言全部通过。
Steps:
- [x] 1.1 client.ts · PiRpcClient：LF/UTF-8 framing、request(type,fields)、onRecord/onExit、isAlive/lastActivity、bounded close；Unicode 分隔符不切帧，死亡拒绝 pending。需求 R-7。
- [x] 1.2 locate.ts · resolvePiBin/probePi：PI_BIN/PATH/私装发现、异步版本检查；错误明确提示。需求 R-2。
- [x] 1.3 permission.ts · assertPiPermission：仅 full 可启动；undefined 按 DEFAULT_PERMISSION_MODE 拒绝，不能默许提升。需求 R-2。
- [x] 2.1 thread.ts · PiThread.runStreamed：订阅先于 prompt，opaque run ID，createPiEventMapper(runId) 转换，handled 收敛，最后统计用量；启动失败也进 error 流。需求 R-3,R-7。
- [x] 2.2 thread.ts · steer/abort/compact/close：校验当前 run ID，abort 有界升级回收、动态模型/effort校验、原生压缩，goal 明确抛不支持。扩展 select/confirm/input 映射 user_input_request，未支持的 UI 明确取消并报告。需求 R-4,R-6,R-8。
- [x] 3.1 backend.ts · PiRpcBackend：doctor/models/start/resume/list/history/title，使用 history.ts 的 listPiSessions/findPiSession/readPiHistory；恢复校验 UUID+cwd。启动后 get_state 回读正确 session 和模型；临时探测进程 close。需求 R-2,R-5,R-6。
- [x] 4.1 runtime.test/fixture · 协议夹具：早到 settled、handled、退出、未知模型/effort、abort/steer旧ID、compact、Unicode分片、权限失败。需求 R-2,R-4,R-6,R-7。
Result: 已实现；主 Agent 定向/全量测试、typecheck/build 通过。

## TASK-pi-card-history

Status: completed
Requirements: R-3,R-4,R-5,R-7
Depends on: none
Write scope: src/agent/pi-rpc/event-map.ts; src/agent/pi-rpc/history.ts; test/pi-rpc-event-map.test.ts; test/pi-rpc-history.test.ts
Shared effects: none
Acceptance: 事件转入既有 run-state；历史读取当前分支，错误不隐藏。
Boundary: 不改 runtime、注册、Plan；不编译测试，不操作 Git；PiRecord 为 Record<string,any>，mapper 在 event-map.ts 定义并导出。
Verification: npm test -- test/pi-rpc-event-map.test.ts test/pi-rpc-history.test.ts；重复文本、错误与分支断言全部通过。
Steps:
- [x] 1.4 history.ts · sessionDirectory/listPiSessions/findPiSession：PI_CODING_AGENT_DIR 或原生 ~/.pi/agent/sessions/编码 cwd，验证 header cwd 与 UUID，按 updatedAt 排序；uuid 完整匹配。需求 R-5。
- [x] 2.3 history.ts · readPiHistory：沿 parentId 重建当前分支、归一化 user/assistant/toolResult、最后 maxTurns、原生 title；格式异常日志可见，允许接口既有 empty-on-fail 契约。需求 R-5,R-7。
- [x] 2.4 event-map.ts · createPiEventMapper(turnId).map(record)：message_start 分配稳定 item ID/contentIndex，delta 与 final reconcile；工具类型/结果、usage、compaction、retry，可见扩展错误；仅 agent_settled 发 done/最终error。需求 R-3,R-4,R-7。
- [x] 4.2 event-map/history 测试：文本不重复、多消息不串、retry成功不误判最终error、失败不伪done、分支/compaction、缺失/异cwd会话。需求 R-3,R-4,R-5,R-7。
Result: 已实现；主 Agent 定向/全量测试、typecheck/build 通过。

## TASK-pi-project-selection

Status: completed
Requirements: R-2,R-8
Depends on: none
Write scope: src/agent/index.ts; src/agent/catalog.ts; src/agent/backend-loader.ts; src/agent/detect.ts; test/backend-registry.test.ts; test/backend-catalog.test.ts; test/backend-detect.test.ts; test/project-backend-selection.test.ts; test/backend-picker.test.ts; test/backend-install-api.test.ts; test/help-card-backend-aware.test.ts; README.md
Shared effects: none
Acceptance: pi 注册、探测和选择真实可用，默认 Codex、旧后端不变。
Boundary: 不改 pi-rpc 文件或 Plan；不修改依赖；不编译测试，不操作 Git。
Verification: npm test -- test/backend-registry.test.ts test/backend-catalog.test.ts test/backend-detect.test.ts test/project-backend-selection.test.ts test/backend-picker.test.ts；注册、权限与默认路由通过。
Steps:
- [x] 3.2 index.ts/catalog.ts · REGISTRY/BACKEND_CATALOG：pi-rpc, family pi, access rpc，external-cli binName pi，pkg @earendil-works/pi-coding-agent，supportedModes full。需求 R-2。
- [x] 3.3 backend-loader.ts · isBackendEntryInstalled：external-cli 有 binName 时支持 PI_BIN/PATH 与私装判断；使用 locate.ts 的 resolvePiBin 或通用探测，避免循环依赖。Codex无binName原判断保持。需求 R-2。
- [x] 3.4 detect.ts · detectAgents：新增 pi 探测调用 PiRpcBackend.doctor，失败可见，默认 pickDefaultBackend 不改；异步。需求 R-2,R-8。
- [x] 4.3 注册/选择/检测测试：新增pi、full选择，qa/write剔除，mock探测避免访问本机；更新受新增catalog影响的断言。需求 R-2,R-8。
- [x] 5.1 README.md · pi 用法：安装/PI_BIN、full-only、会话原生配置/skill/trust、goal不支持、不保证TUI并发控制。需求 R-2,R-8。
Result: 已实现；主 Agent 定向/全量测试、typecheck/build 通过。

## TASK-pi-live-verification

Status: completed
Requirements: R-2,R-3,R-4,R-5,R-6,R-7,R-8
Depends on: TASK-pi-execution,TASK-pi-card-history,TASK-pi-project-selection
Write scope: test/pi-rpc.live.test.ts; test/pi-rpc-backend.test.ts; test/pi-rpc-turn-options.test.ts; docs/testing/2026-09-30-pi-backend-review.md; docs/testing/2026-09-30-pi-backend-e2e.md; docs/assets/_local/pi-e2e/**
Shared effects: 真实 pi 测试进程和一次报告发布，由主 Agent 串行执行。
Acceptance: 真实任务文件回读、卡片构造、恢复、压缩和取消有可复核证据；报告发布回读通过。
Boundary: 不操作生产飞书消息，不部署现有守护进程。
Verification: PI_LIVE=1 PI_E2E_DIR=<evidence-root> npm test -- test/pi-rpc.live.test.ts；再执行发布器dry-run/publish。
Steps:
- [x] 4.4 test/pi-rpc.live.test.ts · real Pi backend E2E：两场景，从后端入口到真实文件/卡片/恢复，保存脱敏JSON。需求 R-2,R-3,R-4,R-5,R-6,R-7,R-8。
- [x] 5.2 docs/testing/2026-09-30-pi-backend-e2e.md · 最终证据：逐层结论、截图与原始结果核对、发布报告URL与回读。需求 R-3,R-5,R-7。
Result: 两个真实 E2E 场景通过；报告发布和回读通过。

## Integration Verification

Simple Design review context:
- expected_behavior: pi 会话进入既有后端接口，再经过同一 run-state 和卡片；原生生命周期与权限仍由 Pi 适配器明确处理。
- concepts: AgentBackend/AgentThread 是同一后端概念；pi JSONL、原生 session、thinking level 是 Pi 专属概念。
- reuse_decisions: types/run-state/buildRunCard → same_concept；spawn/killProcessGroup/external CLI discovery → shared_mechanism；Codex/Claude 协议、沙箱和 goal → different_concept，保持分离。
- prefactor: backend-loader 增加中性 external CLI discovery，pi locate 复用该机制；没有把 pi 分支塞进 Codex 或 Claude 运行类。
- constraints: 不共享特定后端的认证、权限或运行状态；只实现当前 Pi 所需命令；不增加 DSH、OS 沙箱或未来通用协议框架。
- status: applied；没有证据证明需额外重构。

主 Agent 串行执行定向测试、npm run typecheck、npm test、npm run build、git diff --check。不改依赖与 lockfile；node_modules 是主仓库的只读共享软链。集成结果：1544 tests passed、19 skipped（包含需显式启用的 live 环境用例），typecheck/build 通过。review 使用 code-reviewer standard 的需求/架构/品味只读单轮，主 Agent 处理 findings。

## E2E

E2E Required: yes
Evidence publication: required
入口为真实 PiRpcBackend 与现有 run-state/buildRunCard，依照仓库 live 后端验证模式；真实 pi 0.99.1、原生现有模型，不 mock Agent 执行。生产飞书消息投递和守护进程部署 out_of_scope。

### SCENARIO-pi-file-and-resume · 本地任务执行、卡片与续聊恢复

- Covers: R-3,R-5,R-7
- Kind: main
- Entry: createBackend('pi-rpc').startThread + runStreamed，消费至现有 reduce/buildRunCard。
- Preconditions: pi 已安装、现有 provider可用；只在新建临时目录操作；mode full。
- Steps: 发指令创建一个唯一marker文件并读回；读取卡片终态、工具输出与文件内容；关闭进程；按同sessionId恢复，问之前marker且不提供答案；读回回复和历史。
- Assertions: UI: 卡片正文含marker、工具展示和done；API: 真实事件含text_delta/tool_use/tool_result，历史含首次问答，恢复回复含marker；DB: out_of_scope；异步: settled后收敛、关闭后进程退出；外部系统: 模型请求成功，生产飞书投递out_of_scope。
- Evidence: live测试输出JSON、真实最终卡片JSON、文件回读、会话恢复结果；将实际输出渲染为可读证据页并截图，不声称是生产飞书截图。
- Side effects & cleanup: 仅临时目录和原生测试会话，结束关闭进程，临时目录trash；报告发布到个人E2E Wiki。
- Result: 两个真实 E2E 场景通过；报告发布和回读通过。

### SCENARIO-pi-permission-and-cancel · 权限拒绝与运行取消

- Covers: R-2,R-4,R-6,R-8
- Kind: permission
- Entry: backend.startThread；thread.runStreamed/abort/compact。
- Preconditions: 同一测试环境；qa/write无需模型请求即拒绝；full取消指令仅影响临时任务。
- Steps: qa/write 启动验证拒绝；full 对话期间调用abort，等待收敛，下一轮仍可运行；读取模型/effort列表与压缩结果；goal能力为false。
- Assertions: UI: 取消后不误显示成功完成原任务；API: qa/write明确拒绝、旧runID拒绝、compact结果可读；DB: out_of_scope；异步: 停止有界且下一轮可执行。
- Evidence: live输出、卡片状态及协议单元测试（旧runID、异常、模型精确校验）覆盖表。
- Side effects & cleanup: 关闭所有pi测试进程；只清理测试对象。
- Result: 两个真实 E2E 场景通过；报告发布和回读通过。

覆盖表：R-1由文档回读和git范围验证；R-2/R-4/R-6/R-8由第二场景加确定性边界/回归测试；R-3/R-5/R-7由主场景加协议异常夹具；图片由确定性base64测试验证，本次不增加真实图片模型调用。

## Delivery

门禁完成：review 无未处理 must-fix，完整回归/typecheck/build 与真实 E2E 通过，报告已发布回读。交付分支 codex/pi-backend，目标 main；commit、PR 与远程 head 以 Finisher 回读和当前会话附件为准。Merge/deploy: not_requested。外部任务单: not_required。

报告：https://ciderglobal.feishu.cn/docx/GmxrdDGK2o0aTOxB4z3cp4HHnnh；发布回读确认 2 步骤、2 图片和顺序。
