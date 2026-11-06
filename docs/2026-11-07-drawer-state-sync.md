# 0.2.4：点「新会话」后按钮消失、底色变暗（2026-11-07）

真机/模拟器反馈：「点新对话时，旁边的两个按钮消失，然后背景色不同。」

## 复现

雷电 14（Android 14，WebView 146）上装 DSH Remote 0.7.5，配对后进入会话，**在抽屉里点最上面的
「新会话」按钮**。用 WebView 远程调试读页面状态：

```
before        rail=flex  scrim=none                 data-dshm-rail=null
drawer open   rail=none  scrim=block  sidebar=open  data-dshm-rail=1
clicked       wtg9ga_newSession
after new     rail=none  scrim=block  sidebar=closed data-dshm-rail=1   ← 卡住
after 4.5s    rail=none  scrim=block  sidebar=closed data-dshm-rail=1   ← 还是卡住
```

DSH 自己把侧栏关掉了（`translateX(-280px)`），但**我们打的 `data-dshm-rail` 还停在 1**：

- `html[data-dshm-rail='1'] .dshm-rail-button { display:none }` → 两颗悬浮按钮消失；
- `.dshm-scrim` 仍 `display:block` → 一层 `rgba(15,23,42,.36)` 盖在页面上 → 「背景色不同」；
- 更糟的是这层遮罩会吃掉点击（虽然点它本身会关掉，但视觉上就是卡住了）。

## 根因

`assets/mobile.js` 的关闭逻辑只看**点击目标**：

```js
if (target.closest('[class*="sessionRow"]') === null) return;
window.setTimeout(closeDrawer, 160);
```

侧栏顶部的「新会话」按钮（`wtg9ga_newSession`）不是 session row，所以这个 handler 直接 return；
而 DSH 在它自己的逻辑里把侧栏收起来了 —— 两边的状态就此分叉。工作区行、快捷键、深链同理。

## 改法

不再猜「点了什么」，而是**读 DSH 的真实状态**：侧栏折叠按钮的 `aria-label` 在展开态是
「收起侧边栏」/`Collapse sidebar`，据此把 `data-dshm-rail` 与遮罩同步过去。

```js
function dshExpanded() {
  return document.querySelector('[aria-label="收起侧边栏"], [aria-label="Collapse sidebar"]') !== null;
}
function syncDrawer() { /* 只在状态不一致时改写，避免抖动 */ }
```

触发点：

- 任何点击后 60 / 220 / 600ms 各同步一次（覆盖 DSH 的动画与异步渲染）；
- `mark()`（MutationObserver + 启动期 500ms×20）里同步；
- 再挂一个 800ms 的慢速兜底，覆盖快捷键、深链、App 重开等没有点击的状态变化。

点击 session row 仍然走原来的立即关闭路径，不变。

## 实测

| 动作 | 结果 |
|---|---|
| 抽屉打开 | `data-dshm-rail=1`、遮罩显示、按钮隐藏（本来就是对的） |
| 点「新会话」 | `data-dshm-rail=null`、遮罩隐藏、**两颗按钮回来**（修复前是隐藏 + 遮罩卡住） |
| 点工作区行 | 抽屉保持打开，遮罩与按钮状态一致（符合预期） |
| 点会话行 | 立即收起（原行为保持） |

页面底色回到 `rgb(21,21,23)`，也就是 DSH 自己的深色底，不再被那层遮罩压暗。

## 说明

这个修复在**桌面插件**里（`/__mobile/mobile.js` 由插件供给），不在 APK 里 —— 手机刷新页面即可生效，
不用重装 App。