# Pi Goal 插件复用调研

调研日期：2026-09-30。bridge 基线：cc347a9；本机 Pi 0.99.1，Node 25.3.0。

## 结论

优先复用 `@narumitw/pi-goal@0.54.8`，bridge 只增加程序控制转发、Goal 事件映射和运行生命周期处理。无需从零开发目标状态机、自动续跑、预算、阻塞判断及会话持久化。

建议固定上游版本并随 bridge 管理扩展加载；先保持完整上游运行逻辑，再按真实接入需要裁掉 TUI 入口。如果复制源码，保留 MIT LICENSE、原作者版权说明、上游版本及修改记录。不要先把多个插件的状态机拼在一起。

调研阶段只完成插件选择及控制验证。用户随后授权开发，现已固定复用该版本并打开 Pi Goal 能力；真实多轮、等待唤醒、文件回读、结束/取消和恢复已验证，见 `docs/testing/2026-09-30-pi-goal-e2e.md`。

## 候选比较

版本取自 npm registry 实时查询，不能用搜索引擎缓存的版本作为最新版本。

| 插件 | 最新版本 | 契合之处 | 主要差异 | 选择 |
|---|---|---|---|---|
| `@narumitw/pi-goal` | 0.54.8，2026-09-20 | 单会话单目标；明确完成/阻塞/等待工具；token 预算；25 次自动响应和 3 次重复无进展默认限制；原生会话分支状态；带 runId 的开始/取消事件协议 | 控制协议是进程内 `pi.events`，需要跨进程转发；状态事件只在状态改变时发出，进度需另读；工作流互斥的上游保证仅针对已测试的 Pi 0.84.2 | **首选** |
| `@signalridge/pi-goal` | 1.4.2，2026-09-09 | 同一机制家族；已有 managed-run 协议、预算、明确终态 | peer 版本限制在 Pi 0.84/0.85；有实验性目标队列及两个 UI 依赖；相比新版 narumitw 没有接入优势 | 参考 |
| `@piex-dev/goal` | 0.1.0，2026-07-22 | 从 narumitw 移植；8 个 TS 文件、约 2680 行；没有运行时依赖；删除队列和部分 UI | 删除了程序控制协议；代码将返回 void 的 `sendUserMessage` 当 Promise 调 `.catch()`，Pi 0.99.1 上需修复；预算后有额外总结轮，语义不同 | 轻量裁剪参考 |
| `@pinet/agent-goal` | 0.2.21，2026-09-17 | 可替换的 storage/evaluator/continuation；每次 settled 后独立评估；提供 create/get/update 工具 | 默认 SQLite；每轮独立模型评估增加请求；它的“独立评估”不能直接等同于独立工具取证；需要另一套 bridge 状态适配 | 需要额外完成检查时再考虑 |
| `@tian.zuo/pi-goal` | 0.2.0，2026-08-23 | Codex 风格持久目标；预算和完成证据 | 额外依赖 Effect 4 beta；程序控制适配收益低于首选 | 不优先 |
| `@fyeeme/pi-goal` | 1.0.3，2026-09-18 | 移植 oh-my-pi 目标机制；独立 Pi 子进程检查完成/不可能 | 精确 peer 依赖 pi-agent-core 0.84.4；评估默认可运行 10 分钟并使用工具，新增子进程和取消管理 | 不优先 |
| `pi-agent-goal` | npm 2026.7.18，2026-07-17 | 分支状态、进度工具、显式启动；GitHub 分支已有更新 | npm 声明 Pi <0.81；仓库与发布版不可混用为同一验证对象 | 不优先 |
| `@atlas.labs/pi-goal` | 0.0.1，2026-05-12 | 目标队列、监控、预算 | 0.0.1；包含更大的一套目标监控行为，超出 bridge 单目标需求 | 不优先 |

Ralph 类还包括 `@pi-unipi/ralph`、`@lnilluv/pi-ralph-loop`、`@kimuson/pi-ralph` 和 `@tmustier/pi-ralph-wiggum`。这些分别偏任务清单、跨子进程执行或 PR 交付流水线。bridge 的 `/goal` 是同一会话持续执行一个目标，直接的 Goal 扩展更契合。`@shog-lab/pi-goals` 已标记 deprecated，不能作为首选。

## 实际验证

从 npm 发布包下载源码，只解包到临时目录，没有永久安装插件，没有读取、复制或更改用户认证配置。测试设置和会话目录单独隔离；测试进程均正常回收。

