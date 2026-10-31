import {
	compassEntryText,
	normalizeCompassTags,
	type CompassEntry,
	type CompassEntryText,
} from '@/client/queries/compass'
import {
	COMPASS_LIMITS,
	runeLength,
	type CompassEntryState,
} from '@/helpers/compass/constants'
import type {CompassFailure} from '@/helpers/compass/errors'
import {
	isBlankCompassHtml,
	type CompassDraftFields,
} from '@/helpers/compass/drafts'

/** The version the writing desk builds on: what "changed" means, and what a save sends besides the text. */
export type CompassDeskBase = {
	fields: CompassDraftFields
	revision: number
	state: CompassEntryState
}

export const COMPASS_LIMITED_FIELDS = ['title', 'subtitle', 'quote', 'category'] as const
export type CompassLimitedField = typeof COMPASS_LIMITED_FIELDS[number]

export const COMPASS_FIELD_LIMITS: Record<CompassLimitedField, number> = {
	title: COMPASS_LIMITS.entryTitle,
	subtitle: COMPASS_LIMITS.subtitle,
	quote: COMPASS_LIMITS.quote,
	category: COMPASS_LIMITS.category,
}

// From here on the body shows its size; the hard limit is COMPASS_LIMITS.contentBytes (2 MiB).
export const COMPASS_CONTENT_NOTICE_BYTES = 1.5 * 1024 * 1024

export function showsCompassCounter(count: number, limit: number): boolean {
	return count >= limit * .8
}

/** Character counts as the server will see them: the edges are trimmed before saving. */
export function compassFieldLengths(fields: CompassDraftFields): Record<CompassLimitedField, number> {
	return {
		title: runeLength(fields.title.trim()),
		subtitle: runeLength(fields.subtitle.trim()),
		quote: runeLength(fields.quote.trim()),
		category: runeLength(fields.category.trim()),
	}
}

export function compassDraftFieldsOf(entry: CompassEntry): CompassDraftFields {
	return {
		...compassEntryText(entry),
		pinned: entry.pinned,
	}
}

/** The text as it is sent: trimmed edges, de-duplicated tags, and no body that is only empty markup. */
export function compassTextForSave(fields: CompassDraftFields): CompassEntryText {
	return {
		kind: fields.kind,
		title: fields.title.trim(),
		subtitle: fields.subtitle.trim(),
		content: isBlankCompassHtml(fields.content) ? '' : fields.content,
		quote: fields.quote.trim(),
		category: fields.category.trim(),
		tags: normalizeCompassTags(fields.tags),
		theme: fields.theme,
	}
}

/** Why a save failed, as the desk explains it. */
export type CompassDeskFailure =
	// The entry was deleted permanently; the text can still become a new entry.
	| 'missing'
	// Creating failed because the space is gone or no longer writable.
	| 'spaceGone'
	| 'forbidden'
	| 'invalidState'
	| 'network'
	| 'other'
	// A newer version exists but could not be read.
	| 'conflictUnloaded'

export function compassDeskFailure(kind: Exclude<CompassFailure, 'aborted'>, creating: boolean): CompassDeskFailure {
	if (creating && (kind === 'missing' || kind === 'forbidden')) return 'spaceGone'
	if (kind === 'conflict') return 'other'
	return kind
}

/** "Title, Body and Tags" in the reader's language. */
export function formatCompassFieldList(labels: string[], locale: string): string {
	try {
		return new Intl.ListFormat(locale, {
			style: 'long',
			type: 'conjunction',
		}).format(labels)
	} catch {
		return labels.join(', ')
	}
}
