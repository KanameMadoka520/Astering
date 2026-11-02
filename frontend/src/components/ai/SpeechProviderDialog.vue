<script setup lang="ts">
import {computed, ref, watch} from 'vue'
import {useI18n} from 'vue-i18n'
import Modal from '@/components/misc/Modal.vue'
import Message from '@/components/misc/Message.vue'
import ModelPicker from './ModelPicker.vue'
import SpeechRecognitionOptions from './SpeechRecognitionOptions.vue'
import SpeechConnectionTest from './SpeechConnectionTest.vue'
import AliyunSpeechAccess from './AliyunSpeechAccess.vue'
import type {AIConnection, AIProtocol, SpeechModel} from '@/client/queries/tcyAi'
import {aliyunSpeechModelConnection, speechConnectionCanProbe, supportsAliyunSpeechAccess} from '@/helpers/aliyunSpeech'
import {
	speechAudioLimit,
	type SpeechConnectionPresentation,
	type SpeechProviderPreset,
} from '@/helpers/speechProviders'

const props = defineProps<{
	connection: AIConnection
	connections: AIConnection[]
	provider: SpeechProviderPreset
	defaultId: string
	state: SpeechConnectionPresentation
	endpoint: string
	modelsEndpoint: string
}>()
const emit = defineEmits<{
	close: []
	'update:connection': [connection: AIConnection]
	select: [id: string]
	add: []
	save: [connection: AIConnection]
	default: [connection: AIConnection]
	remove: [connection: AIConnection]
	models: [connection: AIConnection]
	test: [connection: AIConnection, file?: File]
	resetTest: []
}>()
const {t} = useI18n({useScope: 'global'})
const revealKey = ref(false)
watch(() => props.connection.id, () => {
	revealKey.value = false
})
const title = computed(() => t('speechSettings.providerSettings', {
	provider: props.provider.labelKey ? t(props.provider.labelKey) : props.provider.name,
}))
const enabled = computed(() => !props.connection.speech?.disabled)
const modelID = computed({
	get: () => props.connection.model,
	set: model => update({model}),
})
const hasModelDiscovery = computed(() =>
	['openai-transcription', 'openai-audio', 'gemini'].includes(props.connection.protocol))
const keyPlaceholder = computed(() => props.connection.has_key && props.state.persisted && !props.state.changedAddress
	? t('tcymc.text.saved_leave_blank_to_keep_the_current_key')
	: t('speechSettings.keyPlaceholder'))
const protocols = computed(() => [...new Set([
	props.connection.protocol,
	...props.provider.models.map(model => model.protocol),
	...(props.provider.id === 'custom' ? ['openai-transcription', 'openai-audio', 'gemini'] as const : []),
])])

function update(patch: Partial<AIConnection>) {
	emit('update:connection', {...props.connection, ...patch})
}
function toggleEnabled() {
	update({speech: {...props.connection.speech, disabled: enabled.value}})
}
function modelConnection(model: SpeechModel): AIConnection {
	if (props.provider.id === 'aliyun') return aliyunSpeechModelConnection(props.connection, model)
	return {
		...props.connection,
		model: model.id,
		protocol: model.protocol,
		base_url: model.base_url,
	}
}
function selectModel(model: SpeechModel) {
	emit('update:connection', modelConnection(model))
}
function selectedModel(model: SpeechModel) {
	return model.id === props.connection.model && model.protocol === props.connection.protocol
}
function currentModel(model: SpeechModel) {
	return selectedModel(model) && props.defaultId === props.connection.id && props.state.canTest
}
function useDefault(model?: SpeechModel) {
	if (props.state.saving) return
	const connection = model ? modelConnection(model) : props.connection
	emit('default', {...connection, speech: {...connection.speech, disabled: false}})
}
function value(event: Event) {
	return (event.target as HTMLInputElement).value
}
</script>

