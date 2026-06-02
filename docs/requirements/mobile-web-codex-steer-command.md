# 移动 Web Codex steer 命令需求

## 背景

移动 Web 聊天页已经支持发送普通消息和通过 `/iris_cancle` 中断当前 Codex 任务。但在长任务执行过程中，用户有时只想补充一段约束或方向调整，不希望打断当前任务，也不希望等任务结束后再排队发送。

Codex app-server 协议中存在 `turn/steer` 能力，可向正在运行的 turn 注入补充指令。

## 目标

- 在移动 Web slash 命令中提供 `/iris_steer <text>`。
- 当 Codex 有 active turn 时，将 `<text>` 作为 steer input 发送给当前 turn。
- 当没有 active turn 时，返回明确提示，不创建新的普通用户消息任务。
- 当 `<text>` 为空时，返回用法提示。

## 非目标

- 本需求不新增独立按钮或复杂弹窗。
- 本需求不实现 `additionalContext` map 参数。
- 本需求不改变普通消息发送策略。

## 行为要求

- `/iris_steer <text>` 应通过 Codex app-server 的 `turn/steer` 方法发送。
- `turn/steer` 参数应使用当前 active turn 的 `expectedTurnId`。
- steer 成功后，时间线显示一条任务运行提示，说明补充指令已发送。
- steer 失败且无 active turn 时，时间线显示 `Codex has no active turn to steer.`。
- Web UI 的 slash 参数解析应把 `<text>` 放入结构化命令参数，避免只发送命令名。

## 验证要求

- 类型检查通过。
- 自动化测试通过。
- 使用移动视口验证 slash 命令可见、参数可发送、无 active turn 时提示正确。
