<script setup lang="ts">
import {computed} from 'vue'
import {useI18n} from 'vue-i18n'
import Message from '@/components/misc/Message.vue'
import type {AISettings} from '@/client/queries/tcyAi'

const props = defineProps<{
	settings: AISettings
	persistedIds: string[]
	speechLayout: boolean
	dirty: boolean
	saved: boolean
	saving: boolean
	error: string
}>()
const emit = defineEmits<{
	'update:settings': [settings: AISettings]
	save: []
}>()
const {t} = useI18n({useScope: 'global'})
const roles = computed(() => [
	{
		id: 'transcription',
		kind: 'transcription',
		label: 'tcymc.text.speech_recognition',
		hint: 'tcymc.text.turn_recordings_or_uploaded_audio_into_text',
	},
	{
		id: 'cleanup',
		kind: 'chat',
		label: props.speechLayout ? 'speechSettings.quickCleanup' : 'tcymc.text.transcript_cleanup',
		hint: 'tcymc.text.improve_wording_and_punctuation_without_changing_tasks',
	},
	{
		id: 'assistant',
		kind: 'chat',
		label: props.speechLayout ? 'speechSettings.advancedAssistant' : 'tcymc.text.task_ai_assistant',
		hint: 'tcymc.text.choose_a_model_with_tool_calling_to_read',
	},
] as const)
function assign(role: 'transcription' | 'cleanup' | 'assistant', event: Event) {
	emit('update:settings', {
		...props.settings,
		[role]: (event.target as HTMLSelectElement).value,
	})
}
function persona(event: Event) {
	emit('update:settings', {
		...props.settings,
		persona: (event.target as HTMLSelectElement).value as 'arona' | 'none',
	})
}
</script>

<template>
	<form
		class="model-roles"
		:class="{'is-speech-layout': speechLayout}"
		aria-labelledby="ai-roles-title"
		@submit.prevent="emit('save')"
	>
		<header>
			<h2
				id="ai-roles-title"
				data-tour="ai-roles"
			>
				{{ t(speechLayout ? 'speechSettings.defaultModels' : 'tcymc.text.models_for_each_feature') }}
			</h2>
			<p>{{ t('modelSettings.saveConnectionFirst') }}</p>
		</header>
		<div class="model-roles__grid">
			<div
				v-for="role in roles"
				:key="role.id"
				class="model-role"
			>
				<label>
					<span>{{ t(role.label) }}</span>
					<span class="select is-fullwidth">
						<select
							:value="settings[role.id]"
							:aria-describedby="`ai-role-${role.id}-hint`"
							@change="assign(role.id, $event)"
						>
							<option value="">
								{{ t(role.id === 'cleanup'
									? 'tcymc.text.keep_the_original_transcript' : 'tcymc.text.not_enabled') }}
							</option>
							<option
								v-for="connection in settings.connections.filter(item => item.kind === role.kind)"
								:key="connection.id"
								:value="connection.id"
								:disabled="!persistedIds.includes(connection.id) || connection.speech?.disabled"
							>
								{{ connection.name }} · {{ connection.model }}
							</option>
						</select>
					</span>
				</label>
				<p :id="`ai-role-${role.id}-hint`">
					{{ t(role.hint) }}
				</p>
			</div>
		</div>
		<div class="model-role model-role--persona">
			<label>
				<span>{{ t('chatFiles.persona') }}</span>
				<span class="select is-fullwidth">
					<select
						:value="settings.persona"
						aria-describedby="ai-role-persona-hint"
						@change="persona"
					>
						<option value="arona">{{ t('chatFiles.personaArona') }}</option>
						<option value="none">{{ t('chatFiles.personaNone') }}</option>
					</select>
				</span>
			</label>
			<p id="ai-role-persona-hint">
				{{ t('chatFiles.personaHint') }}
			</p>
		</div>
		<footer>
			<XButton
				type="submit"
				icon="save"
				data-tour="ai-save"
				:loading="saving"
			>
				{{ t('modelSettings.saveRoles') }}
			</XButton>
			<span role="status">{{ dirty ? t('settingsDraft.unsaved') : saved ? t('modelSettings.saved') : '' }}</span>
		</footer>
		<Message
			v-if="error"
			variant="danger"
		>
			{{ t('settingsDraft.retained') }} {{ error }}
		</Message>
	</form>
</template>

<style lang="scss" scoped>
.model-roles {
	display: grid;
	gap: var(--space-5);
	min-inline-size: 0;
	padding: var(--space-5);
	border: 1px solid var(--border-subtle);
	border-radius: var(--radius-lg);
	background: var(--surface);
	box-shadow: var(--elevation-1);

	h2 {
		margin: 0 0 var(--space-2);
		font-size: var(--text-lg);
	}

	p {
		margin: 0;
		color: var(--text-secondary);
		font-size: var(--text-sm);
		line-height: var(--leading-normal);
	}

	footer {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-3);
		color: var(--text-secondary);
		font-size: var(--text-sm);
	}

	@media (width <= 640px) {
		padding: var(--space-4);
	}
}

.model-roles__grid {
	display: grid;
	grid-template-columns: repeat(3, minmax(0, 1fr));
	gap: var(--space-5);

	@media (width <= 900px) {
		grid-template-columns: minmax(0, 1fr);
	}
}

.model-role,
.model-role label {
	display: grid;
	align-content: start;
	gap: var(--space-3);
	min-inline-size: 0;
}

.model-role label > span:first-child {
	font-weight: var(--weight-semibold);
}

.model-role--persona {
	padding-block-start: var(--space-4);
	border-block-start: 1px solid var(--border-subtle);

	label {
		max-inline-size: 28rem;
	}
}
</style>
