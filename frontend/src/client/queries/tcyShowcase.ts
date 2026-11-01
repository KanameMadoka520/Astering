import {i18n} from '@/i18n'
const {t} = i18n.global
import {queryOptions, useMutation, type QueryClient} from '@tanstack/vue-query'
import {
	tcyShowcaseSettings, tcyShowcaseSave, tcyShowcasePreview, tcyShowcasePublish,
	tcyShowcaseUnpublish, tcyShowcasePublic,
	type DraftWritable, type State,
} from '@/client/generated'
import {contextMutationOptions} from './contextMutation'
import {canonicalApiBaseUrl} from '@/client/requestContext'
import {publicClient} from '@/client/publicClient'
import {getApiBaseUrl} from '@/helpers/apiUrl'

export type ShowcaseDraft = {
	custom_layout: boolean, slug: string, title: string, intro: string, content: string, format: 'markdown' | 'html',
	days: number, start_hour: number, end_hour: number, weekdays: number[],
	projects: {id: number, alias: string, mode: 'hidden' | 'busy' | 'titles'}[],
	tasks: {id: number, alias: string, hidden: boolean}[],
}

export function normalizeDraft(d?: DraftWritable): ShowcaseDraft {
	return {
		custom_layout: d?.custom_layout ?? false, slug: d?.slug ?? '', title: d?.title || t('tcymc.text.my_schedule'), intro: d?.intro ?? '', content: d?.content ?? '', format: d?.format ?? 'markdown',
		days: d?.days ?? 7, start_hour: d?.start_hour ?? 9, end_hour: d?.end_hour ?? 21, weekdays: d?.weekdays ?? [1, 2, 3, 4, 5],
		projects: (d?.projects ?? []).map(p => ({id: p.id ?? 0, alias: p.alias ?? '', mode: p.mode ?? 'hidden'})),
		tasks: (d?.tasks ?? []).map(t => ({id: t.id ?? 0, alias: t.alias ?? '', hidden: t.hidden ?? false})),
	}
}

const showcaseKey = ['tcymc-showcase'] as const

export function showcaseSettingsQuery() {
	return queryOptions({
		queryKey: showcaseKey,
		queryFn: async ({signal}) => (await tcyShowcaseSettings({signal})).data,
		// The settings page shows its own error with Retry.
		meta: {handlesError: true},
	})
}

// Save, publish and take-down all answer with the new state: show it right away, so the published status is right
// even if the refetch afterwards fails.
function storeState(state: State, client: QueryClient) {
	client.setQueryData(showcaseKey, state)
}

export function publicShowcaseQuery(slug: string) {
	return queryOptions({
		queryKey: ['tcymc-public', slug, i18n.global.locale.value],
		queryFn: async ({signal}) => (await tcyShowcasePublic({client: publicClient, baseUrl: canonicalApiBaseUrl(getApiBaseUrl()), path: {slug}, headers: {'Accept-Language': i18n.global.locale.value}, signal, throwOnError: true})).data,
		meta: {handlesError: true}, retry: false, refetchInterval: 60000,
	})
}

export function useSaveShowcase() {
	return useMutation(contextMutationOptions({
		mutationFn: async (body: ShowcaseDraft) => (await tcyShowcaseSave({body})).data,
		onSuccess: (state, _input, client) => storeState(state, client),
		onSettled: (_input, client) => client.invalidateQueries({queryKey: showcaseKey}),
		successMessage: () => t('tcymc.text.draft_saved_published_content_has_not_changed'),
	}))
}
export function usePreviewShowcase() {
	return useMutation(contextMutationOptions({mutationFn: async (body: ShowcaseDraft) => (await tcyShowcasePreview({body})).data}))
}
export function usePublishShowcase() {
	return useMutation(contextMutationOptions({
		mutationFn: async (body: ShowcaseDraft) => (await tcyShowcasePublish({body})).data,
		onSuccess: (state, _input, client) => storeState(state, client),
		onSettled: (_input, client) => client.invalidateQueries({queryKey: showcaseKey}),
		successMessage: () => t('tcymc.text.your_page_is_published_the_schedule_will_update'),
	}))
}
export function useUnpublishShowcase() {
	return useMutation(contextMutationOptions({
		mutationFn: async () => (await tcyShowcaseUnpublish()).data,
		onSuccess: (state, _input, client) => storeState(state, client),
		onSettled: (_input, client) => client.invalidateQueries({queryKey: showcaseKey}),
		successMessage: () => t('tcymc.text.your_public_page_and_json_endpoint_have_been'),
	}))
}