<template>
	<Modal
		wide
		class="speech-provider-dialog"
		:aria-label="title"
		:loading="state.saving"
		@close="emit('close')"
	>
		<form
			class="speech-provider-form connection"
			:aria-label="connection.name || title"
			@submit.prevent="emit('save', connection)"
		>
			<header class="speech-provider-dialog__header">
				<div class="speech-provider-dialog__identity">
					<span
						class="speech-provider-dialog__mark"
						aria-hidden="true"
					>{{ provider.mark }}</span>
					<div>
						<h2>{{ title }}</h2>
						<p>{{ t('speechSettings.title') }}</p>
					</div>
				</div>
				<a
					v-if="provider.docsURL"
					:href="provider.docsURL"
					target="_blank"
					rel="noopener noreferrer"
					class="speech-provider-dialog__guide"
				>
					<Icon
						icon="external-link-alt"
						aria-hidden="true"
					/> {{ t('speechSettings.guide') }}
				</a>
				<label
					class="speech-provider-dialog__enabled"
					:class="{'is-enabled': enabled}"
				>
					<span>{{ t(enabled ? 'speechSettings.enabled' : 'speechSettings.disabled') }}</span>
					<input
						type="checkbox"
						role="switch"
						:checked="enabled"
						:aria-label="t('speechSettings.enableConnection')"
						@change="toggleEnabled"
					>
				</label>
				<XButton
					type="button"
					variant="tertiary"
					icon="times"
					class="speech-provider-dialog__close"
					:aria-label="t('misc.closeDialog')"
					:aria-disabled="state.saving"
					@click="!state.saving && emit('close')"
				/>
			</header>
			<p class="speech-provider-dialog__hint">
				{{ t('speechSettings.savedOnServer') }}
			</p>
			<Message
				v-if="provider.local"
				variant="info"
			>
				{{ t('speechSettings.localHint') }}
			</Message>
			<div
				class="speech-provider-dialog__connections"
			>
				<label
					v-if="connections.length > 1"
					class="speech-field"
				>
					<span>{{ t('speechSettings.connection') }}</span>
					<span class="select is-fullwidth">
						<select
							:value="connection.id"
							@change="emit('select', value($event))"
						>
							<option
								v-for="item in connections"
								:key="item.id"
								:value="item.id"
							>{{ item.name || item.model || t('tcymc.text.new_model') }}</option>
						</select>
					</span>
				</label>
				<XButton
					type="button"
					variant="tertiary"
					icon="plus"
					:aria-disabled="state.saving || !state.canAdd"
					@click="!state.saving && state.canAdd && emit('add')"
				>
					{{ t('speechSettings.addConnection') }}
				</XButton>
			</div>
			<Message
				v-if="state.changedAddress"
				variant="warning"
			>
				{{ t('speechSettings.keyDestinationChanged') }}
			</Message>
			<AliyunSpeechAccess
				v-if="provider.id === 'aliyun' && supportsAliyunSpeechAccess(connection.protocol)"
				:connection="connection"
				@update:connection="emit('update:connection', $event)"
			/>
			<div class="speech-field">
				<div class="speech-field__heading">
					<label :for="`${connection.id}-speech-key`">{{ t('tcymc.apiKey') }}</label>
					<a
						v-if="provider.keyURL"
						:href="provider.keyURL"
						target="_blank"
						rel="noopener noreferrer"
					>{{ t('speechSettings.getKey') }}</a>
				</div>
				<div class="speech-key">
					<input
						:id="`${connection.id}-speech-key`"
						:value="connection.api_key"
						:type="revealKey ? 'text' : 'password'"
						class="input"
						autocomplete="new-password"
						:placeholder="keyPlaceholder"
						@input="update({api_key: value($event)})"
					>
					<button
						type="button"
						:aria-label="t(revealKey ? 'speechSettings.hideKey' : 'speechSettings.showKey')"
						:aria-pressed="revealKey"
						@click="revealKey = !revealKey"
					>
						<Icon
							:icon="revealKey ? 'eye-slash' : 'eye'"
							aria-hidden="true"
						/>
					</button>
				</div>
			</div>
			<section
				class="speech-models"
				:aria-label="t('speechSettings.models')"
			>
				<div class="speech-field__heading">
					<h3>{{ t('speechSettings.models') }}</h3>
					<a
						v-if="provider.docsURL"
						:href="provider.docsURL"
						target="_blank"
						rel="noopener noreferrer"
					>{{ t('speechSettings.moreModels') }}</a>
				</div>
				<article
					v-for="model in provider.models"
					:key="`${model.protocol}:${model.id}`"
					class="speech-model"
					:class="{'is-selected': selectedModel(model)}"
				>
					<button
						type="button"
						class="speech-model__choose"
						:aria-pressed="selectedModel(model)"
						@click="selectModel(model)"
					>
						<span
							class="speech-model__icon"
							aria-hidden="true"
						><Icon icon="magic" /></span>
						<span class="speech-model__name">
							<strong>{{ model.name || model.id }}</strong>
							<code v-if="model.name && model.name !== model.id">{{ model.id }}</code>
						</span>
						<span
							v-if="model.recommended"
							class="speech-model__recommendation"
						>{{ t('speechSettings.recommended') }}</span>
					</button>
					<XButton
						variant="secondary"
						type="button"
						class="is-small"
						:icon="currentModel(model) ? 'check' : undefined"
						:aria-disabled="state.saving || currentModel(model)"
						@click="!currentModel(model) && useDefault(model)"
					>
						{{ t(currentModel(model) ? 'speechSettings.currentModel' : 'speechSettings.makeDefault') }}
					</XButton>
				</article>
			</section>
			<details
				class="speech-advanced"
				:open="provider.id === 'custom' || !provider.models.length"
			>
				<summary>{{ t('speechSettings.connectionDetails') }}</summary>
				<div class="speech-advanced__fields">
					<label class="speech-field">
						<span>{{ t('tcymc.text.connection_name') }}</span>
						<input
							:value="connection.name"
							class="input"
							required
							@input="update({name: value($event)})"
						>
					</label>
					<label class="speech-field">
						<span>{{ t('tcymc.text.request_protocol') }}</span>
						<span class="select is-fullwidth"><select
							:value="connection.protocol"
							@change="update({protocol: value($event) as AIProtocol})"
						>
							<option
								v-for="protocol in protocols"
								:key="protocol"
								:value="protocol"
							>{{ protocol }}</option>
						</select></span>
					</label>
					<label class="speech-field">
						<span>{{ t('tcymc.text.api_base_url') }}</span>
						<input
							:value="connection.base_url"
							class="input"
							required
							type="url"
							autocomplete="url"
							@input="update({base_url: value($event)})"
						>
					</label>
					<div class="speech-field">
						<ModelPicker
							v-model="modelID"
							:models="state.models"
							:label="t('tcymc.text.model_id')"
							required
						/>
					</div>
					<XButton
						v-if="hasModelDiscovery"
						type="button"
						variant="secondary"
						icon="cloud-download-alt"
						:loading="state.fetching"
						:aria-disabled="!connection.base_url"
						@click="connection.base_url && emit('models', connection)"
					>
						{{ t('tcymc.text.fetch_model_list') }}
					</XButton>
					<p
						v-if="state.modelNotice"
						role="status"
						class="speech-provider-dialog__hint"
					>
						{{ state.modelNotice }}
					</p>
				</div>
			</details>
			<SpeechRecognitionOptions
				:connection="connection"
				:provider="provider"
				@update:connection="emit('update:connection', $event)"
			/>
			<dl class="speech-endpoints">
				<dt>{{ t('tcymc.text.request_endpoint') }}</dt><dd><code>{{ endpoint }}</code></dd>
				<template v-if="hasModelDiscovery">
					<dt>{{ t('tcymc.text.model_list_endpoint') }}</dt><dd><code>{{ modelsEndpoint }}</code></dd>
				</template>
			</dl>
			<SpeechConnectionTest
				:key="connection.id"
				:can-test="state.canTest && enabled"
				:can-probe="speechConnectionCanProbe(connection)"
				:testing="state.testing"
				:max-bytes="speechAudioLimit(connection)"
				:result="state.result"
				@test="emit('test', connection, $event)"
				@reset="emit('resetTest')"
			/>
			<footer class="speech-provider-dialog__footer">
				<XButton
					type="submit"
					icon="save"
					:loading="state.saving"
				>
					{{ t('modelSettings.saveConnection') }}
				</XButton>
				<XButton
					v-if="!provider.models.length"
					type="button"
					variant="secondary"
					:aria-disabled="state.saving"
					@click="useDefault()"
				>
					{{ t('speechSettings.makeDefault') }}
				</XButton>
				<span
					role="status"
					class="speech-provider-dialog__hint"
				>{{ t(state.saved ? 'modelSettings.saved' : 'settingsDraft.unsaved') }}</span>
				<XButton
					type="button"
					variant="tertiary"
					danger
					:aria-disabled="state.saving"
					@click="!state.saving && emit('remove', connection)"
				>
					{{ t('tcymc.text.remove_connection') }}
				</XButton>
			</footer>
			<Message
				v-if="state.error"
				variant="danger"
			>
				{{ t('settingsDraft.retained') }} {{ state.error }}
			</Message>
		</form>
	</Modal>
