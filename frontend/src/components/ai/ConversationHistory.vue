<script setup lang="ts">
import {computed, ref, watch} from 'vue'
import {refDebounced} from '@vueuse/core'
import {useQuery} from '@tanstack/vue-query'
import {useI18n} from 'vue-i18n'
import {faThumbtack} from '@fortawesome/free-solid-svg-icons'
import {conversationsQuery} from '@/client/queries/tcyConversations'
import type {ConversationSummary} from '@/client/generated'
import LoadError from '@/components/misc/state/LoadError.vue'
import ConversationMenu from './ConversationMenu.vue'
withDefaults(defineProps<{
	selected: string,
	disabled?: boolean,
	showCreate?: boolean,
}>(), {
	disabled: false,
	showCreate: true,
})
const emit = defineEmits<{select: [id: string], create: [], close: [], action: [action: string, conversation: ConversationSummary]}>()
const {t} = useI18n({useScope: 'global'})
const search = ref('')
const searchInput = ref<HTMLInputElement>()
const query = refDebounced(search, 250)
const archived = ref(false)
const page = ref(1)
const scope = computed(() => archived.value ? 'archived' : query.value.trim() ? 'all' : 'active')
watch([query, archived], () => { page.value = 1 }, {flush: 'sync'})
const sessions = useQuery(computed(() => conversationsQuery(page.value, query.value.trim(), scope.value)))
watch(() => sessions.data.value?.total_pages, total => { if (total !== undefined && page.value > Math.max(1, total)) page.value = Math.max(1, total) })
const groups = computed(() => {
	const groups: {name: string, items: ConversationSummary[]}[] = []
	const today = new Date(); today.setHours(0, 0, 0, 0)
	const week = new Date(today); week.setDate(week.getDate() - 7)
	for (const item of sessions.data.value?.items ?? []) {
		const time = new Date(item.updated ?? 0).getTime()
		const name = query.value.trim() ? 'results' : item.pinned ? 'pinned' : archived.value ? 'archived' : time >= +today ? 'today' : time >= +week ? 'week' : 'older'
		let group = groups.find(group => group.name === name)
		if (!group) { group = {name, items: []}; groups.push(group) }
		group.items.push(item)
	}
	return groups
})
defineExpose({focusSearch: () => searchInput.value?.focus()})
</script>

