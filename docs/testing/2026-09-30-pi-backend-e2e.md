# pi 后端 E2E 验证

日期：2026-09-30。分支：codex/pi-backend。基线：585bb6e。环境：macOS、Node 25.3.0、pi 0.99.1，使用本机既有 llm-proxy-responses/LOW 模型与 high 思考档位。

结论：两个真实 E2E 场景通过，适用层完成验证。报告已发布并回读；生产飞书客户端渲染和消息投递、守护进程部署不在本次范围。

报告：[2026-09-30-001-feat-pi后端接入-E2E测试报告](https://ciderglobal.feishu.cn/docx/GmxrdDGK2o0aTOxB4z3cp4HHnnh)。section_key：e2e-20260930-001-feat-pi-backend。

## 实际结果

| 场景 | 断言与实际证据 | 结论 |
|---|---|---|
| 文件、卡片与恢复 | 真实 pi 创建 marker.txt，回读 pi-e2e-ba2d69bf-a9cf-47d5-86fd-25dbda4a2058；真实事件进入 reduce/buildRunCard，卡片正文含标记且工具均已收尾；关闭后恢复同一会话 d08770e2-82c0-40ff-91ce-03f2401f5fd1，不提供答案仍能答出标记；原生历史含两轮，列表有同一 ID | passed |
| 权限、取消与配置 | qa/write 启动前拒绝；活跃输出取消后以 error 收尾，没有误记原任务成功；下一轮回复“取消后可继续”；旧 run ID 拒绝；394 个模型，默认 LOW/high 正确；短会话 compacted=false；goal=false | passed |

模型首次把 write/read 并行调用，读取产生 ENOENT，随后再次读取成功。失败工具退出码 1 保留在卡片和原生历史，成功读取退出码 0；不是把失败工具改为成功。真实压缩调用返回“Nothing to compact (session too small)”，桥转换为明确的 compacted=false；没有宣称长会话已真实压缩。

## 验证范围

| 层 | 状态 | 依据 |
|---|---|---|
| 卡片构造 | passed | 真实事件、RunState 与最终 buildRunCard JSON；截图是这些实际结果的证据页 |
| RPC / 文件 | passed | 真实外部模型调用、文件写入与内容回读 |
| 会话 / 异步 | passed | settled 后收敛、同 ID 恢复与历史、取消后可续用 |
| 飞书客户端 UI / 消息投递 | out_of_scope | 未向生产话题发送消息，未验证客户端实际渲染 |
| 业务数据库 | out_of_scope | 无数据库链路 |
| 图片模型调用 | out_of_scope | 图片编码与传输由确定性测试验证，没有增加真实图片请求 |
| 大会话压缩 | unverified | 原生 compact 接口和有效结果形状有协议测试；真实短会话无需压缩 |
| 部署 / 合并 | not_requested | 本次交付到 PR，不更新运行服务 |

## 检查与审查

- 完整测试：1544 passed、19 skipped；包含需要显式启用的其他真实环境测试。
- 真实 Pi E2E：2 passed、0 failed；使用 PI_LIVE=1 单独启用，没有 mock Agent 执行。
- npm run typecheck、npm run build、git diff --check 通过。
- code-reviewer standard 三层只读审查一轮；两个 P1 已修复并补回归测试。详见 docs/testing/2026-09-30-pi-backend-review.md。

首次 E2E 未通过：工具断言误要求每次调用都成功，未允许模型重试；compact 未把原生短会话结果转成 no-op。校正断言、补 compact fixture 和单向终端 UI 通知处理后，适用测试、类型检查与构建再次通过，再补跑真实 E2E。首次失败结果保留在本地 attempt-01，不用旧结果冒充本轮成功。

## 证据与发布回读

本地脱敏证据在 docs/assets/_local/pi-e2e，受 .gitignore 排除：file-and-card.json、resume-and-history.json、cancel.json、controls-scenario-result.json、unit-tests.json、live-tests.json、两张 JPG 截图、manifest.json、publish-result.json。正文和图片已逐项人工核对，不含凭据或个人业务数据。

通过 verification-evidence 发布：create → insert_image → insert_image → fetch。回读确认标题、passed 状态、2 个步骤、2 张图片与图片顺序。发布预检发现截图实际为 JPEG，修正文件扩展名后通过内容校验，没有绕过预检。

Pi 测试进程均已关闭，临时工作目录移入废纸篓。原生测试会话历史保留供核对；本地证据 HTTP 服务和浏览器临时页已关闭。未修改凭据、Pi 配置、全局扩展、生产群或业务服务。

## CI 补验

首次 GitHub CI 的 Ubuntu/macOS 全部通过，Windows 三个 Node 版本均在同一历史测试断言失败：测试输入用 /tmp 根路径，join 的预期没有盘符，而实际绝对路径正确包含 D:。已将 fixture.cwd 规范成绝对路径，再保留同一业务断言；没有修改运行代码、跳过用例或放宽判断。失败记录：[run 36707822078](https://github.com/maplezzk/feishu-codex-bridge/actions/runs/36707822078)。补验终态以 PR #10 最新 head 的九项检查为准；原有真实 E2E 的适配器源码指纹保持一致，复用已发布证据。
