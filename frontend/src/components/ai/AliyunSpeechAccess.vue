<script setup lang="ts">
import {computed} from 'vue'
import {useI18n} from 'vue-i18n'
import type {AIConnection} from '@/client/queries/tcyAi'
import {
	aliyunSpeechAccess,
	aliyunSpeechBaseURL,
	type AliyunSpeechRegion,
} from '@/helpers/aliyunSpeech'

const props = defineProps<{connection: AIConnection}>()
const emit = defineEmits<{'update:connection': [connection: AIConnection]}>()
const {t} = useI18n({useScope: 'global'})
const access = computed(() => aliyunSpeechAccess(props.connection))

function selectRegion(event: Event) {
	const region = (event.target as HTMLSelectElement).value
	if (region !== 'beijing' && region !== 'singapore') return
	setAddress(region)
}
function setAddress(region: AliyunSpeechRegion, workspace = false) {
	const baseURL = aliyunSpeechBaseURL(props.connection.protocol, region, workspace)
	if (baseURL) emit('update:connection', {...props.connection, base_url: baseURL})
}
</script>

<template>
	<section class="aliyun-speech-access">
		<label class="speech-field">
			<span>{{ t('speechSettings.aliyunRegion') }}</span>
			<span class="select is-fullwidth">
				<select
					:value="access"
					:aria-label="t('speechSettings.aliyunRegion')"
					@change="selectRegion"
				>
					<option value="beijing">{{ t('speechSettings.aliyunBeijing') }}</option>
					<option value="singapore">{{ t('speechSettings.aliyunSingapore') }}</option>
					<option
						v-if="access === 'workspace'"
						value="workspace"
					>{{ t('speechSettings.aliyunDedicatedCurrent') }}</option>
					<option
						v-if="access === 'custom'"
						value="custom"
					>{{ t('speechSettings.aliyunCustomCurrent') }}</option>
				</select>
			</span>
			<small>{{ t('speechSettings.aliyunRegionHint') }}</small>
		</label>
		<details class="aliyun-speech-access__advanced">
			<summary>{{ t('speechSettings.aliyunDedicatedAdvanced') }}</summary>
			<p>{{ t('speechSettings.aliyunDedicatedHint') }}</p>
			<div class="aliyun-speech-access__actions">
				<XButton
					type="button"
					variant="tertiary"
					@click="setAddress('beijing', true)"
				>
					{{ t('speechSettings.aliyunDedicatedBeijing') }}
				</XButton>
				<XButton
					type="button"
					variant="tertiary"
					@click="setAddress('singapore', true)"
				>
					{{ t('speechSettings.aliyunDedicatedSingapore') }}
				</XButton>
			</div>
			<a
				href="https://help.aliyun.com/zh/model-studio/regions"
				target="_blank"
				rel="noopener noreferrer"
			>{{ t('speechSettings.aliyunAccessDocs') }}</a>
		</details>
	</section>
</template>

<style lang="scss" scoped>
.aliyun-speech-access,
.speech-field {
	display: grid;
	gap: var(--space-2);
	min-inline-size: 0;
}

.speech-field > span:first-child {
	font-weight: var(--weight-semibold);
}

.speech-field small,
.aliyun-speech-access__advanced p {
	color: var(--text-secondary);
	font-size: var(--text-sm);
	line-height: var(--leading-normal);
}

.aliyun-speech-access__advanced {
	summary {
		min-block-size: var(--target-min);
		padding-block: var(--space-2);
		cursor: pointer;
	}
}

.aliyun-speech-access__actions {
	display: flex;
	flex-wrap: wrap;
	gap: var(--space-2);
	margin-block-end: var(--space-3);
}
</style>
