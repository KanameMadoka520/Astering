import type {NoteSegment, NoteText} from '@/client/queries/notes'

export function sameNoteText(left: Readonly<NoteText>, right: Readonly<NoteText>): boolean {
	return left.title === right.title
		&& left.pinned === right.pinned
		&& left.content === right.content
}

export function transcriptTime(milliseconds: number): string {
	const seconds = Math.max(0, Math.floor(milliseconds / 1000))
	const hours = Math.floor(seconds / 3600)
	const minutes = Math.floor(seconds / 60) % 60
	const tail = `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
	return hours > 0 ? `${hours}:${tail}` : tail
}

/** Capture time is never replaced with the later HTTP/database ingestion time. */
export function transcriptCapturedTime(segment: Pick<NoteSegment, 'captured_at' | 'timezone'>, timezone?: string, locale = 'en'): string | undefined {
	if (!segment.captured_at || !Number.isFinite(Date.parse(segment.captured_at))) return undefined
	try {
		return new Intl.DateTimeFormat(locale, {
			timeZone: timezone || segment.timezone || 'UTC',
			year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
			hour12: false, timeZoneName: 'shortOffset',
		}).format(new Date(segment.captured_at))
	} catch {
		return new Date(segment.captured_at).toISOString()
	}
}

/** A selection is always taken from the current bounded page, in source order. */
export function selectedTranscript(segments: NoteSegment[], selected: readonly number[], timezone?: string): string {
	const ids = new Set(selected)
	return segments.filter(segment => ids.has(segment.id))
		.map(segment => {
			const estimated = segment.timing_estimated ? '≈ ' : ''
			const capture = transcriptCapturedTime(segment, timezone)
			return `[${capture ? `${capture} · ` : ''}${estimated}${transcriptTime(segment.start_ms)}–${transcriptTime(segment.end_ms)}] ${segment.text}`
		})
		.join('\n\n')
}

export function noteExportFilename(title: string, extension: 'md' | 'txt'): string {
	const name = title.replace(/[<>:"/\\|?*]/g, '-').replace(/\p{Cc}/gu, '-').replace(/\.+$/, '').trim().slice(0, 120)
	return `${name || 'note'}.${extension}`
}
