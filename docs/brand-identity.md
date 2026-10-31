# vikunja-x 品牌素材

应用名为 **vikunja-x**，中文版本标识为 **-x 版**，英文为 **-x edition**。源码在 [KanameMadoka520/vikunja-x](https://github.com/KanameMadoka520/vikunja-x)。内部配置键与 `v2.7.1-tcymc.N` 版本序列保持兼容。

## 角色形象（tcymc.33）

依据维护者指定的两张角色参考重新绘制：浅绿色头发、深色角与金色细节、中央深色发束、蓝眼睛、眨眼、红晕及爱心。主参考决定 Q 版神态，另一张用于核对角色配色和外形。参考图来自维护者私人网盘；原文件没有复制进公开仓库。

同一套形象分为两层：

- **详细头像**：捧心的双手和发饰保留，用于登录页及 README 品牌展示。母版 [avatar-source.png](../frontend/originalMedia/brand/avatar-source.png)，发布 [PNG](../frontend/public/images/brand/avatar.png) / [WebP](../frontend/public/images/brand/avatar.webp)。
- **简化标识**：减少发丝、手部与装饰，突出绿发、角、眨眼和爱心，用于导航字标、favicon 和桌面图标。母版 [logo-character-source.png](../frontend/originalMedia/brand/logo-character-source.png)，发布 [PNG](../frontend/public/images/brand/logo.png) / [SVG 容器](../frontend/public/images/brand/logo.svg)。
- **单色轮廓**：[手写 SVG](../frontend/originalMedia/brand/vikunja-x-character-mono.svg)，用于 Safari 固定标签与 Android 通知徽标。眼睛、眨眼与爱心镂空，颜色由使用场景决定。

品牌头像不会写入账户头像设置；阿罗娜的独立头像与角色设置保持原有用途。

## 小尺寸、背景与性能

两张生成母版均有真实 alpha 通道，不用纯色冒充透明。发布 PNG/WebP 保留 alpha；桌面与 maskable 图标使用浅鼠尾草底板 `#F1F4E8`。maskable 图形缩到 680 / 1024，保留安全区域。登录页采用完整容纳的头像，不以 cover 裁掉角或双手。

字标文字采用 `currentColor` 跟随主题；独立字标分别提供 [浅色](../frontend/public/images/brand/wordmark.svg) 和 [深色](../frontend/public/images/brand/wordmark-dark.svg) 版本。字标中的图形是嵌入的 160px 调色板 PNG，**并非矢量图**；这个尺寸足以支撑当前导航布局，同时避免将 1254px 原图放进前端 JavaScript。SVG 不依赖外部图片请求。导出更大尺寸时应使用 PNG 母版，不应放大 SVG 容器中的小图。

所有光栅尺寸均从母版生成；标签页 ICO 包含 16、32、48px 三档。计时状态仍有独立红点图标。图标与登录头像 URL 使用 `x33` 缓存标识；桌面操作系统可能按自己的周期刷新图标。

## 离线生成

```sh
cd frontend
pnpm install --frozen-lockfile
pnpm brand:assets
```

脚本 [brand-assets.mjs](../frontend/scripts/brand-assets.mjs) 使用锁定的 Sharp 版本生成 Logo、字标、头像、ICO、PWA、Apple、Safari 和通知图标，无网络请求。修改母版后运行脚本，不手改派生文件。需要替换角色时同时检查两种主题、16/32px、移动端和登录页，并递增 `index.html`、`vite.config.ts` 及登录头像的缓存标识。

旧 X 图形和芽耳形象仅在 Git 历史中保留，不进入本版构建输入。

## 来源与提示词

2026-11-01 使用内置 **imagegen** 生成详细头像，再以该头像为参考生成简化标识；没有使用 CLI/API 回退。完整的两次提示词见 [generation-prompts.json](../frontend/originalMedia/brand/generation-prompts.json)，便于复现和继续调整。单色标识在仓库内以 SVG 编写。

这是依据维护者提供的《明日方舟：终末地》角色图片绘制的衍生形象，不能声称角色本身为本项目原创或由本项目授权。相关角色与原参考作品权益属于各自权利人；本仓库代码许可证不授予第三方角色权利。项目与该作品无官方隶属关系。既有阿罗娜素材另见其 [来源说明](../frontend/src/assets/arona/README.md)。
