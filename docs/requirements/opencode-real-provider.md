# OpenCode 真实 Provider 接入约束

## 背景

当前项目中的 `opencode` profile 曾通过本地代理把请求转发给 `qwen` CLI，再由 OpenCode 充当外层壳。这种实现虽然能跑通最小链路，但不符合“使用本机真实 OpenCode agent”的语义，也会误导用户对实际模型与 provider 的判断。

## 目标

本次调整需要将 `opencode` profile 收敛为“真实 OpenCode 接入”：

1. `opencode` 只代表本机真实安装并已配置完成的 OpenCode CLI。
2. 若当前机器没有可用的 OpenCode agent 配置，则 Hub 不应暴露 `opencode` profile。
3. tmux bridge 调用 `opencode` 时，不应再注入本地代理或替换为其他 provider。
4. 文档应明确说明 `opencode` 的出现条件和运行边界。

## 非目标

- 本次不为 OpenCode 自动生成 provider 配置。
- 本次不替用户代填 API key 或 provider 认证信息。
- 本次不继续维护“OpenCode 壳 + qwen 实体”这类兼容模式。
- 本次不实现 OpenCode TUI 的完整交互式 tool loop。

## 功能要求

### 1. Profile 暴露条件

- Hub 只有在同时满足以下条件时，才返回 `opencode` profile：
  - 本机存在可执行的 `opencode` 命令；
  - 当前用户存在真实可用的 OpenCode 配置；
  - 配置中至少能解析到 `agents.coder.model`，且存在 provider 配置或等价的认证环境。

### 2. 执行方式

- `tmux-agent` 在 `TMUX_BRIDGE_PROFILE=opencode` 时，应直接调用本机 `opencode` CLI。
- 不应注入项目内的本地 OpenAI-compatible proxy。
- 不应把请求转发给 `qwen`、`codex`、`copilot` 或其他替身 provider。

### 3. Android 展示

- 若当前机器不满足真实 OpenCode 可用条件，Android 新建会话弹窗中不应显示 `opencode`。
- 只有在真实可用时，`opencode` 才能作为默认优先项出现。

## 验收标准

- 当前机器未配置真实 OpenCode agent 时，`GET /api/agent-profiles` 不包含 `opencode`。
- 当前机器已配置真实 OpenCode agent 时，`GET /api/agent-profiles` 包含 `opencode`。
- `opencode` 会话发送消息时，实际执行链路中不再出现本地代理或 `qwen` 转发。
- README 与 bridge 文档不再把 `opencode` 描述为 `qwen` 的壳。
