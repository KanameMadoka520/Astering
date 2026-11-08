import {describe, expect, it, vi} from 'vitest'
import type {NoteSegment, NoteText} from '@/client/queries/notes'
import {noteExportFilename, sameNoteText, selectedTranscript, transcriptTime} from './text'

function segment(id: number, text: string): NoteSegment {
	return {id, note_id: 1, client_id: `segment-${id}`, text, start_ms: id * 1000, end_ms: id * 1000 + 1000, timing_estimated: false}
}

describe('notes source selection', () => {
	it('exports only selected segments on the current page, in source order', () => {
		const source = [segment(2, 'Second'), segment(5, 'Fifth')]
		expect(selectedTranscript(source, [5, 999, 2])).toBe('[00:02–00:03] Second\n\n[00:05–00:06] Fifth')
	})
	it('keeps elapsed recording hours without wrapping at a day', () => {
		expect(transcriptTime(26 * 3600 * 1000 + 65_000)).toBe('26:01:05')
	})
	it('marks approximate provider timing in selected source text', () => {
		expect(selectedTranscript([{...segment(2, 'Approximate'), timing_estimated: true}], [2]))
			.toBe('[≈ 00:02–00:03] Approximate')
	})
	it('uses a safe local filename for downloads', () => {
		expect(noteExportFilename('../Draft: A/B?', 'md')).toBe('..-Draft- A-B-.md')
	})
})


describe('editor text equality without article serialization', () => {
	const original: Readonly<NoteText> = {
		title: 'A title with "quotes"',
		content: 'Line one\nLine two\t🌠',
		pinned: false,
	}

	it('compares equal independent field snapshots by value', () => {
		expect(sameNoteText(original, {...original})).toBe(true)
	})

	it.each([
		{title: 'Changed heading'},
		{content: 'Changed article'},
		{pinned: true},
	])('detects a change to any editorial field: %s', change => {
		expect(sameNoteText(original, {...original, ...change})).toBe(false)
	})

	it('keeps field boundaries distinct even when values contain punctuation and separators', () => {
		expect(sameNoteText({
			title: 'one|two',
			content: 'three',
			pinned: false,
		}, {
			title: 'one',
			content: 'two|three',
			pinned: false,
		})).toBe(false)
	})

	it('does not serialize an 8 MiB article when comparing draft snapshots', () => {
		const content = 'r'.repeat(8 * 1024 * 1024)
		const left: Readonly<NoteText> = {
			title: 'Large article',
			content,
			pinned: false,
		}
		const right = {...left}
		const serialize = vi.spyOn(JSON, 'stringify')
		const equal = sameNoteText(left, right)
		const calls = serialize.mock.calls.length
		serialize.mockRestore()
		expect(equal).toBe(true)
		expect(calls).toBe(0)
	})
})
