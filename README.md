# DSH Remote Plugin

> English summary: the desktop (controlled) side of DSH Remote. A DeepSeek Harness Host plugin that
> pairs a phone over the LAN or keeps an outbound AES-128-GCM tunnel to a relay, serves the DSH web
> UI to the phone, and injects a phone layout into it.

把本机的 DeepSeek Harness 接到手机上的**电脑端插件**。手机端 App 与中转服务器分别在：

- 手机客户端：[umeabc/dsh-remote-android](https://github.com/umeabc/dsh-remote-android)
- 中转服务器：[umeabc/dsh-remote-relay](https://github.com/umeabc/dsh-remote-relay)

```
Phone App ──TCP+AEAD──▶ Relay ◀──TCP+AEAD── dsh-remote-plugin ──▶ 127.0.0.1:8319 (DSH)
Phone ──http://电脑IP:8320──▶ 同一 Wi-Fi 直连 ──▶ dsh-remote-plugin ──▶ 127.0.0.1:8319
```

两种通路共用同一套反向代理；电脑不需要公网 IP、不需要证书，`127.0.0.1:8319` 保持不变。

## 功能

- **局域网配对**：`0.0.0.0:8320` 监听，6 位配对码（10 分钟、用后即换、每 IP 限次），
  手机浏览器扫码打开；配对后持有 HMAC 签名的 `dshmb` 授权 Cookie。
- **中转隧道**：主动连出中转、AES-128-GCM 端到端加密、按 `channel/stream` 多路复用，
  支持多台手机；中转只转发密文帧。
- **手机布局注入**：只注入给经过插件的页面——对话全宽、侧栏变覆盖抽屉、隐藏桌面挂件、
  把 DSH 设置页改成顶部标签 + 满宽内容。
- **设置页**：**设置 → 手机访问**，显示局域网地址/二维码/配对码/设备数、中转地址与连接二维码。
- **模型工具**：`mobile_access`（status / pair / revoke / relay-reset）。

## 安装

插件是一个普通 DSH bundle（`package.json` 里的 `dsh.bundle.patch` 指向 `cordis.patch.yml`）。

```bash
# 用 dsh CLI
dsh plugin --profile desktop add "/path/to/dsh-remote-plugin"

# 或在 Harness 里用 plugin_manager 的 install_bundle，目标填这个目录
```

安装后重载/重启 `mobile-bridge` 行。默认配置在 `cordis.patch.yml`：

```yaml
- insert:
    - id: mobile-bridge
      name: dsh-mobile-bridge
      config:
        lan:
          enabled: true
          host: 0.0.0.0
          port: 8320
        relay:
          url: ''
```

`relay.url` 也可以直接在设置页里填，保存后立即重连，不需要改配置文件。

## 使用

1. 打开 **设置 → 手机访问**。
2. 同一 Wi-Fi：手机扫左侧二维码 → 输入桌面显示的 6 位配对码。
3. 外网：先在中转服务器上启动 `dsh-remote-relay`，在设置页填 `你的服务器:9443`，
   状态变「已连接」后，用手机 App 扫右侧二维码（或复制连接码粘贴）。

连接码格式（`dshm://`）由中转地址 + 房间 ID + 房间密钥组成，等同于钥匙，不要公开发布。

## 局域网与防火墙

局域网通路需要在系统防火墙上放行入站 TCP（默认 8320）。Windows：

```powershell
netsh advfirewall firewall add rule name="DSH Remote (LAN 8320)" dir=in action=allow protocol=TCP localport=8320
```

不需要时删除同名规则。中转通路是主动出站，不需要任何入站规则。

## 本机路由

设置页通过这些同源接口读取状态（都要求桌面浏览器已登录）：

| 路由 | 作用 |
|---|---|
| `GET /__mobile/status` | 局域网/中转状态、配对码、设备数 |
| `GET /__mobile/qr.svg?kind=lan\|relay` | 二维码 SVG |
| `POST /__mobile/pair/rotate` | 换配对码 |
| `POST /__mobile/devices/clear` | 撤销全部手机授权 |
| `POST /__mobile/relay/config` | 保存中转地址 `{ "url": "host:port" }` |
| `POST /__mobile/relay/reset` | 更换房间（room/key） |
| `GET /__mobile/mobile.css\|mobile.js` | 注入的手机布局资源 |

## 安全模型

- 桌面端的 DSH 会话 Cookie 只存在于电脑进程内；手机拿到的是插件自己签发的 `dshmb` 授权。
- 局域网：6 位码 + 限次 + 可撤销；每台设备独立。
- 中转：房间密钥从不发给中转；载荷 AES-128-GCM 端到端加密，中转只能看到帧头。
- 本机 `/__mobile/*` 接口要求浏览器已登录；局域网侧只公开 manifest/图标/静态布局资源。

## 配置项

| 字段 | 默认 | 说明 |
|---|---|---|
| `lan.enabled` | `true` | 是否启动局域网监听 |
| `lan.host` | `0.0.0.0` | 绑定地址；也可填某个具体网卡 IP |
| `lan.port` | `8320` | 监听端口 |
| `lan.publicHost` | `''` | 对外展示的主机名（如 Tailscale 名称） |
| `lan.sessionDays` | `30` | 手机授权的有效期 |
| `relay.url` | `''` | 中转地址 `host:port`；设置页保存的值优先 |
| `relay.enabled` | `true` | 是否允许中转通路 |

## 自测

```bash
node test/lan-e2e.mjs                                   # 配对/Cookie/HTML 注入/WebSocket
DSH_RELAY_JS=/path/to/dsh-remote-relay/relay.js \
  node test/relay-e2e.mjs                               # 双手机/未知房间/篡改帧
```

`test/relay-e2e.mjs` 需要一个中转 `relay.js`；不设置 `DSH_RELAY_JS` 时会直接跳过。

## License

MIT
