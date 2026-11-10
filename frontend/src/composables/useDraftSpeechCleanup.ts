import {onScopeDispose, ref} from 'vue'

/** Cleanup may improve a draft, but it must never delay sending or overwrite a newer edit. */
export function useDraftSpeechCleanup(options: {
	request: (text: string, signal: AbortSignal) => Promise<{text?: string}>,
	revision: () => number,
	onFailure: () => void,
}) {
	const pending = ref(false)
	const proposal = ref('')
	let active: AbortController | undefined

	function cancel() {
		active?.abort()
		active = undefined
		pending.value = false
		proposal.value = ''
	}

	async function run(input: {
		text: string,
		current: () => boolean,
		apply: (text: string) => void,
		onTiming?: (ms: number) => void,
	}) {
		cancel()
		const controller = new AbortController()
		active = controller
		const revision = options.revision()
		const started = performance.now()
		const current = () => active === controller && !controller.signal.aborted && input.current()
		pending.value = true
		try {
			const result = await options.request(input.text, controller.signal)
			if (!current()) return
			input.onTiming?.(performance.now() - started)
			if (!result.text?.trim()) {
				options.onFailure()
				return
			}
			if (options.revision() === revision) input.apply(result.text)
			else proposal.value = result.text
		} catch {
			if (current()) {
				input.onTiming?.(performance.now() - started)
				options.onFailure()
			}
		} finally {
			if (active === controller) {
				active = undefined
				pending.value = false
			}
		}
	}

	onScopeDispose(cancel)
	return {
		pending,
		proposal,
		run,
		cancel,
	}
}
