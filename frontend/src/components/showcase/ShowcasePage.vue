<script setup lang="ts">
import {computed, nextTick, ref, watch} from 'vue'
import {useI18n} from 'vue-i18n'
import {marked} from 'marked'
import DOMPurify from 'dompurify'
import type {Event as ShowcaseEvent, TcyShowcasePublicResponse} from '@/client/generated'
import TcyBrand from '@/components/home/TcyBrand.vue'
import {useColorScheme} from '@/composables/useColorScheme'

const props = withDefaults(defineProps<{
	page: TcyShowcasePublicResponse
	// Inside the settings preview the page sits below the editor's own h1 and h2.
	embedded?: boolean
}>(), {
	embedded: false,
})
const {t, locale} = useI18n({useScope: 'global'})

const events = computed(() => props.page.events ?? [])
const free = computed(() => props.page.free ?? [])
const projects = computed(() => props.page.projects ?? [])
const headingBase = computed(() => props.embedded ? 3 : 1)
const titleTag = computed(() => `h${headingBase.value}`)
const sectionTag = computed(() => `h${headingBase.value + 1}`)
const itemTag = computed(() => `h${headingBase.value + 2}`)

const formatTime = (value?: string) => value
	? new Date(value).toLocaleString(locale.value, {
		timeZone: 'Asia/Shanghai',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		weekday: 'short',
	})
	: ''
function allDayLabel(event: ShowcaseEvent) {
	const format = (value: Date) => value.toLocaleDateString(locale.value, {
		timeZone: 'Asia/Shanghai', month: 'short', day: 'numeric', weekday: 'short',
	})
	const first = new Date(event.start!)
	const last = new Date(Date.parse(event.end!) - 1)
	const start = format(first)
	const end = format(last)
	return `${start}${start === end ? '' : ` – ${end}`} · ${t('calendar.allDay')}`
}
const escape = (value: string) => value
	.replaceAll('&', '&amp;')
	.replaceAll('<', '&lt;')
	.replaceAll('>', '&gt;')
	.replaceAll('"', '&quot;')

// The sandboxed frame is a separate document without the app's stylesheets, so it receives the
// current token values. They are read after the colour-scheme class on <html> has switched.
const {isDark} = useColorScheme()
function readFrameTheme() {
	const style = getComputedStyle(document.documentElement)
	const token = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback
	return {
		scheme: isDark.value ? 'dark' : 'light',
		text: token('--text-primary', 'CanvasText'),
		muted: token('--text-secondary', 'GrayText'),
		link: token('--accent-text', 'LinkText'),
		border: token('--border-default', 'GrayText'),
		surface: token('--surface', 'Canvas'),
		font: token('--font-ui', 'system-ui, sans-serif'),
		mono: token('--font-mono', 'monospace'),
		size: token('--text-base', '1rem'),
		leading: token('--leading-normal', '1.5'),
		gap: token('--space-4', '1rem'),
		itemGap: token('--space-2', '.5rem'),
		radius: token('--radius-sm', '4px'),
	}
}
const frameTheme = ref(readFrameTheme())
watch(isDark, () => nextTick(() => {
	frameTheme.value = readFrameTheme()
}), {flush: 'post'})

const frameStyle = computed(() => {
	const theme = frameTheme.value
	return [
		`:root{color-scheme:${theme.scheme}}`,
		`body{margin:${theme.gap};font-family:${theme.font};font-size:${theme.size};line-height:${theme.leading};`
		+ `color:${theme.text};background:${theme.surface};overflow-wrap:anywhere}`,
		`img{max-width:100%;height:auto;border-radius:${theme.radius}}`,
		`a{color:${theme.link}}`,
		`li{margin:${theme.itemGap} 0}`,
		`hr{border:0;border-top:1px solid ${theme.border}}`,
		`blockquote{margin-inline:0;padding-inline-start:${theme.gap};border-inline-start:3px solid ${theme.border};color:${theme.muted}}`,
		`code,pre{font-family:${theme.mono}}`,
		`table{border-collapse:collapse}th,td{padding:${theme.itemGap};border:1px solid ${theme.border}}`,
	].join('')
})

