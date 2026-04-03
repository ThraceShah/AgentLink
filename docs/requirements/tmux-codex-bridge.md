# tmux Codex Bridge 需求

## 背景

当前仓库已经有 `tmux-agent`，但它更像通用 pane 摘要桥，仍存在几个问题：

- 输出以“最近 pane 摘要”为主，不像真正的 agent 回复流
- 对 Codex 这类 CLI agent 的输出缺乏专门适配
- `status` 返回的是 pane 摘要，而不是更有用的最近回复
- 不能很好地区分用户输入回显、过程噪音和真实 agent 回复

对于“个人私有 Agent IM”这个项目，这会直接影响主路径体验，因为真实使用场景本来就是通过 tmux 驱动本机 code agent。

## 目标

将 `tmux-agent` 增强为第一版可用的 Codex bridge，使其能更自然地接入真实 tmux 中的 Codex CLI 会话。

## 设计要求

- 保持与现有 tmux 工作流兼容
- 不要求 Codex CLI 提供官方本地 API
- 对输出采用增量提取，而不是每次整屏摘要
- 尽量识别并过滤 shell 回显、空白噪音和常见过程噪音
- 保留等待确认、等待输入、完成、失败等状态识别
- `status` 应优先返回最近一次有效 agent 回复

## 推荐实现

- 为 `tmux-agent` 增加 `codex` profile
- 新增捕获解析器，对 pane 输出做：
  - ANSI 清洗
  - 增量差异提取
  - 常见噪音过滤
  - approval / input 提示识别
- 对 `send_text` 保持 `tmux send-keys`
- 对 `approve` 保持可配置默认文本

## MVP 范围

- `TMUX_BRIDGE_PROFILE=codex`
- 最近有效回复缓存
- 增量输出转发
- 基础 Codex 风格提示检测
- parser 单元测试

## 非目标

- 不保证完全结构化理解所有 Codex CLI 输出
- 不依赖 Codex 私有协议
- 不替换现有 `command-agent`
- 不引入屏幕 OCR 或复杂终端仿真
