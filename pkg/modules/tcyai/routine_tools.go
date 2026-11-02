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

func routineTools(mode string) []map[string]any {
	id := map[string]any{
		"type":    "integer",
		"minimum": 1,
		"maximum": 9007199254740991,
	}
	revision := map[string]any{
		"type":    "integer",
		"minimum": 0,
	}
	date := map[string]any{
		"type":        "string",
		"pattern":     "^[0-9]{4}-[0-9]{2}-[0-9]{2}$",
		"description": "使用 get_task_routine 返回的当前周期 date；不要用浏览器日期代替。",
	}
	tools := []map[string]any{
		tool("get_task_routine", "读取周期打卡 routine 配置和本期状态：daily 每日、weekly 每周、monthly 每月；含时区、换日时间、周期起止、date/revision、本期已累计 current_amount/目标 target。同一任务跨周期保留。", map[string]any{
			"id": id,
		}, "id"),
		tool("get_task_routine_history", "读取指定年月真实周期打卡 history、额度和历史周期快照；旧每日记录也保留。没有记录不推测完成，不虚构补打卡。", map[string]any{
			"id": id,
			"year": map[string]any{
				"type":    "integer",
				"minimum": 1970,
				"maximum": 9998,
			},
			"month": map[string]any{
				"type":    "integer",
				"minimum": 1,
				"maximum": 12,
			},
		}, "id", "year", "month"),
	}
	if mode != "write" {
		return tools
	}
	return append(tools,
		tool("configure_task_routine", "完整配置周期打卡 routine：每日 daily/每周 weekly/每月 monthly，可凌晨4/5点换日、自定义周起点/月起日、本期目标额度 quota。先读配置保留未要求修改的字段并提供 revision。停用/暂停保留历史；不能与 task.done 或普通 repeat 混用。设置在下次读取自动滚周期，不创建新任务。", map[string]any{
			"id":      id,
			"enabled": map[string]any{"type": "boolean"},
			"paused":  map[string]any{"type": "boolean"},
			"timezone": map[string]any{
				"type":        "string",
				"minLength":   1,
				"maxLength":   100,
				"description": "IANA timezone，例如 Asia/Shanghai。",
			},
			"revision": revision,
			"period": map[string]any{
				"type": "string",
				"enum": []string{
					"daily",
					"weekly",
					"monthly",
				},
			},
			"reset_hour": map[string]any{
				"type":        "integer",
				"minimum":     0,
				"maximum":     23,
				"description": "周期起点的当地小时；4 表示凌晨4点换日。",
			},
			"reset_minute": map[string]any{
				"type":    "integer",
				"minimum": 0,
				"maximum": 59,
			},
			"week_start": map[string]any{
				"type":        "integer",
				"minimum":     0,
				"maximum":     6,
				"description": "每周起点：0周日、1周一，直到6周六；非weekly仍保留原值。",
			},
			"month_day": map[string]any{
				"type":        "integer",
				"minimum":     1,
				"maximum":     31,
				"description": "每月起日；短月自动夹到月底。非monthly仍保留原值。",
			},
			"target": map[string]any{
				"type":        "integer",
				"minimum":     1,
				"maximum":     9007199254740991,
				"description": "本期完成额度，例如每周3次、每日2000毫升；整数单位由unit说明。",
			},
			"unit": map[string]any{
				"type":        "string",
				"maxLength":   40,
				"description": "额度单位，例如次、分钟、毫升；无单位为空。",
			},
		}, "id", "enabled", "paused", "timezone", "revision", "period", "reset_hour", "reset_minute", "week_start", "month_day", "target", "unit"),
		tool("check_in_task_routine", "完成/撤销本期打卡 check-in，不改变 task.done、不生成新任务。先读 get_task_routine 的 date/revision；completed=true 达到本期target，false 撤销本期额度为0。共享项目共用一份本期进度，暂停时拒绝。需设置部分额度时用 set_task_routine_progress。", map[string]any{
			"id":        id,
			"date":      date,
			"revision":  revision,
			"completed": map[string]any{"type": "boolean"},
		}, "id", "date", "revision", "completed"),
		tool("set_task_routine_progress", "设置本期累计额度 routine quota progress（绝对值，不是增量）。先读 get_task_routine 的 date/revision/current_amount；用户说再加2次时先用当前量计算总数再写。重复相同请求不会重复累加；0清除本期进度，达到target即完成，可超额。保留原任务和跨周期历史，不能改过去周期。", map[string]any{
			"id":       id,
			"date":     date,
			"revision": revision,
			"amount": map[string]any{
				"type":    "integer",
				"minimum": 0,
				"maximum": 9007199254740991,
			},
		}, "id", "date", "revision", "amount"),
	)
}

func taskReminderSchema() map[string]any {
	return map[string]any{
		"type":        "array",
		"maxItems":    20,
		"description": "完整替换 reminders 提醒列表，空数组清空。绝对提醒填 reminder（RFC3339）；相对提醒填 relative_to + relative_period秒（负数提前、0到时）。due_date/start_date/end_date 随任务日期顺延；routine_period_end 仅用于启用的周期打卡，本期截止前/当时且未达标才提醒，秒数须<=0且在本期内，下期自动续用。保留用户已有提醒。",
		"items": map[string]any{
			"type": "object",
			"properties": map[string]any{
				"reminder": map[string]any{
					"type":   "string",
					"format": "date-time",
				},
				"relative_to": map[string]any{
					"type": "string",
					"enum": []string{
						"",
						"due_date",
						"start_date",
						"end_date",
						"routine_period_end",
					},
				},
				"relative_period": map[string]any{
					"type":    "integer",
					"minimum": -315360000,
					"maximum": 315360000,
				},
			},
			"anyOf": []any{
				map[string]any{"required": []string{"reminder"}},
				map[string]any{"required": []string{
					"relative_to",
					"relative_period",
				}},
			},
			"additionalProperties": false,
		},
	}
}
