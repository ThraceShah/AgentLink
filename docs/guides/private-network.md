# 私网与 Tailscale 运行说明

## 推荐部署方式

- hub 运行在家庭主机、工作站或 NAS
- Android 与 agent 通过局域网或 Tailscale 访问 hub

## 地址建议

- 局域网：`http://192.168.x.x:8787`
- Tailscale：`http://100.x.y.z:8787`

## 移动 Web 原型访问

移动 Web 原型由 Hub 直接托管，不需要额外前端服务。

推荐访问：

- 本机验证：`http://127.0.0.1:8787/mobile/`
- 局域网手机浏览器：`http://192.168.x.x:8787/mobile/`
- Tailscale 手机浏览器：`http://100.x.y.z:8787/mobile/`

页面会基于浏览器当前打开的地址自动推导：

- HTTP API 地址
- WebSocket 地址
- artifact 下载地址

因此通过局域网地址打开时会连接同一个局域网 Hub，通过 Tailscale 地址打开时会连接同一个 Tailscale Hub，不需要在页面内再配置 Hub 地址。

当前主机示例地址：

- 局域网：`http://192.168.31.113:8787/mobile/`
- Tailscale：`http://100.97.117.95:8787/mobile/`

若这些地址不可访问，应优先检查：

- Hub 是否运行并监听 `0.0.0.0:8787`
- 手机是否与主机处于同一局域网或同一 tailnet
- 本机防火墙是否允许 TCP `8787`
- 浏览器是否能访问对应地址的 `/healthz`

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
