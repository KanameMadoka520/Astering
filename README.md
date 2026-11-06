# Astering

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="frontend/public/images/brand/wordmark-dark.svg">
    <img src="frontend/public/images/brand/wordmark.svg" alt="Astering" width="300">
  </picture>
</p>

> 记录行动，让一路走来的点滴渐成星群。

**Astering 基于 Vikunja 改造而来**，以 [Vikunja 官方 v2.7.1](https://github.com/go-vikunja/vikunja/releases/tag/v2.7.1) 为上游基础，为个人与团队扩展项目管理、日程、长期记录和原生 AI 助手。由 **KanameMadoka520** 维护，遵循 **AGPL-3.0-or-later**；保留上游版权、许可证及来源，参见 [LICENSE](LICENSE) 和 [上游 README](README.upstream.md)。

我们赋予 **Astering**「像星星闪烁、使之星光熠熠」的意象：一次行动、一段研究、一条值得记住的原则，逐渐连接成自己的星群。**Aster的AI集成工业系统**（Aster’s AI-integrated industrial system）是项目的副标题；工具与积累服务于更自由的创造。

- 当前版本：`v2.7.1-aster.59`
- 源码与问题反馈：[KanameMadoka520/Astering](https://github.com/KanameMadoka520/Astering)
- 本机编译的发布产物：[GitHub Releases](https://github.com/KanameMadoka520/Astering/releases)
- [品牌与升级兼容](docs/brand-migration.md) · [品牌素材](docs/brand-identity.md) · [详细功能与演进记录](docs/product-reference.md)

标识以两块斜切面和一道光隙形成有方向感的 A，右上用一颗小四芒星呼应 Astering 的星辰意象。炭黑、星蓝／浅青和白灰配合浅蓝底板，与站点及星辰主题协调；矢量标识、深色头像与各平台图标共用同一份几何轮廓。设计参考、生成来源和本地重建方法见[品牌素材](docs/brand-identity.md)。

喜欢深色界面时，可在 **设置 → 通用设置 → 外观与行为 → 配色方案** 选择 **星辰**：近黑底、稀疏星点与淡星座线，正文和任务卡片保持清楚的实色表面。选择随账户保存，原有配色和自定义背景继续可用，详见[星辰主题](docs/starlight-theme.md)。

## 从安排今天，到记住一路走来

Astering 把不同用途保留在各自合适的空间里，关联真实任务与记录，不用生成出来的示例统计填满界面。

| 想做什么 | 使用入口 | 行为与边界 |
|---|---|---|
| 推进项目 | 项目的列表、看板、表格与甘特图 | 任务、栏目、关系、附件和公告；共享范围沿用项目权限。 |
| 安排时间 | 独立日历 | 月、周、日与议程查看真实任务日期；精确时段、独立截止与全天自然日分别表达，不猜测午夜等于全天。 |
| 形成习惯 | 周期任务 | 同一任务保留按日、周、月的进度历史，可设换日时间、额度与单位，不为漏掉的周期自动补打卡。 |
| 回看过去 | 项目回顾 | 按真实日期汇总项目时间线，另看完成与归档记录；没有日期的数据不会被编成工作时段。 |
| 比较与恢复内容 | 项目内容历史 | 建立命名保存点，先预览差异再恢复；自动保存恢复前状态，保留后来的评论、打卡事实和当前成员权限。 |
| 留住原则与想法 | 星图 | 空间、图文条目、主题和修订，支持归档与回收站；内容不自动灌入每次模型请求。 |
| 复用文件 | 个人网盘 | 查找已上传文件、复用附件、查看引用与回收站；多选后批量置顶、设置分类、回收或恢复，引用中的文件保留单项确认，详见[网盘多选管理](docs/drive-batch-management.md)。 |
| 清点和清理空间 | 设置 → 数据 → 存储空间 | 分类查看本人文件、预览与对话占用；选择条目后预览影响，再按引用保护规则清理，详见[统计与清理边界](docs/personal-storage.md)。 |
| 让别人知道何时有空 | 公开主页与忙闲 | 明确选择公开范围、别名和展示内容；公开页不自动获得私人项目的完整访问权限。 |

电脑端支持信息密集的视图，手机保留可达的触控入口。常规编辑与阿罗娜操作共用状态更新路径，尽量局部呈现变化，同时保护正在输入的草稿。弱网下区分加载中、旧结果、失败和离线；公开构建资源按实际访问缓存，私人业务数据不会因为扩展名像图片就进入 Service Worker 离线缓存。

看板可收起卡片里的上级关系提示，保留任务与子任务进度，并记住每个看板的显示选择。阿罗娜会话列表区分工作中与未读回复；桌面浮窗支持拖动、边角缩放和恢复默认，调整布局时保留草稿与后台执行。

## 阿罗娜：能执行，也能追溯

阿罗娜可以读取上下文、按需发现工具并操作账户有权访问的内容。她可以在独立对话页或悬浮窗口工作；离开页面不会自动终止服务端任务，明确停止才取消执行。模型连接与密钥在服务端管理，可配置文字、多模态、语音和联网搜索能力，具体支持取决于所选协议与上游服务。

手机对话页使用单行会话顶栏和紧凑输入栏；点击模型与工作方式摘要展开完整配置，点会话标题查看文件占用和压缩记录。全站导航、账户、搜索及通知仍可从会话历史进入，键盘弹出和浮窗变化会保留草稿与会话；详见[手机对话布局](docs/arona-mobile-chat.md)。

开始一轮对话前，选择模型、工作方式和工具范围：

1. **工具模块**分别设置项目任务、星图的关闭、只读或读写；旧项目配置保持兼容，星图默认关闭。全局只读模式仍限制写入。
2. **权限与审核**叠加账户原有权限、项目写入范围及操作策略。星图写入和外部 MCP 写入需审核；模型不能靠参数或自称管理员扩大权限。
3. **执行中补充要求**保留原目标，将新要求排队在安全的模型或工具边界应用。已经执行的操作不会因一句补充要求自动回滚。
4. **记录与恢复**保留服务商返回的中间说明、工具步骤、错误、用量和时间指标；不编造隐藏推理。失败后按安全边界重试，结果未知的写入不会自动重放。

会话支持管理、置顶、分支、压缩和导出；不同会话可以独立执行或压缩，停止一个会话不会取消其他会话，同一会话保留必要互斥，详见[会话并发](docs/agent-concurrency.md)。图片可来自上传或网盘；阿罗娜可按需查看当前会话附件清单，以真实图片 ID 复用到有权编辑的任务描述中，插入位置沿用描述版本和审核保护。插图成功后，任务附件独立于会话存在；文件详情与删除确认会说明原件归属、使用位置和引用保护，详见[附件归属与保留](docs/attachment-retention.md)。语音输入支持点按开始与结束，触屏长按作为补充；识别结果先进入草稿，不自动发送为任务指令。外部 MCP 按连接和本轮选择使用，不在页面打开时遍历全部远端工具。

详见[阿罗娜集成](docs/arona-integration.md)、[工具模块权限](docs/agent-tool-modules.md)、[运行中补充要求](docs/arona-steering.md)、[外部 MCP 与聊天插图](docs/external-mcp-and-chat-images.md)及[专用语音协议](docs/speech-and-routines-v41.md)。

## 多账户与运行用量

个人模型设置、阿罗娜会话、MCP 连接和个人网盘按账户隔离。项目通过显式的用户或团队共享协作，阿罗娜还受本轮工具模块、读写方式、资源权限与审核约束；实例管理员身份不会让她读取或修改未共享项目。这里是同一实例内的多账户协作，并非独立数据库的组织租户，详见[账户隔离与用量](docs/multi-user-isolation.md)。

被单独授予用量权限的真人账户，可在 **设置 → 站点 → 站点用量** 查看账户状态、角色标记、项目／任务数量与归属存储。该只读能力不授予正文、会话或密钥访问权，也不修改上游许可管理功能。弱网加载浮层显示资源类别、等待阶段和耗时；SDK 文件传输在可测量时提供已收字节、接收速度及可信进度，详见[加载活动](docs/network-activity.md)。

## 安装与运行

提供源码包、Git bundle、Linux amd64 二进制、Docker 镜像包和 SHA256 校验文件。检查、测试与编译在维护者本机完成，再手工发布；本仓库不使用 GitHub Actions。

从源码构建：

```sh
git clone https://github.com/KanameMadoka520/Astering.git
cd Astering
docker build -f Dockerfile.aster \
  --build-arg RELEASE_VERSION=v2.7.1-aster.59 \
  --build-arg SOURCE_COMMIT="$(git rev-parse HEAD)" \
  -t astering:v2.7.1-aster.59 .
```

或下载对应 Release，先检查 `sha256sum -c SHA256SUMS`，再导入镜像包：

```sh
docker load -i astering-v2.7.1-aster.59.docker.tar.gz
```

以下是**新安装**的最小 SQLite 示例；生产也可配置 PostgreSQL。现有部署不要用新建的空目录替换原数据卷。

```sh
mkdir -p data/files data/db
sudo chown -R 1000:1000 data
docker run -d --name Astering --restart unless-stopped \
  -p 127.0.0.1:3456:3456 \
  -v "$PWD/data/files:/app/astering/files" \
  -v "$PWD/data/db:/db" \
  -e ASTERING_SERVICE_PUBLICURL=https://task.example.com/ \
  -e ASTERING_SERVICE_SECRET=替换为随机且持久保存的长密钥 \
  -e ASTERING_SERVICE_ENABLEREGISTRATION=false \
  -e ASTERING_SERVICE_TIMEZONE=Asia/Shanghai \
  astering:v2.7.1-aster.59
```

在反向代理提供 HTTPS，将 `PUBLICURL` 改为自己的实际域名。创建首个账户前可查看 CLI 参数：

```sh
docker exec -it Astering /app/astering/astering user create --help
```

注册默认建议关闭。SMTP 可使用 `ASTERING_MAILER_*`（兼容旧 `VIKUNJA_MAILER_*`）环境配置，受授权的管理员也可在网站发信设置页管理。账号名中包含 `admin` 不会自动获得额外权限。主机指标使用[只读挂载模板](deploy/compose.host-status.yml)，不需要 Docker socket 或特权容器。

项目菜单中的「项目历史版本」用于保存服务器上已提交的项目内容、任务、看板布局与附件引用；它与完成／归档历程分开。未改变的历史实体按内容去重，媒体原件不复制；只记录明确保存的保存点，不能找回上线前或未保存的编辑。恢复要求当前项目管理员并使用最新差异预览，阿罗娜也始终需要人工审核。详细范围、存储口径及保留边界见[项目内容历史](docs/project-versions.md)。

## 从旧版本升级

本次品牌更名不要求重建账户、数据库或文件库。新变量前缀为 `ASTERING_*`，旧 `VIKUNJA_*` 继续兼容；不要同时填入互相冲突的配置。

- 先确认后台任务已结束或安全停止，再备份数据库、全部文件及原始 `service.secret`。加密会话与模型配置依赖该密钥；只保留数据库不足以恢复。
- 保留实际运行版本、源码提交和可用回退镜像。切换应用镜像时沿用原数据挂载和数据库配置，核对服务名、容器名、文件路径和反向代理目标。
- 部署后检查版本、权限、文件和业务数据。用户并发产生的合法记录可能造成差异，不得为了让计数一致而恢复旧库或删除新数据。
- 旧加密目录、OAuth 协议、桌面配置目录等兼容名称不是品牌文案，不能用全盘字符串替换迁移。
- 应用 CLI 的旧版 dump 必须先用匹配原版本的镜像恢复，再升级；不能将旧 `tcymc.49` dump 直接交给 `aster.50` restore。原生 PostgreSQL `pg_dump` 是另一种备份格式，详见迁移说明。

历史 Release 展示采用 `aster.N`；旧产物内部版本和镜像名称可能仍有原标识。外部文件名变化不代表原字节已重编译，校验和与导入后的镜像身份应以实际产物为准。完整规则见[品牌迁移](docs/brand-migration.md)。

## 文档导航

| 主题 | 文档 |
|---|---|
| 日历日期、全天与权限 | [日历接口](docs/calendar-v45.md)、[全天交互](docs/calendar-v47.md)、[工具栏](docs/calendar-toolbar-v48.md) |
| 项目回顾与排序 | [实际日期时间线](docs/project-timeline.md)、[完成与归档](docs/project-history.md)、[视图排序工具](docs/task-order-v46.md) |
| 周期任务 | [公告与日常基础](docs/project-announcements-routines.md)、[周期与额度扩展](docs/speech-and-routines-v41.md) |
| 星图与图文记录 | [使用设计](docs/compass.md)、[数据与权限](docs/compass-data.md) |
| 语音与多模态 | [语音输入交互](docs/voice-input-v43.md)、[协议适配](docs/speech-and-routines-v41.md)、[阿罗娜集成](docs/arona-integration.md) |
| 模型与工具执行 | [运行时](docs/arona-runtime-design.md)、[工具发现恢复](docs/agent-tool-loading.md)、[模块范围](docs/agent-tool-modules.md) |
| 缓存与弱网 | [浏览器缓存](docs/browser-cache.md)、[弱网设计与验证](docs/weak-network-v49.md) |
| 外观主题 | [星辰主题与显示边界](docs/starlight-theme.md) |
| 品牌与历史 | [品牌素材](docs/brand-identity.md)、[更名兼容](docs/brand-migration.md)、[功能演进参考](docs/product-reference.md) |

## 本地开发

使用 Go 1.27、Node.js 24、pnpm 11.27 和 Mage；精确依赖以 `go.mod`、锁文件及前端 `package.json` 为准。开始前阅读 [AGENTS.md](AGENTS.md)、[长期开发准则](.agents/docs/development-principles.md)及目标目录规则。

```sh
cd frontend
corepack enable
pnpm install --frozen-lockfile
pnpm build
cd ..
mage build
```

Go 测试通过 `mage test:filter <测试名过滤器>`，浏览器测试通过 `mage test:e2e <spec路径>`；共享数据库测试串行运行。API v2 的客户端通过 `mage generate:frontend-client` 生成，不手改 SDK。仅修改文档时检查链接与差异，无需重建生产服务。

提交使用中文 Conventional Commits，作者为 `KanameMadoka520 <90090108+KanameMadoka520@users.noreply.github.com>`。不提交生产数据、访问令牌、模型密钥或 SMTP 凭据。安全报告见[本仓库政策](.github/SECURITY.md)。
