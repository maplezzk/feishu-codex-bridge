# pi 接入调研

调研日期：2026-09-30。目标仓库：feishu-codex-bridge；基线 585bb6e（0.6.14）。

## 结论

增加 `pi-rpc` 后端即可复用飞书消息编排、话题绑定、卡片渲染和 backend/sessionId 存储。使用独立 `pi --mode rpc` 子进程，保持 pi 原生配置和会话格式。首版支持 full 权限、文本/图片、实时文本/思考、工具结果、引导、取消、压缩、模型与思考档位、历史选择与重启恢复。后续增量已复用 `@narumitw/pi-goal@0.54.8` 接入持续 Goal，详见 Goal Plan 与验收记录。

## 已验证事实

本机 pi 已从 0.87.1 升级到 npm latest 0.99.1，Node 25.3.0。RPC 的 get_state、get_available_models、get_available_thinking_levels、get_session_stats 成功，测试进程正常退出。当前配置的 provider 为 llm-proxy-responses。该调研握手没有调用模型。

协议以 LF 分隔 JSON；U+2028/U+2029 是字符串内容，不能使用会按这些字符断行的 readline。必须先订阅事件，再发送 prompt。prompt 回执只代表 accepted；handled 不会启动任务。只有 agent_settled 表示没有自动重试、压缩恢复或队列任务会继续；agent_end/turn_end 不能关闭卡片。

## 接入设计

- 新增 src/agent/pi-rpc/{client,locate,backend,thread,event-map,history,permission}.ts。
- 在 src/agent/index.ts、catalog.ts 注册 pi-rpc；补 detect.ts 和已安装判断，保证本机 PATH 上的 pi 在项目选择器可见。
- 使用平台 spawnProcess/killProcessGroup，独立进程便于统一退出回收和 raw activity。现有 RpcClient 可复用，但不公开桥所需的进程健康、进程组回收和 raw activity；首版采用只覆盖所需命令的 JSONL 客户端，不复制模型或 Agent 执行逻辑，也不把整个 pi 包塞进桥依赖。
- 查找顺序 PI_BIN、PATH、桥私装 .bin/pi。配置和认证由 pi 自己加载；不读取或复制凭据。显式 full-only；qa/write 拒绝启动。project trust 沿用 pi 的已保存决策；桥不自动信任未知项目。
- 使用 pi 原生会话文件，按 cwd 校验 UUID 和文件 header；支持 PI_CODING_AGENT_SESSION_DIR 扁平目录覆盖。历史沿 parentId 取当前分支，不能把废弃分支当当前对话。恢复不存在的会话明确报错，不能同 ID 创建空会话冒充恢复。
- model 保存 provider/id，none 映射 off；选择后用 get_available_thinking_levels 校验实际档位。未知模型或不支持档位明确失败。
- 一轮使用 bridge 自己的 run ID；同一进程不允许并发两个 runStreamed。steer/abort 仍校验本地 run ID，防止旧按钮操作新轮次。
- 自动重试由 pi 原生事件驱动，在卡片显示等待状态；终态错误在 agent_settled 确认。暂停中的工具、扩展问答转成桥已有 user_input_request，无法表达的 UI 明确回应取消，避免挂死。

## 验收与限制

后续 Goal 优先复用 `@narumitw/pi-goal@0.54.8`，候选比较、Pi 0.99.1 控制验证及跨进程接入边界见 [Goal 插件复用调研](2026-09-30-pi-goal-plugins.md)。后续实现已打开 Pi Goal 能力，保留首版验证记录作为历史证据。

验收记录见 docs/testing/2026-09-30-pi-backend-e2e.md；1544 项确定性测试与两个真实 E2E 场景通过。需要覆盖的边界包括早到事件、handled、最终错误/重试恢复、UTF-8 分片、Unicode 行分隔符、图片、压缩、旧轮次取消、进程死亡、恢复和拒绝权限降级；live E2E 用真实 pi 和已有模型，从后端入口走到卡片状态和临时文件回读。飞书生产投递及运行服务部署不在本次授权范围。

pi 没有内置沙箱。full-only 不等同于 qa/write；后续只有实际 OS 隔离验证通过后才开放更多档位。旧扩展当前有依赖声明兼容警告：rpiv-ask-user-question、pi-thinking-steps；cider/* 模型匹配警告也存在，不能吞掉或据此宣称真实任务验证通过。

## 来源

- https://pi.dev/docs/latest/rpc
- https://pi.dev/docs/latest/rpc-commands
- https://pi.dev/docs/latest/json
- https://pi.dev/docs/latest/security
- 本机 @earendil-works/pi-coding-agent 0.99.1 的导出接口、RPC 文档和 SessionManager 实现。
