# vikunja-x 品牌素材

应用名统一为 **vikunja-x**；中文版本标识为 **-x 版**，英文为 **-x edition**。源码位于 [KanameMadoka520/vikunja-x](https://github.com/KanameMadoka520/vikunja-x)。这是独立维护的 Vikunja 分支，上游版权、AGPL-3.0-or-later 许可证和致谢保持不变；内部 API、配置键与 `v2.7.1-tcymc.N` 版本序列不因视觉更名而迁移。

## 素材与使用

- 标识母版：[主标识](../frontend/originalMedia/brand/vikunja-x-creature.svg)（24px 及以上）、[小尺寸版](../frontend/originalMedia/brand/vikunja-x-creature-small.svg)（16–32px 浏览器图标）、[单色版](../frontend/originalMedia/brand/vikunja-x-creature-mono.svg)（遮罩与通知）
- 发布标识：[Logo SVG](../frontend/public/images/brand/logo.svg)、[favicon SVG](../frontend/public/images/brand/favicon.svg)、[单色 SVG](../frontend/public/images/brand/logo-mono.svg)、[透明 Logo PNG](../frontend/public/images/brand/logo.png)
- [浅色背景字标](../frontend/public/images/brand/wordmark.svg)、[深色背景字标](../frontend/public/images/brand/wordmark-dark.svg)
- [品牌头像 PNG](../frontend/public/images/brand/avatar.png)、[登录页 WebP](../frontend/public/images/brand/avatar.webp)、[头像原图](../frontend/originalMedia/brand/avatar-source.png)
- [小生物方向稿](../frontend/originalMedia/brand/concepts/vikunja-x-creature-v2.png)（只作来源参考，不直接发布）；[旧 X 标识原图](../frontend/originalMedia/brand/logo-source.png) 已退役，脚本不再读取，仅存档

头像是原创蓝白色数字伙伴，用于项目头像、README 和登录页。它不替换用户的个人头像，也不改变阿罗娜的名称、人设或现有角色素材。导航使用小生物字标，避免人物头像与账户入口混淆。手机 maskable 图标有独立底色和安全边距。计时状态仍使用带红点的独立 favicon。

## 标识：芽耳小生物

标识是一只圆润梨形的小生物：两片短短的芽耳像种子刚长出的两片子叶，左大右小；正面一双眼睛和一道小小的笑。它表达"计划从一颗种子慢慢长出来"，同时保持安静、友好的气质。它不是阿罗娜的头像，没有人物、发型或服装特征，也不替换上面的品牌头像。

从方向稿到最终标识做了这些取舍：

- 去掉生成图上的纹理、杂点、渐变、阴影和滤镜，全部改为平涂；不含遮罩、嵌入位图或 `id`，同一页面内联多次也不会冲突。
- 身体改为正面对称，保证 16–24px 仍然稳定；耳朵保留不对称，留住生命感和"芽"的意象。
- 身体、两片芽耳和两只小脚合并为一条路径，配合 `paint-order="stroke"` 只画一圈外轮廓，内部接缝被填充覆盖。
- 64×64 网格，锚点基本落在 0.5 网格；主标识只有身体、芽耳内侧、眼睛、高光和嘴五组图形。
- 小尺寸版裁到 `3 2 58 58` 视框，加粗描边、放大眼睛，并去掉小脚、嘴和高光，这些细节在 32px 以下只会变成杂点。单色版沿用小尺寸版的外形和眼睛，眼睛为镂空（外形顺时针、眼睛逆时针绕向，按 nonzero 规则形成孔）。

### 色板

| 名称 | Hex | 用途 |
| --- | --- | --- |
| 薰衣草 | `#98A6F8` | 身体 |
| 靛蓝 | `#4B4FB8` | 外轮廓；Safari `mask-icon` 颜色 |
| 薄荷芽 | `#ADF0DA` | 芽耳内侧（装饰色） |
| 夜色 | `#1E2043` | 眼睛、嘴 |
| 白 | `#FFFFFF` | 眼睛高光 |
| 浅薰衣草底板 | `#F3F1FF` | 应用图标、maskable 图标底色 |
| 字标文字 | `#17243B` / `#EEF5FF` | 浅色 / 深色背景字标 |

对比度（WCAG 相对亮度）：浅色背景（`#FFFFFF`、`#F3F4F6`）上身体只有 2.3:1 / 2.1:1，外形由靛蓝描边承担（6.8:1 / 6.1:1）；深色背景（`#0D1119`、`#1A1D24`）上描边只有 2.8:1 / 2.5:1，外形由身体承担（8.2:1 / 7.3:1）。因此在常见浅色和深色界面上，外缘总有一层达到 3:1 的非文本对比要求。眼睛对身体 6.8:1；薄荷对身体约 1.8:1，只做点缀，不承担识别。

### 使用规则

- 最小尺寸：主标识不小于 24px（嘴和高光在 24px 会自然淡出，属预期）；16–32px 的浏览器标签图标使用小尺寸版；单色版不小于 16px。
- 留白：标识四周至少留出标识高度的 1/8（例如 32px 标识留 4px）。字标中图形与文字的间距以模板为准，不要压缩。
- 浅色与深色：图形本身可直接用于浅色和深色背景，不需要反色版本；只有字标文字区分 `wordmark.svg`（`#17243B`）和 `wordmark-dark.svg`（`#EEF5FF`）。应用内 `Logo.vue` 的文字使用 `currentColor`（`--logo-text-color`），跟随主题。
- 避免中等亮度的蓝紫色背景：身体和描边会同时失去对比；在彩色或照片背景上改用单色版。
- 单色：`logo-mono.svg` 只有一种颜色，默认黑色，可通过 `fill` 或 `currentColor` 改色；用于 Safari `mask-icon`、Android 通知徽标和只能显示单色的场合。不要给单色版加描边或第二种颜色。
- 不要拉伸、旋转、加阴影、渐变或发光，不要改色板，不要单独使用耳朵或脸，也不要给它添加人物特征或当作阿罗娜头像使用。

### 本次改稿涉及的文件

- 新增三个母版：`frontend/originalMedia/brand/vikunja-x-creature.svg`、`vikunja-x-creature-small.svg`、`vikunja-x-creature-mono.svg`。
- `frontend/public/images/brand/logo.svg`、`wordmark.svg`、`wordmark-dark.svg` 改为纯矢量，不再嵌入 PNG（单个文件由约 62 KB 降到约 1.5 KB）。字标文字基线由 `y=44` 下移到 `y=46`、Pride 条由 `y=53` 移到 `y=55`，让文字和小生物的眼睛线对齐；字号、字距和横向位置不变。
- 新增 `frontend/public/images/brand/favicon.svg`（小尺寸版）和 `logo-mono.svg`（单色版）。
- `frontend/index.html` 新增 `mask-icon`，指向 `logo-mono.svg`；`favicon.ico` 与苹果图标链接不变。
- `frontend/scripts/brand-assets.mjs` 的输入由 `logo-source.png` 改为三个 SVG 母版，原有输出路径不变，另外写出 `favicon.svg` 和 `logo-mono.svg`。应用图标底板由 `#EEF5FF` 改为 `#F3F1FF`，标识缩放到 84% 居中，四周留出呼吸空间。
- 运行脚本后才会更新的派生文件：`frontend/src/assets/logo.svg`、`logo-full.svg`、`logo-full-pride.svg`（`Logo.vue` 与迁移页使用），`frontend/originalMedia/images/logo*.svg`，`public/images/brand/logo.png`、`logo.webp`，`public/favicon.ico`，以及 `public/images/icons/*` 和 `originalMedia/icons/*`。

## 重新生成发布尺寸

```sh
cd frontend
pnpm install --frozen-lockfile
pnpm brand:assets
```

脚本 `scripts/brand-assets.mjs` 使用锁定的 Sharp 版本（其中的 librsvg 负责 SVG）离线生成 Logo、字标、ICO、PWA、Apple、Safari 与通知图标，并从头像原图生成头像尺寸。每个尺寸都按目标像素直接栅格化矢量母版，不放大位图；只调整发布尺寸、编码、图标底板和安全边距，不重新请求模型。静态图标 URL 带品牌版本标识，帮助已安装客户端识别图标更新；系统桌面仍可能按自己的周期刷新图标缓存。

root 合并本次改稿时：

1. 运行上面的命令，确认上一节列出的派生文件都已更新，并目视检查 `favicon-16x16.png`、`apple-touch-icon-180x180.png`、`icon-maskable.png` 和 `badge-monochrome.png`。
2. 把 `frontend/index.html` 与 `frontend/vite.config.ts` 中所有图标链接的 `?v=x29` 一起递增（例如 `x30`），已安装的 PWA 才会换新图标。
3. `favicon.svg` 暂未接入 `index.html`：`useTimeTrackingFavicon` 只替换第一个 `link[rel="icon"]`，如果再加一个 SVG 图标，浏览器会优先显示 SVG，计时红点就看不到了。要接入，需要先让该组合式函数在计时期间替换或移除所有 `rel="icon"` 链接。ICO 已由同一小尺寸版生成，标签页里的视觉一致。
4. 以后修改图形时，只改 `originalMedia/brand` 下的三个 SVG 母版并保持路径绕向，然后重新运行脚本；不要手改 `public/images/brand` 和 `src/assets` 下的派生 SVG。

## 来源、生成方式与授权

- 小生物方向稿 `originalMedia/brand/concepts/vikunja-x-creature-v2.png` 由 root 于 2026-11-01 使用内置 **imagegen** 生成；该稿的提示词没有随文件记录，如需复用请 root 补录。
- 最终标识是依据方向稿在仓库内手写的 SVG 路径，不是自动描摹，也不含嵌入位图。小尺寸版和单色版由同一组路径简化而来。
- 头像和已退役的 X 标识于 2026-10-31 使用内置 **image_gen** 生成，不是 CLI/API 回退。头像为不透明方图；X 标识开启了 `transparent_background: true`。

这些品牌原图和方向稿由维护者使用内置图像生成工具产出，最终标识为仓库内手写矢量，均不是下载的第三方游戏素材；随本仓库公开，按本仓库许可证提供维护者能够授予的使用权限。既有阿罗娜素材仍遵循其[单独来源说明](../frontend/src/assets/arona/README.md)。

完整提示词如下，便于以后复用和迭代。

### 头像

> Use case: logo-brand. Create an ORIGINAL avatar mascot for the open-source app Vikunja-X, a personal project planning app with an AI companion. A polished square anime-inspired avatar, close-up bust of a friendly and quietly capable young adult female digital assistant, icy white hair with pale sky-blue tips, a short neat bob with a small asymmetrical fringe, expressive clear blue eyes, subtle smile, clean white and navy futuristic jacket. Distinctive tiny cobalt X-shaped hair clip, an abstract orbit arc behind her, subtle geometric X motif. Palette white, cobalt #2878ff, pale cyan, tiny lavender accent. Flat elegant cel shading, restrained detail, crisp silhouette readable as 40px circular avatar. Center face in middle, keep generous safe margins for circular crop. Full-bleed pale blue background with a very subtle circular gradient. No text, no letters except the small geometric X symbol, no watermark, no animal ears, no complicated scenery. Original character, not a copy of any existing anime/game character. Professional charming calm visual identity, not childish, not glossy plastic 3D. Output one single square avatar image, not a contact sheet.

### 已退役的 X 标识

仅作历史记录；`logo-source.png` 已不再参与生成。

> Use case: logo-brand. Asset: production logo icon for Vikunja-X, open-source personal project manager with an anime-inspired AI companion, blue-white visual identity. Create one beautifully restrained geometric X mark with a distinctive cut: two broad rounded diagonal ribbons crossing, one cobalt blue #2878ff, the other icy cyan-blue, a small clean negative-space diamond at their center. A very subtle short orbit arc can echo planning/time but must not clutter the X. Compact, balanced symmetrical silhouette, smooth vector-like crisp edges, mostly flat colors with only extremely subtle tonal variation. The mark occupies 70 percent of the square canvas, centered, generous padding. Must read immediately at favicon size; no thin decorative fragments. Transparent background, no white plate or backdrop, no cast shadow. No text, no wordmark, no labels, no mockup, no watermark, no multiple alternatives. Original logo, sophisticated friendly open-source product design, not a game badge, not glossy plastic. Single square logo mark only.
