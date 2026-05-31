# Codex Web 结构化命令需求

## 背景

移动 Web 原型需要承载 Codex app-server 中面向用户的结构化命令。用户应能通过浏览器快速验证 Android 端未来的交互，而不是把所有 slash 命令作为普通文本发送给 Codex。

## 范围

第一版只实现用户命令层，不暴露底层 RPC 控制台。Web UI 以 slash 入口为主，对需要参数、确认或选择的命令提供移动端友好的弹窗表单。

已纳入第一版的命令：

- `/model`：选择模型和 reasoning effort。
- `/goal`：查看、设置、替换、清除当前 goal。
- `/rename`：重命名当前 Codex thread。
- `/compact`：触发上下文压缩。
- `/memory`：启用、禁用当前 thread memory 或重置本地记忆。
- `/mcp`：查看 MCP server 状态。
- `/status`：查看 Codex session、thread、模型、reasoning、goal 和上下文状态。

AgentLink 自定义命令继续使用 `/iris-*` 前缀，避免和 Codex 官方命令语义冲突。

## 交互要求

- 用户输入 `/` 时展示可用命令。
- 点击复杂命令时打开底部弹窗或移动端可用的 modal。
- 直接输入 `/goal xxx`、`/goal clear`、`/rename xxx` 等文本命令也应可用。
- 命令执行结果写入 timeline，并刷新底部运行态信息。
- 获取模型列表等内部结构化响应不应作为普通聊天消息展示。
- 手机宽度下不得产生横向滚动。

## 验证要求

- TypeScript 构建通过。
- Web UI 在手机视口下完成 slash 命令弹窗、模型选择、goal 表单和确认类命令的基础验证。
- Hub 完成后保持运行，`/healthz` 返回 OK。
