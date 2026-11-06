<template>
	<div class="version-entity">
		<LoadError
			v-if="isError"
			:retry="() => refetch()"
		/>
		<p
			v-else-if="isPending"
			role="status"
		>
			{{ t('misc.loading') }}
		</p>
		<template v-else-if="data">
			<p class="version-entity__note">
				{{ t('projectVersions.entityHelp') }}
			</p>
			<XButton
				v-if="canFilterChanges"
				variant="secondary"
				:aria-pressed="showAllFields"
				@click="showAllFields = !showAllFields"
			>
				{{ t(showAllFields ? 'projectVersions.onlyChangedFields' : 'projectVersions.allFields') }}
			</XButton>
			<p
				v-if="hasUnknownChangedFields"
				class="version-entity__note"
			>
				{{ t('projectVersions.unknownChangedFields') }}
			</p>
			<div class="version-entity__columns">
				<section
					v-for="side in sides"
					:key="side.key"
					:aria-label="side.label"
				>
					<h4>{{ side.label }}</h4>
					<p v-if="!side.content">
						{{ t('projectVersions.absent') }}
					</p>
					<dl v-else>
						<template
							v-for="field in fields"
							:key="field"
						>
							<dt>{{ fieldLabel(field) }}</dt>
							<dd>
								<template v-if="isRichText(field) && typeof side.content[field] === 'string'">
									<!-- Only protected checkpoint images below can load; the text sanitizer removes all media. -->
									<!-- eslint-disable vue/no-v-html -->
									<div
										class="version-entity__prose content"
										v-html="sanitizeAnnouncement(String(side.content[field]))"
									/>
									<!-- eslint-enable vue/no-v-html -->
									<ProjectVersionFile
										v-for="image in savedImages(side.key, String(side.content[field])).slice(0, imageLimit)"
										:key="image.file"
										:project="project"
										:version="version"
										:file="image.file"
										:name="image.name"
										image
									/>
									<XButton
										v-if="savedImages(side.key, String(side.content[field])).length > imageLimit"
										variant="secondary"
										@click="imageLimit += 4"
									>
										{{ t('projectVersions.moreImages') }}
									</XButton>
								</template>
								<span v-else>{{ formatValue(side.content[field], field) }}</span>
							</dd>
						</template>
					</dl>
				</section>
			</div>
			<ProjectVersionFile
				v-if="kind === 'attachment' && typeof data.content?.file_id === 'number'"
				:project="project"
				:version="version"
				:file="data.content.file_id"
				:name="String(data.content.name ?? '')"
				:image="typeof data.content.mime === 'string' && data.content.mime.startsWith('image/')"
			/>
		</template>
	</div>
</template>

<script setup lang="ts">
import {
	computed,
	ref,
	watch,
} from 'vue'
import {useI18n} from 'vue-i18n'
import {useQuery} from '@tanstack/vue-query'
import LoadError from '@/components/misc/state/LoadError.vue'
import ProjectVersionFile from './ProjectVersionFile.vue'
import XButton from '@/components/input/Button.vue'
import {projectVersionEntityQuery} from '@/client/queries/projectVersions'
import {sanitizeAnnouncement} from '@/helpers/sanitizeAnnouncement'
import {formatDateLong} from '@/helpers/time/formatDate'
import {getApiRootUrl} from '@/helpers/apiUrl'

const props = defineProps<{
	project: number,
	version: number,
	kind: string,
	entity: string,
	changedFields?: string[],
}>()
const {
	t, te,
} = useI18n({useScope: 'global'})
const imageLimit = ref(4)
const showAllFields = ref(false)
watch(() => `${props.project}/${props.version}/${props.kind}/${props.entity}`, () => {
	imageLimit.value = 4
	showAllFields.value = false
})
const {
	data, isError, isPending, refetch,
} = useQuery(computed(() =>
	projectVersionEntityQuery(props.project, props.version, props.kind, props.entity),
))
const sides = computed(() => [
	{
		key: 'current',
		label: t('projectVersions.currentContent'),
		content: data.value?.current_content,
	},
	{
		key: 'saved',
		label: t('projectVersions.savedContent'),
		content: data.value?.content,
	},
])
const allFields = computed(() => [...new Set(sides.value.flatMap(side => Object.keys(side.content ?? {})))]
	.filter(field => te(`projectVersions.fields.${field}`))
	.filter(field => !['updated', 'is_favorite', 'is_archived', 'content_hash'].includes(field)))
