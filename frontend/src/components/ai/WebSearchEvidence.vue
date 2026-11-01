<script setup lang="ts">
import {useI18n} from 'vue-i18n'
import type {WebSearchResult} from '@/client/generated'
import {sanitizeAronaContent} from '@/helpers/sanitizeAronaContent'
import {useAronaLinks} from '@/composables/useAronaLinks'
defineProps<{result: WebSearchResult}>()
const {t} = useI18n({useScope: 'global'})
const followLink = useAronaLinks()
function safeURL(value = '') { try { const u = new URL(value); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password ? u.href : '' } catch { return '' } }
</script>

<template>
	<section
		class="web-evidence"
		:aria-label="t('webSearch.evidence')"
		@click="followLink"
	>
		<details class="sources-disclosure">
			<summary>
				<Icon icon="globe" /><strong>{{ t('webSearch.sourceCount', {count: result.sources?.length || 0}) }}</strong><span
					class="search-verification"
					:class="{'is-verified': result.verified}"
				><Icon :icon="result.verified ? 'check' : 'circle-info'" />{{ t(result.verified ? 'webSearch.verified' : 'webSearch.unverified') }}</span><Icon
					class="sources-chevron"
					icon="chevron-down"
				/>
			</summary>
			<div class="sources-body">
				<ul v-if="result.sources?.length">
					<li
						v-for="source in result.sources"
						:key="source.url"
					>
						<a
							v-if="safeURL(source.url)"
							:href="safeURL(source.url)"
							target="_blank"
							rel="noopener noreferrer"
						>{{ source.title || source.url }}</a>
					</li>
				</ul>
				<p v-else>
					{{ t('webSearch.noSources') }}
				</p>
				<div
					v-if="result.search_entry_point"
					v-html="sanitizeAronaContent(result.search_entry_point)"
				/>
				<details class="source-diagnostics">
					<summary>{{ t('webSearch.technicalDetails') }}</summary><p>{{ result.protocol }} · {{ t('chat.seconds', {value: ((result.duration_ms || 0) / 1000).toFixed(2)}) }}</p>
					<code>{{ result.endpoint }}</code>
					<p v-if="result.step">
						HTTP {{ result.step.http_status || '—' }}<template v-if="result.step.model">
							· {{ result.step.model }}
						</template> · {{ t(result.step.streaming ? 'webSearch.streamed' : 'webSearch.nonStreamed') }}
					</p>
					<p v-if="result.step?.usage?.reported">
						{{ t('webSearch.usage', {input: result.step.usage.input, output: result.step.usage.output}) }}
					</p>
					<p v-else>
						{{ t('webSearch.usageUnknown') }}
					</p>
				</details>
			</div>
		</details>
	</section>
</template>

<style scoped lang="scss">
.web-evidence {
	margin-block: var(--space-3);
	border: 1px solid var(--border-subtle);
	border-radius: var(--radius-md);
	background: var(--surface-sunken);
	color: var(--text-secondary);
	font-size: var(--text-sm);
	overflow-wrap: anywhere;
}

.sources-disclosure > summary {
	display: flex;
	align-items: center;
	gap: var(--space-2);
	min-block-size: var(--control-height);
	padding: var(--space-1) var(--space-3);
	border-radius: var(--radius-md);
	list-style: none;
	cursor: pointer;

	&::-webkit-details-marker {
		display: none;
	}

	&:hover {
		background: var(--surface-hover);
	}

	&:focus-visible {
		@include focus-ring;
	}

	strong {
		color: var(--text-primary);
		font-weight: var(--weight-medium);
	}
}

.sources-chevron {
	flex-shrink: 0;
	margin-inline-start: auto;
	color: var(--text-tertiary);
	transition: transform var(--motion-fast) var(--ease-standard);
}

.sources-disclosure[open] > summary .sources-chevron {
	transform: rotate(180deg);
}

.search-verification {
	display: inline-flex;
	align-items: center;
	gap: var(--space-1);
	color: var(--text-tertiary);
	font-size: var(--text-xs);

	&.is-verified {
		color: var(--text-secondary);
	}

	svg {
		inline-size: .8em;
	}
}

.sources-body {
	padding: var(--space-3) var(--space-4);
	border-block-start: 1px solid var(--border-subtle);
}

code {
	font-family: var(--font-mono);
	white-space: pre-wrap;
	overflow-wrap: anywhere;
}

ul {
	margin: 0;
	padding-inline-start: var(--space-5);
}

li + li {
	margin-block-start: var(--space-2);
}

a {
	text-decoration: underline;
	text-underline-offset: .2em;
}

.source-diagnostics {
	margin-block-start: var(--space-3);
	color: var(--text-tertiary);

	summary {
		cursor: pointer;
	}
}

@media (width <= 480px) {
	.search-verification {
		position: absolute;
		inline-size: 1px;
		block-size: 1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}
}
</style>
