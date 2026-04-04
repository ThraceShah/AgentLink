# OpenCode 新版 CLI 适配需求

## 背景

当前主机上已安装并可运行真实 OpenCode CLI，但其接口形态与项目早先接入时假设的旧版命令不同：

- 真实可用命令为 `opencode run ... --format json`
- 返回的 JSON 事件文本位于 `part.text`
- 旧版的 `-p`、`-f json`、`-q` 形式不再适合作为项目内的稳定接入方式

这会导致两个直接问题：

1. Hub 可能错误判断 `opencode` 不可用，从而不在 Android 新建会话中展示它。
2. 即使实际执行了新版 OpenCode CLI，tmux bridge 也可能因为参数或输出解析不匹配而无法把回复显示到会话中。

## 目标

将项目中的 `opencode` 接入正式切换到当前机器已安装的新版 OpenCode CLI，并保证不再依赖旧版参数假设。

## 非目标

- 本次不替用户安装 OpenCode。
- 本次不替用户自动登录或初始化 OpenCode provider。
- 本次不实现 OpenCode 的交互式 TUI attach，仅适配当前 MVP 所需的非交互消息链路。
- 本次不为了 OpenCode 兼容而改变 `codex`、`qwen`、`copilot` 的现有工作模式。

## 功能要求

### Hub 可用性判断

- Hub 在检测 `opencode` profile 时，不应再仅依赖旧版 `.opencode.json` 结构。
- Hub 应基于真实 OpenCode CLI 的轻量探测结果判断 `opencode` 是否可用。
- 为避免每次请求都重复触发真实推理调用，Hub 应对探测结果进行短时缓存。

### tmux bridge 执行链路

- `TMUX_BRIDGE_PROFILE=opencode` 时，应调用已安装的真实 OpenCode CLI。
- 执行命令应使用新版 `run` 子命令。
- 工作目录应继续绑定到当前 tmux 会话目录。
- 若有显式模型配置，bridge 应继续支持把模型参数透传给 OpenCode CLI。

### 输出解析

- bridge 应能从新版 OpenCode JSON 事件中提取 `part.text`。
- 若 OpenCode 返回非 JSON 错误文本，仍应把错误明确回传到时间线，而不是静默失败。

## 验收标准

- 当前机器上真实 OpenCode 可运行时，`GET /api/agent-profiles` 中应包含 `opencode`。
- Android 新建会话时可看到并选择 `opencode`。
- 使用 `opencode` 创建的新会话发送文本后，能在会话中收到真实 OpenCode 回复。
- Node 测试通过，Android APK 完成标准模拟器自测并刷新到 `temp_docs/apk/`。
