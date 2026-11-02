<script setup lang="ts">
import {computed, useId} from 'vue'
import {useI18n} from 'vue-i18n'
import type {
	MCPConnection,
	MCPTestResult,
} from '@/client/queries/tcyMcp'
import {sameMCPDestination, WALLOS_MCP_URL} from '@/client/queries/tcyMcp'

const props = defineProps<{
	connection: MCPConnection
	saved?: MCPConnection
	dirty: boolean
	busy: boolean
	testing: boolean
	testBlocked?: boolean
	error?: string
	testError?: string
	testResult?: MCPTestResult
	savedNotice?: boolean
}>()
const emit = defineEmits<{
	'update:connection': [connection: MCPConnection]
	save: []
	test: []
	remove: []
	discard: []
}>()
const {t} = useI18n({useScope: 'global'})
const prefix = useId()
const builtInPolicy = computed(() => props.connection.preset === 'wallos' && props.connection.url === WALLOS_MCP_URL)
const savedKey = computed(() => Boolean(props.saved?.has_key
	&& sameMCPDestination(props.saved, props.connection)))
const changedDestination = computed(() => Boolean(props.saved?.has_key
	&& !sameMCPDestination(props.saved, props.connection)))
const missingFromCatalog = computed(() => props.connection.read_tools
	.filter(name => !props.testResult?.tools.some(tool => tool.name === name)))

function update(patch: Partial<MCPConnection>) {
	emit('update:connection', {...props.connection, ...patch})
}
function checked(event: Event) {
	return (event.target as HTMLInputElement).checked
}
function trustTool(name: string, trusted: boolean) {
	update({read_tools: trusted
		? [...new Set([...props.connection.read_tools, name])]
		: props.connection.read_tools.filter(tool => tool !== name)})
}
</script>

