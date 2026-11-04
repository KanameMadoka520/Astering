# 项目年度回顾 / Project year in review

> 年度页面现在默认展示[按任务明确日期汇总的项目时间线](project-timeline.md)。本文说明作为辅助视图保留的完成与归档事件，事件数量不代表项目持续天数。

入口：左侧“项目年度回顾”、项目菜单中的同名入口。路径 `/projects/history`。

这里按**整个项目**的完成和归档事件绘制年度日历，不是任务完成统计。

- 项目管理员可以在项目菜单中“标记项目已完成”或“重新打开项目”。完成不会修改任务、子项目、归档状态或写权限。普通成员只能查看其可访问项目的历史。
- 完成和归档分别操作。归档沿用 Vikunja 原有规则：收起日常导航、设为只读，并影响子项目；父项目导致的子项目归档/取消归档也留记录。
- 完成、重新打开、归档、取消归档均保留历史。重复提交同一完成状态不生成重复事件。删除项目会清理对应历史。
- 桌面显示全年方格，手机显示按月日历。选择年份、项目、事件类型、日期或搜索项目名称；下方每页最多 24 条。筛选条件保存在 URL，返回页面可继续查看。
- 日历按账户时区划分年份和日期，使用实际服务器记录时间。创建至事件时间是**记录跨度**，不能解释为实际工时或计划排期。
- 升级前已归档的项目原本没有归档时间，迁移时建立“日期未知”记录，不用更新时间或升级时间伪造历史。过去未记录的完成/恢复行为无法还原。
- 每次完成后重新打开仍能看到过去记录；标题、当前状态、可见权限随当前项目变化。删除或失去访问权限的项目不再出现在回顾中。
- 所选年份没有任何项目级记录时，空状态说明这里只记录整个项目的完成、重新打开、归档和取消归档，勾选任务完成不会让项目完成；同时显示当前筛选范围内的项目数、已标记完成数和已归档数（来自响应的 `scope`，与年份无关），说明如何在项目菜单中操作，并提供“前往项目列表”和“查看按任务日期统计的时间线”两个入口。页面不会自动完成项目，也不补记过去的日期。

## API / implementation

- `GET /api/v2/projects/history?year=2026&timezone=Asia/Shanghai`: lightweight per-day counts and paginated event records. Optional `project`, `kind` (`milestones`, `all`, `completed`, `archived`, `reopened`, `unarchived`), `day`, `unknown`, `q`, `page`.
- `POST /api/v2/projects/{project}/completion`, body `{"completed":true}`: project-admin-only, transactional and idempotent. Read-only `is_completed` / `completed_at` fields are returned by project reads; generic project writes cannot set them.
- `pkg/models/project_history.go` owns authorization and calendar calculations. The query applies the same inherited/team/link-share access scope before statistics, search and pagination, and includes archived projects.
- `project_lifecycle_events` stores server timestamps and event kinds. Year statistics stream timestamps and project IDs only; the browser receives at most one year of day counts and one page of lightweight rows, without task bodies.
- Migration `20261031032235` uses `partialSync` for existing project columns and adds the new event table. Legacy archived projects get an undated event. No project, task or original index is deleted.

The overview describes project milestones, not an immutable title/audit snapshot and not a time-tracking report.

## 阿罗娜协作 / Arona tools (aster.27)

可以直接询问“今年完成过哪些项目”“某项目的归档和重开记录”，或要求“将这个项目标记完成／重新打开”。阿罗娜按需发现 `list_project_history` 和 `set_project_completed`，不会增加每轮固定工具声明的数量。历史工具保留分页和当前访问权限；日期未知的旧记录单独查询，不虚构时间。模型只接收分页记录和统计，日历绘制数据保留在完整操作记录中。

完成操作使用相同的项目管理员权限、事务和幂等逻辑，还受本轮写入项目范围与审核策略约束。审核期间项目有变化会重新生成审核内容；修改成功后刷新项目与年度回顾。只读模式不能发现或执行完成工具，切换模式不会沿用旧写权限。

The assistant discovers project history and completion tools on demand through the existing stable tool transport. Completion is independently scoped, permission-checked and reviewed, with a locked current-state check before the transaction commits. It never changes task completion or archive state. Full operation evidence remains in the conversation; model-facing results omit the heatmap rendering payload.
