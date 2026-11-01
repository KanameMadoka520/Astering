<script setup lang="ts">
import {computed, ref, watch} from 'vue'
import {useQuery} from '@tanstack/vue-query'
import {useI18n} from 'vue-i18n'
import {barkQuery, useSaveBark, useTestBark} from '@/client/queries/bark'
import type {BarkSaveData} from '@/client/generated'
import {useTitle} from '@/composables/useTitle'
import Message from '@/components/misc/Message.vue'
import LoadError from '@/components/misc/state/LoadError.vue'
import PageHeader from '@/components/misc/state/PageHeader.vue'
defineOptions({name: 'BarkSettingsPage'})
const {t} = useI18n({useScope: 'global'})
useTitle(() => `${t('bark.title')} - ${t('user.settings.title')}`)
// The page shows its own load error; the 10s poll would otherwise toast it again every time.
const query = useQuery({...barkQuery(), meta: {handlesError: true}})
const draft = ref<BarkSaveData['body']>()
const baseline = ref('')
const dirty = computed(() => JSON.stringify(draft.value) !== baseline.value)
const save = useSaveBark()
const test = useTestBark()
const error = ref('')
function adopt(value: NonNullable<typeof query.data.value>) {
	const {has_key: _hasKey, ...settings} = value.settings ?? {}
	draft.value = {...settings, device_key: ''}
	baseline.value = JSON.stringify(draft.value)
}
watch(query.data, value => {if (value && (!draft.value || !dirty.value)) adopt(value)}, {immediate: true})
async function submit() {
	if (!draft.value || save.isPending.value) return
	error.value = ''
	try {adopt(await save.mutateAsync({...draft.value}))} catch {error.value = t('bark.saveFailed')}
}
async function sendTest() {
	if (dirty.value || test.isPending.value) return
	error.value = ''
	try {await test.mutateAsync()} catch {error.value = t('bark.testFailed')}
}
const endpoint = computed(() => (draft.value?.server_url ?? '').replace(/\/+$/, '') + '/push')
</script>

<template>
	<div class="settings-page">
		<PageHeader
			:title="t('bark.title')"
			:description="t('bark.intro')"
		/>
		<div class="settings-sections">
			<Card :loading="query.isPending.value">
				<Message class="mbe-4">
					{{ t('bark.reminderHint') }}
				</Message>
				<LoadError
					v-if="query.isError.value && !query.data.value"
					class="mbe-4"
					:message="t('bark.loadFailed')"
					:retry="() => query.refetch()"
				/>
				<form
					v-if="draft"
					class="bark-settings"
					@submit.prevent="submit"
				>
					<fieldset :disabled="save.isPending.value || test.isPending.value">
						<label class="check-row">
							<input
								v-model="draft.enabled"
								type="checkbox"
							>
							<span>{{ t('bark.enabled') }}</span>
						</label>
						<div class="field-grid">
							<label class="settings-field">
								<span class="settings-field__label">{{ t('bark.server') }}</span>
								<input
									v-model="draft.server_url"
									class="input"
									type="url"
									required
									placeholder="https://api.day.app"
									autocomplete="off"
								>
							</label>
							<div class="settings-field">
								<label class="settings-field">
									<span class="settings-field__label">{{ t('bark.key') }}</span>
									<input
										v-model="draft.device_key"
										class="input"
										type="password"
										autocomplete="new-password"
										aria-describedby="bark-key-help"
										:placeholder="t(query.data.value?.settings?.has_key ? 'bark.keySaved' : 'bark.keyEmpty')"
									>
								</label>
								<p
									id="bark-key-help"
									class="settings-field__hint"
								>
									{{ t('bark.keyHelp') }}
								</p>
							</div>
							<label class="settings-field">
								<span class="settings-field__label">{{ t('bark.scope') }}</span>
								<span class="select is-fullwidth">
									<select v-model="draft.scope">
										<option value="reminders">{{ t('bark.reminders') }}</option>
										<option value="all">{{ t('bark.all') }}</option>
									</select>
								</span>
							</label>
							<label class="settings-field">
								<span class="settings-field__label">{{ t('bark.level') }}</span>
								<span class="select is-fullwidth">
									<select v-model="draft.level">
										<option value="timeSensitive">{{ t('bark.timeSensitive') }}</option>
										<option value="active">{{ t('bark.active') }}</option>
										<option value="passive">{{ t('bark.passive') }}</option>
									</select>
								</span>
							</label>
							<label class="settings-field">
								<span class="settings-field__label">{{ t('bark.language') }}</span>
								<span class="select is-fullwidth">
									<select v-model="draft.language">
										<option value="zh-CN">简体中文</option>
										<option value="en">English</option>
									</select>
								</span>
							</label>
						</div>
						<div>
							<label class="check-row">
								<input
									v-model="draft.preview"
									type="checkbox"
									aria-describedby="bark-privacy-help"
								>
								<span>{{ t('bark.preview') }}</span>
							</label>
							<p
								id="bark-privacy-help"
								class="settings-field__hint"
							>
								{{ t('bark.privacy') }}
							</p>
						</div>
						<dl class="bark-endpoint">
							<dt>{{ t('bark.endpoint') }}</dt>
							<dd><code>{{ endpoint }}</code></dd>
						</dl>
					</fieldset>
					<div class="bark-actions">
						<XButton
							type="submit"
							icon="save"
							:loading="save.isPending.value"
						>
							{{ t('bark.save') }}
						</XButton>
						<XButton
							variant="secondary"
							icon="bell"
							:disabled="dirty || !query.data.value?.settings?.has_key"
							:loading="test.isPending.value"
							@click="sendTest"
						>
							{{ t('bark.test') }}
						</XButton>
						<p
							v-if="dirty"
							class="settings-field__hint"
						>
							{{ t('bark.saveFirst') }}
						</p>
					</div>
					<Message
						v-if="error"
						variant="danger"
					>
						{{ error }}
					</Message>
				</form>
				<details class="bark-guide">
					<summary>{{ t('bark.guide') }}</summary>
					<ol>
						<li>{{ t('bark.step1') }}</li>
						<li>{{ t('bark.step2') }}</li>
						<li>{{ t('bark.step3') }}</li>
					</ol>
					<p>{{ t('bark.deliveryHint') }}</p>
					<a
						href="https://github.com/Finb/Bark/blob/master/docs/tutorial.md"
						target="_blank"
						rel="noopener noreferrer"
					>{{ t('bark.docs') }}</a>
				</details>
			</Card>

			<Card :title="t('bark.recent')">
				<p class="settings-field__hint mbe-3">
					{{ t('bark.acceptedHint') }}
				</p>
				<!-- "No deliveries yet" only once the history loaded: while loading or after a failure it is unknown. -->
				<p
					v-if="!query.data.value && query.isPending.value"
					class="bark-empty"
					role="status"
				>
					{{ t('misc.loading') }}
				</p>
				<p
					v-else-if="!query.data.value"
					class="bark-empty"
				>
					{{ t('bark.deliveriesUnknown') }}
				</p>
				<p
					v-else-if="!query.data.value.deliveries?.length"
					class="bark-empty"
				>
					{{ t('bark.empty') }}
				</p>
				<ul
					v-else
					class="bark-deliveries"
				>
					<li
						v-for="(delivery, index) in query.data.value.deliveries"
						:key="`${delivery.notification_id}-${index}`"
					>
						<strong>
							{{ delivery.notification_id
								? t('bark.notification', {id: delivery.notification_id})
								: t('bark.testDelivery') }}
							· {{ t(`bark.status_${delivery.status}`) }}
						</strong>
						<span class="bark-deliveries__meta">
							{{ new Date(delivery.updated!).toLocaleString() }} ·
							{{ t('bark.attempts', {count: delivery.attempts}) }}
						</span>
						<span
							v-if="delivery.error"
							class="bark-deliveries__meta"
						>{{ t('bark.errorCode') }}: <code>{{ delivery.error }}</code></span>
						<span
							v-if="delivery.status === 'pending' && delivery.attempts"
							class="bark-deliveries__meta"
						>{{ t('bark.next') }}: {{ new Date(delivery.next!).toLocaleString() }}</span>
					</li>
				</ul>
			</Card>
		</div>
	</div>
