/** Timings have different clocks; never subtract provider time from a browser timestamp. */
export type SpeechTelemetry = {
	mode: 'live' | 'file',
	model: string,
	endpoint?: string,
	requestID?: string,
	stopToTextMS?: number,
	prepareMS?: number,
	requestMS?: number,
	firstTextMS?: number,
	finishMS?: number,
	cleanupMS?: number,
	audioMS?: number,
	inputBytes?: number,
}
