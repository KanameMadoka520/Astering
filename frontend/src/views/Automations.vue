<script setup lang="ts">
import {computed, onBeforeUnmount, ref, shallowRef, watch} from 'vue'
import {useQuery} from '@tanstack/vue-query'
import {useRoute, useRouter} from 'vue-router'
import {useI18n} from 'vue-i18n'
import {useTitle} from '@/composables/useTitle'
import {useAuthStore} from '@/stores/auth'
import {
	automationQuery,
	automationRunsQuery,
	automationsQuery,
	useDeleteAutomation,
	useRunAutomation,
	useSaveAutomation,
	type Automation,
	type AutomationDraft,
} from '@/client/queries/automations'
import {clampPage} from '@/client/queries/pagination'
import {captureClientRequestContext, isClientRequestContextCurrent, isRequestContextAbort} from '@/client/requestContext'
import {ApiError} from '@/client/problem'
import {normalizeOptions, profileOptions} from '@/helpers/assistantProfiles'
import {automationTime, scheduleDescription} from '@/helpers/automationSchedule'
import {automationNotificationKey, automationRunErrorKey} from '@/helpers/automationRun'
import {resolveUserTimezone} from '@/helpers/time/userTimezone'
import PageHeader from '@/components/misc/state/PageHeader.vue'
import EmptyState from '@/components/misc/state/EmptyState.vue'
import LoadError from '@/components/misc/state/LoadError.vue'
import XButton from '@/components/input/Button.vue'
import Modal from '@/components/misc/Modal.vue'
import Card from '@/components/misc/Card.vue'
import AutomationEditor from '@/components/ai/AutomationEditor.vue'

defineOptions({name: 'AronaAutomations'})
const {t} = useI18n({useScope: 'global'})
const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const id = computed(() => typeof route.params.automationId === 'string' ? route.params.automationId : '')
const page = ref(1)
const runsPage = ref(1)
const requestContext = computed(() => {
	void auth.session
	return captureClientRequestContext()
})
const library = useQuery(computed(() => automationsQuery(page.value, requestContext.value)))
const detail = useQuery(computed(() => automationQuery(id.value, requestContext.value)))
const history = useQuery(computed(() => automationRunsQuery(id.value, runsPage.value, requestContext.value)))
const selected = computed(() => detail.isError.value ? undefined : detail.data.value)
const save = useSaveAutomation()
const remove = useDeleteAutomation()
const run = useRunAutomation()
const editing = shallowRef<{key: string, id?: string, revision?: number, draft: AutomationDraft}>()
const deleteTarget = shallowRef<Automation>()
const formError = ref('')
const actionError = ref('')
const actionTarget = ref('')
const requestIDs = new Map<string, string>()
let disposed = false
onBeforeUnmount(() => { disposed = true })
const running = computed(() => selected.value?.last_status === 'running'
	|| history.data.value?.items.some(item => item.status === 'running'))
const busy = computed(() => save.isPending.value || remove.isPending.value || run.isPending.value)
useTitle(() => t('automations.title'))
watch(id, () => { runsPage.value = 1; actionError.value = '' })
watch([library.data, library.isPlaceholderData], () => {
	page.value = clampPage(page.value, {data: library.data.value, isPlaceholderData: library.isPlaceholderData.value})
})
watch([history.data, history.isPlaceholderData], () => {
	runsPage.value = clampPage(runsPage.value, {data: history.data.value, isPlaceholderData: history.isPlaceholderData.value})
})
const sessionOwner = computed(() => {
	void auth.session
	const owner = captureClientRequestContext()
	return JSON.stringify([owner.identity?.id, owner.identity?.type, auth.session?.sid, owner.authSessionEpoch, owner.apiBaseUrl])
})
watch(sessionOwner, () => {
	editing.value = undefined
	deleteTarget.value = undefined
	formError.value = ''
	actionError.value = ''
	requestIDs.clear()
}, {flush: 'sync'})