</template>


<style scoped lang="scss">
.settings-sections {
	display: grid;
	gap: var(--space-5);

	> .card {
		margin-block-end: 0;
	}
}

.bark-settings {
	display: grid;
	gap: var(--space-4);
}

.bark-settings fieldset {
	display: grid;
	gap: var(--space-4);
	margin: 0;
	padding: 0;
	border: 0;
	min-inline-size: 0;
}

.field-grid {
	display: grid;
	grid-template-columns: repeat(2, minmax(0, 1fr));
	gap: var(--space-3) var(--space-4);

	@media screen and (max-width: $tablet) {
		grid-template-columns: minmax(0, 1fr);
	}
}

.settings-field {
	display: grid;
	align-content: start;
	gap: var(--space-1);
	min-inline-size: 0;
}

.settings-field__label {
	color: var(--text-secondary);
	font-size: var(--text-sm);
	font-weight: var(--weight-semibold);
}

.settings-field__hint {
	color: var(--text-tertiary);
	font-size: var(--text-xs);
	line-height: var(--leading-normal);
}

.check-row {
	display: flex;
	align-items: flex-start;
	gap: var(--space-2);
	cursor: pointer;

	input {
		flex-shrink: 0;
		inline-size: 1rem;
		block-size: 1rem;
		margin-block-start: .2rem;
		accent-color: var(--primary);
	}
}

.bark-endpoint {
	display: grid;
	gap: var(--space-1);
	margin: 0;
	font-size: var(--text-sm);

	dt {
		color: var(--text-secondary);
		font-weight: var(--weight-medium);
	}

	dd {
		margin: 0;
	}

	code {
		font-family: var(--font-mono);
		font-size: var(--text-xs);
		overflow-wrap: anywhere;
	}
}

.bark-actions {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: var(--space-2) var(--space-3);
	padding-block-start: var(--space-4);
	border-block-start: 1px solid var(--border-subtle);
}

.bark-guide {
	margin-block-start: var(--space-5);
	font-size: var(--text-md);

	summary {
		cursor: pointer;
		font-weight: var(--weight-semibold);
		border-radius: var(--radius-xs);

		&:focus-visible {
			@include focus-ring;
		}
	}

	ol {
		margin-block: var(--space-2);
		padding-inline-start: var(--space-5);
	}

	p {
		margin-block-end: var(--space-2);
		color: var(--text-secondary);
	}
}

.bark-empty {
	color: var(--text-secondary);
}

.bark-deliveries {
	margin: 0;
	padding: 0;
	list-style: none;
}

.bark-deliveries li {
	display: grid;
	gap: var(--space-1);
	padding-block: var(--space-3);
	border-block-end: 1px solid var(--border-subtle);
	overflow-wrap: anywhere;

	&:last-child {
		border-block-end: 0;
	}
}

.bark-deliveries__meta {
	color: var(--text-secondary);
	font-size: var(--text-sm);
}
</style>