<template>
	<form
		class="mcp-connection-card"
		:data-mcp-id="connection.id"
		:aria-labelledby="`${prefix}-title`"
		@submit.prevent="!busy && emit('save')"
	>
		<header class="mcp-connection-card__header">
			<div>
				<h3 :id="`${prefix}-title`">
					{{ connection.name || t('tcy.mcp.newConnection') }}
				</h3>
				<p class="mcp-connection-card__hint">
					{{ t(dirty ? 'settingsDraft.unsaved' : connection.enabled ? 'tcy.mcp.enabled' : 'tcy.mcp.disabled') }}
				</p>
			</div>
			<label class="mcp-connection-card__check">
				<input
					type="checkbox"
					:checked="connection.enabled"
					@change="update({enabled: checked($event)})"
				>
				{{ t('tcy.mcp.enableConnection') }}
			</label>
		</header>
		<div class="mcp-connection-card__fields">
			<label>
				<span>{{ t('tcy.mcp.name') }}</span>
				<input
					:id="`mcp-name-${connection.id}`"
					class="input"
					:value="connection.name"
					:aria-label="t('tcy.mcp.name')"
					maxlength="100"
					required
					@input="update({name: ($event.target as HTMLInputElement).value})"
				>
			</label>
			<label>
				<span>{{ t('tcy.mcp.transport') }}</span>
				<select
					class="input"
					:value="connection.transport"
					:aria-label="t('tcy.mcp.transport')"
					@change="update({transport: ($event.target as HTMLSelectElement).value as MCPConnection['transport']})"
				>
					<option value="streamable_http">Streamable HTTP</option>
					<option value="sse">SSE</option>
				</select>
			</label>
			<label class="mcp-connection-card__full">
				<span>{{ t('tcy.mcp.endpoint') }}</span>
				<input
					class="input"
					type="url"
					maxlength="2048"
					:value="connection.url"
					:aria-label="t('tcy.mcp.endpoint')"
					:aria-describedby="`${prefix}-endpoint-help`"
					autocomplete="off"
					required
					@input="update({url: ($event.target as HTMLInputElement).value})"
				>
				<small :id="`${prefix}-endpoint-help`">{{ t('tcy.mcp.endpointHelp') }}</small>
			</label>
			<label class="mcp-connection-card__full">
				<span>{{ t('tcy.mcp.apiKey') }}</span>
				<input
					class="input"
					type="password"
					maxlength="8192"
					:value="connection.api_key"
					:aria-label="t('tcy.mcp.apiKey')"
					:placeholder="t(savedKey ? 'tcy.mcp.keySaved' : 'tcy.mcp.keyPlaceholder')"
					:aria-describedby="`${prefix}-key-help`"
					autocomplete="new-password"
					@input="update({api_key: ($event.target as HTMLInputElement).value})"
				>
				<small :id="`${prefix}-key-help`">{{ t('tcy.mcp.keyHelp') }}</small>
			</label>
		</div>
		<p
			v-if="changedDestination && !connection.api_key"
			class="mcp-connection-card__warning"
			role="status"
		>
			{{ t('tcy.mcp.destinationChanged') }}
		</p>
		<p
			v-if="builtInPolicy"
			class="mcp-connection-card__hint"
		>
			{{ t('tcy.mcp.wallosKeyHelp') }}
			<a
				href="https://wallos.tcymc.space/agent.php"
				target="_blank"
				rel="noopener noreferrer"
			>{{ t('tcy.mcp.createWallosKey') }}</a>
		</p>
		<fieldset class="mcp-connection-card__permissions">
			<legend>{{ t('tcy.mcp.permissions') }}</legend>
			<label class="mcp-connection-card__check">
				<input
					type="checkbox"
					:checked="connection.allow_write"
					@change="update({allow_write: checked($event), allow_delete: checked($event) && connection.allow_delete})"
				>
				{{ t('tcy.mcp.allowWrite') }}
			</label>
			<label class="mcp-connection-card__check">
				<input
					type="checkbox"
					:checked="connection.allow_delete"
					:aria-disabled="!connection.allow_write"
					@click="!connection.allow_write && $event.preventDefault()"
					@change="connection.allow_write && update({allow_delete: checked($event)})"
				>
				{{ t('tcy.mcp.allowDelete') }}
			</label>
			<p class="mcp-connection-card__hint">
				{{ t('tcy.mcp.permissionsHelp') }}
			</p>
		</fieldset>
		<details class="mcp-connection-card__catalog">
			<summary>{{ t('tcy.mcp.toolPermissions') }}</summary>
			<p class="mcp-connection-card__hint">
				{{ t(builtInPolicy ? 'tcy.mcp.wallosTrustHelp' : 'tcy.mcp.readTrustHelp') }}
			</p>
			<template v-if="testResult">
				<p class="mcp-connection-card__hint">
					{{ t('tcy.mcp.testPassed', {count: testResult.tools.length}) }}
					{{ testResult.server_name }} {{ testResult.server_version }}
				</p>
				<ul class="mcp-tool-list">
					<li
						v-for="tool in testResult.tools"
						:key="tool.name"
					>
						<label
							v-if="!builtInPolicy"
							class="mcp-connection-card__check"
						>
							<input
								type="checkbox"
								:checked="connection.read_tools.includes(tool.name)"
								:aria-label="t('tcy.mcp.trustTool', {name: tool.name})"
								@change="trustTool(tool.name, checked($event))"
							>
							<code>{{ tool.name }}</code>
						</label>
						<code v-if="builtInPolicy">{{ tool.name }}</code>
						<p>{{ tool.description }}</p>
						<small>
							{{ t(tool.destructive ? 'tcy.mcp.declaredDestructive' : tool.read_only
								? 'tcy.mcp.declaredReadOnly' : 'tcy.mcp.declaredWrite') }}
						</small>
					</li>
				</ul>
				<p
					v-if="testResult.more_available"
					class="mcp-connection-card__hint"
				>
					{{ t('tcy.mcp.catalogTruncated') }}
				</p>
			</template>
			<p
				v-else
				class="mcp-connection-card__hint"
			>
				{{ t('tcy.mcp.testToList') }}
			</p>
			<label v-if="!builtInPolicy">
				<span>{{ t('tcy.mcp.readTools') }}</span>
				<textarea
					class="textarea"
					:value="connection.read_tools.join('\n')"
					:aria-label="t('tcy.mcp.readTools')"
					rows="3"
					@input="update({read_tools: [...new Set(($event.target as HTMLTextAreaElement).value.split('\n').map(name => name.trim()).filter(Boolean))]})"
				/>
			</label>
			<p
				v-if="!builtInPolicy && testResult && missingFromCatalog.length"
				class="mcp-connection-card__hint"
			>
				{{ t('tcy.mcp.missingToolsRetained', {count: missingFromCatalog.length}) }}
			</p>
		</details>
		<p
			v-if="error"
			class="mcp-connection-card__warning"
			role="alert"
		>
			{{ error }}
		</p>
		<p
			v-if="testError"
			class="mcp-connection-card__warning"
			role="alert"
		>
			{{ testError }}
		</p>
		<p
			v-else-if="testResult"
			role="status"
		>
			{{ t('tcy.mcp.testPassed', {count: testResult.tools.length}) }}
		</p>
		<p
			v-if="savedNotice"
			role="status"
		>
			{{ t('tcy.mcp.saved') }}
		</p>
		<div class="mcp-connection-card__actions">
			<XButton
				type="submit"
				:aria-disabled="busy || !dirty"
				@click="!dirty && $event.preventDefault()"
			>
				{{ t('tcy.mcp.saveConnection') }}
			</XButton>
			<XButton
				type="button"
				variant="secondary"
				:aria-disabled="testing || testBlocked || busy || !connection.url"
				@click="!testing && !testBlocked && !busy && connection.url && emit('test')"
			>
				{{ t(testing ? 'tcy.mcp.testing' : 'tcy.mcp.testConnection') }}
			</XButton>
			<XButton
				type="button"
				variant="tertiary"
				:aria-disabled="busy || !dirty"
				@click="!busy && dirty && emit('discard')"
			>
				{{ t('tcy.mcp.discardConnection') }}
			</XButton>
			<XButton
				type="button"
				variant="tertiary"
				danger
				:aria-disabled="busy"
				@click="!busy && emit('remove')"
			>
				{{ t('misc.delete') }}
			</XButton>
		</div>
		<p class="mcp-connection-card__hint">
			{{ t('tcy.mcp.testHelp') }}
		</p>
	</form>