</template>

<style lang="scss" scoped>
.speech-provider-form {
	display: grid;
	gap: var(--space-5);
	min-inline-size: 0;
	padding: var(--space-5);
	border: 1px solid var(--border-subtle);
	border-radius: var(--radius-lg);
	background: var(--surface);
	color: var(--text-primary);
	text-align: start;
}

:global(.modal-dialog.speech-provider-dialog > .modal-container > .close) {
	display: none;
}

.speech-provider-dialog__close {
	margin-inline-start: auto;
}

.speech-provider-dialog__header,
.speech-provider-dialog__identity,
.speech-field__heading,
.speech-provider-dialog__footer,
.speech-provider-dialog__enabled {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: var(--space-3);
}

.speech-provider-dialog__header {
	align-items: start;
}

.speech-provider-dialog__identity {
	flex: 1 1 15rem;
	min-inline-size: 0;

	h2 {
		margin: 0;
		font-size: var(--text-xl);
		overflow-wrap: anywhere;
	}

	p {
		margin-block: var(--space-1) 0;
		color: var(--text-secondary);
		font-size: var(--text-sm);
	}
}

.speech-provider-dialog__mark {
	display: grid;
	flex: 0 0 2.75rem;
	place-items: center;
	block-size: 2.75rem;
	border-radius: var(--radius-md);
	background: var(--surface-active);
	color: var(--primary);
	font-size: var(--text-xl);
	font-weight: var(--weight-bold);
}

