import {uploadAwareFetch} from '@/helpers/uploadTransport'
import {captureHttpDiagnostic} from '@/helpers/diagnostics'
import {i18n} from '@/i18n'
import {client} from '@/client/generated/client.gen'
import type {ResolvedRequestOptions} from '@/client/generated/client/types.gen'
import {getParseAs} from '@/client/generated/client/utils.gen'
import {
	beginNetworkDownload,
	clearStaleNetworkDownloads,
	downloadNetworkLabel,
	type NetworkDownload,
} from '@/client/networkActivity'
import {
	assertClientRequestContext,
	assertClientRequestMatchesContext,
	captureClientRequestContext,
	type ClientRequestContext,
} from '@/client/requestContext'
import {normalizeProblemBody} from '@/client/problem'
import {getToken, getTokenIdentity, refreshToken} from '@/helpers/auth'
import {getApiBaseUrl} from '@/helpers/apiUrl'
import {AUTH_TYPES} from '@/constants/auth'

async function getProblemCode(response: Response): Promise<number | null> {
	try {
		const problem = await response.clone().json() as {code?: unknown}
		return typeof problem.code === 'number' ? problem.code : null
	} catch {
		return null
	}
}

const requestContexts = new WeakMap<Request, ClientRequestContext>()
const requestDownloads = new WeakMap<Request, NetworkDownload>()
const retryRequests = new WeakMap<Request, {
	request: Request
	token: string
	identity: {id: number; type: number} | null
}>()

function isStreamingResponse(response: Response, options: ResolvedRequestOptions): boolean {
	return response.ok && (options.parseAs === 'stream' ||
		(options.parseAs === 'auto' && response.headers.get('Content-Type') === null)
	)
}

async function fenceResponseBody(
	response: Response,
	context: ClientRequestContext | undefined,
	options: ResolvedRequestOptions,
	download?: NetworkDownload,
): Promise<Response> {
	if (!context) {
		return response
	}

	assertClientRequestContext(context)
	if (response.body === null || isStreamingResponse(response, options)) {
		return response
	}

	// Handing the drained blob back fences without the clone's second copy of a large download.
	const parseAs = options.parseAs === 'auto' ? getParseAs(response.headers.get('Content-Type')) : options.parseAs
	if (response.ok && parseAs === 'blob') {
		const blob = await (download?.observe(response) ?? response).blob()
		assertClientRequestContext(context)
		return new Response(blob, {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers,
		})
	}

	await response.clone().arrayBuffer()
	assertClientRequestContext(context)
	return response
}

export function configureApiClient(): void {
	clearStaleNetworkDownloads()
	client.setConfig({
		baseUrl: getApiBaseUrl(),
		fetch: uploadAwareFetch,
		credentials: 'include',
		throwOnError: true,
	})
	client.interceptors.request.clear()
	client.interceptors.response.clear()
	client.interceptors.error.clear()

	client.interceptors.request.use((request, options: ResolvedRequestOptions) => {
		request.headers.set('Accept-Language', i18n.global.locale.value)
		const context = captureClientRequestContext()
		assertClientRequestMatchesContext(request, context, options.baseUrl)

		let managedRequest = request
		const token = getToken()
		if (token && !request.headers.has('Authorization')) {
			const headers = new Headers(request.headers)
			headers.set('Authorization', `Bearer ${token}`)
			managedRequest = new Request(request, {headers})
			retryRequests.set(managedRequest, {
				request: managedRequest.clone(),
				token,
				identity: getTokenIdentity(token),
			})
		}
		requestContexts.set(managedRequest, context)
		if (options.parseAs === 'blob') {
			const download = beginNetworkDownload(
				downloadNetworkLabel(options.url, options.path),
				context,
				managedRequest.signal,
			)
			if (download) requestDownloads.set(managedRequest, download)
		}
		return managedRequest
	})

	client.interceptors.response.use(async (response, request, options: ResolvedRequestOptions) => {
		const context = requestContexts.get(request)
		const download = requestDownloads.get(request)
		requestContexts.delete(request)
		try {
			response = await fenceResponseBody(response, context, options, download)

			const retryRequest = retryRequests.get(request)
			retryRequests.delete(request)
			if (!retryRequest || response.status !== 401) {
				return response
			}
			const problemCode = await getProblemCode(response)
			if (context) {
				assertClientRequestContext(context)
			}
			if (problemCode !== 11) {
				return response
			}

			const originalIdentity = retryRequest.identity
			if (originalIdentity?.type !== AUTH_TYPES.USER) {
				return response
			}

			const hasOriginalIdentity = (token: string | null) => {
				const identity = getTokenIdentity(token)
				return identity?.id === originalIdentity.id && identity.type === originalIdentity.type
			}

			let replacementToken = getToken()
			if (!replacementToken || !hasOriginalIdentity(replacementToken)) {
				return response
			}

			if (replacementToken === retryRequest.token) {
				try {
					await refreshToken(true)
				} catch {
					if (context) {
						assertClientRequestContext(context)
					}
					return response
				}
				if (context) {
					assertClientRequestContext(context)
				}

				replacementToken = getToken()
				if (!replacementToken || !hasOriginalIdentity(replacementToken)) {
					return response
				}
			}

			const headers = new Headers(retryRequest.request.headers)
			headers.set('Authorization', `Bearer ${replacementToken}`)
			const retry = new Request(retryRequest.request, {headers})
			const retryResponse = await (options.fetch ?? globalThis.fetch)(retry)
			return await fenceResponseBody(retryResponse, context, options, download)
		} finally {
			download?.finish()
			requestDownloads.delete(request)
			retryRequests.delete(request)
		}
	})

	client.interceptors.error.use((error, response, request) => {
		if (request) {
			requestDownloads.get(request)?.finish()
			requestDownloads.delete(request)
			requestContexts.delete(request)
			retryRequests.delete(request)
		}
		captureHttpDiagnostic(error, response, request)
		const problem = typeof error === 'string' && /<!doctype|<html/i.test(error)
			? {detail: i18n.global.t('debug.proxyError')}
			: error
		return normalizeProblemBody(problem, response)
	})
}
