/**
 * Bridge-scoped developer guidance, injected ONLY into threads this bridge
 * starts (never the user's own codex/claude usage). Teaches the two output
 * conventions the bridge renders: real-file image refs, and the ```feishu-card
 * fence that the bridge turns into a standalone Feishu card (see
 * card/markdown-render). It is purely additive (a developer/system append, not
 * a base-prompt replacement) so the agent's normal behavior is unchanged when
 * neither convention is invoked. Shared verbatim by every backend — codex
 * passes it as `developerInstructions`, claude appends it to the claude_code
 * system-prompt preset.
 */
export const BRIDGE_DEVELOPER_INSTRUCTIONS = [
  '你现在通过「飞书桥」与用户对话：你的回复会被渲染成飞书消息。请遵守两条输出约定。',
  '',
  '1) 图片：要配图时，用标准 Markdown 图片语法 ![说明](路径) 引用一个【真实存在】的图片，',
  '飞书桥会自动上传并在飞书里渲染。路径可以是相对当前工作目录的相对路径、工作目录内的绝对路径，',
  '或一个 http(s) 图片 URL。绝不要编造不存在的图片占位（例如写 ![管理台截图] 却没有对应文件）——',
  '没有真实图片就不要写图片语法。',
  '',
  '2) 卡片：仅当用户明确要求「用卡片回复 / 做成飞书卡片 / 卡片形式展示 / changelog 卡片」之类时，',
  '把要展示的内容包进一个 ```feishu-card 代码块，块内用 Markdown 书写：',
  '首行用 `# 标题` 作为卡片标题栏；用 `---` 作分隔线；用 `> 文字` 作灰色注脚；',
  '`**粗体**`、列表、链接照常使用；配图同样用 ![说明](真实路径)。',
  '不要手写飞书卡片的 JSON。普通问答正常回复即可，只有用户要卡片时才用 ```feishu-card 代码块。',
  '',
  '3) 多 Agent 协作：如果当前运行时提供 spawn_agent、wait_agent、followup_task 等协作工具，',
  '协作工具必须作为独立工具直接调用，绝不要放进 functions.exec、shell、脚本或其他工具调用里。',
  '使用 full-history fork 时不要同时传 agent_type；一次调用被拒绝后不要盲目重复堆叠。',
  '优先拆成少量（通常不超过 2 个）目标清晰、上下文必要的短子任务；启动后必须等待并汇总所有必要结果，',
  '确认子任务完成前不要结束主轮，也不要把“正在等待”说成“已经完成”。长时间没有结果时先报告仍在等待，',
  '必要时再直接中断并清理对应子任务。遇到网络、连接或超时错误时，只有在调用结果确定未落地且操作可安全重试时才重试一次；',
  '写入类调用结果不确定时先查询状态，绝不要盲目重复提交。',
].join('\n');
