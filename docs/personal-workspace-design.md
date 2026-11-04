# 个人工作台设计说明 / Personal workspace design notes

适用版本：`feat-personal-workspace` 分支，随 v2.7.1-aster.27 发布。本文记录本轮前端改版的依据、取舍和不变量，方便后续维护时不倒退。

## 目标

让中重度个人用户每天打开 Astering 时，**先看到今天要做的事，再自然地走到项目、阿罗娜和回顾**。不做营销首页，不堆卡片，不编造统计。

## 研究来源（实际读取的一手文档）

以下页面由本轮设计调研子代理通过 WebFetch 读取正文（只读文档，没有操作这些产品的界面）。每条写明读到的内容和对本项目的具体影响。

| 来源 | 读到的要点 | 本项目的落地 |
|---|---|---|
| Todoist · Today view — https://www.todoist.com/help/articles/plan-your-day-with-the-todoist-today-view-UVUXaiSs | Today 汇总所有项目中今天的任务，只含有日期的任务；建议及时处理逾期，避免堆积。 | 工作台把「今天」「已逾期」做成两个独立视图，不把逾期混进今天。 |
| Todoist · Upcoming view — https://www.todoist.com/help/todoist/get-started/plan-your-week-with-the-upcoming-view-OKOg1mR8 | Upcoming 按日期浏览并提供 Reschedule；可直接在某天添加任务。 | 「全部待办」按 逾期 / 今天 / 明天 / 未来 7 天 / 更晚 / 无日期 分组；完整的日期范围浏览仍由「近期」页负责。 |
| Todoist · Quick Add — https://www.todoist.com/help/articles/use-task-quick-add-in-todoist-va4Lhpzz | 快速添加直接解析日期、项目、标签、优先级。 | 工作台沿用现有 `AddTask`（已支持 quick-add magic），不另造输入框；新增添加成功的状态反馈。 |
| Things 3 · Today/Upcoming/Logbook — https://culturedcode.com/things/support/articles/4001304/ | Upcoming 从明天开始逐日展示；Logbook 保留已完成的待办和项目供日后查看。 | 分组里「明天」单列；「项目完成」作为保留的生命周期记录供回顾，与归档分开。这些记录不是永久档案：删除项目会一并删除其历史，失去访问权限后也不再显示。 |
| Linear · My Issues — https://linear.app/docs/my-issues | 按「专注顺序」分组，空分组不显示。 | 分组固定顺序，空分组隐藏。 |
| Linear · Project status — https://linear.app/docs/project-status | 状态显示在项目名旁，表示生命周期位置。 | 项目卡片、最近项目、年度回顾都用「图标 + 文字」状态徽章（`ProjectStatusBadges`），不只靠颜色。 |
| Linear · Projects — https://linear.app/docs/projects | 选择器里活跃项目优先，已完成/取消的靠后。 | 项目列表默认「进行中」，已完成/已归档通过筛选查看。 |
| GitHub · Viewing contributions — https://docs.github.com/en/account-and-profile/setting-up-and-managing-your-github-profile/managing-contribution-settings-on-your-profile/viewing-contributions-on-your-profile | 点击方格筛选下方活动；年份在旁边切换。 | 年度回顾保留点选日期筛选和年份切换。 |
| GitHub · Contributions concepts — https://docs.github.com/en/account-and-profile/concepts/contributions-on-your-profile | 贡献按 UTC 计时；文档未解释色阶含义。 | 年度回顾明确写出所用时区，并给出色阶图例说明。 |
| Apple HIG · Sidebars（JSON 端点）— https://developer.apple.com/tutorials/data/design/human-interface-guidelines/sidebars.json | 层级不超过两级；每组用简短标签；不要把关键操作放在侧栏底部。 | 侧栏分为「日常工作」「记录与回顾」「整理」三组，阿罗娜在第一组。 |
| Apple HIG · Accessibility（JSON 端点）— https://developer.apple.com/tutorials/data/design/human-interface-guidelines/accessibility.json | iOS 默认点击区域 44×44pt；减少动态效果时用淡入替代位移。 | 触屏 (`pointer: coarse`) 下按钮/行高 ≥ 44px；新动效均在 `prefers-reduced-motion: reduce` 下关闭。 |
| Material Components · Navigation drawer — https://github.com/material-components/material-components-android/blob/master/docs/components/NavigationDrawer.md | 手机用带遮罩的模态抽屉，Esc 关闭；分组用分隔和小标题。 | 手机抽屉按 Esc 关闭并把焦点还给菜单按钮；关闭后的抽屉不再出现在 Tab 顺序中。 |
| WCAG 2.2 · 2.5.8 Target Size — https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html | 最小 24×24 CSS px，密集数据可视化有例外（需有等价方式）。 | 年度热力图方格保留键盘漫游和下方等价的记录列表；其他控件 ≥ 24px（触屏 44px）。 |
| WCAG 2.2 · 2.4.11 Focus Not Obscured — https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-minimum.html | 焦点不能被吸顶/吸底内容完全遮住。 | 工作台侧栏只在宽屏 sticky；手机上为单列，避免遮挡。 |
| WCAG 2.2 · 2.4.7 Focus Visible — https://www.w3.org/WAI/WCAG22/Understanding/focus-visible.html | 键盘焦点必须可见，不得用样式去掉。 | 沿用全局 `:focus-visible` 环；新组件不覆盖 outline。 |
| MDN · prefers-reduced-motion — https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-motion | `reduce` 表示希望减少非必要动效。 | 抽屉滑动、分段控件、链接箭头等过渡在 reduce 下关闭。 |
| Claude Help · Projects — https://support.claude.com/en/articles/9519177-how-can-i-create-and-manage-projects | 归档项目可继续访问对话；归档是可逆的。 | 阿罗娜历史栏保持置顶/归档分区；项目归档与完成都可撤回且保留历史。 |
| Claude Help · Chat search and memory — https://support.claude.com/en/articles/11817273-use-claude-s-chat-search-and-memory-to-build-on-previous-context | 检索历史以工具步骤形式出现并附引用。 | 保留阿罗娜现有真实工具步骤展示，不额外编造进度。 |

