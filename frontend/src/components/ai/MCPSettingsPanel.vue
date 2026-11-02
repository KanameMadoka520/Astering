<script setup lang="ts">
import {
	computed,
	nextTick,
	onBeforeUnmount,
	ref,
	watch,
} from 'vue'
import {useQuery} from '@tanstack/vue-query'
import {useI18n} from 'vue-i18n'
import {
	captureClientRequestContext,
	isClientRequestContextCurrent,
	isRequestContextAbort,
} from '@/client/requestContext'
import {
	mcpSettingsQuery,
	WALLOS_MCP_URL,
	normalizeMCPConnection,
	sameMCPDestination,
	useSaveMCPSettings,
	useTestMCPConnection,
	type MCPConnection,
	type MCPSettings,
	type MCPTestResult,
} from '@/client/queries/tcyMcp'
import LoadError from '@/components/misc/state/LoadError.vue'
import Modal from '@/components/misc/Modal.vue'
import MCPConnectionCard from './MCPConnectionCard.vue'

const props = defineProps<{active: boolean}>()
const emit = defineEmits<{dirty: [dirty: boolean]}>()
const {t} = useI18n({useScope: 'global'})
const settings = useQuery({...mcpSettingsQuery(), enabled: computed(() => props.active)})
const save = useSaveMCPSettings()
const test = useTestMCPConnection()
const baseline = ref<MCPSettings>()
const connections = ref<MCPConnection[]>([])
const errors = ref<Record<string, string>>({})
const savedStamps = ref<Record<string, string>>({})
const testErrors = ref<Record<string, string>>({})
type TestReceipt = {
	stamp: string
	result: MCPTestResult
}
const results = ref<Record<string, TestReceipt>>({})
const testing = ref('')
const testRequests = new Map<string, number>()
const testCredentials = new Map<string, number>()
const pendingRemove = ref<MCPConnection>()
const removeError = ref('')
const refreshError = ref('')
const owner = captureClientRequestContext()
let disposed = false
const current = () => !disposed && isClientRequestContextCurrent(owner)
const stamp = (connection: MCPConnection) => JSON.stringify(connection)
const dirty = computed(() => Boolean(baseline.value)
	&& JSON.stringify(connections.value) !== JSON.stringify(baseline.value?.connections))
const busy = computed(() => save.isPending.value)
const baselineConnection = (id: string) => baseline.value?.connections.find(connection => connection.id === id)
const cardDirty = (connection: MCPConnection) => stamp(connection) !== JSON.stringify(baselineConnection(connection.id))
// Permissions and labels do not change the remote catalog. Credentials and destinations do.
const testStamp = (connection: MCPConnection) => JSON.stringify({
	id: connection.id,
	url: connection.url,
	transport: connection.transport,
	credential_version: testCredentials.get(connection.id) ?? 0,
	saved_revision: baselineConnection(connection.id)?.revision ?? '',
})

watch(dirty, value => emit('dirty', value), {immediate: true})
watch(() => settings.data.value, value => {
	if (!value || !current() || dirty.value) return
	baseline.value = value
	connections.value = value.connections.map(normalizeMCPConnection)
}, {immediate: true})
onBeforeUnmount(() => {
	disposed = true
	testRequests.clear()
})

function update(connection: MCPConnection) {
	if (!current()) return
	const previous = connections.value.find(item => item.id === connection.id)
	if (previous && (!sameMCPDestination(previous, connection) || previous.api_key !== connection.api_key)) {
		testCredentials.set(connection.id, (testCredentials.get(connection.id) ?? 0) + 1)
	}
	connections.value = connections.value.map(previous => previous.id === connection.id ? connection : previous)
}
async function add(preset: 'wallos' | 'custom') {
	if (!current() || !baseline.value || busy.value || connections.value.length >= 20) return
	const connection = normalizeMCPConnection({
		id: crypto.randomUUID(),
		name: preset === 'wallos' ? 'Wallos' : '',
		url: preset === 'wallos' ? WALLOS_MCP_URL : '',
		preset,
	})
	connections.value = [...connections.value, connection]
	await nextTick()
	if (current()) document.getElementById(`mcp-name-${connection.id}`)?.focus()
}

