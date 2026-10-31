import {computed, toValue, type MaybeRefOrGetter} from 'vue'
import {useQuery} from '@tanstack/vue-query'
import {
	compassEntriesQuery,
	compassEntryQuery,
	compassRevisionQuery,
	compassRevisionsQuery,
	compassSpaceQuery,
	compassSpacesQuery,
	compassTopicsQuery,
	type CompassEntryFilters,
	type CompassSpace,
} from '@/client/queries/compass'
import {useTeam} from '@/composables/useTeams'
import {getApiBaseUrl} from '@/helpers/apiUrl'
import {compassAccountNamespace} from '@/helpers/compass/storage'
import {i18n} from '@/i18n'
import {useAuthStore} from '@/stores/auth'

export function useCompassSpaces() {
	const query = useQuery(compassSpacesQuery())
	return {
		...query,
		spaces: computed(() => query.data.value ?? []),
	}
}

export function useCompassSpace(spaceId: MaybeRefOrGetter<number>) {
	const query = useQuery(computed(() => ({
		...compassSpaceQuery(toValue(spaceId)),
		enabled: toValue(spaceId) > 0,
	})))
	return {
		...query,
		space: computed(() => query.data.value),
	}
}

export function useCompassEntries(
	spaceId: MaybeRefOrGetter<number>,
	filters: MaybeRefOrGetter<CompassEntryFilters>,
	page: MaybeRefOrGetter<number>,
) {
	const query = useQuery(computed(() => ({
		...compassEntriesQuery(toValue(spaceId), toValue(filters), toValue(page)),
		enabled: toValue(spaceId) > 0,
	})))
	return {
		...query,
		entries: computed(() => query.data.value?.items ?? []),
		total: computed(() => query.data.value?.total ?? 0),
		totalPages: computed(() => query.data.value?.total_pages ?? 0),
	}
}

export function useCompassEntry(entryId: MaybeRefOrGetter<number>) {
	const query = useQuery(computed(() => ({
		...compassEntryQuery(toValue(entryId)),
		enabled: toValue(entryId) > 0,
	})))
	return {
		...query,
		entry: computed(() => query.data.value),
	}
}

export function useCompassTopics(spaceId: MaybeRefOrGetter<number>) {
	const query = useQuery(computed(() => ({
		...compassTopicsQuery(toValue(spaceId)),
		enabled: toValue(spaceId) > 0,
	})))
	return {
		...query,
		categories: computed(() => query.data.value?.categories ?? []),
		tags: computed(() => query.data.value?.tags ?? []),
	}
}

export function useCompassRevisions(entryId: MaybeRefOrGetter<number>, page: MaybeRefOrGetter<number>) {
	const query = useQuery(computed(() => ({
		...compassRevisionsQuery(toValue(entryId), toValue(page)),
		enabled: toValue(entryId) > 0,
	})))
	return {
		...query,
		revisions: computed(() => query.data.value?.items ?? []),
		totalPages: computed(() => query.data.value?.total_pages ?? 0),
	}
}

export function useCompassRevision(entryId: MaybeRefOrGetter<number>, revision: MaybeRefOrGetter<number>) {
	const query = useQuery(computed(() => ({
		...compassRevisionQuery(toValue(entryId), toValue(revision)),
		enabled: toValue(entryId) > 0 && toValue(revision) > 0,
	})))
	return {
		...query,
		snapshot: computed(() => query.data.value),
	}
}

/**
 * The local-storage namespace for drafts and preferences: one per account and API server, so a
 * shared browser or a second server never hands one person's writing to another. Empty while the
 * account is unknown or for link shares, which never reach Compass.
 */
export function useCompassAccountNamespace() {
	const authStore = useAuthStore()
	return computed(() => {
		const id = authStore.info?.id
		if (!id || authStore.isLinkShareAuth) return ''
		return compassAccountNamespace(getApiBaseUrl(), id)
	})
}

/**
 * Names the people behind an edit. A personal space only has its owner; a team space resolves
 * members through the team the space belongs to. Unknown ids fall back to "member #id".
 */
export function useCompassPeople(space: MaybeRefOrGetter<CompassSpace | undefined>) {
	const authStore = useAuthStore()
	const teamId = computed(() => toValue(space)?.team_id ?? 0)
	const team = useTeam(teamId)
	const names = computed(() => {
		const map = new Map<number, string>()
		for (const member of team.data.value?.members ?? []) {
			if (member.id) map.set(member.id, member.name || member.username || '')
		}
		return map
	})
	function personName(userId: number): string {
		const {t} = i18n.global
		if (userId <= 0) return ''
		if (userId === authStore.info?.id) return t('compass.people.you')
		return names.value.get(userId) || t('compass.people.member', {id: userId})
	}
	return {personName}
}
