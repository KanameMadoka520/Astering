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

//nolint:gosmopolitan // Bilingual discovery descriptions are intentional.
package tcyai

func calendarTools() []map[string]any {
	civil := map[string]any{
		"type":    "string",
		"pattern": "^[0-9]{4}-[0-9]{2}-[0-9]{2}$",
	}
	return []map[string]any{tool("list_calendar_events", "日历 calendar agenda 日程 预约 时间安排：读取有权限任务的实际开始/结束/截止时间，按任务ID稳定分页。from含、to不含，最多62个当地日；timezone省略用账户时区。完整起止区间与窗口重叠或任一日期点在窗口内即返回，每任务一次。全天按显式all_day_start/all_day_end日期范围重叠返回（end不含），跨时区不漂移。缺少日期不虚构预约，不从午夜推断全天，不展开未来重复；截止独立于结束。默认仅未完成且非归档项目。需详细描述用get_task；增改日程用create_task/update_task/bulk_update_tasks，删除整个任务用delete_task，取消安排仅清空相应日期。", map[string]any{
		"from": civil,
		"to":   civil,
		"timezone": map[string]any{
			"type":        "string",
			"maxLength":   100,
			"description": "IANA时区，如Asia/Shanghai；省略用账户时区。返回值timezone是有效时区，不能按浏览器时区猜测。",
		},
		"project_id": map[string]any{
			"type":        "integer",
			"minimum":     0,
			"description": "0或省略为所有可见项目；正数选择单个项目，不展开子项目；不能扩大账户访问权限。",
		},
		"done": map[string]any{
			"type":        "string",
			"enum":        []string{"all", "open", "done"},
			"description": "默认open；all包括已完成。",
		},
		"include_archived": map[string]any{"type": "boolean"},
		"page": map[string]any{
			"type":    "integer",
			"minimum": 1,
			"maximum": 10000000,
		},
		"per_page": map[string]any{
			"type":        "integer",
			"minimum":     1,
			"maximum":     50,
			"description": "每页条数，默认25；继续查询下一页直到满足需要。",
		},
	}, "from", "to")}
}
