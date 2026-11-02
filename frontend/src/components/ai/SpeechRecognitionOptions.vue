<script setup lang="ts">
import {computed} from 'vue'
import {useI18n} from 'vue-i18n'
import type {AIConnection, SpeechOptions} from '@/client/queries/tcyAi'
import {speechModelCapabilities, type SpeechProviderPreset} from '@/helpers/speechProviders'
import {speechWorkspaceRequired} from '@/helpers/aliyunSpeech'

const props = defineProps<{
	connection: AIConnection
	provider: SpeechProviderPreset
}>()
const emit = defineEmits<{'update:connection': [connection: AIConnection]}>()
const {t} = useI18n({useScope: 'global'})
const capabilities = computed(() => speechModelCapabilities(props.connection, props.provider))
const languageHint = computed(() => props.provider.id === 'mimo' ? 'speechSettings.mimoLanguageHint'
	: props.provider.id === 'sensevoice' ? 'speechSettings.sensevoiceLanguageHint' : 'speechSettings.languageHint')
const workspaceRequired = computed(() => speechWorkspaceRequired(props.connection))
const fields = computed(() => [
	{
		key: 'workspace_id',
		enabled: capabilities.value?.workspace || workspaceRequired.value,
		label: 'workspace',
		required: workspaceRequired.value,
	},
	{
		key: 'app_id',
		enabled: capabilities.value?.app_id,
		label: 'appID',
		required: false,
	},
	{
		key: 'resource_id',
		enabled: capabilities.value?.resource_id,
		label: 'resourceID',
		required: true,
	},
	{
		key: 'vocabulary_id',
		enabled: capabilities.value?.vocabulary,
		label: 'vocabulary',
		required: false,
	},
] as const)

function update<K extends keyof SpeechOptions>(key: K, value: SpeechOptions[K]) {
	emit('update:connection', {
		...props.connection,
		speech: {
			...props.connection.speech,
			[key]: value,
		},
	})
}
function inputValue(event: Event) {
	return (event.target as HTMLInputElement).value
}
function hotwords(event: Event) {
	const value = inputValue(event)
	update('hotwords', value ? value.split('\n') : [])
}
</script>

<template>
	<div class="speech-options">
		<label
			v-for="field in fields.filter(item => item.enabled && item.required)"
			:key="field.key"
			class="speech-field"
		>
			<span>{{ t(`speechSettings.${field.label}`) }}</span>
			<input
				:value="connection.speech?.[field.key] || ''"
				class="input"
				autocomplete="off"
				:maxlength="field.key === 'workspace_id' ? 100 : 200"
				:aria-label="t(`speechSettings.${field.label}`)"
				required
				@input="update(field.key, inputValue($event))"
			>
			<small>{{ t(`speechSettings.${field.label}Hint`) }}</small>
		</label>
		<label
			v-if="capabilities?.language"
			class="speech-field"
		>
			<span>{{ t('speechSettings.language') }}</span>
			<input
				:value="connection.speech?.language || ''"
				class="input"
				:placeholder="t('speechSettings.languagePlaceholder')"
				autocomplete="off"
				maxlength="35"
				@input="update('language', inputValue($event))"
			>
			<small>{{ t(languageHint) }}</small>
		</label>
		<label
			v-if="capabilities?.prompt"
			class="speech-field"
		>
			<span>{{ t('speechSettings.prompt') }}</span>
			<textarea
				:value="connection.speech?.prompt || ''"
				class="textarea"
				rows="3"
				:maxlength="provider.id === 'aliyun' ? 400 : 8000"
				@input="update('prompt', inputValue($event))"
			/>
			<small>{{ t(provider.id === 'aliyun' ? 'speechSettings.aliyunPromptHint' : 'speechSettings.promptHint') }}</small>
		</label>
		<label
			v-if="capabilities?.hotwords"
			class="speech-field"
		>
			<span>{{ t('speechSettings.hotwords') }}</span>
			<textarea
				:value="connection.speech?.hotwords?.join('\n') || ''"
				class="textarea"
				rows="3"
				@input="hotwords"
			/>
			<small>{{ t('speechSettings.hotwordsHint') }}</small>
		</label>
		<details
			v-if="fields.some(item => item.enabled && !item.required)"
			class="speech-options__enhancements"
		>
			<summary>{{ t('speechSettings.optionalEnhancements') }}</summary>
			<p>{{ t('speechSettings.optionalEnhancementsHint') }}</p>
			<label
				v-for="field in fields.filter(item => item.enabled && !item.required)"
				:key="field.key"
				class="speech-field"
			>
				<span>{{ t(`speechSettings.${field.label}`) }}</span>
				<input
					:value="connection.speech?.[field.key] || ''"
					class="input"
					autocomplete="off"
					:maxlength="field.key === 'workspace_id' ? 100 : 200"
					:aria-label="t(`speechSettings.${field.label}`)"
					@input="update(field.key, inputValue($event))"
				>
				<small>{{ t(`speechSettings.${field.label}Hint`) }}</small>
			</label>
		</details>
	</div>
</template>

<style lang="scss" scoped>
.speech-options,
.speech-field {
	display: grid;
	gap: var(--space-2);
	min-inline-size: 0;
}

.speech-options {
	gap: var(--space-4);
}

.speech-field > span {
	font-weight: var(--weight-semibold);
}

.speech-field small {
	color: var(--text-secondary);
	line-height: var(--leading-normal);
}

.speech-options__enhancements {
	summary {
		min-block-size: var(--target-min);
		padding-block: var(--space-2);
		cursor: pointer;
	}

	p {
		color: var(--text-secondary);
		font-size: var(--text-sm);
	}

	.speech-field + .speech-field {
		margin-block-start: var(--space-4);
	}
}
</style>
