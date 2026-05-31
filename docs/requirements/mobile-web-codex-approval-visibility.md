# 移动 Web Codex 审批可见性需求

## 背景

Codex app-server 在执行命令、文件写入或权限变更时可能进入 pending approval 状态。此前移动 Web 只显示会话 `busy`，用户无法判断是模型仍在工作还是正在等待审批，后续输入也会被 bridge 拒绝为“上一请求仍在工作”，造成会话看似卡死。

## 目标

- 当 Codex 请求审批时，Hub 时间线必须产生明确的 `need_approval` 事件。
- 移动 Web 聊天页必须把审批请求展示为醒目的可操作消息。
- 移动 Web 输入区必须在待审批期间显示审批操作入口，避免用户误以为普通输入可以继续执行。
- 会话列表必须能从摘要看出该会话正在等待审批。
- 审批入口必须支持本轮批准；当 provider 支持时，保留会话级批准入口。
- 对于已经启动的旧 bridge 或未产生 `need_approval` 事件的 Codex busy 会话，移动 Web 必须显示兼容审批入口，避免用户无法从 UI 触发批准。

## 非目标

- 不实现审批请求队列。
- 不改变 Codex app-server 的审批策略。
- 不自动批准审批请求。

## 验收标准

- 收到 `need_approval` 后，移动 Web 时间线显示审批卡片，并提供 `Approve` 按钮。
- 审批请求支持 `allowForSession` 元数据时，移动 Web 显示 `Allow session` 按钮。
- 点击审批按钮会向 Hub 发送 `approve` 命令；会话级按钮会传递 `session` 文本参数。
- 待审批期间底部输入区显示审批提示和操作按钮。
- Codex 会话处于 `busy` 且具备 `approve` 能力但没有显式审批事件时，底部输入区显示“可能等待审批”的兼容操作按钮。
- `node --check apps/mobile-web/app.js`、`npm test`、`npm run build` 通过。
