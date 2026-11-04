# Astering 品牌素材

应用名为 **Astering**，自有版本标识为 **aster**。源码位于 [KanameMadoka520/Astering](https://github.com/KanameMadoka520/Astering)。产品基于 Vikunja，保留真实上游版权、来源和许可证；部署与历史产物规则见[品牌迁移](brand-migration.md)。

我们赋予 Astering“像星星闪烁、使之星光熠熠”的意象：一条记录、一次行动，逐渐连接成自己的星群。这是本项目的命名与设计寓意，不是已有词典释义的声明。

## 五瓣星孔

从 `aster.51` 起，标识采用五片顺向舒展的有机轮廓，环绕中心星形留白。它既可以让人联想到花瓣和星光，也保留轻微的生命感；没有依赖眼睛、微笑或细小装饰来表达身份。主色为鸢尾紫 `#6857D9`，头像用深夜蓝底与浅色轮廓，单色版保持同一几何。

本轮调研了 GitHub 高 Star AI 项目的官方视觉，包括 [Firecrawl](https://github.com/firecrawl/firecrawl)、[ComfyUI](https://github.com/Comfy-Org/ComfyUI)、[DeepSeek](https://github.com/deepseek-ai/DeepSeek-V3)、[OpenCode](https://github.com/anomalyco/opencode)、[Ollama](https://ollama.com)、[Open WebUI](https://openwebui.com) 等。调研取样于 2026-11-04，不代表全 GitHub 的绝对排名。这些参考支持的是设计方法：清晰剪影、足够大的留白、有限配色、同一标识适用于小图标与单色场景；本项目没有复制这些项目的图形，也不声称获得它们的认可。

## 母版与来源

- **共用矢量轮廓**：[astering-symbol.svg](../frontend/originalMedia/brand/astering-symbol.svg)。所有尺寸和单色资源的几何来源，使用 `currentColor`，没有内嵌位图。
- **头像构图**：[astering-avatar.svg](../frontend/originalMedia/brand/astering-avatar.svg) 与 [PNG](../frontend/originalMedia/brand/astering-avatar.png)。直接复用同一个路径，置于深夜蓝背景，不由另一次模型重绘近似的轮廓。
- **生成原稿**：[选中概念](../frontend/originalMedia/brand/astering-aperture-concept.png) 与 [精修原稿](../frontend/originalMedia/brand/astering-aperture-generated.png)。保留以便追溯设计过程，不作为日常运行时依赖。
- **完整提示词与制作记录**：[astering-prompts.json](../frontend/originalMedia/brand/astering-prompts.json)。记录三种探索方向、最终精修、技术矢量化和头像派生方式。

概念探索与精修于 2026-11-04 使用内置 **imagegen** 完成，不使用 CLI/API 回退，也不需要将生成服务密钥写入仓库。生产 SVG 是对选中精修图的透明轮廓进行技术描摹：alpha 阈值 128、Potrace 1.16（`--flat --turdsize 64 --alphamax 1 --opttolerance 0.6`），再用 SVGO 3.3.5 多轮精简，统一为单个 `currentColor` 路径。不能将其表述为 imagegen 直接生成的 SVG。Potrace 与 SVGO 只用于这次制作，普通素材重建不需要它们。

阿罗娜仍是独立的助手角色，账户个人头像不随产品品牌更换。旧金色星灵及主体提取脚本已退出当前生成流程，其历史记录保留在 Git 中。更早的第三方角色素材不作为这轮生成输入，不能据新形象的原创性反向宣称旧角色也属于本项目原创。

## 发布资源与缓存

前端沿用稳定的公开路径 `frontend/public/images/brand/`，提供 Logo、头像、浅深色字标、favicon 和单色图标；提供 `logo-1024.png` 供高分辨率场景使用。字标与独立 Logo 都保留真实 SVG 路径，PNG 按目标尺寸直接从矢量渲染，不先缩成 64px 再放大。

固定品牌资源引用使用 `aster51`，覆盖 favicon、Apple/Safari 图标、PWA、登录头像与计时图标，避免继续引用已缓存的旧图样。固定路径仍使用 `no-cache` 与条件重验证，内容哈希的构建资源仍由构建系统生成 URL；私人图片和任意固定路径不能因此获得永久缓存。

检查浅深色主题、16/24/32px 图标、通知白色单色轮廓、手机 maskable 中央安全区域、登录页、75px 邮件图标及桌面多尺寸图标。安全区域按实际非透明轮廓核对，不能只比较包含透明边距的画布。桌面系统可能继续缓存图标，资源版本更新不意味着所有已安装应用图标立即刷新。

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

[前端生成器](../frontend/scripts/brand-assets.mjs) 使用锁定的 Sharp 依赖，从已提交的共用 SVG 轮廓离线派生标识与头像资源；[桌面生成器](../desktop/scripts/brand-assets.mjs) 按目标尺寸直接从 SVG 渲染 1024px PNG 与七个尺寸的 ICNS。邮件内嵌图标必须同步复制，并核对摘要。更新素材后验证真实消费者，不手改某个派生文件来掩盖生成规则问题。

上游程序版权及 AGPL 义务继续保留。阿罗娜素材来源和第三方角色权利见其[独立说明](../frontend/src/assets/arona/README.md)，本次品牌更换不扩大那些素材的许可范围。
