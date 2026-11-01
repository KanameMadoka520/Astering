import type {ProjectResponse} from '@/client/queries/projects'
import {getDisplayName} from '@/helpers/user'

// Access rules mirrored here (pkg/models/project_access.go): the owner and every user or team share on a project
// also apply to all projects below it; link shares only open their own project.

type ProjectLookup = Readonly<Record<number, ProjectResponse | undefined>>

export type ProjectAncestry = {
	/** Nearest parent first. */
	ancestors: ProjectResponse[]
	/** A parent is missing from the caller's project list: they can't open it, but others can. */
	hasHiddenAncestor: boolean
}

export function projectAncestry(
	projects: ProjectLookup,
	project: Pick<ProjectResponse, 'id' | 'parent_project_id'>,
): ProjectAncestry {
	const ancestors: ProjectResponse[] = []
	const seen = new Set([project.id])
	let parentId = project.parent_project_id
	while (parentId > 0 && !seen.has(parentId)) {
		const parent = projects[parentId]
		if (!parent) {
			return {ancestors, hasHiddenAncestor: true}
		}
		ancestors.push(parent)
		seen.add(parentId)
		parentId = parent.parent_project_id
	}
	return {ancestors, hasHiddenAncestor: false}
}

/** Every project below the given one, not only its direct children. */
export function descendantProjects(projects: readonly ProjectResponse[], projectId: number): ProjectResponse[] {
	const found: ProjectResponse[] = []
	const seen = new Set([projectId])
	const queue = [projectId]
	while (queue.length > 0) {
		const parentId = queue.shift()!
		for (const project of projects) {
			if (project.parent_project_id === parentId && !seen.has(project.id)) {
				seen.add(project.id)
				found.push(project)
				queue.push(project.id)
			}
		}
	}
	return found
}

export type ProjectAccessHint =
	| {kind: 'sharedWithYou', ownerName: string}
	| {kind: 'inSharedParent', parentTitle: string | null}

/**
 * What the project list alone can say for certain about who else can open a project. An own project in an own tree
 * gets no hint: it may still have direct shares, which only the share page can read.
 */
export function projectAccessHint(
	projects: ProjectLookup,
	project: ProjectResponse,
	currentUserId: number | undefined,
): ProjectAccessHint | null {
	const ownerId = project.owner?.id
	if (!currentUserId || project.id <= 0 || ownerId === undefined) {
		return null
	}
	if (ownerId !== currentUserId) {
		return {kind: 'sharedWithYou', ownerName: getDisplayName(project.owner)}
	}
	const {ancestors, hasHiddenAncestor} = projectAncestry(projects, project)
	const foreign = ancestors.find(ancestor => ancestor.owner?.id !== undefined && ancestor.owner.id !== currentUserId)
	if (foreign) {
		return {kind: 'inSharedParent', parentTitle: foreign.title}
	}
	return hasHiddenAncestor ? {kind: 'inSharedParent', parentTitle: null} : null
}
