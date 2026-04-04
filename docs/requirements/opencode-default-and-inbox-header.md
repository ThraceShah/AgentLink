# OpenCode 默认接入与首页头部精简需求

## 背景

当前 Android 客户端和 tmux bridge 已支持 `codex`、`qwen`、`copilot`，但仍存在以下问题：

- 尚未接入 `opencode`
- 新建会话时默认 provider 不符合当前使用偏好
- profile 展示顺序不稳定
- 首页会话卡片仍保留左滑删除的红色背景提示，视觉干扰较强
- 首页左上角标题仍是固定产品文案，缺少与当前连接主机的直接关联

这些问题会降低首页作为“个人私有 agent IM”入口的效率，也会让新建会话路径与当前工作流不一致。

## 目标

本次调整需要完成以下目标：

1. 为 tmux bridge 增加 `opencode` provider/profile 接入能力。
2. 在可用 provider 列表中，按 `opencode`、`qwen`、`codex`、`copilot` 的顺序展示。
3. 新建会话时默认优先选中 `opencode`；若当前机器不可用，则回退到列表中的第一个可用 profile。
4. 去掉首页会话卡片左滑时背后的红色删除底板，保留更克制的删除交互。
5. 首页左上角标题区域改为显示当前连接主机的用户名，而不是固定营销文案。

## 非目标

- 本次不改变首页会话卡片按“最后一条真实消息时间”排序的规则。
- 本次不引入新的团队用户体系或主机切换面板。
- 本次不强制完成 `opencode` provider 的账号认证或模型配置。
- 本次不重做 Android 的整体导航结构。

## 功能要求

### 1. OpenCode provider

- Hub 应自动检测本机是否存在 `opencode` 命令。
- 若存在，则在 `GET /api/agent-profiles` 中返回 `opencode` profile。
- tmux bridge 应支持 `TMUX_BRIDGE_PROFILE=opencode`。
- `send_text` 时应走 OpenCode 官方非交互 prompt 模式。
- 若当前主机尚未完成 OpenCode provider 配置，bridge 至少应把失败结果明确回传到时间线，而不是静默无响应。

### 2. Profile 顺序与默认值

- 可选 profile 的展示顺序固定为：
  - `opencode`
  - `qwen`
  - `codex`
  - `copilot`
- Android 新建会话弹窗默认选中 `opencode`。
- 若 `opencode` 不可用，则回退到排序后的第一个可用 profile。

### 3. 首页头部

- 移除固定文案：
  - `Agent Inbox`
  - `Personal private agent control`
- 改为显示当前 hub 所在主机的用户名。
- 该用户名应由 hub 返回，不应由 Android 本地猜测。

### 4. 卡片删除视觉

- 去掉会话卡片左滑时背后的红色删除底板。
- 删除操作仍应保留一个明确入口，避免能力退化。

## 验收标准

- 本机安装 `opencode` 后，Android 新建会话可看到 `opencode` profile。
- 新建会话弹窗默认会选中 `opencode`。
- profile 展示顺序符合预期。
- 首页左上角改为显示当前连接主机用户名。
- 首页会话卡片不再出现红色删除底板。
- Android 改动使用本机模拟器完成自测。
