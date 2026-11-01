import {describe, expect, it} from 'vitest'

import {normalizeProject, type ProjectResponse} from '@/client/queries/projects'
import {descendantProjects, projectAccessHint, projectAncestry} from './projectAccess'

const ME = 1
const OTHER = 2

function project(id: number, parent: number, owner: number, title = `P${id}`): ProjectResponse {
	return normalizeProject({
		id,
		title,
		parent_project_id: parent,
		owner: {id: owner, username: owner === ME ? 'me' : 'sam', name: owner === ME ? '' : 'Sam'},
	})
}

function lookup(...projects: ProjectResponse[]) {
	return Object.fromEntries(projects.map(item => [item.id, item]))
}

describe('projectAncestry', () => {
	it('walks the parents nearest first', () => {
		const projects = lookup(project(1, 0, ME), project(2, 1, ME), project(3, 2, ME))
		const ancestry = projectAncestry(projects, projects[3]!)
		expect(ancestry.ancestors.map(item => item.id)).toEqual([2, 1])
		expect(ancestry.hasHiddenAncestor).toBe(false)
	})

	it('reports a parent the user cannot open', () => {
		const projects = lookup(project(2, 1, ME), project(3, 2, ME))
		const ancestry = projectAncestry(projects, projects[3]!)
		expect(ancestry.ancestors.map(item => item.id)).toEqual([2])
		expect(ancestry.hasHiddenAncestor).toBe(true)
	})

	it('stops on a cycle instead of looping', () => {
		const projects = lookup(project(1, 2, ME), project(2, 1, ME))
		expect(projectAncestry(projects, projects[1]!).ancestors.map(item => item.id)).toEqual([2])
	})
})

describe('descendantProjects', () => {
	it('includes grandchildren, not only direct children', () => {
		const projects = [project(1, 0, ME), project(2, 1, ME), project(3, 2, ME), project(4, 0, ME)]
		expect(descendantProjects(projects, 1).map(item => item.id)).toEqual([2, 3])
	})
})

describe('projectAccessHint', () => {
	it('says a project owned by someone else is shared with you', () => {
		const projects = lookup(project(5, 0, OTHER))
		expect(projectAccessHint(projects, projects[5]!, ME)).toEqual({kind: 'sharedWithYou', ownerName: 'Sam'})
	})

	it('says an own project inside someone else\'s project is in a shared project', () => {
		const projects = lookup(project(1, 0, OTHER, 'Team'), project(2, 1, ME))
		expect(projectAccessHint(projects, projects[2]!, ME)).toEqual({kind: 'inSharedParent', parentTitle: 'Team'})
	})

	it('says an own project inside a hidden parent is in a shared project', () => {
		const projects = lookup(project(2, 1, ME))
		expect(projectAccessHint(projects, projects[2]!, ME)).toEqual({kind: 'inSharedParent', parentTitle: null})
	})

	it('makes no claim about an own project in an own tree', () => {
		const projects = lookup(project(1, 0, ME), project(2, 1, ME))
		expect(projectAccessHint(projects, projects[2]!, ME)).toBeNull()
	})

	it('makes no claim without an owner or a signed-in user', () => {
		const projects = lookup(normalizeProject({id: 3, title: 'No owner'}))
		expect(projectAccessHint(projects, projects[3]!, ME)).toBeNull()
		expect(projectAccessHint(lookup(project(5, 0, OTHER)), project(5, 0, OTHER), undefined)).toBeNull()
	})
})
