import {computed, toValue, type MaybeRefOrGetter} from 'vue'
import {useIsFetching, useQueries} from '@tanstack/vue-query'

import type {TeamWithPermission, UserWithPermission} from '@/client/generated'
import {projectKeys, type ProjectResponse} from '@/client/queries/projects'
import {
	normalizeSharePermission,
	projectTeamSharesQuery,
	projectUserSharesQuery,
} from '@/client/queries/projectShares'
import {useProjects} from '@/composables/useProjects'
import {PERMISSIONS, type Permission} from '@/constants/permissions'
import {projectAncestry} from '@/helpers/projectAccess'

/**
 * - pending: nothing loaded yet.
 * - error: the last request failed. Rows from an earlier load may still be on screen, but they are not confirmed.
 * - refreshing: loaded, and a newer copy is on its way.
 * - success: loaded and settled; only this state may back a statement like "not shared".
 */
export type AccessStatus = 'pending' | 'error' | 'refreshing' | 'success'

export type InheritedSource = {
	parent: ProjectResponse
	/** The parent's owner is someone other than this project's owner, so they can open it as an admin. */
	ownerDiffers: boolean
	users: UserWithPermission[]
	teams: TeamWithPermission[]
	status: AccessStatus
}

/** A grant one parent project gives. It is the least access known, not everything the person or team can do. */
export type InheritedGrant = {
	parent: ProjectResponse
	permission: Permission
}

/** A failed refetch is an error even when older data is still cached: access may have changed since. */
export function queryStatus(data: unknown, isError: boolean, isFetching = false): AccessStatus {
	if (isError) return 'error'
	if (data === undefined) return 'pending'
	return isFetching ? 'refreshing' : 'success'
}

export function combineStatus(statuses: readonly AccessStatus[]): AccessStatus {
	for (const status of ['error', 'pending', 'refreshing'] as const) {
		if (statuses.includes(status)) return status
	}
	return 'success'
}

/** The list is known well enough to show: settled, or settled before and refreshing now. */
export function isListed(status: AccessStatus) {
	return status === 'success' || status === 'refreshing'
}

/**
 * The grant that stays when a direct share goes. Admin on any parent applies however far up it is (the backend's
 * "admin sticks"); below admin the nearest parent with a grant counts.
 */
export function strongestInheritedGrant(grants: readonly InheritedGrant[]): InheritedGrant | null {
	return grants.find(grant => grant.permission === PERMISSIONS.ADMIN) ?? grants[0] ?? null
}

/**
 * Who can open a project through its parents. The share endpoints only list direct grants, so the grants of every
 * parent the user can open are read from their own share lists.
 */
export function useProjectAccess(project: MaybeRefOrGetter<ProjectResponse | undefined>) {
	const projectList = useProjects()

	// The parent chain is only known once the project list has loaded; a missing parent before that is not hidden.
	const listFetching = useIsFetching({queryKey: projectKeys.list()})
	const listHasData = computed(() => !projectList.isLoading && (projectList.projectsArray.length > 0 || !projectList.isError))
	const listStatus = computed<AccessStatus>(() => queryStatus(
		listHasData.value ? true : undefined,
		projectList.isError,
		listFetching.value > 0,
	))
	const ancestry = computed(() => {
		const current = toValue(project)
		return current && listHasData.value
			? projectAncestry(projectList.projects, current)
			: {ancestors: [], hasHiddenAncestor: false}
	})

	const shareQueries = useQueries({queries: computed(() => ancestry.value.ancestors.flatMap(ancestor => [
		projectUserSharesQuery(ancestor.id),
		projectTeamSharesQuery(ancestor.id),
	]))})

	const sources = computed<InheritedSource[]>(() => {
		const ownerId = toValue(project)?.owner?.id
		return ancestry.value.ancestors.map((parent, index) => {
			const users = shareQueries.value[index * 2]
			const teams = shareQueries.value[index * 2 + 1]
			return {
				parent,
				ownerDiffers: parent.owner?.id !== undefined && parent.owner.id !== ownerId,
				users: users?.data ?? [],
				teams: teams?.data ?? [],
				status: combineStatus([
					users ? queryStatus(users.data, users.isError, users.isFetching) : 'pending',
					teams ? queryStatus(teams.data, teams.isError, teams.isFetching) : 'pending',
				]),
			}
		})
	})

	const status = computed(() => combineStatus([listStatus.value, ...sources.value.map(source => source.status)]))

	// Sources are nearest first; the owner of a parent project is an admin there.
	function inheritedUser(userId: number): InheritedGrant | null {
		if (listStatus.value !== 'success') return null
		return strongestInheritedGrant(sources.value.filter(source => source.status === 'success').flatMap(source => {
			if (source.parent.owner?.id === userId) {
				return [{parent: source.parent, permission: PERMISSIONS.ADMIN}]
			}
			const share = source.users.find(user => user.id === userId)
			return share ? [{parent: source.parent, permission: normalizeSharePermission(share.permission)}] : []
		}))
	}

	function inheritedTeam(teamId: number): InheritedGrant | null {
		if (listStatus.value !== 'success') return null
		return strongestInheritedGrant(sources.value.filter(source => source.status === 'success').flatMap(source => {
			const share = source.teams.find(team => team.id === teamId)
			return share ? [{parent: source.parent, permission: normalizeSharePermission(share.permission)}] : []
		}))
	}

	function retry() {
		if (projectList.isError) {
			projectList.refetch()
		}
		for (const query of shareQueries.value) {
			if (query.isError) {
				query.refetch()
			}
		}
	}

	return {
		listStatus,
		ancestry,
		sources,
		status,
		inheritedUser,
		inheritedTeam,
		retry,
	}
}
