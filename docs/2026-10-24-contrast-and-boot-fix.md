# 0.1.1 收尾记录（2026-10-24）

## 1. 崩溃根因（已修）

浏览器插件模块的身份 = 包的 manifest 名字。`dsh-remote-plugin` 0.1.1 的 `client.js` 当时还写着

```js
window.__ModuleLoader__.load({ id: 'dsh-mobile-bridge', factory })
```

于是：

- 行 id 是 `dsh-remote-plugin`，注册的工厂却是 `dsh-mobile-bridge`
  → `loaded without registering "dsh-remote-plugin"` → web boot 报 `1 entry did not activate`；
- 旧插件同时在线时两边注册同一个 id
  → `duplicate factory registration for "dsh-mobile-bridge"`。

现在工厂 id、样式标签、宿主 `name` 导出都统一成 `dsh-remote-plugin`，并且 profile 里不再链接旧的
`dsh-mobile-bridge`。

## 2. 暗色模式对比度（已修）

实测 0.2.1-rc.3 的主题 token：

| token | 亮色 | 暗色 |
|---|---|---|
| `--dsw-alias-brand-primary` | `#0f1115` | `#f9fafb` |
| `--dsw-alias-button-primary-fill` | `#0f1115` | `#f9fafb` |
| `--dsw-alias-label-primary-foreground` | `#fff` | `#0f1115` |

老代码 `background: brand-primary` + `color:#fff` 在暗色下就是**白底白字**，对比度 **1.05:1**。
（见 `docs/shots/01-dark-before.png` 里「保存」整块空白。）

改法：主按钮用 `button-primary-fill` / `button-primary-hover`（hover）
+ `label-primary-foreground` 作文字色；禁用态用 `button-primary-dimmed` + `label-secondary`；
次级按钮 hover 用 `interactive-bg-hover`；输入框边线 `border-l2`、聚焦 `button-info-fill`；
二维码底板保持纯白（扫码需要亮底色），加 `border-l2` 描边。

暗色下主按钮实测 **18.08:1**（`docs/shots/02-dark-after-live.png`），亮色 18.9:1。

## 3. 其它补齐

- `GET /__pc/status` 之前只有客户端在轮询、宿主没注册 → 「远程电脑」永远显示「未配置」。已补。
- 「远程电脑」面板的硬编码中文改成 zh/en 两套文案。
- README 更新到 0.1.1（安装用 `link:`、bundle 选择、id 约束、token 说明）。

## 4. 验证方式

- 宿主半侧：假 `ctx` 冒烟（路由表、8320 监听、`mobile_access` 工具、优雅关闭）。
- 客户端半侧：本地预览页加载真实主题 CSS + 真实组件（React 18 UMD、stub `/__mobile/*`）。
- 线上：`dsh plugin add link:` 安装后，HMR 卸载/重载一次条目让宿主读新文件；
  用插件自己的上游代理（minted cookie）打开 GUI 截图确认两个设置页都渲染正常。
