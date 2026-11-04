# Astering 品牌素材

应用名为 **Astering**，自有版本标识为 **aster**。源码位于 [KanameMadoka520/Astering](https://github.com/KanameMadoka520/Astering)。产品基于 Vikunja，保留真实上游版权、来源和许可证；部署与历史产物规则见[品牌迁移](brand-migration.md)。

我们赋予 Astering“像星星闪烁、使之星光熠熠”的意象：一条记录、一次行动，逐渐连接成自己的星群。这是本项目的命名与设计寓意，不是已有词典释义的声明。

## 星灵与头像

本轮以全新生成的原创星灵替换旧角色品牌形象：暖金色五角星、深夜蓝粗轮廓，眼睛与微笑保持简单，让小尺寸图标也能呈现亲近感。头像使用同一星灵，配以深夜蓝背景和稀疏星光；标识与头像互相呼应，不用两个不同角色代表同一产品。

- **透明标识母版**：[astering-star.png](../frontend/originalMedia/brand/astering-star.png)。用于派生导航、浏览器、桌面及通知图标。
- **头像母版**：[astering-avatar.png](../frontend/originalMedia/brand/astering-avatar.png)。用于品牌展示、登录页及适合方形构图的入口。
- **生成记录**：[astering-prompts.json](../frontend/originalMedia/brand/astering-prompts.json)，保留本轮两张母版的完整提示词；透明标识的后续编辑提示词见 [astering-cleanup-prompt.txt](../frontend/originalMedia/brand/astering-cleanup-prompt.txt)。
- **单色轮廓**：[astering-star-mono.svg](../frontend/originalMedia/brand/astering-star-mono.svg)。这是前端为小尺寸与单色场景维护的简化 SVG，不应表述为 imagegen 直接生成的矢量图。

阿罗娜仍是独立的助手角色，账户个人头像也不随产品品牌更换。旧品牌角色与原参考素材不再进入当前品牌生成输入；其历史来源说明应随 Git 历史保留，不能据新形象的原创性反向宣称旧第三方角色也属于本项目原创。

## 发布资源与尺寸

前端消费者沿用稳定的公开资源路径：`frontend/public/images/brand/logo.png`、`logo.svg`、`avatar.png`、`avatar.webp`、`wordmark.svg` 和 `wordmark-dark.svg`。SVG 字标中的嵌入光栅图不等于可无限放大的矢量母版；制作更大尺寸时应从原始 PNG 派生。

品牌资源查询标识使用 `aster50`，覆盖固定地址的 favicon、Apple 图标、Safari mask、PWA 图标、登录头像及计时图标。内容哈希的构建资源仍沿用构建系统生成的 URL，不能为了品牌缓存把私人图片或任意固定地址标为永久缓存。

修改素材时应检查浅色与深色主题、16/32px 标签图标、通知单色轮廓、手机 maskable 安全区域及登录页显示；不要裁去星角、让眼睛在缩小时消失，或只检查大图而忽略实际使用尺寸。桌面系统自身也可能缓存图标，资源版本更新不意味着所有系统会立即刷新已安装应用图标。

## 本地生成

```sh
cd frontend
pnpm install --frozen-lockfile
pnpm brand:assets
```

[brand-assets.mjs](../frontend/scripts/brand-assets.mjs) 使用锁定的 Sharp 依赖，从母版派生品牌 Logo、字标、头像及各平台图标。派生步骤不调用上游生成模型；修改母版后重新生成并检查实际消费者，不手改派生文件来掩盖生成规则问题。

透明标识在导出时由 [brand-alpha.mjs](../frontend/scripts/brand-alpha.mjs) 保留最大的八连通非透明区域，清理星灵轮廓以外孤立的残留像素。主体的颜色、透明度、抗锯齿与内部孔洞保持原值，母版也保持不变；这一步仅规范导出，不重新绘制形象。

两张新母版于 2026-11-04 使用内置 **imagegen** 生成，不使用 CLI/API 回退，也不需要将任何生成服务密钥写入仓库。完整提示词以生成记录文件为准；光栅母版、派生资源、手写单色轮廓分别维护来源，不混称为同一种生成方式。

上游程序版权及 AGPL 义务继续保留。阿罗娜现有素材的来源和第三方角色权利见其[独立说明](../frontend/src/assets/arona/README.md)，本次 Astering 品牌更换不扩大那些素材的许可范围。