const canFilterChanges = computed(() => !!props.changedFields?.length && !!data.value?.content && !!data.value?.current_content)
const hasUnknownChangedFields = computed(() => canFilterChanges.value
	&& props.changedFields?.some(field => !te(`projectVersions.fields.${field}`)))
const fields = computed(() => canFilterChanges.value && !showAllFields.value
	? allFields.value.filter(field => props.changedFields?.includes(field))
	: allFields.value)


function fieldLabel(field: string) {
	if (field === 'other_id') {
		return t(`projectVersions.fields.${props.kind === 'assignee' ? 'user_id' : props.kind === 'label' ? 'label_id' : 'other_task_id'}`)
	}
	return te(`projectVersions.fields.${field}`)
		? t(`projectVersions.fields.${field}`)
		: t('projectVersions.otherSetting')
}

function isRichText(field: string) {
	return ['description', 'content', 'body'].includes(field)
}

function savedImages(side: string, html: string) {
	if (side !== 'saved' || !html.includes('<img')) return []
	const document = new DOMParser().parseFromString(html, 'text/html')
	const base = new URL(getApiRootUrl() || '/', window.location.origin)
	const found = new Map<number, {
		file: number,
		name: string,
	}>()
	for (const image of document.querySelectorAll('img')) {
		try {
			const url = new URL(image.getAttribute('data-src') || image.getAttribute('src') || '', base)
			if (url.origin !== base.origin) continue
			const prefix = base.pathname.replace(/\/$/, '')
			const path = prefix && url.pathname.startsWith(prefix + '/') ? url.pathname.slice(prefix.length) : url.pathname
			const match = /^\/api\/v2\/projects\/(\d+)\/versions\/(\d+)\/files\/(\d+)$/.exec(path)
			if (!match || Number(match[1]) !== props.project || Number(match[2]) !== props.version) continue
			const file = Number(match[3])
			if (Number.isSafeInteger(file) && file > 0) found.set(file, {
				file,
				name: image.alt || t('projectVersions.savedImage'),
			})
		} catch { /* Authored external or malformed image URLs are not checkpoint file references. */ }
	}
	return [...found.values()]
}

function formatValue(value: unknown, field = ''): string {
	if (value === null || value === undefined || value === '') return t('projectVersions.noValue')
	if (typeof value === 'string' && /^0001-01-01/.test(value)) return t('projectVersions.noValue')
	if (typeof value === 'boolean') return t(value ? 'projectVersions.yes' : 'projectVersions.no')
	if (te(`projectVersions.values.${field}.${String(value)}`)) return t(`projectVersions.values.${field}.${String(value)}`)
	if (Array.isArray(value)) {
		return value.length ? value.map(item => formatValue(item)).join(' · ') : t('projectVersions.noValue')
	}
	if (typeof value === 'object') {
		const item = value as Record<string, unknown>
		return Object.entries(item).map(([key, entry]) => `${fieldLabel(key)}: ${formatValue(entry, key)}`).join(' · ')
	}
	if (typeof value === 'string' && (/(?:date|_at|reminder)$/.test(field) || field === 'created') && !Number.isNaN(Date.parse(value))) {
		return formatDateLong(value)
	}
	if (field === 'percent_done' && typeof value === 'number') return `${Math.round(value * 100)}%`
	return String(value)
}
</script>

<style scoped lang="scss">
.version-entity {
	padding: var(--space-4);
	background: var(--surface);
	border-block-start: 1px solid var(--border-subtle);
}

.version-entity__note {
	color: var(--text-secondary);
	font-size: var(--text-sm);
	margin-block-end: var(--space-3);
}

.version-entity__columns {
	display: grid;
	grid-template-columns: repeat(2, minmax(0, 1fr));
	gap: var(--space-4);

	@media (width <= 600px) {
		grid-template-columns: 1fr;
	}

	section {
		min-inline-size: 0;
	}
	h4 {
		margin-block-end: var(--space-3);
	}
	dt {
		color: var(--text-secondary);
		font-size: var(--text-sm);
	}
	dd {
		margin: 0 0 var(--space-3);
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
}

.version-entity__prose {
	white-space: normal;
	max-block-size: 30rem;
	overflow: auto;
}
</style>