const custom = computed(() => {
	if (!props.page.content) return ''
	const schedule = '<ul>' + events.value.map(e => {
		const when = e.all_day ? allDayLabel(e)
			: formatTime(e.start) + (e.kind === 'busy' ? ' — ' + formatTime(e.end) : t('tcymc.text.due'))
		return `<li>${escape(when)} · ${escape(e.title ?? '')} · ${escape(e.project ?? '')}</li>`
	}).join('') + '</ul>'
	const availability = '<ul>'
		+ free.value.map(f => `<li>${escape(formatTime(f.start))} — ${escape(formatTime(f.end))}</li>`).join('')
		+ '</ul>'
	const names = '<ul>' + projects.value.map(p => `<li>${escape(p)}</li>`).join('') + '</ul>'
	const raw = props.page.format === 'html' ? props.page.content : marked.parse(props.page.content, {async: false})
	const content = DOMPurify.sanitize(raw, {ADD_TAGS: ['style']})
		.replaceAll('{{schedule}}', schedule)
		.replaceAll('{{availability}}', availability)
		.replaceAll('{{projects}}', names)
	return `<!doctype html><html lang="${escape(locale.value)}"><head><meta charset="utf-8">`
		+ '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; '
		+ 'img-src https: data:; font-src https:; base-uri \'none\'; form-action \'none\'">'
		+ `<style>${frameStyle.value}</style></head><body>${content}</body></html>`
})
</script>

<template>
	<article
		class="showcase-page"
		:class="{'is-embedded': embedded}"
	>
		<header class="showcase-hero">
			<p class="showcase-eyebrow">
				{{ t('tcymc.publicEyebrow') }}
			</p>
			<component
				:is="titleTag"
				class="showcase-title"
			>
				{{ page.title }}
			</component>
			<p
				v-if="page.intro"
				class="showcase-intro"
			>
				{{ page.intro }}
			</p>
			<p class="showcase-timezone">
				<Icon :icon="['far', 'clock']" />
				<span>{{ t('tcymc.text.asia_shanghai_china_standard_time') }}</span>
			</p>
		</header>
		<iframe
			v-if="custom"
			class="custom-page"
			:title="t('tcymc.text.custom_public_content')"
			sandbox=""
			referrerpolicy="no-referrer"
			:srcdoc="custom"
		/>
		<div
			v-if="!page.custom_layout"
			class="showcase-columns"
		>
			<section class="showcase-section">
				<component
					:is="sectionTag"
					class="showcase-section-title"
				>
					{{ t('tcymc.text.upcoming_schedule') }}
				</component>
				<p
					v-if="!events.length"
					class="showcase-empty"
				>
					{{ t('tcymc.text.there_are_no_published_events_for_this_period') }}
				</p>
				<ol
					v-else
					class="schedule-list"
				>
					<li
						v-for="(event, index) in events"
						:key="index"
						class="schedule-event"
						:class="event.kind === 'busy' ? 'is-busy' : 'is-due'"
					>
						<p class="event-when">
							<template v-if="event.all_day">
								{{ allDayLabel(event) }}
							</template>
							<template v-else>
								<time :datetime="event.start">{{ formatTime(event.start) }}</time>
								<template v-if="event.kind === 'busy'">
									{{ ' – ' }}<time :datetime="event.end">{{ formatTime(event.end) }}</time>
								</template>
							</template>
						</p>
						<component
							:is="itemTag"
							v-if="event.title"
							class="event-title"
						>
							{{ event.title }}
						</component>
						<p class="event-meta">
							<span class="event-kind">
								<Icon :icon="event.kind === 'busy' ? ['far', 'clock'] : 'flag-checkered'" />
								{{ event.all_day ? t('calendar.allDay') : event.kind === 'busy' ? t('tcymc.text.time_block') : t('tcymc.text.due_item') }}
							</span>
							<span
								v-if="event.project"
								class="event-project"
							>{{ event.project }}</span>
						</p>
					</li>
				</ol>
			</section>
			<div class="showcase-aside">
				<section class="showcase-section">
					<component
						:is="sectionTag"
						class="showcase-section-title"
					>
						{{ t('tcymc.text.available_times') }}
					</component>
					<p class="showcase-explanation">
						{{ t('tcymc.text.these_times_are_not_occupied_by_your_published') }}
					</p>
					<p
						v-if="!free.length"
						class="showcase-empty"
					>
						{{ t('tcymc.text.there_are_no_available_times_to_show') }}
					</p>
					<ul
						v-else
						class="free-list"
					>
						<li
							v-for="(slot, index) in free"
							:key="index"
							class="free-slot"
						>
							<time :datetime="slot.start">{{ formatTime(slot.start) }}</time>
							<span class="free-to">{{ ` ${t('tcymc.text.to')} ` }}</span>
							<time :datetime="slot.end">{{ formatTime(slot.end) }}</time>
						</li>
					</ul>
				</section>
				<section
					v-if="projects.length"
					class="showcase-section"
				>
					<component
						:is="sectionTag"
						class="showcase-section-title"
					>
						{{ t('tcymc.text.current_projects') }}
					</component>
					<ul class="project-chips">
						<li
							v-for="(project, index) in projects"
							:key="index"
						>
							{{ project }}
						</li>
					</ul>
				</section>
			</div>
		</div>
		<footer class="showcase-footer">
			<p>
				{{ `${t('tcymc.text.schedule_generated_at')} ` }}<time :datetime="page.generated_at">{{ formatTime(page.generated_at) }}</time>
				{{ `${t('tcymc.text.showing_until')} ` }}<time :datetime="page.until">{{ formatTime(page.until) }}</time>
			</p>
			<TcyBrand />
		</footer>
	</article>
