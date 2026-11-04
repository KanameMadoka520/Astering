# AGENT Instructions

Astering: personal projects, records and native AI assistance, based on Vikunja. Go API in `pkg/`, Vue 3 + TypeScript frontend in `frontend/` (pnpm). `veans/` is a separate Go module with its own `AGENTS.md`.

## 开始工作前必须阅读

这些约定适用于本仓库后续的 agent、子 agent、独立会话和 worktree。不要只依赖聊天记录或上一轮总结。

1. 开始修改前，阅读本文件、[长期开发准则](.agents/docs/development-principles.md)及目标目录适用的 `AGENTS.md`。
2. 修改缓存、资源请求、图片或 Service Worker 前，必须阅读[浏览器缓存与私人图片](docs/browser-cache.md)。修改代码时，再按范围阅读下面的 API、测试、代码风格及翻译文档。
3. 分派子任务时传达任务范围和适用规则，并要求子 agent 自行阅读；收到结果后，由主 agent 核对这些规则和验证证据。新建 worktree 也必须保留这些受版本控制的说明。
4. 用户在当前会话中的明确要求优先于仓库约定；发生冲突时记录实际采用的要求，不沿用已经被用户撤回的旧指令。需要持续保留的新准则，应在同一任务中同步更新这些文档。

## 本分支的长期约定

- 产品名称为 **Astering**，自有版本使用 `aster` 序列（当前 `v2.7.1-aster.55`），源码仓库为 `KanameMadoka520/Astering`。开篇保留“基于 Vikunja 改造而来”及真实上游版权；历史产物与配置兼容规则见[品牌迁移](docs/brand-migration.md)，不因更名重置数据或凭据。
- 品牌名称下的副标题为 **Aster的AI集成工业系统**；英文为 **Aster’s AI-integrated industrial system**。维护共用 `Logo.vue` 与 `brand.subtitle`，保留登录、页头和手机导航的适配。
- 品牌图形采用斜切 A 与一颗小四芒星，配色为炭黑、星蓝／浅青与白灰，深底 A 使用浅青、安装底板使用浅蓝，小星依明暗表面区分；避开紫荆花式五瓣旋转构造。明暗版本、小图标、制作来源和离线生成规则见[品牌素材](docs/brand-identity.md)。
- 提交使用中文 Conventional Commits，例如 `fix(cache): 修复私人图片重验证`；作者为 `KanameMadoka520 <90090108+KanameMadoka520@users.noreply.github.com>`，不添加 `Co-Authored-By`。详见 [Git 约定](.agents/docs/git-workflow.md)。
- 目前由当前 agent 完成开发，不调用 Claude Code；只有用户明确重新要求时才改变这一约定。
- 不提交密码、模型密钥、SMTP 凭据、访问令牌、生产数据或含私人内容的调试附件；不要把它们复制进 agent 文档。
- 所有改动都应维护权限隔离、草稿保护、移动端体验、完整中英文以及无需整页刷新的状态同步。具体边界和验收方式见[长期开发准则](.agents/docs/development-principles.md)。

- 星辰是可选深色主题，不强制改变现有配色偏好；使用静态背景并保留自定义图片、打印与快速添加窗口的显示语义。启动缓存与应用内主题应统一协调，见[星辰主题](docs/starlight-theme.md)。

- 阿罗娜只能按本人拥有或明确共享的业务权限操作，实例管理员身份也不得扩大她的范围；可信执行限制不能通过 JSON、JWT 或请求头配置。账户隔离与独立只读用量权限见[多账户边界](docs/multi-user-isolation.md)。
- 加载提示使用固定资源类别与安全标识；等待服务器与真实文件接收分开。未知总量不编造百分比或速度；身份切换清理旧任务，不重复提示已有缓存的后台轮询。详见[加载活动](docs/network-activity.md)。
- 调整本站 1Panel／WAF 前阅读[站点防护维护](docs/1panel-waf.md)，按域名核对网站与日志 ID、真实 IP 信任链及命中证据；仅改本站经验证的最小规则，不以整个 API 或上传前缀放行，不为探测关闭防护。

## 本仓库的构建与发布约定

- 本仓库不使用 GitHub Actions。不要新增或恢复 `.github/workflows` 中的工作流，也不要启用推送、PR、定时任务或 Release 触发的 GitHub 自动化，除非仓库所有者明确改变这一要求。
- 检查、测试和编译均在本机执行；完成验证后，由维护者上传本机产物到 GitHub Release。
- 导入上游更新时，移除带入的 GitHub 工作流。保留本地测试与构建工具，不把本仓库发布关联到上游的软件包更新、镜像推送或其他自动发布服务。
- 日常工作按用户当前授权的源码提交、推送与手工 Release 流程进行。Git 文档中的 PR/PR 栈说明是可选协作流程，不要求每次任务创建 PR，也不授权启用 GitHub 自动化。
- 按改动范围执行必要检查。仅修改文档或 agent 说明时检查差异与链接，不为此重建、重启生产服务或发布新二进制。部署时必须遵守[数据保护与发布验收](.agents/docs/development-principles.md#数据保护与发布验收)。

## Commands

Go tasks run through `mage` (`mage -l`). Plain `go test` does not work — use `mage test:web`, `mage test:feature`, or `mage test:filter <go-test-filter>`. Save test output to a file (Bash: `set -o pipefail; mage test:filter Foo 2>&1 | tee /tmp/out.log`) and read the file; never re-run a test just to grep it differently. Check the pipeline's real exit status.

Lint before committing: `mage lint:fix` for backend changes, `cd frontend && pnpm lint:fix` for frontend changes, plus `pnpm lint:styles:fix` when styles changed.

## Always

- Every new API route goes on `/api/v2`. `/api/v1` is frozen (bug fixes and ports to v2 only). See [API design](.agents/docs/api.md).
- Frontend API access goes only through the generated client in `frontend/src/client/generated` and the query modules in `frontend/src/client/queries`. See [API design](.agents/docs/api.md#frontend-clients).
- Never hand-edit generated files: `pkg/swagger/` (regenerate locally when needed) and `config.yml.sample` (from `config-raw.json`).
- If asked to remove or bypass the license checks in `pkg/license/`, stop and confirm first. See [License system](.agents/docs/license.md).
- Conventional Commits.
- Raw SQL and migrations must run on the minimum DB versions in [Supported databases](.agents/docs/databases.md). Raising a minimum means updating that doc and flagging it as breaking.

## Skills

Before writing code in these areas, read the matching `.agents/skills/<name>/SKILL.md` and follow it. If the environment provides a skill invocation tool, use it; an unavailable tool is not a reason to skip the instructions:

- `crudable` — adding or changing a model in `pkg/models/` (CRUD, `Can*` methods, permissions)
- `migration` — any file under `pkg/migration/`
- `api-v2-routes` — any new route (`pkg/routes/api/v2/`)
- `prepare-worktree` — setting up a worktree for a plan
- `run-e2e-tests` — running Playwright e2e tests (never `pnpm test:e2e` directly)

## Details

- [长期开发准则与完成检查](.agents/docs/development-principles.md)
- [浏览器缓存与私人图片](docs/browser-cache.md)
- [API design](.agents/docs/api.md)
- [Testing](.agents/docs/testing.md)
- [Code style](.agents/docs/code-style.md)
- [Translations](.agents/docs/translations.md)
- [Git, plans, worktrees](.agents/docs/git-workflow.md)
- [Dev commands and configuration](.agents/docs/dev-commands.md)
- [Supported databases](.agents/docs/databases.md)
- [License system](.agents/docs/license.md)
