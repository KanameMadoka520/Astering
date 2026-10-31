// Vikunja is a to-do list application to facilitate your life.
// Copyright 2018-present Vikunja and contributors. All rights reserved.
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.

//nolint:gosmopolitan // Bilingual tool contracts are intentional.
package tcyai

import "slices"

// BucketTasksPerPage bounds one list_buckets task page; bucket metadata never embeds tasks.
const BucketTasksPerPage = 25

var bucketToolNames = []string{
	"list_project_views",
	"list_buckets",
	"create_bucket",
	"update_bucket",
	"move_task_to_bucket",
	"set_view_buckets",
	"delete_bucket",
}

// IsBucketTool reports the kanban tools served by the dedicated bucket executor instead of HTTP dispatch.
func IsBucketTool(name string) bool {
	return slices.Contains(bucketToolNames, name)
}

// Deleting a column relocates its tasks and may clear view settings. It is reviewed in every
// approval mode and does not depend on allow_delete, which only authorizes task deletion.
func bucketAlwaysReviewed(name string) bool {
	return name == "delete_bucket"
}

// bucketTools only joins the deferred catalog: find_tools loads these schemas on demand, so the
// fixed entry tools and the cached prefix never carry them. Write contracts exist only in write mode.
// Descriptions repeat literal Chinese phrases because discovery matches each query term as a substring.
func bucketTools(mode string) []map[string]any {
	id := func(description string) map[string]any {
		return map[string]any{
			"type":        "integer",
			"minimum":     1,
			"maximum":     9007199254740991,
			"description": description,
		}
	}
	optionalID := func(description string) map[string]any {
		return map[string]any{
			"type":        "integer",
			"minimum":     0,
			"maximum":     9007199254740991,
			"description": description,
		}
	}
	// Saved filters appear in list_projects as negative pseudo project IDs; 0 and -1 (favorites) are rejected by the executor.
	project := func() map[string]any {
		return map[string]any{
			"type":        "integer",
			"minimum":     -9007199254740991,
			"maximum":     9007199254740991,
			"description": "真实项目 ID；保存的筛选器 saved filter 使用 list_projects 返回的负数 ID。不要猜测。",
		}
	}
	view := func() map[string]any {
		return id("该项目的看板视图 ID，来自 list_project_views。")
	}
	title := func() map[string]any {
		return map[string]any{
			"type":        "string",
			"minLength":   1,
			"maxLength":   250,
			"description": "栏目名称",
		}
	}
	limit := func() map[string]any {
		return map[string]any{
			"type":        "integer",
			"minimum":     0,
			"maximum":     2147483647,
			"description": "栏目任务上限 WIP limit；0 表示不限。低于当前任务数时已有任务保留，只阻止再移入。",
		}
	}

	result := []map[string]any{
		tool("list_project_views", "列出项目视图 project views（list 列表、gantt 甘特、table 表格、kanban 看板 board），返回视图 ID、类型、看板栏目模式（manual 手动栏目、filter 按筛选生成）、默认栏目 default bucket、完成列 done bucket 和栏目数量。看板栏目 bucket 工具需要这里的真实 view_id。保存的筛选器看板会汇集多个项目的任务。只读。", map[string]any{
			"project_id": project(),
		}, "project_id"),
		tool("list_buckets", "读取看板栏目/桶 kanban buckets（列 columns、board）：ID、名称、从左到右顺序、任务上限 limit、当前任务数、是否默认栏目/完成列，不包含任务内容。提供 bucket_id 时按看板顺序分页读取该栏目的任务摘要，每页 25 条。只读。", map[string]any{
			"project_id": project(),
			"view_id":    view(),
			"bucket_id":  optionalID("可选：要分页读取任务的栏目 ID；按筛选生成的栏目使用从 0 开始的序号。省略时只返回栏目元数据。"),
			"page":       id("任务页码，从 1 开始，仅在提供 bucket_id 时使用。"),
		}, "project_id", "view_id"),
	}
	if mode != "write" {
		return result
	}
	return append(result,
		tool("create_bucket", "新建栏目/桶 create kanban bucket column：在手动栏目看板中添加一列。可设置任务上限 limit 和位置 after_bucket_id；省略位置时追加到最右侧。需要项目写权限，每个视图最多 100 个栏目；按筛选生成栏目的看板不能手动加栏目。", map[string]any{
			"project_id":      project(),
			"view_id":         view(),
			"title":           title(),
			"limit":           limit(),
			"after_bucket_id": optionalID("放在该栏目右侧；0 放到最左侧；省略则追加到最右侧。"),
		}, "project_id", "view_id", "title"),
		tool("update_bucket", "修改看板栏目/桶：重命名栏目 rename bucket、任务上限 limit 或顺序 reorder（after_bucket_id）。仅修改提供的字段，至少提供一项。设置默认栏目或完成列请用 set_view_buckets。需要项目写权限。", map[string]any{
			"project_id":      project(),
			"view_id":         view(),
			"bucket_id":       id("要修改的栏目 ID"),
			"title":           title(),
			"limit":           limit(),
			"after_bucket_id": optionalID("移动到该栏目右侧；0 移到最左侧；不能是自身。"),
		}, "project_id", "view_id", "bucket_id"),
		tool("move_task_to_bucket", "把任务移动到栏目 move task to bucket：在看板栏目/桶 kanban column 之间移动任务。project_id、view_id、bucket_id、task_id 都必须来自真实读取结果，不要猜测。移入完成列 done bucket 会把任务标记完成，并同步到同一项目其他看板的完成列；重复任务则顺延日期并回到默认栏目。移出完成列会重新打开任务。受目标栏目任务上限限制。在保存的筛选器看板中，只能移动符合筛选条件的任务，且任务所在的真实项目也需要写权限。", map[string]any{
			"project_id": project(),
			"view_id":    view(),
			"bucket_id":  id("目标栏目 ID"),
			"task_id":    id("要移动的任务 ID"),
		}, "project_id", "view_id", "bucket_id", "task_id"),
		tool("set_view_buckets", "设置默认栏目、设置完成列 set default/done bucket：为看板视图选择默认栏目 default bucket（新任务进入的列）和完成列 done bucket（移入即完成、标记完成的任务自动移入）。只修改提供的字段，0 表示清除；不改视图名称、筛选或其他设置；两者不能是同一栏目。不改变已有任务的完成状态。需要项目管理员权限。", map[string]any{
			"project_id":        project(),
			"view_id":           view(),
			"default_bucket_id": optionalID("新的默认栏目 ID；0 清除，之后使用最左侧栏目。"),
			"done_bucket_id":    optionalID("新的完成列 ID；0 清除。"),
		}, "project_id", "view_id"),
		tool("delete_bucket", "删除栏目/桶 delete kanban bucket column：删除看板栏目，不删除任务。栏目中的任务会移到默认栏目（未设置时为最左侧栏目），完成状态不变；如果删除的是默认栏目或完成列，会清除对应设置。以下情况会被拒绝：视图只剩这一个栏目；这个栏目本身就是兜底栏目且仍有任务（需先设置其他默认栏目、调整顺序或移走任务）。无论审核模式如何都需要用户审核，审核预览会显示任务去向和数量。", map[string]any{
			"project_id": project(),
			"view_id":    view(),
			"bucket_id":  id("要删除的栏目 ID"),
		}, "project_id", "view_id", "bucket_id"),
	)
}
