# Astering 品牌素材

应用名为 **Astering**，自有版本标识为 **aster**。源码位于 [KanameMadoka520/Astering](https://github.com/KanameMadoka520/Astering)。产品基于 Vikunja，保留真实上游版权、来源和许可证；部署与历史产物规则见[品牌迁移](brand-migration.md)。

我们赋予 Astering“像星星闪烁、使之星光熠熠”的意象：一条记录、一次行动，逐渐连接成自己的星群。这是本项目的命名与设计寓意，不是已有词典释义的声明。星光可以通过斜向光隙表达，不要求图形是一颗完整五角星。

## 斜切 A 与工业配色

从 `aster.52` 起，标识采用两块不对称的斜切面和一道光隙。第一眼呈现向上的方向感，第二眼可以读出 Astering 的 A。采用炭黑 `#191919`、信号黄 `#fffa00`、白灰 `#f2f2f2`，以平面色、粗实体与留白建立张力。

此前五瓣旋转星孔容易让人联想到紫荆花，已退出当前素材与生成输入。后续维护应保持非放射的几何结构，不再使用五瓣、五等分花瓣或围绕中心旋转的花形。

色彩参考了[《明日方舟：终末地》官网](https://endfield.gryphline.com/en-us)、[官方宣传海报](https://web-static.hg-cdn.com/upload/image/20261014/be8cb7db7c9e1f307acf5c0caae546e7.jpg)与[官网实际 CSS](https://web-static.hg-cdn.com/endfield/official-v4/_next/static/css/1135c1a3999ef48b.css)。上述颜色确实用于其官方网页的强调色和结构面，不声称找到了一份官方品牌规范。Astering 借鉴配色和工业信息设计方法，没有复制游戏的标志、角色或版式，也不表示获得官方认可。

## 母版与来源

- **共用几何轮廓**：[astering-symbol.svg](../frontend/originalMedia/brand/astering-symbol.svg)。两个 `currentColor` 路径，只有直线段，无内嵌位图。
- **生成概念原稿**：[astering-rift-generated.png](../frontend/originalMedia/brand/astering-rift-generated.png)。保留设计来源，不作为运行时依赖。
- **头像构图**：[SVG](../frontend/originalMedia/brand/astering-avatar.svg)与[PNG](../frontend/originalMedia/brand/astering-avatar.png)。精确复用同一组路径，深底黄标，不进行独立模型重绘。
- **完整提示词与制作记录**：[astering-prompts.json](../frontend/originalMedia/brand/astering-prompts.json)。记录斜切 A、光帆两个探索方向与最终矢量化方法。

概念于 2026-11-04 使用内置 **imagegen** 生成，不使用 CLI/API 回退，也不把生成服务密钥写入仓库。生产 SVG 是参照选中概念，以原生多边形重新建立的几何，斜缝做了小尺寸可读性调整；不能将其表述为 imagegen 直接生成的 SVG，也不是原稿逐像素自动描摹。

阿罗娜是独立的助手角色，账户个人头像不随品牌更换。旧金色星灵、五瓣星孔及其制作记录保留在 Git 历史，不再作为当前发布输入。更早的第三方角色也没有作为这轮生成输入，不能据新形象反向宣称旧角色属于本项目原创。

## 明暗版本、图标与缓存

信号黄在白底上的对比很低，因此不能把黄色透明图直接放到浅色界面。公开资源位于 `frontend/public/images/brand/`：

| 资源 | 使用方式 |
| --- | --- |
| `logo.svg` / `logo.png` / `logo-1024.png` | 透明炭黑标识，用于浅色表面与邮件。 |
| `logo-dark.svg` | 透明信号黄标识，用于深色表面。 |
| `wordmark.svg` / `wordmark-dark.svg` | 浅深色字标均使用黄色底板与黑色几何，文字分别为炭黑和浅灰。 |
| `app-icon.svg` / `favicon.svg` | 带信号黄底板的黑色图形，供浏览器与桌面图标使用。 |
| `logo-mono.svg` | 纯黑同轮廓，供 Safari mask 和单色输出。 |
| `avatar.png` / `avatar.webp` | 炭黑底、信号黄图形的品牌头像。 |

应用内部独立 SVG 继承页面文字色；共享字标继承当前主题的文字色。PWA 图标采用不透明黄色底板，maskable 按实际图形核对中央安全圆；通知 badge 使用透明底与纯白轮廓。桌面各档直接渲染同一个带底板 SVG，不从低分辨率 PNG 放大。

固定品牌资源引用使用 `aster52`，覆盖 favicon、Apple/Safari 图标、PWA、登录头像与计时图标，避免继续使用已缓存的旧图样。固定路径仍使用 `no-cache` 与条件重验证；内容哈希构建资源沿用构建系统 URL，私人图片和任意固定路径不能因此获得永久缓存。

素材验收必须检查实际 16/24/32px、浅深色页面、中英文副标题、小屏溢出、通知单色版和手机裁切。新结构不再以“单连通轮廓、中心星孔”作为验收标准；应检查两块切面、斜缝与整体方向能否辨认。桌面系统可能缓存已安装图标，不能保证资源发布后系统图标立即刷新。

## 本地生成

```sh
cd frontend
pnpm install --frozen-lockfile
pnpm brand:assets
cd ../desktop
pnpm brand:assets
cd ..
cp frontend/public/images/brand/logo.png pkg/notifications/logo.png
```

[前端生成器](../frontend/scripts/brand-assets.mjs)用锁定的 Sharp 依赖离线生成头像、品牌图、字标和平台图标；[桌面生成器](../desktop/scripts/brand-assets.mjs)按目标尺寸直接从 SVG 渲染 1024px PNG 与七档 ICNS。邮件内嵌 PNG 必须同步复制并核对摘要。修改母版后检查实际消费者，不通过手改派生文件掩盖生成规则问题。

上游程序版权及 AGPL 义务继续保留。阿罗娜素材的来源及第三方角色权利见其[独立说明](../frontend/src/assets/arona/README.md)，本次更换不扩大那些素材的许可范围。
