# 0.2.5：去掉重复的悬浮按钮，把用量放回来（2026-11-07）

三条要求，一次改完。

## 1. 去掉右侧的会话栏按钮

DSH 自己在左上角（`shell.leading`，`12,11,28`）就画了一颗「打开侧边栏」，会话页和新建页都有；
我们右下那颗 38px 悬浮按钮和它功能完全重复，还压住过会话头的「…更多操作」。

现在 `mobile.js` 不再创建 `.dshm-rail-button`，抽屉直接用 DSH 自己的按钮开；点会话行仍然自动收起，
遮罩与 `data-dshm-rail` 继续按 DSH 的真实侧栏状态同步（0.2.4 的逻辑不变）。

## 2. 断开连接移到刷新旁边

原来那颗 `.dshm-power-button` 是画在网页里的悬浮按钮（`dshm://disconnect`）。现在改为**原生顶栏按钮**：

```
[←] 标题 · 状态胶囊   …   [刷新] [断开] [设置]
```

App 里 `btn_session_exit` 紧挨 `btn_session_refresh`，点它走原来的 `confirmDisconnect()`
（弹确认框：「断开后远端的会话会保留，可随时再点「打开」继续」）。网页侧的 `dshm://disconnect`
拦截保留，旧入口不会失效。

## 3. 用量放回来，但去掉「X 轮 X 步」

上一版把 `[data-slot="conversation.composer.bar"] [class*="_dock"]` 整个 `display:none` 了 ——
用户反馈「token 用量、token 速度都没了」。改成保留，只收掉噪音：

| 原来 | 现在 |
|---|---|
| `13 轮 755 步 · 175 tok/s` | `175 tok/s` |
| `198M tok · 缓存命中 99%` | 原样 |
| `44%`（上下文占用） | 原样 |

「轮 / 步」是纯文本节点、不是独立元素，CSS 删不掉，所以由 `mobile.js` 的 `trimActivityLabels()`
在每次 `mark()` 时把 pill 里分隔符之前的节点摘掉（`[data-composer-stat="activity"] [class*="_label"]`
里的 `*_sep` 之前的内容）。DSH 重渲染后会自动再裁一次。

布局上不再让它折行：`flex-wrap:nowrap` + `overflow-x:auto`，一行 26px 高，放不下就横向滚动。

## 实测（雷电 14，Android 14 / WebView 146）

```
dock: 332×26, display:flex
pills: ["158 tok/s", "958K tok·缓存命中 97%"]
rail:false  power:false            ← 两颗悬浮按钮确实没了
截图底栏仍有像素墨水            ← 统计行真的画出来了
```

App 顶栏（`uiautomator`）：

```
btn_session_back [24,60][96,132]
btn_session_refresh [644,60][716,132]
btn_session_exit [724,60][796,132]   ← 新增，紧挨刷新
btn_session_settings [804,60][876,132]
```

点「断开」正确弹出确认框（「断开连接 / 断开后远端的会话会保留… / 取消 / 断开」）。

## 升级

- 插件 0.2.5：`dsh plugin --profile desktop add link:D:/harness/dsh-remote-plugin`，手机刷新页面。
- App 0.7.6：装新的 APK（顶栏多了一颗按钮，必须换包）。