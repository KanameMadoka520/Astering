import {ApiError} from '@/client/problem'
import {isRequestContextAbort} from '@/client/requestContext'
import {COMPASS_ERROR_CODES} from './constants'

export type CompassFailure =
	// The account or server changed mid-request: show nothing.
	| 'aborted'
	// Someone saved a newer revision (409 / 20101).
	| 'conflict'
	// Gone or never visible (404 / 20102).
	| 'missing'
	// The entry's state forbids the action, e.g. editing in the trash (400 / 20103).
	| 'invalidState'
	// An image in the body or the background cannot be used (20104 / 20105 / 20106); the server's message names it.
	| 'image'
	| 'forbidden'
	// No answer at all: offline, DNS, proxy down.
	| 'network'
	| 'other'

const IMAGE_CODES: readonly number[] = [
	COMPASS_ERROR_CODES.imageUnavailable,
	COMPASS_ERROR_CODES.imageLimit,
	COMPASS_ERROR_CODES.imageUnsupported,
]

export function classifyCompassFailure(cause: unknown): CompassFailure {
	if (isRequestContextAbort(cause)) return 'aborted'
	if (cause instanceof ApiError) {
		// Before the status: an unavailable image also answers 409, but no newer revision exists.
		if (cause.code !== undefined && IMAGE_CODES.includes(cause.code)) return 'image'
		if (cause.status === 409 || cause.code === COMPASS_ERROR_CODES.revisionConflict) return 'conflict'
		if (cause.status === 404 || cause.code === COMPASS_ERROR_CODES.missing) return 'missing'
		if (cause.code === COMPASS_ERROR_CODES.invalidState) return 'invalidState'
		if (cause.status === 403) return 'forbidden'
		return 'other'
	}
	// fetch rejects with a TypeError when the request never got an answer.
	if (cause instanceof TypeError) return 'network'
	return 'other'
}
