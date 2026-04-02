# 私网与 Tailscale 运行说明

## 推荐部署方式

- hub 运行在家庭主机、工作站或 NAS
- Android 与 agent 通过局域网或 Tailscale 访问 hub

## 地址建议

- 局域网：`http://192.168.x.x:8787`
- Tailscale：`http://100.x.y.z:8787`

## 安全边界

- MVP 假设运行环境是个人可控私网
- 默认不暴露到公网
- 默认不依赖 HTTPS

若后续需要更强保护，可增加：

- Tailscale ACL
- 反向代理 + 内网 TLS
- hub token

## Android cleartext 注意事项

- Android 默认会限制 cleartext
- 本项目通过网络安全配置显式允许私网目标
- 若切换到 HTTPS / WSS，可移除对应 cleartext 例外

## Android 端地址输入建议

Android 客户端当前在界面顶部直接输入 hub 地址。

推荐输入：

- 局域网：`http://192.168.x.x:8787`
- Tailscale：`http://100.x.y.z:8787`

客户端会基于该地址自动推导 WebSocket 地址与 artifact 下载地址。
