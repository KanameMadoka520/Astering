import {queryOptions} from '@tanstack/vue-query'
import {
	authAccountSessionsList,
	authAccountSessionsRemember,
	authAccountSessionsSwitch,
	authAccountSessionsForget,
	authAccountSessionsClear,
	authLogout,
	type RememberedAccountsBodyBody,
} from '@/client/generated'
import {publicClient} from '@/client/publicClient'
import {canonicalApiBaseUrl} from '@/client/requestContext'
import {getApiBaseUrl} from '@/helpers/apiUrl'

const intentHeaders = {'X-Astering-Account-Intent': 'manage'}

function deviceOptions() {
	return {
		client: publicClient,
		baseUrl: canonicalApiBaseUrl(getApiBaseUrl()),
		headers: intentHeaders,
	}
}

export type DeviceAccount = {
	session_id: string,
	user_id: number,
	username: string,
	name: string,
}

function normalizeDeviceAccounts(data: RememberedAccountsBodyBody): {accounts: DeviceAccount[]; limit: number} {
	if (!Array.isArray(data.accounts) || data.accounts.length > 5 || data.limit !== 5) throw new Error('Invalid device account response')
	const accounts = data.accounts.map(account => {
		if (typeof account.session_id !== 'string' || !/^[a-f0-9-]{36}$/i.test(account.session_id) ||
   typeof account.user_id !== 'number' || !Number.isSafeInteger(account.user_id) || account.user_id <= 0 ||
   typeof account.username !== 'string' || !account.username) throw new Error('Invalid device account response')
		return {
			session_id: account.session_id,
			user_id: account.user_id,
			username: account.username,
			name: account.name ?? '',
		}
	})
	return {
		accounts,
		limit: data.limit,
	}
}

export const deviceAccountKeys = {
	all: ['device-account-sessions'] as const,
	list: () => [...deviceAccountKeys.all, canonicalApiBaseUrl(getApiBaseUrl())] as const,
}

// This is a cookie-authorized login chooser, including when there is no active
// bearer token. It deliberately uses publicClient to avoid recursive refresh.
export function deviceAccountsQuery() {
	return queryOptions({
		queryKey: deviceAccountKeys.list(),
		queryFn: async ({signal}) => normalizeDeviceAccounts((await authAccountSessionsList({...deviceOptions(), signal})).data),
		staleTime: 0,
		gcTime: 0,
		retry: false,
		meta: {handlesError: true},
	})
}

export async function rememberCurrentDeviceAccount(token: string) {
	// Called under the shared refresh/switch lock. Skip recursive 401 refresh:
	// the caller supplies and fences the one current short-lived bearer token.
	return normalizeDeviceAccounts((await authAccountSessionsRemember({
		...deviceOptions(),
		headers: {
			...intentHeaders,
			Authorization: `Bearer ${token}`,
		},
	})).data)
}

export async function logoutCurrentDeviceAccount(token: string) {
	await authLogout({
		...deviceOptions(),
		headers: {Authorization: `Bearer ${token}`},
	})
}

export async function selectDeviceAccount(sessionId: string) {
	return (await authAccountSessionsSwitch({
		...deviceOptions(),
		body: {session_id: sessionId},
	})).data
}

export async function forgetDeviceAccount(sessionId: string) {
	await authAccountSessionsForget({
		...deviceOptions(),
		body: {session_id: sessionId},
	})
}

export async function clearDeviceAccounts() {
	await authAccountSessionsClear(deviceOptions())
}
