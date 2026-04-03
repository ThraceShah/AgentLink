# 会话时间线体验与真实 AI Bridge 需求

## 背景

当前 Android 客户端与示例 agent 已具备最小闭环，但仍存在三个明显问题：

1. 进入会话页时默认停留在最早消息，而不是最新消息
2. 时间线中暴露了过多协议层标签，例如 `user_command`、`text_output`、`status`
3. 示例 agent 仍然是回声逻辑，不是真实 AI 对话桥

这些问题会直接损害使用体验，使系统更像协议调试器，而不是可日常使用的 Agent IM。

## 目标

在不改变整体协议架构的前提下，完成以下改进：

- 会话页默认定位到最新消息
- 时间线只强调用户内容和 agent 响应内容，不暴露协议标签
- 示例 agent 升级为真实 AI bridge，可直接接 OpenAI API

## 设计要求

- 会话页进入时应滚动到底部
- 新消息到达时应优先维持“查看最新消息”的阅读体验
- 对没有正文的 `user_command` 事件可不在时间线中显示
- 消息卡片展示应以正文和产物为主，而不是 `eventType`
- 示例 agent 在有 `OPENAI_API_KEY` 时应返回真实模型结果
- 若缺少 API key，应明确提示缺失条件，而不是继续伪造回声回复

## MVP 范围

- Android 时间线自动定位到最新消息
- Android 时间线隐藏协议标签，精简消息头
- demo-agent 接入 OpenAI Responses API
- README、bridge 文档、变更日志同步更新

## 非目标

- 不引入多轮持久化数据库
- 不引入复杂消息分页
- 不引入完整模型选择界面
- 不替换现有 tmux-agent 与 command-agent 的行为