function makeDraft(template = 'blank'): AutomationDraft {
	const options = normalizeOptions({...profileOptions('assist'), approval: 'unattended'})
	if (template === 'brief' || template === 'review') options.mode = 'read'
	return {
		title: template === 'blank' ? '' : t(`automations.templates.${template}.title`),
		prompt: template === 'blank' ? '' : t(`automations.templates.${template}.prompt`),
		kind: template === 'reminder' ? 'reminder' : 'agent',
		enabled: true,
		timezone: resolveUserTimezone(auth.settings.timezone),
		schedule: {kind: template === 'review' ? 'weekly' : 'daily', time: template === 'review' ? '18:00' : '09:00', ...template === 'review' ? {weekdays: [5]} : {}},
		options,
		notify_on_success: true,
		notify_on_failure: true,
		max_runtime_seconds: 3600,
	}
}
function newAutomation(template = 'blank') {
	if (busy.value) return
	formError.value = ''
	editing.value = {key: crypto.randomUUID(), draft: makeDraft(template)}
}
function editAutomation(automation: Automation) {
	formError.value = ''
	editing.value = {
		key: crypto.randomUUID(),
		id: automation.id,
		revision: automation.revision,
		draft: {...automation, options: normalizeOptions(automation.options), schedule: {...automation.schedule}},
	}
}
function failure(cause: unknown): string {
	if (cause instanceof ApiError && cause.status === 409) {
		if (cause.detail === 'automation_run_receipt_expired') return t('automations.receiptExpired')
		if (cause.detail === 'automation_limit') return t('automations.limitReached')
		if (cause.detail === 'automation_running_or_scheduler_busy') return t('automations.schedulerBusy')
		return t('automations.conflict')
	}
	return t('automations.actionFailed')
}
async function saveDraft(body: AutomationDraft) {
	const target = editing.value
	if (!target || busy.value) return
	const owner = captureClientRequestContext()
	const origin = route.fullPath
	formError.value = ''
	try {
		const result = await save.mutateAsync({id: target.id, expected_revision: target.revision, body})
		if (disposed || !isClientRequestContextCurrent(owner) || editing.value?.key !== target.key || route.fullPath !== origin) return
		editing.value = undefined
		await router.push({name: 'automations', params: {automationId: result.id}})
	} catch (cause) {
		if (!disposed && isClientRequestContextCurrent(owner) && editing.value?.key === target.key && !isRequestContextAbort(cause)) {
			formError.value = failure(cause)
		}
	}
}
async function toggle(automation: Automation) {
	if (busy.value) return
	const owner = captureClientRequestContext()
	actionTarget.value = automation.id
	actionError.value = ''
	try {
		await save.mutateAsync({id: automation.id, expected_revision: automation.revision, body: {...automation, enabled: !automation.enabled}})
	} catch (cause) {
		if (!disposed && isClientRequestContextCurrent(owner) && !isRequestContextAbort(cause)) actionError.value = failure(cause)
	}
}
async function runNow(automation: Automation) {
	if (busy.value || running.value) return
	const owner = captureClientRequestContext()
	actionTarget.value = automation.id
	actionError.value = ''
	const requestID = requestIDs.get(automation.id) ?? crypto.randomUUID()
	requestIDs.set(automation.id, requestID)
	try {
		await run.mutateAsync({id: automation.id, request_id: requestID})
		if (!disposed && isClientRequestContextCurrent(owner)) {
			requestIDs.delete(automation.id)
			if (id.value === automation.id) runsPage.value = 1
		}
	} catch (cause) {
		// Keep the idempotency key on transport failure: a retry must not start a second side effect.
		if (!disposed && isClientRequestContextCurrent(owner) && !isRequestContextAbort(cause)) actionError.value = failure(cause)
	}
}
async function deleteAutomation() {
	const target = deleteTarget.value
	if (!target || busy.value) return
	const owner = captureClientRequestContext()
	actionTarget.value = target.id
	actionError.value = ''
	try {
		await remove.mutateAsync({id: target.id, expected_revision: target.revision})
		if (disposed || !isClientRequestContextCurrent(owner)) return
		if (deleteTarget.value?.id === target.id) deleteTarget.value = undefined
		if (id.value === target.id) await router.replace({name: 'automations'})
	} catch (cause) {
		if (!disposed && isClientRequestContextCurrent(owner) && !isRequestContextAbort(cause)) actionError.value = failure(cause)
	}
}
</script>

