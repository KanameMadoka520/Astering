# Astering 品牌、版本与兼容迁移

**Astering 基于 Vikunja 改造而来**，继续保留 Vikunja 和贡献者的真实版权、AGPL-3.0-or-later 许可证及上游来源。更名不改变第三方代码与角色素材各自的许可边界；根目录 [LICENSE](../LICENSE)、[上游 README](../README.upstream.md) 和[品牌素材来源](brand-identity.md)继续适用。

我们赋予 Astering“像星星闪烁、使之星光熠熠”的意象：让记录与行动逐渐连接成星群。这是项目的创作寓意，不声称它是已有通行词典定义。本轮以全新的星形标识与头像承载该意象，旧角色素材不再作为当前品牌发布输入。

## 当前身份

- 产品名：**Astering**；副标题：**Aster的AI集成工业系统** / **Aster’s AI-integrated industrial system**。
- 自有版本序列：`aster`，本次正式版本为 `v2.7.1-aster.50`。
- 源码、问题反馈与手工 Release：[KanameMadoka520/Astering](https://github.com/KanameMadoka520/Astering)。
- 构建文件：`Dockerfile.aster`；镜像示例：`astering:v2.7.1-aster.50`；应用二进制：`/app/astering/astering`。
- 新部署 Compose 应用服务为 `astering`，本机应用容器名为 `Astering`、数据库容器名为 `Astering-postgres`。主机指标的四个只读文件挂载至 `/run/aster-host-proc/`。

实际访问地址仍为 `task.tcymc.space`；相关 Wallos 地址、邮件域名、账户身份和其他应用的外部 ID 按真实配置保留。品牌更名不等于域名迁移，不应把真实地址臆改成尚未配置的域名。

## 数据与配置兼容

现有账户、数据库表、任务、星图、会话、网盘文件与加密配置必须完整保留。升级前沿用停机一致备份、运行任务检查、隔离恢复验证及数据哈希对比；更名不需要重新创建账户或初始化空数据库。

Docker 镜像的两个路径默认值继续使用 `VIKUNJA_SERVICE_ROOTPATH`、`VIKUNJA_DATABASE_PATH` 兼容变量，值已指向 Astering 路径。这样，旧部署显式设置的旧变量可以覆盖镜像默认值，新部署显式设置的 `ASTERING_*` 也仍然优先；镜像不会预填同名新变量而意外遮蔽旧部署的数据库或文件路径。

`ASTERING_*` 是新的环境变量前缀，已有 `VIKUNJA_*` 配置继续兼容。不要让新旧前缀配置互相冲突，尤其是数据库连接、文件路径与 `service.secret`；必须保留原始解密密钥，不能为更名随机生成一个新值替换它。上游配置字段如 `service.secret` 和数据库结构不因产品名字改变而自动改名。

文档中仍可见的 `.tcymc-ai/`、`.tcymc-smtp.enc`、`TCYMC_SETTINGS_ADMIN_IDS`、`tcymc-compass-draft` 等名称是历史存储或兼容接口标识，不是当前品牌。旧数据目录、加密派生材料、浏览器草稿键和认证标识只能通过有读取回退与验证的明确迁移更改，不能批量替换字符串后要求用户删除旧数据。Go 模块路径、API 模型名称、上游源码引用同样保留真实兼容性。

部署示例展示新安装的名称与目录；已有部署应将镜像切换指向原数据挂载，逐项核对 Compose 服务、容器和挂载路径。不要直接叠加新的应用服务，让两个实例意外共享同一生产库并同时运行后台任务。数据库容器名称变化也不表示应重建数据库卷。宿主机源码目录应按实际部署选择，不为品牌更名删除原工作目录或备份。

应用 CLI 的 dump/restore 继续严格核对生成备份时的实际版本；历史发布展示改名不改变备份内部版本。旧 `tcymc.49` 应用 dump 不能直接交给 `aster.50` 的 restore 命令。需要使用与备份实际版本对应的保留镜像恢复并验证，再按升级流程切换新版；不得为品牌迁移放宽该安全检查。

本机部署脚本另行保存的 PostgreSQL 原生 `pg_dump` 与文件归档不是应用 CLI dump：它们可以在兼容的隔离 PostgreSQL 中用 `pg_restore` 验证，不经过应用版本检查。两种备份格式不能混用；生产恢复仍需确认数据库版本、原密钥、全部文件及对应应用版本，不能把隔离恢复命令直接指向生产。

桌面端的 `vikunja-desktop` 包名、`io.vikunja.desktop` 应用 ID、OAuth 客户端与回调协议，以及 `vikunjaDesktop` 前端桥接标识继续作为兼容接口；公开产品名、菜单与仓库链接使用 Astering。打包桌面程序继续使用旧 `Vikunja Desktop` 用户配置与会话目录，开发模式保留包名对应目录；显式 `--user-data-dir` 参数不被覆盖。详见[桌面端说明](../desktop/README.md#compatibility-identifiers)。

## 历史发布与校验

公开文档和迁移后的 Release 展示采用 `aster.N`。历史文件原本在旧品牌和 `tcymc.N` 版本下编译；迁移展示名、标签、Release 标题或资产文件名，不会让文件内部版本、镜像元数据、旧提交内容或程序行为自动改变。不得声称这些历史产物已用 Astering 重新编译。

历史二进制和归档的字节保持原样，其 SHA256 摘要不因外部文件名改变而变化。若资产文件名调整，校验清单中的文件名必须同步，但每个资产的摘要仍应对应原始字节；校验清单自身的字节和摘要则会随文件名更新。Docker 归档导入后的内部镜像名称以归档实际内容为准，不能仅凭下载文件名假设已经包含新镜像标签。

`v2.7.1-aster.50` 及之后的新构建使用新品牌和版本；发布时继续绑定干净源码、最终提交、标签、镜像 ID、OCI revision 与实际运行实例。既有可用回退镜像和备份在验证完成前必须保留。每个历史验收记录只证明当时执行的版本与用例，不代表本次改名已重新执行全部历史测试。

## 本地发布

检查、测试、编译和 Release 资产生成均在本机完成，然后手工推送源码及上传产物。本仓库不使用 GitHub Actions，也不在品牌迁移时恢复自动工作流。新仓库不能只更新 README 链接：Git remote、镜像来源标签、发布脚本目标、前端仓库入口和最终下载校验需在正式发布流程中一致核验。

## 原生系统包

`nfpm.yaml` 的新安装包名为 `astering`，使用 `/etc/astering/config.yml`、`/opt/astering/astering` 与 `/usr/local/bin/astering`，服务模板为 `astering.service` / `astering.initd`。安装脚本仅处理这些新路径，不读取、迁移、删除或停止旧 `/etc/vikunja`、`/opt/vikunja` 与旧服务。已有安装需要维护者在备份后明确迁移配置、原数据库路径、文件和密钥；安装新包本身不代表完成数据迁移，不能同时启动旧新实例共享生产库。

`build/` 的主项目选择器为 `astering`；旧 `vikunja` 选择器只是命令兼容别名，输出仍使用新名称。Pacman 仓库元数据使用 `astering.db` / `astering.files`，这些是包索引，不是用户的 SQLite 业务数据库。原有已签名仓库缓存与历史包不得原地冒名覆盖；若迁移包仓库，需独立生成并验证新索引与签名。

本仓库未配置可验证的捐款目的地，因此不把上游资助链接改写成未经确认的新收款入口。GitHub issue 和安全报告政策均指向 Astering 仓库；未使用的 Actions composite 模板已移除，不新增工作流。
