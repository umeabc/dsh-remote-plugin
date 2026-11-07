# Changelog

## Unreleased（已合入 main，随下一个版本发布）

代码瘦身，**行为无变化**，对用户不可见：

- 删除确认无引用的死代码：`assets/mobile.js` 的 `openDrawer()`、`relay.js` 的 `closeQuietly()`、
  `core.js` 的 `delay()` 及其 import、`index.js` 的 `DEFAULTS.client`、`lan.js` 里只赋值不读取的
  `this.ctx`、`relay.js` 里 channel 状态没读过的 `salt`、`direct.js` 永远不会命中的 `f[cd]` 过滤。
- 合并三处重复：`sendJson` 复用 `sendText`、`relay.send()` 统一走 `encodeFrame`、
  room/key 生成抽成 `newRelayCredentials()`（路由不等待、工具等待的既有差异保持不变）。
- `docs/shots/` 十张截图转成**逐像素相同**的 WebP：479,497 → 155,566 字节（−68%）。

受跟踪内容 722,324 → 397,367 字节。测试：`lan 15/15`、`pool 4/4`、`relay 7 PASS`。

> `index.js` / `core.js` 属宿主半侧，**需重启 DSH** 才生效；`assets/`、`client.js` 刷新手机页面即可。

## 0.2.5

- 去掉网页侧两颗悬浮按钮：左上角 DSH 自带的「打开侧边栏」已经能开抽屉；「断开连接」改由
  [DSH Remote 0.7.6](https://github.com/umeabc/dsh-remote-android) 的顶栏提供（`dshm://disconnect` 仍保留）。
- 运行统计放回手机：保留 token 速度、累计 token、缓存命中与上下文占用，只去掉「N 轮 N 步」前缀；
  收成一行可横向滚动。

## 0.2.4

- 抽屉状态改为**跟随 DSH 的真实侧栏**，不再只按点击目标判断。此前点侧栏的「新会话」（以及工作区行、
  快捷键）时，DSH 自己收起了侧栏而我们的标记没变：两颗悬浮按钮消失、遮罩压在页面上
  （用户看到的「背景色不同」）且吃掉点击。

## 0.2.3

- 适配 DSH **0.2.2-rc.1**：
  - 会话被挤成三分之一宽（frame 变成三列、子元素钉在网格线上）→ 塌模板时把所有子元素放回第 1 条线；
  - 设置弹窗 0.2.2 自带窄屏布局，我们的兼容层只在弹窗仍是桌面尺寸时才打标记；
  - 会话头新增「…更多操作 / 打开方式 / 后台任务」把标题挤没 → 按结构隐藏（`[data-open-target]`、
    `titleCluster` 里的按钮），状态胶囊以后新增什么都覆盖；
  - 运行统计从 `composer.dock` 挪进 `composer.bar` 的 `*_dock`；
- 桌面视图（远程电脑 iframe）的压缩响应修复：`text/html` 原路径解压后又按原 `content-encoding`
  回明文，浏览器解码失败即白屏；现在桌面视图直接字节透传，解码失败也退回透传。
- `decompress()` 支持 zstd（防御性）。
- 上游连接池去掉并发上限、关闭时释放上游请求（见 0.2.2 的说明）。

## 0.2.2

- **连接池卡死修复**：DSH 的客户端 HMR 是 SSE（`/plugins/events`），手机每个页面长期占一条；
  固定 32 条的上游池在十几次打开后会让整条 bridge 排队挂死。现在不设并发上限、只限制空闲 socket，
  并在页面关闭时销毁对应的上游请求。`test/pool-e2e.mjs` 覆盖。
- **自动接管修复**：`POST /__pc/link` 应答时隧道仍在握手（`connected: false`），旧逻辑据此收起远端界面，
  导致「连上了却没接管」。改为按连接码是否还在判断，并在隧道连上后挂载。
- 手机隐藏 0.2.1 新增的运行统计；会话头为悬浮按钮让出 64px。
- 接管工具栏在 390px 不再折行。

## 0.2.1

- 接管工具栏避开 Windows 的原生标题栏按钮；远端视图不再继承手机布局；监听器可正常停止。

## 0.2.0

- 「接管整个窗口」：连接成功后把整个 DSH 窗口切成远端（iframe），不再另开浏览器窗口；
  断开、退出视图、刷新保持接管状态。

## 0.1.1

- 一个插件同时承担「手机访问」与「远程电脑」两个方向。
- 修复暗色主题下主按钮白底白字（改用 `button-primary-fill` + `label-primary-foreground`）。
- 工厂 id 与包名对齐（否则 `loaded without registering`）；补上缺失的 `/__pc/status`。

## 0.1.0

- 首版：局域网配对（6 位码）+ 中转隧道，手机可通过任一通路打开本机 DSH。