import {queryOptions} from '@tanstack/vue-query'
import {
	projectTimeline,
	type ProjectTimeline,
	type ProjectTimelineData,
	type ProjectTimelineDeadline,
	type ProjectTimelineItem,
} from '@/client/generated'

export type ProjectTimelineQuery = ProjectTimelineData['query']

export type ProjectTimelineRow = ProjectTimelineItem & {
	deadline_days: ProjectTimelineDeadline[]
}

export type ProjectTimelineResponse = Omit<ProjectTimeline, 'items' | 'days'> & {
	days: NonNullable<ProjectTimeline['days']>
	items: ProjectTimelineRow[]
}

export const projectTimelineKeys = {
	all: ['project-timeline'] as const,
	query: (query: ProjectTimelineQuery) => [...projectTimelineKeys.all, query] as const,
}

// Same year, scope and search: only the day or page changed, so the year-wide statistics
// on screen stay valid while the rows reload.
const SAME_SCOPE: (keyof ProjectTimelineQuery)[] = [
	'year',
	'timezone',
	'project',
	'status',
	'q',
]

export function normalizeProjectTimeline(data: ProjectTimeline): ProjectTimelineResponse {
	return {
		...data,
		days: data.days ?? {},
		items: (data.items ?? []).map(item => ({
			...item,
			scheduled_spans: item.scheduled_spans ?? [],
			elapsed_spans: item.elapsed_spans ?? [],
			deadline_days: item.deadline_days ?? [],
		})),
	}
}

export function projectTimelineQuery(query: ProjectTimelineQuery) {
	return queryOptions({
		queryKey: projectTimelineKeys.query(query),
		queryFn: async ({signal}) => normalizeProjectTimeline((await projectTimeline({query, signal})).data!),
		staleTime: 30_000,
		placeholderData: (previous, previousQuery) => {
			const old = previousQuery?.queryKey[1] as ProjectTimelineQuery | undefined
			return old && SAME_SCOPE.every(key => old[key] === query[key]) ? previous : undefined
		},
		meta: {handlesError: true},
	})
}