1. narumitw、Signalridge、PieX、Pinet 四个候选均在 Pi 0.99.1 的原生 `--mode rpc` 中成功加载；`get_commands` 返回 `/goal`，加载阶段 stderr 为空。这里只证明能加载，不代表全部运行行为兼容。
2. 使用 narumitw 的原版发布入口及一个临时转发扩展，启用隔离的 `rpc.enabled`。程序开始目标，收到 `active` 后立即按相同 runId 取消，收到一个 `paused` 终态。
3. 另一 runId 的取消请求得到 `RUN_NOT_FOUND`，没有影响原目标。
4. Pi 原生会话记录中存在 `goal-state`，状态为 paused。关闭进程后用相同会话文件重新打开，状态保留；执行 `/goal clear` 后记录为 goal:null。
5. 全过程没有 `agent_start`，没有模型调用，也没有自动执行工具。

首次测试在全新、没有任何对话的会话上验证恢复失败。当前 Pi SessionManager 在没有 user/assistant 消息时仅保留内存中的 setup/custom entries，不创建会话文件。这是测试实际命中的持久化边界。改为显式空会话文件交由 Pi 初始化后，开始、取消、恢复及清除全部通过。接入时需要保证刚创建即取消的目标也有可恢复的原生会话文件，不能仅凭 get_state.sessionFile 路径宣称已经落盘。

调研时尚未验证实际模型多轮及工具控制。后续实现验证了实际模型自动续跑、完成/等待工具、工具中的结束/取消和原生恢复；预算耗尽、三轮阻塞、压缩与自动重试交错及生产飞书按钮/送达未做真实模型或客户端验收。预算/阻塞状态映射和错误路径有确定性验证。

## bridge 接入方式

1. 固定插件版本，使用 bridge 自己管理的加载路径和设置；避免修改用户全局的 Pi 配置。只在 bridge 创建的 Pi 子进程加载转发扩展和 Goal 扩展。
2. 转发扩展注册专用命令，接受 bridge 的开始/结束/状态请求。开始时先订阅 `pi-goal:event:<runId>`，再发 `pi-goal:start`；错误和 canonical state 转成现有 RPC 可以传输的结构化消息。内部事件总线不等于 Pi 的 stdin/stdout RPC，需要显式转发。
3. 映射 `usage_limited` → `usageLimited`、`budget_limited` → `budgetLimited`，保留 active/complete/blocked/paused。等待是 active 下的子状态，不能当 complete；补读 goal-state 才能取得累计 tokens/time 和等待详情。
4. Goal 流跨越多个 Pi agent run。普通 `runStreamed` 可以在 agent_settled 结束；`runGoal` 必须持续消费到目标真正终止，并处理 settled 后才入队的续跑。不能把每一轮 settled 当整个目标结束。
5. “终止”使用精确 runId 的取消并等待真实收敛。“结束目标”需要单独适配，让当前执行完成后停止续跑；上游 cancel 默认 pause 且 abort，不能直接当作温和结束。清除目标必须获得确认状态，不能只收到 prompt accepted 就宣称完成。
6. 恢复后插件会恢复原生 Goal 状态，但 managed-run 协议不自动接管旧 Goal。bridge 必须补充状态读取、重新订阅/接管的明确规则，防止旧目标静默续跑或丢失卡片控制。

粗略工作量：复用插件后，第一版 bridge 控制转发、事件映射、正常结束和取消约 1～2 天；补齐真实多轮、恢复、预算和压缩/重试交错验证约 1 天。该估计基于控制验证，不是完整实现已完成。

## 来源与许可证

- [narumitw 包说明及完整控制协议](https://pi.dev/packages/@narumitw/pi-goal)，[源码 README](https://github.com/narumiruna/pi-extensions/blob/main/packages/pi-goal/README.md)。npm 0.54.8 包含 MIT LICENSE，Copyright (c) 2026 narumiruna。
- [Signalridge](https://www.npmjs.com/package/@signalridge/pi-goal)，[源码](https://github.com/signalridge/pi-extensions/tree/main/packages/pi-goal)。MIT。
- [PieX 设计与裁剪记录](https://github.com/piex-dev/piex/blob/main/docs/packages/goal.md)，[源码](https://github.com/piex-dev/piex/tree/main/extensions/goal)。npm 元数据声明 MIT，但发布包没有 LICENSE 文件，复制前应从源码仓库补齐上游版权文件。
- [Pinet](https://www.npmjs.com/package/@pinet/agent-goal)，[源码](https://github.com/gugu91/pinet/tree/main/agent-goal)。MIT。
- [Tian Zuo](https://www.npmjs.com/package/@tian.zuo/pi-goal)，[Fyeeme](https://www.npmjs.com/package/@fyeeme/pi-goal)，[KristjanPikhof](https://github.com/KristjanPikhof/Pi-Agent-Goal)，[Atlas](https://www.npmjs.com/package/@atlas.labs/pi-goal)。候选 npm 元数据与随包许可证分别核对。
- 本机 Pi 0.99.1 的 ExtensionAPI 类型、RPC 模式和 SessionManager；npm registry 各包 latest 元数据和发布 tarball。