</template>

<style scoped lang="scss">
.showcase-page {
	container: showcase / inline-size;
	display: grid;
	gap: var(--space-6);
	max-inline-size: var(--page-narrow-width);
	margin-inline: auto;
	padding: var(--space-8) var(--page-gutter) var(--space-6);
	color: var(--text-primary);
	overflow-wrap: anywhere;

	&.is-embedded {
		max-inline-size: none;
		padding: 0;
	}
}

.showcase-hero {
	display: grid;
	justify-items: start;
	gap: var(--space-2);
	padding-block-end: var(--space-5);
	border-block-end: 1px solid var(--border-subtle);
}

.showcase-eyebrow {
	padding: var(--space-1) var(--space-2);
	border-radius: var(--radius-full);
	background: var(--surface-selected);
	color: var(--accent-text);
	font-size: var(--text-xs);
	font-weight: var(--weight-semibold);
	letter-spacing: .04em;
	line-height: var(--leading-tight);
}

.showcase-title {
	margin: 0;
	color: var(--text-primary);
	font-size: var(--text-2xl);
	font-weight: var(--weight-semibold);
	line-height: var(--leading-tight);

	.is-embedded & {
		font-size: var(--text-xl);
	}
}

.showcase-intro {
	max-inline-size: 65ch;
	color: var(--text-secondary);
	font-size: var(--text-base);
	line-height: var(--leading-normal);
	white-space: pre-line;
}

.showcase-timezone {
	display: inline-flex;
	align-items: center;
	gap: var(--space-2);
	color: var(--text-tertiary);
	font-size: var(--text-sm);
}

.custom-page {
	display: block;
	inline-size: 100%;
	block-size: min(70dvh, 40rem);
	border: 1px solid var(--border-subtle);
	border-radius: var(--radius-md);
	background: var(--surface);
	resize: vertical;
}

.showcase-columns {
	display: grid;
	gap: var(--space-6);
	align-items: start;
}

@container showcase (min-width: 40rem) {
	.showcase-columns {
		grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr);
	}
}

.showcase-aside {
	display: grid;
	gap: var(--space-6);
}

.showcase-section-title {
	margin-block: 0 var(--space-3);
	color: var(--text-primary);
	font-size: var(--text-lg);
	font-weight: var(--weight-semibold);
	line-height: var(--leading-tight);
}

.showcase-empty,
.showcase-explanation {
	color: var(--text-secondary);
	font-size: var(--text-md);
	line-height: var(--leading-normal);
}

.showcase-explanation {
	margin-block-end: var(--space-3);
}

.schedule-list,
.free-list,
.project-chips {
	margin: 0;
	padding: 0;
	list-style: none;
}

.schedule-list,
.free-list {
	overflow: hidden;
	border: 1px solid var(--border-subtle);
	border-radius: var(--radius-md);
	background: var(--surface);
	box-shadow: var(--elevation-1);
}

.schedule-event {
	display: grid;
	gap: var(--space-1);
	padding: var(--space-3) var(--space-4);
	border-inline-start: 3px solid var(--primary);

	&.is-due {
		border-inline-start-color: var(--warning);
	}

	& + & {
		border-block-start: 1px solid var(--border-subtle);
	}
}

.event-when {
	color: var(--text-secondary);
	font-size: var(--text-sm);
	font-variant-numeric: tabular-nums;
}

.event-title {
	margin: 0;
	color: var(--text-primary);
	font-size: var(--text-base);
	font-weight: var(--weight-semibold);
	line-height: var(--leading-tight);
}

.event-meta {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: var(--space-1) var(--space-3);
	color: var(--text-tertiary);
	font-size: var(--text-xs);
}

.event-kind {
	display: inline-flex;
	align-items: center;
	gap: var(--space-1);
	font-weight: var(--weight-medium);
}

.free-slot {
	padding: var(--space-2) var(--space-4);
	font-size: var(--text-md);
	font-variant-numeric: tabular-nums;

	& + & {
		border-block-start: 1px solid var(--border-subtle);
	}
}

.free-to {
	color: var(--text-tertiary);
}

.project-chips {
	display: flex;
	flex-wrap: wrap;
	gap: var(--space-2);

	li {
		padding: var(--space-1) var(--space-3);
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-full);
		background: var(--surface);
		color: var(--text-secondary);
		font-size: var(--text-sm);
	}
}

.showcase-footer {
	display: grid;
	justify-items: center;
	gap: var(--space-2);
	padding-block-start: var(--space-4);
	border-block-start: 1px solid var(--border-subtle);
	color: var(--text-tertiary);
	font-size: var(--text-sm);
	text-align: center;
}
</style>
