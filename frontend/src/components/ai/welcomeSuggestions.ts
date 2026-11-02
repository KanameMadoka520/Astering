import type {IconProp} from '@fortawesome/fontawesome-svg-core'
import {profileOptions, type AssistantOptions, type builtinProfileIDs} from '@/helpers/assistantProfiles'

export type BuiltinProfileID = typeof builtinProfileIDs[number]

export interface WelcomeSuggestion {
	id: string
	/** i18n key of the visible label */
	label: string
	/** i18n key of the text placed in the composer */
	prompt: string
	icon: IconProp
	/** Scenario the suggestion needs; it is shown on the suggestion before it is applied. */
	profile?: BuiltinProfileID
}

export const welcomeSuggestions: readonly WelcomeSuggestion[] = [
	{
		id: 'today',
		label: 'tcymc.text.what_should_i_do_today',
		prompt: 'tcymc.text.list_my_unfinished_tasks_and_suggest_a_plan',
		icon: ['far', 'sun'],
	},
	{
		id: 'week',
		label: 'assistantUI.weekReview',
		prompt: 'assistantUI.weekReviewPrompt',
		icon: ['far', 'calendar-check'],
	},
	{
		id: 'break-down',
		label: 'assistantUI.breakDown',
		prompt: 'assistantUI.breakDownPrompt',
		icon: 'sitemap',
		profile: 'plan',
	},
	{
		id: 'create',
		label: 'tcymc.text.create_a_task_with_one_sentence',
		prompt: 'tcymc.text.create_a_task_in_this_project_to_write',
		icon: 'plus',
		profile: 'plan',
	},
]

/**
 * The scenario to switch to before using a suggestion, or undefined when it is already
 * active: re-applying a preset would discard budget tweaks the user applied on top of it.
 */
export function suggestionProfileSwitch(suggestion: WelcomeSuggestion, currentProfile: string) {
	return suggestion.profile && suggestion.profile !== currentProfile ? suggestion.profile : undefined
}

/**
 * Options for switching scenario from a suggestion. The preset supplies mode, approval and
 * budgets, but a suggestion must never widen what the user already narrowed: an explicit
 * write-project restriction (empty means unrestricted), the chosen connection, the project
 * context, the web search choice and pausing at segment limits are carried over.
 */
export function suggestionOptions(profile: BuiltinProfileID, current: AssistantOptions): AssistantOptions {
	return {
		...profileOptions(profile),
		connection_id: current.connection_id,
		project_id: current.project_id,
		search_mode: current.search_mode,
		write_project_ids: [...current.write_project_ids],
		mcp_server_ids: [...current.mcp_server_ids],
		stop_at_segment_limit: current.stop_at_segment_limit,
	}
}
