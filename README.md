# dsh-remote-plugin

把本机的 DeepSeek Harness 桌面端接到手机上（0.1.1：合并了「手机访问」与「远程电脑」两个方向）。
两种通路共用同一套反向代理：

| 通路 | 适用场景 | 手机怎么连 |
|---|---|---|
| **同一 Wi-Fi** | 家里 / 办公室，电脑和手机同一网段 | 扫码打开 `http://<电脑IP>:8320/`，输入 6 位配对码 |
| **中转服务器** | 电脑在内网、手机在外网，电脑不能开公网端口 | 手机 App 扫码，电脑主动连出 AES-128-GCM 加密隧道 |

两种方式都**不需要**把 DSH 暴露到公网，也不需要改 DSH 的 `--host`。

## 安装

插件已作为 `link:` 依赖装在 `desktop` profile 里（`dsh.profile.bundles` 也要有它）：

```bash
dsh plugin --profile desktop add link:D:/harness/dsh-remote-plugin
```

`dsh plugin` 会把包加进依赖；profile 的 `package.json` 里 `dsh.profile.bundles` 需要包含
`dsh-remote-plugin`，bundle 的 patch（`cordis.patch.yml` 的 `mobile-bridge` 行）才会被应用。
HMR 打开时改动即时生效，否则重启 DSH。

> **不要和旧的 `dsh-mobile-bridge`（0.1.0）同时启用。** 两者的设置页工厂都注册在浏览器模块表里，
> 且旧版客户端把工厂 id 写死成 `dsh-mobile-bridge`；同时加载会报
> `duplicate factory registration`，并让整个 web boot 起不来。
> 本版工厂 id 已改为 `dsh-remote-plugin`，与包名一致——客户端模块 id **必须**等于包名，
> 否则入口报 `loaded without registering "<id>"`。

## 使用

打开 **设置 → 手机访问**：

- **同一 Wi-Fi**：地址、二维码、6 位配对码、已配对设备数。手机扫码 → 输入配对码 → 进入 DSH。首次进入后可在手机浏览器里「添加到主屏幕」。
- **中转服务器**：填地址（如 `relay.example.com:9443`）并保存，状态变「已连接」后，手机 App 扫右侧二维码即可。二维码里是 `dshm://relay?url=…&room=…&key=…` 连接码，也可以「复制连接码」粘贴进 App。

**设置 → 远程电脑**：把另一台电脑「手机访问」里的 `dshm://` 连接码粘进来，本机就能直接操作那台电脑上的 DSH；
会话、模型调用和工具执行都还在远端跑，本机只做代理。

配对码 10 分钟有效、用后即换；「全部断开」撤销全部手机授权。

## 设置页样式（0.2.x）

设置页的样式全部用 DSH 的设计 token，没有硬编码颜色，因此跟随明暗主题：

- 主按钮：`--dsw-alias-button-primary-fill` / `--dsw-alias-button-primary-hover`，
  文字用 `--dsw-alias-label-primary-foreground`。
  暗色主题下 `--dsw-alias-brand-primary` 是**近白色**（`#f9fafb`），直接配 `color:#fff`
  会得到 1.05:1 的对比度（肉眼等于空白），这就是 0.1.0 暗色下按钮「看不见字」的原因。
- 次级按钮：`--dsw-alias-bg-layer-2` + `--dsw-alias-border-l2`，hover 用 `--dsw-alias-interactive-bg-hover`。
- 输入框：`--dsw-alias-bg-base` 底 + `--dsw-alias-border-l2` 边；聚焦换成 `--dsw-alias-button-info-fill`。
- 二维码底板**故意**保持纯白（扫码需要亮底色），另加一条 `--dsw-alias-border-l2` 描边，
  免得在暗色卡片上像一块发光方块。

## 中转服务器

见 [`../dsh-mobile-relay`](../dsh-mobile-relay/README.md)。电脑只发起出站 TCP 连接，所以不需要端口映射、DDNS 或 HTTPS 证书。

## 手机布局

桌面端是「56px 图标栏 + 对话 + 右侧栏」的三栏网格；DSH 自己的窄屏模式在展开时还会把 390px 切成 280/110。手机上看就是挤。

`assets/mobile.css` + `assets/mobile.js` 由 bridge 注入到页面里（`/__mobile/mobile.css`、`/__mobile/mobile.js`），做四件事：

- 对话始终占满整个视口，图标栏改成**覆盖式抽屉**；右上角一个浮动按钮打开会话列表，点会话后自动收起。
- 隐藏右侧栏入口、余额鲸鱼挂件、输入框下方的 token/速度统计。
- 对话行高 1.65、聊天区左右留白 12px，正文不再贴边。
- DSH 设置弹窗改成手机布局：导航列变成顶部横向标签页，内容区占满宽度。