<template>
	<div
		class="automations-page"
		:class="{'has-selection': !!id}"
	>
		<PageHeader
			:title="t('automations.title')"
			:description="t('automations.description')"
		>
			<template #actions>
				<XButton
					icon="plus"
					:disabled="busy"
					@click="newAutomation()"
				>
					{{ t('automations.create') }}
				</XButton>
			</template>
		</PageHeader>
		<div
			v-if="!id"
			class="automations-templates"
			:aria-label="t('automations.templatesTitle')"
		>
			<button
				v-for="template in ['brief', 'review', 'reminder']"
				:key="template"
				type="button"
				:disabled="busy"
				@click="newAutomation(template)"
			>
				<Icon :icon="template === 'reminder' ? 'bell' : 'bolt'" /><span><strong>{{ t(`automations.templates.${template}.title`) }}</strong><small>{{ t(`automations.templates.${template}.description`) }}</small></span><Icon icon="plus" />
			</button>
		</div>
		<div class="automations-layout">
			<section
				class="automations-library"
				:aria-label="t('automations.saved')"
			>
				<div class="automations-section-title">
					<h2>{{ t('automations.saved') }}</h2><span v-if="library.data.value">{{ library.data.value.total }}</span>
				</div>
				<LoadError
					v-if="library.isError.value"
					:retry="() => library.refetch()"
				/>
				<p
					v-if="library.isPending.value"
					class="automations-status"
					role="status"
				>
					{{ t('automations.loading') }}
				</p>
				<EmptyState
					v-else-if="!library.isError.value && !library.data.value?.items.length"
					icon="bolt"
					:title="t('automations.empty')"
					:description="t('automations.emptyHint')"
				/>
				<RouterLink
					v-for="item in library.data.value?.items ?? []"
					:key="item.id"
					class="automation-row"
					:class="{'is-selected': item.id === id}"
					:to="{name: 'automations', params: {automationId: item.id}}"
				>
					<span class="automation-row__icon"><Icon :icon="item.kind === 'reminder' ? 'bell' : 'bolt'" /></span>
					<span class="automation-row__body"><strong>{{ item.title }}</strong><small>{{ scheduleDescription(item.schedule, item.timezone) }}</small><span class="automation-row__next">{{ item.enabled ? t('automations.nextRun', {time: automationTime(item.next_run, item.timezone)}) : t('automations.paused') }}</span></span>
					<span
						v-if="item.last_status === 'running'"
						class="automation-state"
					>{{ t('automations.status.running') }}</span>
				</RouterLink>
				<nav
					v-if="(library.data.value?.total_pages ?? 0) > 1"
					class="automations-pagination"
					:aria-label="t('automations.pages')"
				>
					<XButton
						variant="secondary"
						:disabled="page <= 1 || library.isFetching.value"
						@click="page--"
					>
						{{ t('misc.previous') }}
					</XButton><span>{{ page }} / {{ library.data.value?.total_pages }}</span><XButton
						variant="secondary"
						:disabled="page >= (library.data.value?.total_pages ?? 0) || library.isFetching.value"
						@click="page++"
					>
						{{ t('misc.next') }}
					</XButton>
				</nav>
			</section>
			<section
				v-if="id"
				class="automation-detail"
				:aria-label="t('automations.details')"
			>
				<RouterLink
					class="automation-detail__back"
					:to="{name: 'automations'}"
				>
					<Icon icon="arrow-left" /> {{ t('automations.back') }}
				</RouterLink>
				<LoadError
					v-if="detail.isError.value"
					:message="t('automations.detailFailed')"
					:retry="() => detail.refetch()"
				/>
				<p
					v-else-if="detail.isPending.value"
					role="status"
				>
					{{ t('automations.loading') }}
				</p>
				<template v-if="selected">
					<header class="automation-detail__header">
						<span class="automation-detail__kind"><Icon :icon="selected.kind === 'reminder' ? 'bell' : 'bolt'" /> {{ t(`automations.${selected.kind}`) }}</span><h2>{{ selected.title }}</h2><p>{{ scheduleDescription(selected.schedule, selected.timezone) }} · {{ selected.timezone }}</p><strong>{{ selected.enabled ? t('automations.nextRun', {time: automationTime(selected.next_run, selected.timezone)}) : t('automations.paused') }}</strong>
					</header>
					<div class="automation-detail__actions">
						<XButton
							icon="play"
							:disabled="busy || running"
							:loading="run.isPending.value && actionTarget === id"
							@click="runNow(selected)"
						>
							{{ t('automations.runNow') }}
						</XButton><XButton
							variant="secondary"
							:disabled="busy"
							@click="toggle(selected)"
						>
							{{ selected.enabled ? t('automations.pause') : t('automations.resume') }}
						</XButton><XButton
							variant="secondary"
							:disabled="busy"
							@click="editAutomation(selected)"
						>
							{{ t('menu.edit') }}
						</XButton><XButton
							variant="tertiary"
							:disabled="busy"
							@click="actionError = ''; deleteTarget = selected"
						>
							{{ t('misc.delete') }}
						</XButton>
					</div>
					<p
						v-if="actionError && actionTarget === id"
						class="automations-error"
						role="alert"
					>
						{{ actionError }}
					</p>
					<p class="automations-hint">
						{{ t('automations.pauseHint') }}
					</p>
					<details class="automation-instructions">
						<summary>{{ t('automations.savedInstructions') }}</summary><p>{{ selected.prompt }}</p><p
							v-if="selected.kind === 'agent'"
							class="automations-hint"
						>
							{{ t('automations.approvalSummary', {policy: t(`agent.${selected.options.approval === 'unattended' ? 'unattended' : selected.options.approval === 'auto' ? 'auto' : selected.options.approval === 'review' ? 'reviewAll' : 'smart'}`)}) }}
						</p>
					</details>
					<div class="automations-section-title">
						<h3>{{ t('automations.history') }}</h3><span>{{ t('automations.historyRetention') }}</span>
					</div>
					<LoadError
						v-if="history.isError.value"
						:retry="() => history.refetch()"
					/>
					<p
						v-if="history.isPending.value"
						role="status"
					>
						{{ t('automations.loadingHistory') }}
					</p>
					<EmptyState
						v-else-if="!history.isError.value && !history.data.value?.items.length"
						:title="t('automations.noRuns')"
						:description="t('automations.noRunsHint')"
					/>
					<article
						v-for="item in history.data.value?.items ?? []"
						:key="item.id"
						class="automation-run"
						:class="`is-${item.status}`"
					>
						<div class="automation-run__line">
							<strong>{{ t(`automations.status.${item.status}`) }}</strong><small>{{ t(`automations.triggers.${item.trigger}`) }}</small><time>{{ automationTime(item.started ?? item.scheduled_for, selected.timezone) }}</time>
						</div>
						<p
							v-if="item.error || item.error_code"
							class="automations-error"
						>
							{{ t(automationRunErrorKey(item.error_code)) }}<code v-if="item.error_code"> · {{ item.error_code }}</code>
						</p>
						<RouterLink
							v-if="item.error_code === 'CONVERSATION_LIMIT'"
							class="automation-run__link"
							:to="{name: 'user.settings.storage'}"
						>
							{{ t('storage.title') }} <Icon icon="arrow-right" />
						</RouterLink>
						<RouterLink
							v-if="item.conversation_id"
							class="automation-run__link"
							:to="{name: 'tcy-ai', query: {chat: item.conversation_id}}"
						>
							{{ item.status === 'running' ? t('automations.openRunning') : t('automations.openResult') }} <Icon icon="arrow-right" />
						</RouterLink>
						<p
							v-if="item.status !== 'running'"
							class="automations-hint automation-notification"
							:class="{'automations-error': item.notification_status === 'failed' || item.notification_status === 'unknown'}"
						>
							{{ t(automationNotificationKey(item.notification_status)) }}
						</p>
					</article>
					<nav
						v-if="(history.data.value?.total_pages ?? 0) > 1"
						class="automations-pagination"
						:aria-label="t('automations.historyPages')"
					>
						<XButton
							variant="secondary"
							:disabled="runsPage <= 1 || history.isFetching.value"
							@click="runsPage--"
						>
							{{ t('misc.previous') }}
						</XButton><span>{{ runsPage }} / {{ history.data.value?.total_pages }}</span><XButton
							variant="secondary"
							:disabled="runsPage >= (history.data.value?.total_pages ?? 0) || history.isFetching.value"
							@click="runsPage++"
						>
							{{ t('misc.next') }}
						</XButton>
					</nav>
				</template>
			</section>
			<aside
				v-else
				class="automations-about"
			>
				<Icon icon="clock" /><h2>{{ t('automations.backgroundTitle') }}</h2><p>{{ t('automations.backgroundHint') }}</p><p>{{ t('automations.notificationHint') }}</p><RouterLink :to="{name: 'user.settings.push'}">
					{{ t('automations.notificationSettings') }} <Icon icon="arrow-right" />
				</RouterLink>
			</aside>
		</div>
		<Modal
			v-if="editing"
			wide
			:title="t('automations.editorTitle')"
			:aria-label="t('automations.editorTitle')"
			@close="editing = undefined"
		>
			<Card
				:has-content="false"
				class="automation-editor-card"
			>
				<AutomationEditor
					:key="editing.key"
					:initial="editing.draft"
					:busy="busy"
					:error="formError"
					@save="saveDraft"
					@close="editing = undefined"
				/>
			</Card>
		</Modal>
		<Modal
			v-if="deleteTarget"
			danger
			:loading="remove.isPending.value"
			:confirm-label="t('misc.delete')"
			@close="deleteTarget = undefined"
			@submit="deleteAutomation"
		>
			<template #header>
				{{ t('automations.deleteTitle') }}
			</template><template #text>
				<p>{{ t('automations.deleteHint', {title: deleteTarget.title}) }}</p><p
					v-if="actionError"
					class="automations-error"
					role="alert"
				>
					{{ actionError }}
				</p>
			</template>
		</Modal>
	</div>
