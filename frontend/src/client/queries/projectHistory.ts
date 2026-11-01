import {queryOptions, useMutation} from '@tanstack/vue-query'
import {projectHistory, projectCompletion, type ProjectHistoryData} from '@/client/generated'
import {i18n} from '@/i18n'
import {contextMutationOptions} from './contextMutation'
import {mapProjectNavigationItem, projectKeys, type ProjectListResult, type ProjectResponse} from './projects'
import {projectTimelineKeys} from './projectTimeline'

export function projectHistoryQuery(query: NonNullable<ProjectHistoryData['query']>) {
	return queryOptions({
		queryKey: ['project-history', query],
		queryFn: async ({signal}) => (await projectHistory({query, signal})).data!,
		staleTime: 0,
		placeholderData: (previous, previousQuery) => {
			const old = previousQuery?.queryKey[1] as typeof query | undefined
			return old && ['year', 'timezone', 'project', 'kind', 'q'].every(key => old[key as keyof typeof query] === query[key as keyof typeof query]) ? previous : undefined
		},
		meta: {handlesError: true},
	})
}
export function useProjectCompletionMutation() {
	return useMutation(contextMutationOptions({
		mutationFn: async ({id, completed}: {id: number, completed: boolean}) =>
   (await projectCompletion({path: {project: id}, body: {completed}})).data!,
		// Only the completion flag changes, so the cached project is patched instead of reloading every list page.
		onSuccess: (updated, {id, completed}, client) => {
			const complete = (project: ProjectResponse) => ({
				...project,
				is_completed: updated.is_completed ?? completed,
			})
			client.setQueryData<ProjectListResult>(projectKeys.list(), current =>
				current ? mapProjectNavigationItem(current, id, complete) : current,
			)
			client.setQueryData<ProjectResponse>(projectKeys.detail(id), current => current ? complete(current) : current)
		},
		// Started, not awaited: the dialog closes once the change is saved, and these views catch up by themselves.
		onSettled: ({id}, client) => {
			void Promise.all([
				client.invalidateQueries({queryKey: projectKeys.list(), refetchType: 'none'}),
				client.invalidateQueries({queryKey: projectKeys.detail(id)}),
				client.invalidateQueries({queryKey: ['project-history']}),
				client.invalidateQueries({queryKey: projectTimelineKeys.all}),
			])
			return Promise.resolve()
		},
		successMessage: () => i18n.global.t('project.edit.success'),
	}))
}