function message(error: unknown) {
	return error instanceof Error ? error.message : t('settingsDraft.failed')
}
function mergeSaved(saved: MCPSettings, id: string, submitted: string) {
	const clean = saved.connections.find(connection => connection.id === id)
	connections.value = connections.value.map(connection => connection.id === id && clean && stamp(connection) === submitted
		? normalizeMCPConnection(clean)
		: connection)
	baseline.value = saved
	if (clean && stamp(connections.value.find(connection => connection.id === id)!) === stamp(clean)) {
		savedStamps.value[id] = stamp(clean)
	}
}

async function saveConnection(connection: MCPConnection) {
	if (!current() || !baseline.value || busy.value || !cardDirty(connection)) return
	const submitted = stamp(connection)
	const id = connection.id
	const previous = baselineConnection(id)
	if (previous?.has_key && !sameMCPDestination(previous, connection) && !connection.api_key) {
		errors.value[id] = t('tcy.mcp.destinationChanged')
		return
	}
	const payload: MCPSettings = {
		revision: baseline.value.revision,
		connections: baseline.value.connections.map(normalizeMCPConnection),
	}
	const index = payload.connections.findIndex(item => item.id === id)
	if (index < 0) payload.connections.push({...connection, read_tools: [...connection.read_tools]})
	else payload.connections[index] = {...connection, read_tools: [...connection.read_tools]}
	errors.value[id] = ''
	delete savedStamps.value[id]
	try {
		const saved = await save.mutateAsync(payload)
		if (current()) mergeSaved(saved, id, submitted)
	} catch (error) {
		if (current() && !isRequestContextAbort(error)) errors.value[id] = message(error)
	}
}

function discard(connection: MCPConnection) {
	if (!current() || busy.value) return
	const saved = baselineConnection(connection.id)
	connections.value = saved
		? connections.value.map(item => item.id === connection.id ? normalizeMCPConnection(saved) : item)
		: connections.value.filter(item => item.id !== connection.id)
	delete errors.value[connection.id]
	void nextTick(() => document.getElementById(`mcp-name-${connection.id}`)?.focus())
}
function requestRemove(connection: MCPConnection) {
	if (!current() || busy.value) return
	if (!baselineConnection(connection.id)) {
		discard(connection)
		return
	}
	pendingRemove.value = connection
	removeError.value = ''
}
async function remove() {
	const target = pendingRemove.value
	if (!target || !baseline.value || !current() || busy.value) return
	const payload: MCPSettings = {
		revision: baseline.value.revision,
		connections: baseline.value.connections.filter(connection => connection.id !== target.id),
	}
	try {
		const saved = await save.mutateAsync(payload)
		if (!current()) return
		baseline.value = saved
		connections.value = connections.value.filter(connection => connection.id !== target.id)
		if (pendingRemove.value === target) pendingRemove.value = undefined
	} catch (error) {
		if (current() && !isRequestContextAbort(error) && pendingRemove.value === target) removeError.value = message(error)
	}
}
async function refreshSaved() {
	if (!current() || busy.value || settings.isFetching.value) return
	const previous = baseline.value
	refreshError.value = ''
	const result = await settings.refetch()
	if (!current()) return
	if (!result.data || result.isError) {
		refreshError.value = t('tcy.mcp.loadFailed')
		return
	}
	const changed = new Map(connections.value.filter(connection =>
		stamp(connection) !== JSON.stringify(previous?.connections.find(saved => saved.id === connection.id)))
		.map(connection => [connection.id, connection]))
	connections.value = [
		...result.data.connections.map(connection => changed.get(connection.id) ?? normalizeMCPConnection(connection)),
		...[...changed.values()].filter(connection => !result.data!.connections.some(saved => saved.id === connection.id)),
	]
	baseline.value = result.data
}
async function testConnection(connection: MCPConnection) {
	if (!current() || busy.value || testing.value) return
	const saved = baselineConnection(connection.id)
	if (!connection.api_key && !(saved?.has_key && sameMCPDestination(saved, connection))) {
		testErrors.value[connection.id] = t('tcy.mcp.keyRequiredForTest')
		return
	}
	const submitted = testStamp(connection)
	const request = (testRequests.get(connection.id) ?? 0) + 1
	testRequests.set(connection.id, request)
	testing.value = connection.id
	testErrors.value[connection.id] = ''
	try {
		const result = await test.mutateAsync(connection)
		const draft = connections.value.find(item => item.id === connection.id)
		if (!current() || testRequests.get(connection.id) !== request
			|| !draft || testStamp(draft) !== submitted) return
		results.value[connection.id] = {
			stamp: submitted,
			result,
		}
	} catch (error) {
		const draft = connections.value.find(item => item.id === connection.id)
		if (current() && testRequests.get(connection.id) === request && draft
			&& testStamp(draft) === submitted && !isRequestContextAbort(error)) {
			testErrors.value[connection.id] = message(error)
		}
	} finally {
		if (current() && testing.value === connection.id) testing.value = ''
	}
}
function testResult(connection: MCPConnection) {
	const result = results.value[connection.id]
	return result?.stamp === testStamp(connection) ? result.result : undefined
}
</script>

