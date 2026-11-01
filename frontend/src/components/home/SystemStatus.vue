<script setup lang="ts">
import {computed, ref} from 'vue'
import {useQuery} from '@tanstack/vue-query'
import {useDocumentVisibility} from '@vueuse/core'
import {useI18n} from 'vue-i18n'
import {SYSTEM_STATUS_DETAIL_INTERVAL, systemStatusQuery} from '@/client/queries/systemStatus'
import {useBaseStore} from '@/stores/base'
const {t} = useI18n({useScope: 'global'})
const base = useBaseStore()
const visibility = useDocumentVisibility()
const detailsOpen = ref(false)
const query = useQuery(computed(() => systemStatusQuery(base.menuActive && visibility.value === 'visible', detailsOpen.value)))
// Opening the details shows current numbers at once rather than up to a minute old ones.
function toggleDetails(event: Event) {
	detailsOpen.value = (event.target as HTMLDetailsElement).open
	if (detailsOpen.value && Date.now() - query.dataUpdatedAt.value > SYSTEM_STATUS_DETAIL_INTERVAL) void query.refetch()
}
const data = computed(() => query.data.value)
const app = computed(() => data.value?.application)
const appDisk = computed(() => app.value?.storage?.files_bytes != null && app.value?.storage?.database_bytes != null
	? app.value.storage.files_bytes + app.value.storage.database_bytes
	: null)
const state = computed(() => {
	if (query.isError.value) return 'offline'
	if (!data.value) return 'loading'
	if (!data.value.host_metrics_available) return 'unconfigured'
	return data.value.healthy ? 'healthy' : 'degraded'
})
function bytes(n?: number | null) {
	if (n == null) return '—'
	const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
	const index = Math.min(4, Math.max(0, Math.floor(Math.log2(Math.max(1, n)) / 10)))
	return `${(n / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`
}
function ratio(used?: number | null, total?: number | null) {
	return used != null && total ? used / total * 100 : null
}
function percent(value?: number | null) {
	return value == null ? '—' : `${value.toFixed(1)}%`
}
const rows = computed(() => [
	{
		key: 'cpu',
		percent: data.value?.cpu_percent,
		detail: data.value?.cpu_cores ? t('systemStatus.cores', {n: data.value.cpu_cores}) : '—',
	},
	{
		key: 'memory',
		percent: ratio(data.value?.memory_used, data.value?.memory_total),
		detail: `${bytes(data.value?.memory_used)} / ${bytes(data.value?.memory_total)}`,
	},
	{
		key: 'disk',
		percent: ratio(data.value?.disk_used, data.value?.disk_total),
		detail: `${bytes(data.value?.disk_used)} / ${bytes(data.value?.disk_total)}`,
	},
])
function duration(seconds?: number | null) {
	if (seconds == null) return '—'
	return t('systemStatus.duration', {
		days: Math.floor(seconds / 86400),
		hours: Math.floor(seconds % 86400 / 3600),
		minutes: Math.floor(seconds % 3600 / 60),
	})
}
function sampledAt(value?: string | null) {
	return value ? new Date(value).toLocaleString() : '—'
}
</script>

<template>
	<section
		class="system-status"
		:aria-label="t('systemStatus.title')"
	>
		<div class="status-heading">
			<strong>{{ t('systemStatus.title') }}</strong>
			<span
				class="status-state"
				:class="state"
			>{{ t(`systemStatus.${state}`) }}</span>
		</div>
		<template v-if="data">
			<div
				v-for="row in rows"
				:key="row.key"
				class="meter"
				:title="`${t(`systemStatus.${row.key}`)} · ${row.detail}`"
			>
				<span class="meter-label">{{ t(`systemStatus.${row.key}`) }}</span>
				<progress
					:aria-label="t(`systemStatus.${row.key}`)"
					:value="row.percent == null ? 0 : Math.min(100, row.percent)"
					max="100"
				/>
				<span class="meter-value">
					<template v-if="row.percent == null">
						<span aria-hidden="true">—</span>
						<span class="is-sr-only">{{ t('systemStatus.unavailable') }}</span>
					</template>
					<template v-else>{{ percent(row.percent) }}</template>
				</span>
			</div>
			<div class="runtime">
				<span>{{ t('systemStatus.uptime', {duration: duration(data.uptime_seconds)}) }}</span>
				<a
					:href="`https://github.com/KanameMadoka520/vikunja-x/releases/tag/${data.version}`"
					target="_blank"
					rel="noopener noreferrer"
				>{{ data.version }}</a>
			</div>
			<details
				class="status-details"
				@toggle="toggleDetails"
			>
				<summary>{{ t('systemStatus.measurement') }}</summary>
				<p class="detail-group">
					{{ t('systemStatus.host') }}
				</p>
				<dl class="detail-list">
					<template
						v-for="row in rows"
						:key="row.key"
					>
						<dt>{{ t(`systemStatus.${row.key}`) }}</dt>
						<dd>{{ row.percent == null ? t('systemStatus.unavailable') : percent(row.percent) }} · {{ row.detail }}</dd>
					</template>
					<dt>{{ t('systemStatus.load') }} <small>{{ t('systemStatus.loadPeriods') }}</small></dt>
					<dd>
						{{ data.load_average?.length === 3 ? data.load_average.map(n => n.toFixed(2)).join(' / ') : '—' }}
					</dd>
				</dl>
				<p class="detail-note">
					{{ t('systemStatus.hostUptime', {duration: duration(data.host_uptime_seconds)}) }}
				</p>
				<template v-if="app">
					<p class="detail-group">
						{{ t('systemStatus.application') }}
					</p>
					<dl class="detail-list">
						<dt>{{ t('systemStatus.appCPU') }}</dt>
						<dd>
							{{ percent(app.cpu_percent) }} · {{ app.cpu_cores ? t('systemStatus.cores', {n: app.cpu_cores}) : '—' }}
							· {{ t('systemStatus.appCPUScale') }}
						</dd>
						<dt>{{ t('systemStatus.gpu') }}</dt>
						<dd>{{ t(app.gpu_status === 'not_assigned' ? 'systemStatus.gpuNone' : 'systemStatus.gpuUnavailable') }}</dd>
						<dt>{{ t('systemStatus.appMemory') }}</dt>
						<dd>{{ bytes(app.memory_used) }}</dd>
						<dt>{{ t('systemStatus.appFiles') }}</dt>
						<dd>{{ bytes(app.storage?.files_bytes) }}</dd>
						<dt>{{ t('systemStatus.appDatabase') }}</dt>
						<dd>{{ bytes(app.storage?.database_bytes) }}</dd>
						<dt>{{ t('systemStatus.appDisk') }}</dt>
						<dd>{{ bytes(appDisk) }}</dd>
					</dl>
				</template>
				<div class="detail-help">
					<p>{{ t('systemStatus.hostSource') }}</p>
					<p>{{ t('systemStatus.appCPUHelp') }}</p>
					<p>{{ t('systemStatus.appStorageHelp') }}</p>
					<p v-if="app?.gpu_status === 'not_assigned'">
						{{ t('systemStatus.appGPUHelp') }}
					</p>
					<p>{{ t('systemStatus.storageSampled') }} {{ sampledAt(app?.storage?.sampled) }}</p>
					<p>{{ t('systemStatus.cpuHelp') }}</p>
					<p>
						{{ t('systemStatus.ioWait') }} {{ percent(data.cpu_io_wait_percent) }}
						· {{ t('systemStatus.steal') }} {{ percent(data.cpu_steal_percent) }}
					</p>
					<p>{{ t('systemStatus.memoryHelp') }}</p>
					<p>{{ t('systemStatus.loadHelp') }}</p>
					<p>{{ t('systemStatus.diskHelp') }}</p>
					<p>{{ t('systemStatus.refreshHelp') }}</p>
					<p>{{ t('systemStatus.sampled') }} {{ sampledAt(data.sampled) }}</p>
				</div>
			</details>
		</template>
		<button
			v-if="query.isError.value"
			type="button"
			class="status-retry"
			@click="query.refetch()"
		>
			{{ t('loadingError.tryAgain') }}
		</button>
	</section>
