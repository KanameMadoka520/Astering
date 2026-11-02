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

//nolint:gosmopolitan // Bilingual tool discovery contracts are intentional.
package tcyai

import "maps"

func IsTaskOrderTool(name string) bool {
	return name == "list_view_tasks" || name == "reorder_view_tasks"
}

func taskOrderTools(mode string) []map[string]any {
	id := map[string]any{
		"type":    "integer",
		"minimum": 1,
		"maximum": 9007199254740991,
	}
	neighbour := map[string]any{
		"type":    "integer",
		"minimum": 0,
		"maximum": 9007199254740991,
	}
	props := map[string]any{
		"project_id": id,
		"view_id":    id,
		"bucket_id":  neighbour,
		"page": map[string]any{
			"type":    "integer",
			"minimum": 1,
			"maximum": 10000000,
		},
	}
	result := []map[string]any{tool("list_view_tasks", "读取视图内任务手动顺序 task order position 排序：先list_project_views获取真实view_id。支持普通项目list/table或manual看板真实bucket_id；默认done=false列表可用，复杂筛选/search、甘特和保存筛选器暂不支持。每页25条，返回order_version、任务真实ID/日期/位置及分页边界邻居。这里只读保存的手动顺序，不知道当前浏览器是否按截止/标题排序，不修改位置。不改变父子层级。", props, "project_id", "view_id")}
	if mode != "write" {
		return result
	}
	props = maps.Clone(props)
	delete(props, "page")
	props["task_ids"] = map[string]any{
		"type":        "array",
		"items":       id,
		"minItems":    1,
		"maxItems":    100,
		"uniqueItems": true,
		"description": "要移动的1–100个真实任务ID，数组顺序就是目标连续块顺序；未选任务的相对顺序保留。",
	}
	props["after_task_id"] = neighbour
	props["before_task_id"] = neighbour
	props["order_version"] = map[string]any{
		"type":    "string",
		"pattern": "^[a-f0-9]{64}$",
	}
	return append(result, tool("reorder_view_tasks", "调整任务顺序 reorder sort position：将task_ids按给定顺序作为一块放在真实相邻任务之间。必须先list_view_tasks，使用最新order_version；先从序列移除本批任务后，after_task_id和before_task_id必须相邻，0表示首/尾，不能猜ID/浮点位置。只允许同视图、同一手动看板栏目；不换栏目、不改变done/日期/父子关系。不支持的筛选明确拒绝。返回保存的手动顺序及实际changed_positions；不能宣称替用户切换了其他浏览器的排序方式。", props, "project_id", "view_id", "task_ids", "after_task_id", "before_task_id", "order_version"))
}