读取失败、**未使用**其内容：Apple HIG sidebars HTML 页（只返回标题，改用 JSON 端点）、Material 3 navigation drawer 页（只返回标题，改用 GitHub 文档）、OpenAI 帮助中心 Projects 页（HTTP 403）、一个错误的 Todoist URL（落到帮助中心首页）。

## 信息架构

```
侧栏
├─ 日常工作：工作台 (g o) · 近期 (g u) · 项目 (g p) · 阿罗娜
├─ 记录与回顾：项目年度回顾 · 我的网盘 · 工时记录（开启时）
├─ 整理：标签 (g a) · 团队 (g m)
├─ 收藏 / 已保存的筛选 / 项目树（拖拽、收藏、设置菜单不变）
└─ 品牌链接 · 服务器负载
```

`data-tour` 钩子、快捷键、`aria-label` 全部保留。侧栏首项显示「工作台」（`workspace.title`）；`navigation.overview` 仍是「概览 / Overview」，因为管理后台的概览页也用它。设置里指向首页的选项（最近查看、工作台使用的筛选）和迁移完成后的「前往工作台」同步改用「工作台」。中文「即将开始」统一为「近期」。

## 工作台

- 一行标题：问候语 + 按账户时区显示的今天日期。
- 时区：使用账户时区。当前 API 在用户未设置时区时直接返回服务器的生效时区；前端 `resolveUserTimezone` 只在旧 API 返回空值时兜底为默认的 GMT（不保证等于某台服务器的配置），不用浏览器时区，以免一次无关的设置保存（如拖动侧栏宽度）改变筛选和分组。工作台和年度回顾共用这一规则。
- 快速记录：现有 `AddTask`。添加后在下方用常驻的 `role="status"` 区域告知「已添加 N 项任务：<链接>」；只有当截止日期本身就能证明它不在当前视图时，才提示并提供「查看全部待办」。点击后切到全部待办，提示和链接保留，焦点移到任务链接。添加完成（含快速添加附加的标签、指派）后再刷新一次列表。
- 任务面板 `WorkspaceTasks`：三个视图，同一时间只有一个查询在运行。
  - 全部待办：与旧版首页相同的查询（尊重「工作台使用的已保存过滤器」设置和 `?labels=`），在当前页数据上按截止日期分组。
  - 今天：`done = false && due_date >= 'now/d' && due_date < 'now/d+1d'`。
  - 已逾期：`done = false && due_date < 'now/d'`。
  - 数量来自服务器返回的 `total`；超过一页时显示「第 51–55 项，共 55 项」和翻页，不用当前页推算全量。翻页时同一范围的上一页保留到新页到达，翻页按钮和焦点不丢失；切换视图或筛选时不沿用旧数据。
  - 从标签页「显示任务」进入（`?labels=`）时总是先显示全部待办，之后仍可切换今天/逾期。
  - 本地日期跨天时自动重新获取今天/逾期视图（查询键是固定的 datemath）。
  - 加载、错误（可重试）、无项目、无任务都有单独的状态。
- 右侧（窄屏在下方）：最近打开的项目（紧凑行 + 状态徽章）、规划与回顾入口（阿罗娜、近期、项目年度回顾）。

## 项目状态的语义（不可混淆）

- **任务完成** ≠ 项目完成。工作台和项目列表从不根据任务完成情况推断项目状态。
- **项目完成**（`is_completed`）和 **归档**（`is_archived`）是两个独立开关，可以同时成立，所以筛选计数会重叠，「全部」不等于其他三项之和。
- 升级前的归档没有日期，年度回顾里显示为「日期未知」，不使用更新时间伪造。
- 生命周期记录随项目保留，但不是永久档案：删除项目会删除其历史，失去访问权限的项目不会出现在回顾中。

## 可复用组件

| 组件 / 模块 | 用途 |
|---|---|
| `components/input/SegmentedControl.vue` | 胶囊式单选组，`aria-pressed`，方向键移动焦点、Enter/空格选择 |
| `components/project/partials/ProjectStatusBadges.vue` | 已完成 / 已归档 / 进行中 徽章（图标 + 文字） |
| `components/home/workspace/WorkspaceTasks.vue` | 工作台任务面板 |
| `components/home/workspace/RecentProjects.vue` | 最近项目紧凑列表 |
| `components/home/workspace/WorkspaceLinks.vue` | 带说明的入口列表 |
| `helpers/workspaceTasks.ts` | 视图查询、按时区分组、跨天判断（有单元测试） |
| `helpers/projectStatus.ts` | 项目状态筛选、计数、搜索、旧设置迁移（有单元测试） |

## 测试

- 单元测试：`helpers/workspaceTasks.test.ts`、`helpers/projectStatus.test.ts` 等，`pnpm vitest run <file>`。
- 单元测试还包括 `helpers/time/userTimezone.test.ts`。
- E2E：`mage test:e2e "tests/e2e/home/workspace.spec.ts"`，在独立 SQLite 种子下覆盖分组、视图切换与持久化、勾选完成后 API 状态、翻页计数与翻页后焦点、快速记录提示与焦点、标签深链进入全部待办、空状态、键盘可达、`g o` 快捷键、320/390px × 亮/暗色（中文）以及手机抽屉的 Esc 与焦点。截图写入 `testInfo.outputPath()`。
