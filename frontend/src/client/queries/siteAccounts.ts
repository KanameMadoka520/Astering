import {queryOptions, useMutation, type QueryFunctionContext} from '@tanstack/vue-query'
import {
	systemAccountsAccess,
	systemAccountsList,
	systemAccountsStatus,
	systemAccountsRevokeAccess,
	systemAccountsEvents,
	type SystemUsageUsersData,
	type AccountManagementUser,
	type AccountManagementSnapshot,
	type SystemAccountsAccessResponse,
} from '@/client/generated'
import {
	assertClientRequestContext,
	captureClientRequestContext,
	isClientRequestContextCurrent,
	type ClientRequestContext,
} from '@/client/requestContext'
import {contextFetch} from '@/client/requestContextFetch'
import {contextMutationOptions} from './contextMutation'
import {toPaginated} from './pagination'
import type {ScopedUsage} from './siteUsage'

export type ManagedAccountsSnapshot = AccountManagementSnapshot
export type ManagedAccount = AccountManagementUser
export type AccountAction = 'disable' | 'enable' | 'revoke'
export type AccountActionInput = {
	id: number,
	action: AccountAction,
	expectedStatus: number,
	confirmUsername: string,
	reason: string,
}

export const siteAccountsKeys = {
	all: ['site-accounts'] as const,
	access: (context: ClientRequestContext) => ['site-accounts', 'access', context] as const,
	users: (context: ClientRequestContext, query: NonNullable<SystemUsageUsersData['query']>) =>
		['site-accounts', 'users', context, query] as const,
	events: (context: ClientRequestContext, page: number) => ['site-accounts', 'events', context, page] as const,
}

function denyManagementAccess(cause: unknown, context: ClientRequestContext, client: QueryFunctionContext['client']) {
	if ((cause as {status?: number} | null)?.status !== 403 || !isClientRequestContextCurrent(context)) return
	const queryKey = siteAccountsKeys.access(context)
	client.setQueryData<ScopedUsage<SystemAccountsAccessResponse>>(queryKey, current => current ? {
		...current,
		data: {...current.data, can_manage_accounts: false},
	} : undefined)
	// A denial of any protected resource invalidates the page grant. A normal access recheck can restore it.
	void client.invalidateQueries({queryKey, exact: true, refetchType: 'none'}).catch(() => {})
}

export function siteAccountsAccessQuery(context = captureClientRequestContext()) {
	return queryOptions({
		queryKey: siteAccountsKeys.access(context),
		queryFn: async ({signal}) => {
			assertClientRequestContext(context)
			const {data} = await systemAccountsAccess({signal, fetch: contextFetch(context)})
			assertClientRequestContext(context)
			return {context, data}
		},
		staleTime: 0,
		refetchOnMount: 'always',
		refetchOnWindowFocus: true,
		retry: false,
		meta: {handlesError: true},
	})
}

export function siteAccountsQuery(
	query: NonNullable<SystemUsageUsersData['query']>,
	context = captureClientRequestContext(),
) {
	return queryOptions({
		queryKey: siteAccountsKeys.users(context, query),
		queryFn: async ({signal, client}) => {
			assertClientRequestContext(context)
			const {data} = await systemAccountsList({query, signal, fetch: contextFetch(context)}).catch(cause => {
				denyManagementAccess(cause, context, client)
				throw cause
			})
			assertClientRequestContext(context)
			return {context, data}
		},
		staleTime: 0,
		gcTime: 60_000,
		refetchOnMount: 'always',
		refetchInterval: 60_000,
		retry: false,
		meta: {handlesError: true},
	})
}

export function siteAccountEventsQuery(page: number, context = captureClientRequestContext()) {
	return queryOptions({
		queryKey: siteAccountsKeys.events(context, page),
		queryFn: async ({signal, client}) => {
			assertClientRequestContext(context)
			const {data} = await systemAccountsEvents({query: {page}, signal, fetch: contextFetch(context)}).catch(cause => {
				denyManagementAccess(cause, context, client)
				throw cause
			})
			assertClientRequestContext(context)
			return {
				context,
				data: toPaginated(data, page),
			}
		},
		staleTime: 0,
		gcTime: 60_000,
		refetchOnMount: 'always',
		retry: false,
		meta: {handlesError: true},
	})
}

export function siteAccountActionMutationOptions(owner: ClientRequestContext) {
	const recheckAccess = new WeakSet<AccountActionInput>()
	return contextMutationOptions({
		mutationFn: async (input: AccountActionInput) => {
			const body = {confirm_username: input.confirmUsername, reason: input.reason.trim()}
			const options = {path: {id: input.id}, fetch: contextFetch(owner)}
			try {
				return input.action === 'revoke'
					? (await systemAccountsRevokeAccess({...options, body})).data
					: (await systemAccountsStatus({
						...options,
						body: {
							...body,
							status: input.action === 'disable' ? 2 : 0,
							expected_status: input.expectedStatus,
						},
					})).data
			} catch (cause) {
				if ((cause as {status?: number}).status === 403) recheckAccess.add(input)
				throw cause
			}
		},
		onSettled: (input, client) => {
			// The write is confirmed by its POST; a slow follow-up read must not keep the confirmation locked.
			void Promise.all([
				client.invalidateQueries({queryKey: ['site-accounts', 'users']}),
				client.invalidateQueries({queryKey: ['site-accounts', 'events']}),
				client.invalidateQueries({queryKey: ['site-usage']}),
				...(recheckAccess.has(input) ? [client.invalidateQueries({queryKey: siteAccountsKeys.access(owner)})] : []),
			]).catch(() => {})
			return Promise.resolve()
		},
		toastError: () => false,
	}, owner)
}

export function useSiteAccountActionMutation(owner: ClientRequestContext) {
	return useMutation(siteAccountActionMutationOptions(owner))
}
