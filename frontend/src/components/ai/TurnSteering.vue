<script setup lang="ts">
import {computed} from 'vue'
import {useI18n} from 'vue-i18n'
import type {IconProp} from '@fortawesome/fontawesome-svg-core'
import type {ChatTurn} from '@/client/generated'
import {sameItems} from '@/helpers/aronaTimeline'
import {steeringItems, type LocalSteer, type SteeringItem} from '@/helpers/turnSteering'
import MessageTimestamp from './MessageTimestamp.vue'
import {useSteeringOutbox} from './steeringOutbox'

const props = withDefaults(defineProps<{
	entries?: ChatTurn['steering']
	status?: ChatTurn['status']
	turnId?: string
	conversationId?: string
}>(), {
	entries: undefined,
	status: undefined,
	turnId: '',
	conversationId: '',
})
const {t} = useI18n({useScope: 'global'})

const NO_LOCAL: readonly LocalSteer[] = []
const outbox = useSteeringOutbox()
// Kept while this turn's own unconfirmed instructions are unchanged, so another turn's send does not re-render it.
const local = computed<readonly LocalSteer[]>(previous => {
	const next = outbox.value.filter(entry => entry.chat === props.conversationId && entry.turn === props.turnId)
	if (!next.length) return NO_LOCAL
	return previous && sameItems(previous, next) ? previous : next
})
const items = computed(() => steeringItems(props.entries, props.status, local.value))

const STATUS: Record<SteeringItem['state'], string> = {
	sending: 'aronaSteer.statusSending',
	pending: 'aronaSteer.statusPending',
	applied: 'aronaSteer.statusApplied',
	missed: 'aronaSteer.statusMissed',
	unknown: 'aronaSteer.statusUnknown',
}
const ICONS: Partial<Record<SteeringItem['state'], IconProp>> = {
	sending: 'clock',
	pending: 'clock',
	applied: 'check',
}
</script>

<template>
	<ol
		v-if="items.length"
		class="turn-steering"
		:aria-label="t('aronaSteer.list')"
	>
		<li
			v-for="item in items"
			:key="item.key"
			class="steer-item"
			:class="`is-${item.state}`"
			:data-steering-id="item.id"
			:data-steering-status="item.status"
		>
			<p class="steer-bubble">
				<span class="steer-badge">{{ t('aronaSteer.badge') }}</span>{{ item.message }}
			</p>
			<p class="steer-meta">
				<MessageTimestamp
					:value="item.created"
					:label="t('aronaTime.added')"
					hide-label
				/>
				<span class="steer-status">
					<Icon
						v-if="ICONS[item.state]"
						:icon="ICONS[item.state]!"
						class="steer-icon"
					/>{{ t(STATUS[item.state]) }}
					<MessageTimestamp
						v-if="item.state === 'applied'"
						:value="item.appliedAt"
						:label="t('aronaTime.applied')"
						hide-label
					/>
				</span>
			</p>
		</li>
	</ol>
</template>

<style scoped lang="scss">
.turn-steering {
	display: grid;
	justify-items: end;
	gap: var(--space-2);
	margin: var(--space-2) 0 0;
	padding: 0;
	list-style: none;
}

.steer-item {
	display: grid;
	justify-items: end;
	gap: var(--space-1);
	min-inline-size: 0;
	max-inline-size: min(85%, 40rem);
}

// Lighter than the original request, which stays the turn's main message.
.steer-bubble {
	margin: 0;
	padding: var(--space-2) var(--space-3);
	border: 1px dashed var(--border-default);
	border-radius: var(--radius-lg);
	background: var(--surface);
	color: var(--text-primary);
	font-size: var(--text-base);
	line-height: var(--leading-normal);
	white-space: pre-wrap;
	overflow-wrap: anywhere;
}

.steer-badge {
	display: inline-block;
	margin-inline-end: var(--space-2);
	padding-inline: var(--space-2);
	border-radius: var(--radius-full);
	background: var(--tint-info);
	color: var(--accent-text);
	font-size: var(--text-xs);
	font-weight: var(--weight-semibold);
	line-height: 1.6;
	white-space: nowrap;
}

.steer-meta {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	justify-content: flex-end;
	gap: 0 var(--space-2);
	margin: 0;
	color: var(--text-tertiary);
	font-size: var(--text-xs);
	line-height: var(--leading-normal);
}

.steer-status {
	display: inline-flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 0 var(--space-1);
	color: var(--text-secondary);
}

.steer-icon {
	inline-size: .75rem;
	color: var(--accent-text);
}

.is-applied .steer-icon {
	color: var(--success);
}

.is-sending {
	opacity: .75;
}

.is-missed .steer-status,
.is-unknown .steer-status {
	color: var(--text-tertiary);
}
</style>
