# 设置页预览（不启动 DSH）

把「手机访问 / 远程电脑」两页从 DSH 里单独拿出来渲染，用来调样式、比明暗主题、截图。

```bash
# 1) 从已安装的 DSH 里抽出真实主题 token（每次 DSH 升级后重跑一次）
node preview/extract-theme.mjs "D:/dsh/resources/app.asar"

# 2) React 18 的 UMD 构建（只给这个预览页用，不进包）
npm i --no-save react@18 react-dom@18

# 3) 起服务
node preview/serve.mjs 4599
#   http://127.0.0.1:4599/?theme=dark&lang=zh
#   http://127.0.0.1:4599/?theme=light&lang=en
```

服务直接从仓库根目录读 `client.js`（改完刷新即见），并把 `/__mobile/*`、`/__pc/*`
用假数据顶上：局域网跑在 8320、配对码 482913、中转「已连接」、两台已配对设备。

主题切换和 DSH 一样靠 `<body data-ds-dark-theme>`——所以这里看到的就是真实 token 下的效果，
不需要改 DSH 的主题设置。
