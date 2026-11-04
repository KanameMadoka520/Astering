// A waiting worker does not imply the open page is outdated: navigation may
// already have loaded the new HTML while an older worker still controls the tab.
export function needsFrontendRefresh(currentVersion: string, waitingVersion: string): boolean {
	const normalize = (version: string) => version.trim().replace(/^v/, '')
	const current = normalize(currentVersion)
	const waiting = normalize(waitingVersion)
	if (!waiting || waiting === current) return false

	// The rebrand continues the release sequence; an older worker can still reply with its legacy version.
	const release = /^(\d+)\.(\d+)\.(\d+)-(?:tcymc|aster)\.(\d+)$/
	const from = current.match(release)?.slice(1).map(Number)
	const to = waiting.match(release)?.slice(1).map(Number)
	if (from && to) {
		for (let i = 0; i < from.length; i++) {
			if (from[i] !== to[i]) return to[i] > from[i]
		}
		return false
	}
	return true
}

export function readWorkerVersion(worker: ServiceWorker): Promise<string> {
	return new Promise(resolve => {
		const channel = new MessageChannel()
		const finish = (version: string) => {
			clearTimeout(timer)
			channel.port1.close()
			channel.port2.close()
			resolve(version)
		}
		const timer = setTimeout(() => finish(''), 1000)
		channel.port1.onmessage = event => finish(typeof event.data?.version === 'string' ? event.data.version.trim() : '')
		try {
			worker.postMessage('getVersion', [channel.port2])
		} catch {
			finish('')
		}
	})
}