</template>

<style lang="scss" scoped>
.automation-editor-card {
	margin: 0;
	text-align: start;
}

.automations-page {
	max-inline-size: 94rem;
	margin-inline: auto;
}

.automations-templates {
	display: grid;
	grid-template-columns: repeat(3, minmax(0, 1fr));
	gap: var(--space-3);
	margin-block-end: var(--space-5);

	button {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		padding: var(--space-4);
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-lg);
		background: var(--surface);
		color: var(--text-primary);
		text-align: start;
		cursor: pointer;
		transition: border-color 150ms ease;

		&:hover, &:focus-visible {
			border-color: var(--primary);
		}
	}

	span {
		flex: 1;
		min-inline-size: 0;
	}

	strong, small {
		display: block;
	}

	small {
		margin-block-start: var(--space-1);
		color: var(--text-secondary);
		font-size: var(--text-sm);
	}
}

.automations-layout {
	display: grid;
	grid-template-columns: minmax(16rem, 0.75fr) minmax(0, 1.4fr);
	gap: var(--space-5);
	align-items: start;
}

.automations-library, .automation-detail, .automations-about {
	min-inline-size: 0;
	padding: var(--space-4);
	border: 1px solid var(--border-subtle);
	border-radius: var(--radius-lg);
	background: var(--surface);
}

