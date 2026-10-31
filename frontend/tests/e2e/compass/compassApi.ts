import {
	expect,
	type APIRequestContext,
	type APIResponse,
} from '@playwright/test'
import {apiRootUrl} from '../../support/apiUrl'

// Compass state is seeded and checked through the real v2 API: table layout is not part of the contract.
export const COMPASS_API = `${apiRootUrl(process.env.API_URL || 'http://localhost:3456')}/api/v2`

export type CompassSpaceJson = {
	id: number
	owner_id: number
	team_id: number
	title: string
	motto?: string
	introduction?: string
	theme: string
	revision: number
	max_permission: number
	entry_count: number
	pinned_count: number
}

export type CompassEntryJson = {
	id: number
	space_id: number
	kind: string
	title: string
	subtitle?: string
	content?: string
	quote?: string
	category?: string
	tags?: string[] | null
	theme: string
	pinned: boolean
	state: 'active' | 'archived' | 'trashed'
	revision: number
	max_permission: number
}

export type CompassRevisionJson = {
	revision: number
	title: string
	kind: string
	state: string
}

export type CompassEntryInput = {
	kind?: 'principle' | 'vision' | 'action' | 'memory' | 'note'
	title: string
	subtitle?: string
	content?: string
	quote?: string
	category?: string
	tags?: string[]
	theme?: 'inherit' | 'aurora' | 'solar' | 'nebula' | 'ink'
	pinned?: boolean
}

function authorization(token: string) {
	return {Authorization: `Bearer ${token}`}
}

async function json<T>(response: APIResponse): Promise<T> {
	expect(response.ok(), `${response.status()} ${await response.text()}`).toBe(true)
	return response.json() as Promise<T>
}

export async function createCompassSpace(request: APIRequestContext, token: string, data: {
	title?: string
	motto?: string
	introduction?: string
	theme?: 'aurora' | 'solar' | 'nebula' | 'ink'
	team_id?: number
} = {}): Promise<CompassSpaceJson> {
	return json(await request.post(`${COMPASS_API}/compass/spaces`, {
		headers: authorization(token),
		data: {
			title: 'Compass',
			motto: '',
			introduction: '',
			theme: 'aurora',
			team_id: 0,
			...data,
		},
	}))
}

export async function readCompassSpace(request: APIRequestContext, token: string, spaceId: number): Promise<CompassSpaceJson> {
	return json(await request.get(`${COMPASS_API}/compass/spaces/${spaceId}`, {headers: authorization(token)}))
}

export async function listCompassSpaces(request: APIRequestContext, token: string): Promise<CompassSpaceJson[]> {
	const page = await json<{items?: CompassSpaceJson[] | null}>(
		await request.get(`${COMPASS_API}/compass/spaces`, {headers: authorization(token)}),
	)
	return page.items ?? []
}

export async function createCompassEntry(
	request: APIRequestContext,
	token: string,
	spaceId: number,
	data: CompassEntryInput,
): Promise<CompassEntryJson> {
	return json(await request.post(`${COMPASS_API}/compass/spaces/${spaceId}/entries`, {
		headers: authorization(token),
		data: {
			kind: 'note',
			subtitle: '',
			content: '',
			quote: '',
			category: '',
			tags: [],
			theme: 'inherit',
			pinned: false,
			state: 'active',
			...data,
		},
	}))
}

export async function readCompassEntry(request: APIRequestContext, token: string, entryId: number): Promise<CompassEntryJson> {
	return json(await request.get(`${COMPASS_API}/compass/entries/${entryId}`, {headers: authorization(token)}))
}

/** Changes some fields on top of the latest version, the way another device would. */
export async function updateCompassEntry(
	request: APIRequestContext,
	token: string,
	entryId: number,
	change: Partial<CompassEntryInput> & {state?: CompassEntryJson['state']},
): Promise<CompassEntryJson> {
	const latest = await readCompassEntry(request, token, entryId)
	return json(await request.put(`${COMPASS_API}/compass/entries/${entryId}`, {
		headers: authorization(token),
		data: {
			kind: latest.kind,
			title: latest.title,
			subtitle: latest.subtitle ?? '',
			content: latest.content ?? '',
			quote: latest.quote ?? '',
			category: latest.category ?? '',
			tags: latest.tags ?? [],
			theme: latest.theme,
			pinned: latest.pinned,
			state: latest.state,
			...change,
			revision: latest.revision,
		},
	}))
}

export async function listCompassEntries(
	request: APIRequestContext,
	token: string,
	spaceId: number,
	query: Record<string, string> = {},
): Promise<{items: CompassEntryJson[], total: number}> {
	const page = await json<{items?: CompassEntryJson[] | null, total?: number}>(
		await request.get(`${COMPASS_API}/compass/spaces/${spaceId}/entries`, {
			headers: authorization(token),
			params: query,
		}),
	)
	return {
		items: page.items ?? [],
		total: page.total ?? 0,
	}
}

export async function listCompassRevisions(
	request: APIRequestContext,
	token: string,
	entryId: number,
): Promise<CompassRevisionJson[]> {
	const page = await json<{items?: CompassRevisionJson[] | null}>(
		await request.get(`${COMPASS_API}/compass/entries/${entryId}/revisions`, {headers: authorization(token)}),
	)
	return page.items ?? []
}

/** The HTTP status another account gets for a resource; personal spaces must stay invisible. */
export async function compassStatusFor(request: APIRequestContext, token: string, path: string): Promise<number> {
	const response = await request.get(`${COMPASS_API}${path}`, {headers: authorization(token)})
	return response.status()
}
