# E-Hentai 单图页 Flare Readability 兼容设计

## 背景

Flare 的 RSS 全文模式先使用 `moe.tlaster:readability` 提取 HTML 正文，再由 `RssRichText` 渲染。当前网关页面把导航区和图片区放在同级的 `section`、`figure` 中，Readability 会选择包含导航文字的区块，并丢弃未被选为正文候选的同级图片区，因此 Flare 只显示翻页和文件信息。浏览器直接渲染原始 DOM，不会触发这个问题。

## 目标

- Flare 打开 E-Hentai 详情时保留标题、上一页、计数、下一页和当前图片。
- 图片继续通过 `/_gateway/media/` 签名地址加载。
- 浏览器页面仍保持现有布局和翻页体验。
- 不修改 RSSHub 源码、RSSHub token 语义或 Flare 客户端。

## 设计

单图渲染器改用一个连续的 `div.eh-image-page` 作为正文候选容器。标题、导航和图片分别放入直接子级 `p`：

```html
<div class="reader eh-image-page">
  <p class="eh-image-title">标题</p>
  <p class="eh-image-nav">上一页　1 / 2　下一页</p>
  <p class="eh-image-content"><img id="img" src="/_gateway/media/..." /></p>
</div>
```

标题段落提供超过 Readability 最低候选长度的正文，令整个父级容器成为候选；图片段落包含真实 `img`，不会被清理。Flare 的渲染器会递归处理 `div`、`p` 和 `img`，因此会实际发起图片请求。CSS 将标题段和导航段恢复为原来的横向布局，图片段继续居中显示。

## 测试与验收

- 单元测试断言单图页面使用连续容器、三个段落和签名媒体地址，不再依赖同级 `figure`。
- 完整 Node 测试集通过。
- 生产容器重建后，详情 HTML 保留该结构。
- 通过请求日志确认 Flare 的 `ktor-client` 详情请求之后出现 `/_gateway/media/` 请求。