.speech-provider-dialog__enabled {
	justify-content: space-between;
	min-block-size: var(--target-min);
	padding: var(--space-1) var(--space-3);
	border: 1px solid var(--border-subtle);
	border-radius: var(--radius-full);
	background: var(--surface-sunken);
	font-size: var(--text-sm);
	cursor: pointer;

	&.is-enabled {
		color: var(--success);
	}

	input {
		position: relative;
		inline-size: 2.25rem;
		block-size: 1.25rem;
		margin: 0;
		border: 0;
		border-radius: var(--radius-full);
		appearance: none;
		background: var(--border-strong);
		cursor: pointer;

		&::before {
			position: absolute;
			inset-block-start: .125rem;
			inset-inline-start: .125rem;
			inline-size: 1rem;
			block-size: 1rem;
			border-radius: 50%;
			background: #ffffff;
			content: '';
			transition: transform 150ms ease;
		}

		&:checked {
			background: var(--primary);

			&::before {
				transform: translateX(1rem);
			}
		}

		&:focus-visible {
			@include focus-ring;
		}

		@media (prefers-reduced-motion: reduce) {
			&::before {
				transition: none;
			}
		}
	}
}

.speech-provider-dialog__hint,
.speech-provider-dialog__guide {
	margin: 0;
	color: var(--text-secondary);
	font-size: var(--text-sm);
	line-height: var(--leading-normal);
}

.speech-field,
.speech-models,
.speech-advanced__fields {
	display: grid;
	gap: var(--space-3);
	min-inline-size: 0;
}

.speech-field > span,
.speech-field__heading label {
	font-weight: var(--weight-semibold);
}

.speech-field__heading {
	justify-content: space-between;

	h3 {
		margin: 0;
		font-size: var(--text-md);
	}

	a {
		font-size: var(--text-sm);
	}
}

.speech-key {
	position: relative;

	input {
		padding-inline-end: 3rem;
	}

	button {
		position: absolute;
		inset-block: 0;
		inset-inline-end: 0;
		inline-size: 3rem;
		border: 0;
		border-radius: var(--radius-md);
		background: transparent;
		color: var(--text-secondary);
		cursor: pointer;

		&:focus-visible {
			@include focus-ring;
		}
	}
}

.speech-model {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: var(--space-3);
	min-inline-size: 0;
	padding: var(--space-4);
	border: 1px solid var(--border-subtle);
	border-radius: var(--radius-lg);

	&.is-selected {
		border-color: var(--primary);
		background: color-mix(in srgb, var(--primary) 4%, var(--surface));
	}
}

.speech-model__choose {
	display: flex;
	flex: 1 1 14rem;
	align-items: center;
	gap: var(--space-3);
	min-inline-size: 0;
	min-block-size: var(--target-min);
	padding: 0;
	border: 0;
	background: transparent;
	color: inherit;
	font: inherit;
	text-align: start;
	cursor: pointer;

	&:focus-visible {
		@include focus-ring;
	}
}

.speech-model__icon {
	display: grid;
	flex: 0 0 2.75rem;
	place-items: center;
	block-size: 2.75rem;
	border-radius: var(--radius-md);
	background: var(--surface-active);
	color: var(--primary);
}

.speech-model__name {
	display: grid;
	gap: var(--space-1);
	min-inline-size: 0;
	overflow-wrap: anywhere;

	code {
		color: var(--text-secondary);
		font-size: var(--text-xs);
	}
}

.speech-model__recommendation {
	padding: var(--space-1) var(--space-2);
	border-radius: var(--radius-sm);
	background: var(--surface-sunken);
	color: var(--text-secondary);
	font-size: var(--text-xs);
}

.speech-advanced {
	border-block: 1px solid var(--border-subtle);

	summary {
		padding-block: var(--space-3);
		font-weight: var(--weight-semibold);
		cursor: pointer;
	}
}

.speech-advanced__fields {
	padding-block-end: var(--space-4);
}

.speech-endpoints {
	display: grid;
	gap: var(--space-2);
	margin: 0;
	font-size: var(--text-sm);

	dt {
		font-weight: var(--weight-semibold);
	}

	dd {
		margin: 0 0 var(--space-2);
	}

	code {
		font-size: var(--text-xs);
		overflow-wrap: anywhere;
	}
}

.speech-provider-dialog__footer {
	position: sticky;
	inset-block-end: 0;
	padding-block: var(--space-3);
	border-block-start: 1px solid var(--border-subtle);
	background: var(--surface);
}
</style>
