# pi RPC 后端 Code Review 报告

变更规模：30 文件、4072 行新增、54 行删除（含文档与测试）。
日期：2026-09-30。基线：585bb6e。Plan：docs/plans/2026-09-30-001-feat-pi-backend-plan.md。

## 审查概览

使用 code-reviewer standard / review_only，执行入口为 Codex 原生协作，需求、架构和项目代码品味各一轮。Reviewer 只读；修复和全部验证由主 Agent 执行。应用项目规则 coding-taste 的 Deep Modules、依赖注入与状态收敛、名字与注释职责；没有为 TypeScript 虚构其他语言规则。

需求与规范层重复的两个 P1 已按同一根因合并，均已修复。架构层返回三个 advisory，未发现必须调整的模块边界。没有未处理 must-fix，没有 pre-existing finding。

## 必须修复与处理证据

| ID | 规则来源与发现 | 影响 | 修复与验证 |
|---|---|---|---|
| PI-REQ-001 | requirements-review / coding-taste；P1，confidence 98–99；model 切换后沿用旧 effort 缓存 | Pi 会应用模型默认档位或 clamp，缓存可能让请求档位被跳过 | set_model 后读取 get_state 更新缓存；设置 effort 后再次回读。turn-options 测试先复现失败，再确认不支持档位不发送 prompt，同值档位也真正应用 |
| PI-REQ-002 | requirements-review / coding-taste；P1，confidence 99；图片读取后才检查 steer 所属 run | 旧轮消息可能先进入新轮，随后报错无法撤回 | 读取完成后、RPC 副作用前再次校验 run ID。延迟图片读取跨轮测试确认拒绝且不发送 steer |

两条 finding 的 disposition 统一为 must_fix，owner 为 main-agent，pre_existing=false。需求 reviewer 原返回的 partial/violated 表示需求状态，主 Agent 已按 P1 的实际影响归入上述处置。证据路径以当前任务 worktree 为准。

## 主 Agent 补充核对与修复

- 原生 toolcall_start 只有 contentIndex/partial，没有最终调用 ID。延后到 toolcall_end 建立工具块，再和 tool_execution_start/end 复用同一个 ID；真实形状测试确认只有一个已收尾的工具块。
- pending extension UI 取消不能阻挡进程回收；本地问题状态先结束，取消响应异步发送，close 仍进入有界回收。模拟 stdin 写入不返回的测试通过。
- 支持原生 PI_CODING_AGENT_SESSION_DIR 扁平目录，并按 header.cwd 筛选；默认 cwd 编码目录仍保留。跨项目过滤与相对路径测试通过。
- 原生短会话 compact 明确返回 Nothing to compact (session too small)，转换为 compacted=false；其他错误继续抛出。
- setStatus/setWidget/setTitle/set_editor_text 是单向终端展示通知，保留诊断，不当作失败的问答请求；select/confirm/input 继续转交用户输入卡片。

## 仅供参考

| ID | Advisory | 本次处理 |
|---|---|---|
| PI-ARCH-001 | PiRecord 和工具格式函数放在 event-map，传输与历史模块引用它 | 保留；PiRecord 是擦除的类型依赖，历史和实时工具标题当前具有同一展示语义，没有运行失败证据。需要拓展协议类型时再调整归属 |
| PI-ARCH-002 | backend/thread 重复少量 provider/id、none/off 校验规则 | 保留；启动和动态切换已有回读及边界测试；不为本次之外的变化再增加模块 |
| PI-ARCH-003 | Pi/Claude 图片识别与大小校验相似 | 保留；两后端当前失败处理不同，Pi 明确拒绝无效图片，不把 Claude 的跳过行为带入 Pi |

三项均为 P2/advisory、confidence 100、owner main-agent、pre_existing=false；来源为 architecture-review。建议不会被当作已修复。

## Requirements Completeness

TASK-pi-execution、TASK-pi-card-history、TASK-pi-project-selection 的 Acceptance 已实现并完成确定性验证。TASK-pi-live-verification 单独记录真实 Pi、文件、卡片构造、会话恢复、取消、压缩与报告发布结果；不把本报告当作真实 E2E 证据。

## 已读取范围与未执行层面

Reviewer 读取了全部 pi-rpc 模块、pi 测试和进程 fixture、registry/catalog/detect/backend-loader、项目选择相关测试、README、Plan、grill 和两份调研。三层均执行，没有跳过适用层。除上述位置外没有确认问题；修复后新增测试由主 Agent 执行，没有宣称 reviewer 运行过测试。

未验证生产飞书客户端渲染/投递、守护进程部署、TUI 与 RPC 同会话并发控制。未接入 DSH，未授权自动合并。图片只验证确定性传输，不宣称真实图片模型调用已验证。

## 修复后验证

定向回归通过；完整 1544 tests passed、19 skipped；typecheck、build 通过。Skip 包含需要显式开启的真实环境测试，Pi live E2E 另行执行。审查发现已处理，可以进入 E2E 和收尾；交付终态以 E2E 报告发布回读和 PR 回读为准。