<template>
	<div class="history-panel">
		<div class="history-header">
			<h2>{{ t('chat.conversations') }}</h2><button
				type="button"
				class="history-icon-button"
				:aria-label="t('chatHistory.close')"
				:title="t('chatHistory.close')"
				@click="emit('close')"
			>
				<Icon icon="times" />
			</button>
		</div>
		<button
			v-if="showCreate"
			class="history-new"
			type="button"
			:disabled="disabled"
			@click="emit('create')"
		>
			<Icon icon="plus" />{{ t('chat.new') }}
		</button>
		<label class="history-search"><Icon icon="search" /><input
			ref="searchInput"
			v-model="search"
			type="search"
			:aria-label="t('chatHistory.search')"
			:placeholder="t('chatHistory.search')"
		></label>
		<div class="history-filters">
			<button
				type="button"
				:aria-pressed="!archived"
				@click="archived = false"
			>
				{{ t('chatHistory.recent') }}
			</button><button
				type="button"
				:aria-pressed="archived"
				@click="archived = true"
			>
				<Icon icon="archive" />{{ t('chatHistory.archived') }}
			</button>
		</div>
		<p
			v-if="sessions.isPending.value"
			role="status"
			class="history-empty"
		>
			{{ t('misc.loading') }}
		</p>
		<LoadError
			v-else-if="sessions.isError.value && !sessions.data.value"
			class="history-error"
			:retry="() => sessions.refetch()"
		/>
		<p
			v-else-if="!groups.length"
			role="status"
			class="history-empty"
		>
			{{ t(query.trim() ? 'chatHistory.noResults' : archived ? 'chatHistory.noArchived' : 'chat.noConversations') }}
		</p>
		<section
			v-for="group in groups"
			:key="group.name"
			:aria-label="t(`chatHistory.${group.name}`)"
		>
			<h3>{{ t(`chatHistory.${group.name}`) }}</h3>
			<ul>
				<li
					v-for="session in group.items"
					:key="session.id"
					:class="{'is-selected': session.id === selected, 'is-unread': session.unread}"
					:data-chat-id="session.id"
				>
					<button
						type="button"
						class="history-link"
						:disabled="disabled"
						:aria-current="session.id === selected ? 'true' : undefined"
						:title="session.title || t('chat.untitled')"
						@click="emit('select', session.id!)"
					>
						<span class="history-title">{{ session.title || t('chat.untitled') }}</span><small
							v-if="session.unread"
							class="history-badge is-unread"
							:title="t('chatHistory.unreadHint')"
						><span
							class="badge-dot"
							aria-hidden="true"
						/>{{ t('chatHistory.unread') }}</small><small
							v-if="session.running"
							class="history-badge is-running"
						><span
							class="badge-dot"
							aria-hidden="true"
						/>{{ t('chat.running') }}</small><small
							v-else-if="session.archived && !archived"
							class="history-badge"
						>{{ t('chatHistory.archived') }}</small>
					</button>
					<Icon
						v-if="session.pinned"
						:icon="faThumbtack"
						class="pin-mark"
						:title="t('chatHistory.pinned')"
					/>
					<ConversationMenu
						:conversation="session"
						:disabled="disabled"
						@action="emit('action', $event, session)"
					/>
				</li>
			</ul>
		</section>
		<nav
			v-if="(sessions.data.value?.total_pages ?? 0) > 1"
			class="history-pages"
			:aria-label="t('chat.conversations')"
		>
			<button
				type="button"
				class="history-icon-button"
				:aria-label="t('chatHistory.previousPage')"
				:title="t('chatHistory.previousPage')"
				:disabled="page === 1 || sessions.isFetching.value"
				@click="page--"
			>
				<Icon icon="angle-left" />
			</button><span>{{ page }} / {{ sessions.data.value?.total_pages }}</span><button
				type="button"
				class="history-icon-button"
				:aria-label="t('chatHistory.nextPage')"
				:title="t('chatHistory.nextPage')"
				:disabled="page >= (sessions.data.value?.total_pages ?? 1) || sessions.isFetching.value"
				@click="page++"
			>
				<Icon icon="angle-right" />
			</button>
		</nav>
		<p class="history-note">
			{{ t('chatHistory.archiveHint') }}
		</p>
	</div>
</template>

<style scoped lang="scss">
.history-panel {
	min-inline-size: 0;
}

.history-header {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: var(--space-2);
	margin-block-end: var(--space-2);

	h2 {
		margin: 0;
		color: var(--text-primary);
		font-size: var(--text-md);
		font-weight: var(--weight-semibold);
	}
}

button {
	border: 0;
	background: transparent;
	color: var(--text-primary);
	font: inherit;
	cursor: pointer;

	&:focus-visible {
		@include focus-ring;
	}

	&:disabled {
		opacity: .5;
		cursor: not-allowed;
	}
}

.history-icon-button {
	display: inline-flex;
	flex-shrink: 0;
	align-items: center;
	justify-content: center;
	inline-size: var(--control-height);
	block-size: var(--control-height);
	border-radius: var(--radius-sm);
	color: var(--text-secondary);

	&:hover:not(:disabled) {
		background: var(--surface-hover);
		color: var(--text-primary);
	}
}

.history-new {
	display: flex;
	align-items: center;
	gap: var(--space-2);
	inline-size: 100%;
	min-block-size: var(--control-height);
	padding-inline: var(--space-2);
	border-radius: var(--radius-sm);
	font-size: var(--text-md);
	text-align: start;

	&:hover:not(:disabled) {
		background: var(--surface-hover);
	}
}