.automations-section-title {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	justify-content: space-between;
	gap: var(--space-2);
	margin-block-end: var(--space-3);

	h2, h3 {
		margin: 0;
		font-size: var(--text-md);
	}

	span {
		color: var(--text-secondary);
		font-size: var(--text-xs);
	}
}

.automation-row {
	display: flex;
	align-items: flex-start;
	gap: var(--space-3);
	padding: var(--space-3);
	border: 1px solid transparent;
	border-radius: var(--radius-md);
	color: var(--text-primary);
	overflow-wrap: anywhere;

	& + & {
		margin-block-start: var(--space-2);
	}

	&:hover, &.is-selected {
		border-color: var(--border-default);
		background: var(--surface-sunken);
	}

	&__icon {
		display: grid;
		flex: 0 0 2rem;
		place-items: center;
		block-size: 2rem;
		border-radius: var(--radius-md);
		background: var(--tint-primary);
		color: var(--primary);
	}

	&__body {
		display: grid;
		flex: 1;
		gap: var(--space-1);
		min-inline-size: 0;
	}

	small, &__next {
		color: var(--text-secondary);
		font-size: var(--text-xs);
	}
}

.automation-detail {
	display: grid;
	gap: var(--space-4);

	&__header {
		display: grid;
		gap: var(--space-2);
		overflow-wrap: anywhere;

		h2 {
			margin: 0;
			font-size: var(--text-xl);
		}

		p, strong {
			font-size: var(--text-sm);
		}
	}

	&__kind {
		color: var(--text-secondary);
		font-size: var(--text-xs);
	}

	&__actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
	}

	&__back {
		display: none;
	}
}

