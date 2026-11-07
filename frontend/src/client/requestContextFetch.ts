import {client} from '@/client/generated/client.gen'
import {assertClientRequestContext, type ClientRequestContext} from '@/client/requestContext'

/** Keep the normal SDK transport, but check the request's original owner at actual dispatch. */
export function contextFetch(context: ClientRequestContext): typeof fetch {
	const send = client.getConfig().fetch ?? globalThis.fetch
	return (input, init) => {
		// SDK preparation and asynchronous authentication interceptors may yield after the caller's check.
		assertClientRequestContext(context)
		return send(input, init)
	}
}