</template>

<style scoped lang="scss">
.system-status {
	display: grid;
	gap: var(--space-1);
	margin-block-start: var(--space-2);
	padding: var(--space-3) var(--space-2) 0;
	border-block-start: 1px solid var(--border-subtle);
	color: var(--text-secondary);
	font-size: var(--text-xs);
	line-height: var(--leading-tight);
}

.status-heading,
.runtime {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	justify-content: space-between;
	gap: var(--space-1) var(--space-2);
}

.status-heading {
	margin-block-end: var(--space-1);

	strong {
		color: var(--text-primary);
		font-weight: var(--weight-semibold);
	}
}

// The state is spelled out next to its dot, so colour is never the only cue.
.status-state {
	display: inline-flex;
	align-items: center;
	gap: var(--space-1);
	font-weight: var(--weight-medium);

	&::before {
		content: '';
		inline-size: .375rem;
		block-size: .375rem;
		border-radius: var(--radius-full);
		background: currentcolor;
	}

	&.healthy {
		color: color-mix(in srgb, var(--success) 42%, var(--text-strong));
	}

	&.loading {
		color: var(--text-tertiary);
	}

	&.offline,
	&.degraded,
	&.unconfigured {
		color: var(--danger-text);
	}
}

.meter {
	display: grid;
	grid-template-columns: minmax(0, 1fr) 3rem 3.25rem;
	align-items: center;
	gap: var(--space-2);
	min-block-size: 1.25rem;
}

.meter-label {
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.meter progress {
	inline-size: 100%;
	block-size: .25rem;
	accent-color: var(--primary);
}

.meter-value {
	color: var(--text-primary);
	font-variant-numeric: tabular-nums;
	text-align: end;
}

.runtime {
	margin-block-start: var(--space-1);
	color: var(--text-tertiary);

	a {
		color: var(--accent-text);
		overflow-wrap: anywhere;
	}
}

.status-details {
	margin-block-start: var(--space-1);

	summary {
		padding-block: var(--space-1);
		color: var(--text-secondary);
		cursor: pointer;

		&:hover {
			color: var(--text-primary);
		}
	}
}

.detail-list {
	display: grid;
	grid-template-columns: repeat(2, minmax(0, 1fr));
	gap: var(--space-1) var(--space-2);
	margin-block: var(--space-2);

	dt {
		color: var(--text-secondary);
		overflow-wrap: anywhere;

		small {
			display: block;
			color: var(--text-tertiary);
			font-size: var(--text-2xs);
		}
	}

	dd {
		margin: 0;
		color: var(--text-primary);
		text-align: end;
		overflow-wrap: anywhere;
	}
}

.detail-group {
	margin-block-start: var(--space-3);
	color: var(--text-primary);
	font-weight: var(--weight-semibold);
}

.detail-note {
	color: var(--text-tertiary);
}

.detail-help p {
	margin-block: var(--space-2);
	color: var(--text-secondary);
	line-height: var(--leading-normal);
}

.status-retry {
	justify-self: start;
	padding: var(--space-1) 0;
	border: 0;
	background: transparent;
	color: var(--accent-text);
	font: inherit;
	font-weight: var(--weight-medium);
	cursor: pointer;

	&:hover {
		text-decoration: underline;
	}
}
</style>