.automation-instructions {
	padding: var(--space-3);
	border: 1px solid var(--border-subtle);
	border-radius: var(--radius-md);
	font-size: var(--text-sm);

	summary {
		cursor: pointer;
	}

	p {
		margin-block-start: var(--space-3);
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
}

.automation-run {
	padding: var(--space-3);
	border: 1px solid var(--border-subtle);
	border-inline-start: 3px solid var(--border-default);
	border-radius: var(--radius-md);

	&.is-running {
		border-inline-start-color: var(--primary);
	}

	&.is-failed, &.is-interrupted {
		border-inline-start-color: var(--danger);
	}

	&.is-succeeded {
		border-inline-start-color: var(--success);
	}

	&__line {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: var(--space-2) var(--space-3);
		font-size: var(--text-sm);

		time {
			margin-inline-start: auto;
			color: var(--text-secondary);
		}
	}

	&__link {
		display: inline-flex;
		align-items: center;
		gap: var(--space-2);
		min-block-size: 2.75rem;
		margin-block-start: var(--space-2);
		font-size: var(--text-sm);
	}
}

.automations-hint, .automations-status {
	color: var(--text-secondary);
	font-size: var(--text-sm);
	line-height: var(--leading-normal);
}

.automations-error {
	color: var(--danger-text);
	font-size: var(--text-sm);
	overflow-wrap: anywhere;
}

.automations-about {
	display: grid;
	gap: var(--space-3);
	padding: var(--space-5);
	color: var(--text-secondary);
	line-height: var(--leading-normal);

	h2 {
		margin: 0;
		color: var(--text-primary);
		font-size: var(--text-lg);
	}
}

.automations-pagination {
	display: flex;
	align-items: center;
	justify-content: center;
	gap: var(--space-2);
	margin-block-start: var(--space-4);
	font-size: var(--text-sm);
}

@media (max-width: $tablet) {
	.automations-templates, .automations-layout {
		grid-template-columns: minmax(0, 1fr);
	}

	.has-selection .automations-library {
		display: none;
	}

	.automation-detail__back {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		min-block-size: 2.75rem;
	}

	.automation-run__line time {
		flex-basis: 100%;
		margin-inline-start: 0;
	}
}

@media (prefers-reduced-motion: reduce) {
	.automations-templates button {
		transition: none;
	}
}
</style>