</template>

<style scoped lang="scss">
.mcp-connection-card {
	display: grid;
	gap: var(--space-4);
	min-inline-size: 0;
	padding: var(--space-4);
	border: 1px solid var(--border-default);
	border-radius: var(--radius-lg);
	background: var(--surface);
	overflow-wrap: anywhere;

	h3,
	p { margin: 0; }

	label {
		display: grid;
		gap: var(--space-2);
		min-inline-size: 0;
	}
}

.mcp-connection-card__header,
.mcp-connection-card__actions {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	justify-content: space-between;
	gap: var(--space-3);
}

.mcp-connection-card__fields {
	display: grid;
	grid-template-columns: repeat(2, minmax(0, 1fr));
	gap: var(--space-4);

	@media (width <= 640px) { grid-template-columns: minmax(0, 1fr); }
}

.mcp-connection-card__full { grid-column: 1 / -1; }

.mcp-connection-card .mcp-connection-card__check {
	display: flex;
	align-items: center;
	gap: var(--space-2);
	min-block-size: 44px;
	cursor: pointer;

	input { flex-shrink: 0; }
}

.mcp-connection-card__permissions,
.mcp-connection-card__catalog {
	display: grid;
	gap: var(--space-2);
	min-inline-size: 0;
	padding: var(--space-3);
	border: 1px solid var(--border-subtle);
	border-radius: var(--radius-md);
}

.mcp-connection-card__catalog summary {
	padding-block: var(--space-2);
	cursor: pointer;
}

.mcp-connection-card__hint,
.mcp-connection-card small {
	color: var(--text-secondary);
	font-size: var(--text-sm);
	line-height: var(--leading-normal);
}

.mcp-connection-card__warning { color: var(--danger); }

.mcp-connection-card__actions {
	justify-content: flex-start;

	> * { min-block-size: 44px; }
}

.mcp-tool-list {
	display: grid;
	gap: var(--space-3);
	max-block-size: 22rem;
	margin: 0;
	padding: 0;
	list-style: none;
	overflow-y: auto;

	li { min-inline-size: 0; }
}
</style>