.history-search {
	display: flex;
	align-items: center;
	gap: var(--space-2);
	min-block-size: var(--control-height);
	margin-block: var(--space-2);
	padding-inline: var(--space-2);
	border: 1px solid var(--input-border-color);
	border-radius: $radius;
	background: var(--surface);
	color: var(--text-tertiary);

	&:focus-within {
		@include focus-ring;
	}

	input {
		inline-size: 100%;
		min-inline-size: 0;
		border: 0;
		outline: none;
		background: transparent;
		color: var(--text-primary);
		font-size: var(--text-md);

		&::placeholder {
			color: var(--text-tertiary);
		}
	}
}

.history-filters {
	display: flex;
	gap: var(--space-1);
	margin-block: var(--space-2);
	padding: 2px;
	border-radius: var(--radius-md);
	background: var(--surface-active);

	button {
		display: inline-flex;
		flex: 1;
		align-items: center;
		justify-content: center;
		gap: var(--space-1);
		min-block-size: var(--control-height-sm);
		border-radius: var(--radius-sm);
		color: var(--text-secondary);
		font-size: var(--text-sm);

		&:hover {
			color: var(--text-primary);
		}

		&[aria-pressed='true'] {
			background: var(--surface-raised);
			box-shadow: var(--elevation-1);
			color: var(--text-primary);
			font-weight: var(--weight-semibold);
		}
	}
}

h3 {
	margin: var(--space-4) var(--space-2) var(--space-1);
	color: var(--text-tertiary);
	font-size: var(--text-xs);
	font-weight: var(--weight-semibold);
}

ul {
	margin: 0;
	padding: 0;
	list-style: none;
}

li {
	position: relative;
	display: flex;
	align-items: center;
	min-inline-size: 0;
	border-radius: var(--radius-sm);

	&:hover,
	&:focus-within {
		background: var(--surface-hover);
	}

	// Selection is a tint plus a leading bar, so it differs from hover without relying on colour alone.
	&.is-selected {
		background: var(--surface-selected);

		&::before {
			content: '';
			position: absolute;
			inset-block: var(--space-2);
			inset-inline-start: 0;
			inline-size: 3px;
			border-radius: var(--radius-full);
			background: var(--primary);
		}

		.history-title {
			color: var(--accent-text);
			font-weight: var(--weight-semibold);
		}
	}
}

.history-link {
	display: flex;
	flex: 1;
	align-items: center;
	gap: var(--space-2);
	min-inline-size: 0;
	min-block-size: var(--control-height);
	padding: var(--space-1) var(--space-2) var(--space-1) var(--space-3);
	border-radius: var(--radius-sm);
	text-align: start;

	&:focus-visible {
		outline-offset: -2px;
	}
}

.history-title {
	flex: 1;
	min-inline-size: 0;
	overflow: hidden;
	color: var(--text-primary);
	font-size: var(--text-md);
	text-overflow: ellipsis;
	white-space: nowrap;
}

.is-unread .history-title {
	font-weight: var(--weight-semibold);
}

.history-badge {
	display: inline-flex;
	flex-shrink: 0;
	align-items: center;
	gap: var(--space-1);
	color: var(--text-tertiary);
	font-size: var(--text-xs);

	&.is-running {
		color: var(--text-secondary);
	}

	&.is-unread {
		color: var(--accent-text);

		.badge-dot {
			background: currentColor;
		}
	}
}

.badge-dot {
	inline-size: .4rem;
	block-size: .4rem;
	border-radius: 50%;
	background: var(--success);
}

.pin-mark {
	flex-shrink: 0;
	inline-size: .65rem;
	color: var(--text-tertiary);
}

.history-empty,
.history-note {
	padding: var(--space-2);
	color: var(--text-tertiary);
	font-size: var(--text-sm);
	line-height: var(--leading-normal);
}

.history-error {
	margin-block: var(--space-2);
	font-size: var(--text-sm);
}

.history-pages {
	display: flex;
	align-items: center;
	justify-content: space-between;
	margin-block-start: var(--space-3);
	color: var(--text-secondary);
	font-size: var(--text-sm);
	font-variant-numeric: tabular-nums;
}
</style>
