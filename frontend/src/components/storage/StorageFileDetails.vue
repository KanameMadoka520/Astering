<script setup lang="ts">
import {computed, onBeforeUnmount, onMounted, ref} from 'vue'
import {useI18n} from 'vue-i18n'
import {
	currentStorageData,
	useStoragePreviewMutation,
	type StorageFile,
	type StoragePreview,
} from '@/client/queries/storage'
import {isClientRequestContextCurrent, type ClientRequestContext} from '@/client/requestContext'
import DriveThumbnail from '@/components/drive/DriveThumbnail.vue'
import LoadError from '@/components/misc/state/LoadError.vue'

const props = defineProps<{
	file: StorageFile,
	owner: ClientRequestContext,
}>()
const {t, locale} = useI18n({useScope: 'global'})
const inspect = useStoragePreviewMutation()
const controller = new AbortController()
onBeforeUnmount(() => controller.abort())
const snapshot = ref<{context: ClientRequestContext, data: StoragePreview}>()
const current = computed(() => currentStorageData(snapshot.value)?.items[0])
const thumbnail = computed(() => ({
	file_id: props.file.file_id,
	file: {
		id: props.file.file_id,
		name: props.file.name,
		mime: props.file.mime,
		size: props.file.size,
	},
}))
function bytes(value: number) {
	if (!value) return '0 B'
	const index = Math.min(4, Math.max(0, Math.floor(Math.log(value) / Math.log(1024))))
	const amount = new Intl.NumberFormat(locale.value, {maximumFractionDigits: 1}).format(value / 1024 ** index)
	return `${amount} ${['B', 'KiB', 'MiB', 'GiB', 'TiB'][index]}`
}
async function load() {
	if (!props.file.in_drive || inspect.isPending.value || !isClientRequestContextCurrent(props.owner)) return
	try {
		const value = await inspect.mutateAsync({
			owner: props.owner,
			signal: controller.signal,
			items: [{
				kind: 'file',
				id: props.file.id,
				revision: props.file.revision,
				action: props.file.trash ? 'purge' : 'trash',
			}],
		})
		if (isClientRequestContextCurrent(props.owner)) snapshot.value = value
	} catch { return }
}
onMounted(load)
</script>

<template>
	<div class="storage-file-details">
		<div
			v-if="file.in_drive"
			class="storage-file-details__preview"
		>
			<DriveThumbnail
				:file="thumbnail"
				decorative
			/>
		</div>
		<div class="storage-file-details__body">
			<dl>
				<div>
					<dt>{{ t('drive.size') }}</dt>
					<dd>{{ bytes(file.size) }}</dd>
				</div>
				<div>
					<dt>{{ t('storage.previewBytes') }}</dt>
					<dd>{{ bytes(file.preview_bytes) }}</dd>
				</div>
				<div>
					<dt>{{ t('drive.type') }}</dt>
					<dd>{{ file.mime || t('storage.unknownType') }}</dd>
				</div>
			</dl>
			<template v-if="file.in_drive">
				<h3>{{ t('drive.usedIn') }}</h3>
				<p
					v-if="inspect.isPending.value"
					role="status"
				>
					{{ t('storage.checkingReferences') }}
				</p>
				<LoadError
					v-else-if="inspect.isError.value"
					:message="t('storage.referencesFailed')"
					:retry="load"
				/>
				<ul v-else-if="current?.usages.length">
					<li
						v-for="(usage, index) in current.usages"
						:key="index"
					>
						<span v-if="usage.restricted || !usage.url">{{ usage.restricted ? t('drive.restricted') : t(`drive.kinds.${usage.kind}`) }}</span>
						<RouterLink
							v-else
							:to="usage.url"
						>
							{{ t(`drive.kinds.${usage.kind}`) }}<span v-if="usage.title"> · {{ usage.title }}</span>
						</RouterLink>
					</li>
				</ul>
				<p v-else-if="current">
					{{ t(current.allowed ? 'drive.unused' : 'storage.referencesUnknown') }}
				</p>
				<RouterLink :to="file.url || '/drive'">
					{{ t('storage.openDrive') }} <Icon icon="link" />
				</RouterLink>
			</template>
			<p v-else>
				{{ t('storage.protectedOriginal') }}
			</p>
			<p
				v-if="!file.storage_complete"
				class="storage-file-details__warning"
			>
				{{ t('storage.fileIncomplete') }}
			</p>
		</div>
	</div>
</template>

<style scoped>
.storage-file-details {
	display: flex;
	gap: 1rem;
	padding: 1rem;
	border-block-start: 1px solid var(--border-subtle);
	background: var(--surface-sunken);
}
.storage-file-details__preview {
	flex: none;
	inline-size: 5rem;
	block-size: 5rem;
	overflow: hidden;
	border-radius: .75rem;
	background: var(--surface-raised);
}
.storage-file-details__body {
	flex: 1;
	min-inline-size: 0;
	font-size: var(--text-sm);
}
dl {
	display: flex;
	flex-wrap: wrap;
	gap: .5rem 1.5rem;
	margin: 0 0 1rem;
}
dl div {
	min-inline-size: 0;
}
dt {
	color: var(--text-secondary);
	font-size: var(--text-xs);
}
dd {
	margin: .2rem 0 0;
	overflow-wrap: anywhere;
}
h3 {
	margin: 0 0 .4rem;
	font-size: var(--text-sm);
}
p {
	margin: .4rem 0;
	color: var(--text-secondary);
}
ul {
	margin: .4rem 0 .8rem;
	padding-inline-start: 1.2rem;
}
li {
	padding-block: .25rem;
	overflow-wrap: anywhere;
}
a {
	display: inline-block;
	min-block-size: 2rem;
	padding-block: .25rem;
}
.storage-file-details__warning {
	color: var(--warning);
}
@media (width <= 480px) {
	.storage-file-details {
		flex-direction: column;
	}
}
</style>
