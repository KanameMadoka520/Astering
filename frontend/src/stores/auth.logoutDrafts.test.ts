import {describe, it, expect, beforeEach, vi} from 'vitest'
import {setActivePinia, createPinia} from 'pinia'

import {useAuthStore} from './auth'
import {queryClient} from '@/client/queryClient'
import {getToken, saveToken} from '@/helpers/auth'
import {editorDraftNamespace} from '@/helpers/draftScope'
import {loadEditorDraft, saveEditorDraft, scopedEditorDraftKey} from '@/helpers/editorDraftStorage'

const {authLogoutMock, userShowMock, routerPushMock} = vi.hoisted(() => ({
	authLogoutMock: vi.fn(),
	userShowMock: vi.fn(),
	routerPushMock: vi.fn(),
}))

vi.mock('@/client/generated', async (importOriginal) => ({
	...await importOriginal<typeof import('@/client/generated')>(),
	authLogout: authLogoutMock,
	userShow: userShowMock,
}))

vi.mock('@/router', () => ({
	default: {push: routerPushMock},
}))

vi.mock('@/client/queryClient', async () => {
	const {QueryClient} = await import('@tanstack/vue-query')
	return {queryClient: new QueryClient({defaultOptions: {queries: {retry: false}}})}
})

vi.mock('@/composables/useWebSocket', () => ({
	useWebSocket: () => ({
		disconnect: vi.fn(),
		connect: vi.fn(),
		closeStaleConnection: vi.fn(),
	}),
}))

vi.mock('@/helpers/redirectToProvider', () => ({
	getRedirectUrlFromCurrentFrontendPath: vi.fn(),
	redirectToProvider: vi.fn(),
	redirectToProviderOnLogout: vi.fn(() => false),
}))

const token = (id: number) => `header.${btoa(JSON.stringify({id, type: 1}))}.signature`
let draftKey = ''

describe('auth store logout and local drafts', () => {
	beforeEach(() => {
		setActivePinia(createPinia())
		localStorage.clear()
		authLogoutMock.mockReset().mockResolvedValue({data: {}})
		userShowMock.mockReset()
		routerPushMock.mockReset().mockResolvedValue(undefined)
		saveToken(token(1), false)
		draftKey = scopedEditorDraftKey(editorDraftNamespace(), 'task-description-10')
		saveEditorDraft(draftKey, '<p>half a sentence</p>')
		localStorage.setItem('editorDraft-task-description-3', '<p>from before accounts</p>')
		localStorage.setItem('tcymc-ai-settings', '{"apiKey":"secret"}')
		queryClient.setQueryData(['private-account-content'], 'previous account data')
	})

	it("signs out and clears settings but keeps this account's unsaved task text", async () => {
		await useAuthStore().logout()

		expect(getToken()).toBeNull()
		expect(queryClient.getQueryData(['private-account-content'])).toBeUndefined()
		expect(localStorage.getItem('tcymc-ai-settings')).toBeNull()
		expect(localStorage.getItem('editorDraft-task-description-3')).toBeNull()
		expect(loadEditorDraft(draftKey)).toBe('<p>half a sentence</p>')
	})

	it('keeps the unsaved task text when the server ends the session', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {})
		userShowMock.mockRejectedValue({status: 401})

		await useAuthStore().refreshUserInfo()

		expect(getToken()).toBeNull()
		expect(queryClient.getQueryData(['private-account-content'])).toBeUndefined()
		expect(loadEditorDraft(draftKey)).toBe('<p>half a sentence</p>')
	})
})