<template>
	<section
		class="mcp-settings"
		:aria-label="t('tcy.mcp.settingsTitle')"
	>
		<header>
			<h2>{{ t('tcy.mcp.settingsTitle') }}</h2>
			<p>{{ t('tcy.mcp.intro') }}</p>
			<RouterLink :to="{name: 'user.settings.mcp'}">
				{{ t('tcy.mcp.inboundLink') }}
			</RouterLink>
		</header>
		<LoadError
			v-if="settings.isError.value && !baseline"
			:message="t('tcy.mcp.loadFailed')"
			:retry="() => settings.refetch()"
		/>
		<p
			v-else-if="!baseline"
			role="status"
		>
			{{ t('tcy.mcp.loading') }}
		</p>
		<template v-else>
			<div class="mcp-settings__add">
				<XButton
					type="button"
					variant="secondary"
					:aria-disabled="busy || connections.length >= 20"
					@click="add('wallos')"
				>
					{{ t('tcy.mcp.addWallos') }}
				</XButton>
				<XButton
					type="button"
					variant="secondary"
					icon="plus"
					:aria-disabled="busy || connections.length >= 20"
					@click="add('custom')"
				>
					{{ t('tcy.mcp.addCustom') }}
				</XButton>
			</div>
			<p v-if="connections.length >= 20">
				{{ t('tcy.mcp.connectionLimit') }}
			</p>
			<p v-if="!connections.length">
				{{ t('tcy.mcp.empty') }}
			</p>
			<MCPConnectionCard
				v-for="connection in connections"
				:key="connection.id"
				:connection="connection"
				:saved="baselineConnection(connection.id)"
				:dirty="cardDirty(connection)"
				:busy="busy"
				:testing="testing === connection.id"
				:test-blocked="Boolean(testing && testing !== connection.id)"
				:error="errors[connection.id]"
				:test-error="testErrors[connection.id]"
				:test-result="testResult(connection)"
				:saved-notice="savedStamps[connection.id] === stamp(connection)"
				@update:connection="update"
				@save="saveConnection(connection)"
				@test="testConnection(connection)"
				@discard="discard(connection)"
				@remove="requestRemove(connection)"
			/>
			<div class="mcp-settings__refresh">
				<XButton
					type="button"
					variant="tertiary"
					:aria-disabled="busy || settings.isFetching.value"
					@click="refreshSaved"
				>
					{{ t('tcy.mcp.refreshSaved') }}
				</XButton>
				<p>{{ t('tcy.mcp.refreshHelp') }}</p>
				<p
					v-if="refreshError"
					role="alert"
				>
					{{ refreshError }}
				</p>
			</div>
		</template>
		<Modal
			danger
			:enabled="Boolean(pendingRemove)"
			:confirm-label="t('tcy.mcp.deleteConnection')"
			@close="pendingRemove = undefined"
			@submit="remove"
		>
			<template #header>
				{{ t('tcy.mcp.deleteConnection') }}
			</template>
			<template #text>
				<p>{{ t('tcy.mcp.deleteConfirm', {name: pendingRemove?.name}) }}</p>
				<p
					v-if="removeError"
					role="alert"
				>
					{{ removeError }}
				</p>
			</template>
		</Modal>
	</section>
</template>

<style scoped lang="scss">
.mcp-settings {
	display: grid;
	gap: var(--space-5);
	min-inline-size: 0;

	header {
		display: grid;
		gap: var(--space-2);
	}

	h2,
	p { margin: 0; }

	header p,
	.mcp-settings__refresh p {
		color: var(--text-secondary);
		font-size: var(--text-sm);
		line-height: var(--leading-normal);
	}
}

.mcp-settings__add {
	display: flex;
	flex-wrap: wrap;
	gap: var(--space-3);

	> * { min-block-size: 44px; }
}

.mcp-settings__refresh {
	display: grid;
	justify-items: start;
	gap: var(--space-2);
}
</style>
