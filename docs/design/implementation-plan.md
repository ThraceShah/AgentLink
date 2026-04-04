# 分阶段实施计划

## Phase 1：最小打通

### 交付内容

- hub 基础服务
- 协议定义
- shell command bridge
- tmux-backed agent bridge
- Android 客户端骨架
- 最小 demo 脚本

### 为什么先做这个

- 先验证“presence + timeline + command loop”是否成立
- 尽快暴露协议和 UI 的不合理处
- 避免过早陷入复杂通知、持久化或 tmux 细节

### 成功标准

- agent 启动后可出现在列表中
- client 可收到状态消息
- client 可发命令并收到回执
- agent 下线状态可更新
- 至少一种真实会话消息链路可展示

### 风险

- Android 客户端当前环境无法编译验证
- cleartext 和私网访问在不同 Android 版本上的行为可能有差异
- 事件模型若过于简陋，后续 bridge 接入会返工

## Phase 2：可用性增强

### 交付内容

- 会话状态持久化
- 更完整的命令集
- 本地通知
- 更好的 artifact 预览
- 基础 tmux 集成

### 为什么做这个

- MVP 跑通后，最大痛点会转向可靠性和操作效率
- 需要减少只在前台打开应用时才能看到的窗口期

### 成功标准

- 应用重连后可恢复最近状态
- 常用命令无需手输
- 通知可准确提示完成、失败、待确认

### 风险

- Android 后台限制会推高实现复杂度
- tmux 与不同 agent CLI 的输出协议不统一

## Phase 3：体验优化

### 交付内容

- 多会话视图
- 过滤与搜索
- richer card UI
- 更强的 agent adaptor 机制
- iOS / Web 兼容评估

### 为什么做这个

- 当实际 agent 数量增加后，信息组织会成为主要问题

### 成功标准

- 用户可快速定位等待确认 / 失败 / 完成的 agent
- 新 agent 类型能以较低成本接入

### 风险

- 若 Phase 1 协议边界不稳，Phase 3 会出现兼容性问题