这是对桌面 DOM 的适配层，用 `[class*="sidebarCol"]`、`[data-slot="..."]` 这类语义后缀定位；DSH 大版本改结构时可能需要跟着调。桌面浏览器不受影响（只注入给经过 bridge 的页面）。

## 传输优化

- 转发浏览器的 `Accept-Encoding`：上游对 JS/CSS 做 gzip，HTML 需要注入时先在 bridge 里解压。
- 给 `/plugins/*`、`/assets/*` 的响应补 `Cache-Control: public, max-age=31536000, immutable`（URL 带 `rev`/内容哈希），手机 WebView 第二次启动直接命中缓存。
- 手机 App 内置了 4.8MB 的壳资源，连 `/assets/*` 都不用过隧道。

## 安全模型

- 桌面端的 DSH 会话 Cookie 只存在于桌面进程内，手机拿到的是独立的 bridge 授权（`dshmb`，HMAC 签名、HttpOnly、30 天）。
- 局域网监听要求 6 位配对码；每个 IP 10 分钟最多 8 次尝试。
- 中转通路的载荷用房间密钥派生的 AES-128-GCM 端到端加密，中转服务器只按 `channel/stream` 转发帧，**拿不到密钥、读不到内容**。
- 连接码（`dshm://…`）等同于钥匙，谁拿到谁就能连；不要发到公开群组。

## Windows 防火墙

局域网通路需要放行入站 TCP 8320。规则名：

```
DSH Mobile Bridge (LAN 8320)   TCP 8320   入站   域/专用/公用
```

不需要时删除：

```powershell
netsh advfirewall firewall delete rule name="DSH Mobile Bridge (LAN 8320)"
```

## 配置

`cordis.patch.yml` 里的 `mobile-bridge` 行：

```yaml
- insert:
    - id: mobile-bridge          # loader 行 id（profile patch 用这个 id 覆盖）
      name: dsh-remote-plugin    # 包名，必须能解析到已安装的包
      config:
        lan:
          enabled: true
          host: 0.0.0.0          # 想只绑某块网卡时填具体 IP
          port: 8320
          publicHost: ''         # 覆盖对外展示的主机名（如 Tailscale 名称）
          sessionDays: 30
        relay:
          url: ''                # host:port；设置页里保存的值优先
        clientLink: ''           # 反向：本机要去连的远端 dshm:// 连接码
        clientPort: 8331         # 反向代理在本机监听的端口
```

## 本机路由

设置页通过这些同源接口读写状态（都要求桌面浏览器已登录）：

| 路由 | 作用 |
|---|---|
| `GET /__mobile/status` | 局域网/中转/直连状态、配对码、设备数 |
| `GET /__mobile/qr.svg?kind=lan\|relay` | 二维码 SVG |
| `POST /__mobile/pair/rotate` | 换配对码 |
| `POST /__mobile/devices/clear` | 撤销全部手机授权 |
| `POST /__mobile/relay/config` | 保存中转地址 `{ "url": "host:port" }` |
| `POST /__mobile/relay/reset` | 更换房间（room/key） |
| `GET /__mobile/direct.json` | 直连候选地址 |
| `GET /__pc/status` · `POST /__pc/link` | 远程电脑方向：状态、保存连接码 |

模型侧还有一个 `mobile_access` 工具，`action` 取 `status` / `pair` / `revoke` / `relay-reset`。

## 自测

```bash
node test/lan-e2e.mjs     # 配对、Cookie、HTML 注入、WebSocket
node test/relay-e2e.mjs   # 中转协议、多手机、篡改拒绝
```

宿主半侧可以脱离 DSH 单独冒烟：用假的 `ctx`（`webServer.register` / `connection.admit` / `get('tools')`）
import `index.js` 再 `apply(ctx, config)`，检查路由表与 8320 监听是否起来。

## 已知限制

- 手机端拿到的是桌面 UI，不是原生界面；390px 宽度下侧栏会收成 56px 图标栏，聊天区可用。
- 只支持一个桌面、多个手机；中转房间同时最多 16 个手机连接。
- 没有文件选择器/通知/后台常驻（Android 端说明见 `dsh-mobile-android`）。

## 预览

`preview/` 里有脱离 DSH 的单页预览（真实主题 token + 假数据），调样式不必重启应用：

```bash
node preview/extract-theme.mjs "D:/dsh/resources/app.asar"
node preview/serve.mjs 4599   # http://127.0.0.1:4599/?theme=dark
```

改完样式与暗色对比度实测见 [`docs/2026-10-24-contrast-and-boot-fix.md`](docs/2026-10-24-contrast-and-boot-fix.md)。
