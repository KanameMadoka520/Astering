<script setup lang="ts">
import {computed, nextTick, ref, watch} from 'vue'
import {useDebounceFn} from '@vueuse/core'
import {useQuery} from '@tanstack/vue-query'
import {useI18n} from 'vue-i18n'
import {currentSiteUsageData, siteUsageAccessQuery, siteUsageUsersQuery} from '@/client/queries/siteUsage'
import {captureClientRequestContext, isClientRequestContextCurrent} from '@/client/requestContext'
import type {SystemUsageUsersData} from '@/client/generated'
import {useTitle} from '@/composables/useTitle'
import PageHeader from '@/components/misc/state/PageHeader.vue'
import Message from '@/components/misc/Message.vue'
import XButton from '@/components/input/Button.vue'
import {useAuthStore} from '@/stores/auth'

const {t, locale} = useI18n({useScope: 'global'})
useTitle(() => t('siteUsage.title'))
const authStore = useAuthStore()
const scope = computed(() => ({
	identity: authStore.identityKey,
	human: authStore.authUser,
	context: captureClientRequestContext(),
}))
const access = useQuery(computed(() => ({
	...siteUsageAccessQuery(scope.value.context),
	enabled: scope.value.human && Boolean(scope.value.identity),
})))
const canFilter = computed(() => scope.value.human && !access.isError.value
	&& currentSiteUsageData(access.data.value)?.can_view_usage === true)
const allowed = computed(() => canFilter.value && !access.isFetching.value)
const page = ref(1)
const search = ref('')
const queryText = ref('')
const status = ref<NonNullable<SystemUsageUsersData['query']>['status']>('all')
const role = ref<NonNullable<SystemUsageUsersData['query']>['role']>('all')
const anomaly = ref<NonNullable<SystemUsageUsersData['query']>['anomaly']>('all')
const sortBy = ref<NonNullable<SystemUsageUsersData['query']>['sort_by']>('projects_owned')
const orderBy = ref<'asc' | 'desc'>('desc')
const applySearch = useDebounceFn(() => { queryText.value = search.value.trim() }, 300)
watch(search, applySearch)
watch([queryText, status, role, anomaly, sortBy, orderBy], () => { page.value = 1 })
const usage = useQuery(computed(() => ({
	...siteUsageUsersQuery({
		page: page.value,
		per_page: 25,
		q: queryText.value,
		status: status.value,
		role: role.value,
		anomaly: anomaly.value,
		sort_by: sortBy.value,
		order_by: orderBy.value,
	}, scope.value.context),
	enabled: allowed.value,
})))
// Every selected key must complete a fresh read, including a formerly cached key.
const result = computed(() => allowed.value && !usage.isError.value && !usage.isFetching.value
	? currentSiteUsageData(usage.data.value) : undefined)
const overview = computed(() => result.value?.overview)
const busy = computed(() => access.isFetching.value || usage.isFetching.value)
const statuses = ['all', 'active', 'email_confirmation_required', 'disabled', 'account_locked'] as const
const roles = ['all', 'human', 'bot', 'instance_admin', 'usage_admin'] as const
const sorts = ['projects_owned', 'projects_created_24h', 'projects_created_7d', 'tasks_owned', 'tasks_created', 'file_bytes', 'ai_bytes', 'username', 'created', 'id'] as const
const details = ['projects_archived', 'projects_created_24h', 'projects_created_7d', 'tasks_created', 'files_uploaded', 'file_bytes', 'drive_files', 'drive_file_bytes', 'drive_trashed_files', 'drive_trashed_bytes', 'compass_spaces_owned', 'compass_entries_owned', 'ai_conversations', 'ai_conversation_bytes', 'ai_attachment_bytes', 'ai_settings_bytes'] as const
function number(value: number) { return new Intl.NumberFormat(locale.value).format(value) }
function bytes(value: number) {
	if (!value) return '0 B'
	const index = Math.min(4, Math.floor(Math.log(value) / Math.log(1024)))
	return `${new Intl.NumberFormat(locale.value, {maximumFractionDigits: 1}).format(value / 1024 ** index)} ${['B', 'KiB', 'MiB', 'GiB', 'TiB'][index]}`
}
function date(value: string) { return new Intl.DateTimeFormat(locale.value, {dateStyle: 'medium', timeStyle: 'short'}).format(new Date(value)) }
async function refresh() {
	if (busy.value) return
	const context = scope.value.context
	const fresh = await access.refetch()
	await nextTick()
	if (!isClientRequestContextCurrent(context) || fresh.isError
		|| !currentSiteUsageData(fresh.data)?.can_view_usage || usage.isFetching.value) return
	await usage.refetch()
}
function changePage(delta: number) {
	if (busy.value || !result.value) return
	const target = page.value + delta
	if (target < 1 || target > result.value.total_pages) return
	page.value = target
}
</script>

<template>
	<div class="usage-page">
		<PageHeader
			:title="t('siteUsage.title')"
			:description="t('siteUsage.intro')"
		>
			<template #actions>
				<XButton
					variant="secondary"
					:shadow="false"
					:aria-disabled="busy"
					@click="refresh"
				>
					{{ t('siteUsage.refresh') }}
				</XButton>
			</template>
		</PageHeader>
		<p class="usage-boundary">
			{{ t('siteUsage.boundary') }}
		</p>
		<form
			v-if="canFilter"
			class="usage-filters"
			@submit.prevent
		>
			<label class="usage-search"><span>{{ t('siteUsage.search') }}</span><input
				v-model="search"
				class="input"
				type="search"
				maxlength="250"
				:placeholder="t('siteUsage.searchPlaceholder')"
			></label>
			<label><span>{{ t('siteUsage.status') }}</span><select v-model="status"><option
				v-for="value in statuses"
				:key="value"
				:value="value"
			>{{ t(`siteUsage.statuses.${value}`) }}</option></select></label>
			<label><span>{{ t('siteUsage.role') }}</span><select v-model="role"><option
				v-for="value in roles"
				:key="value"
				:value="value"
			>{{ t(`siteUsage.roles.${value}`) }}</option></select></label>
			<label><span>{{ t('siteUsage.volume') }}</span><select v-model="anomaly"><option value="all">{{ t('siteUsage.all') }}</option><option value="flagged">{{ t('siteUsage.flaggedOnly') }}</option></select></label>
			<label><span>{{ t('siteUsage.sort') }}</span><select v-model="sortBy"><option
				v-for="value in sorts"
				:key="value"
				:value="value"
			>{{ t(`siteUsage.counts.${value}`) }}</option></select></label>
			<label><span>{{ t('siteUsage.order') }}</span><select v-model="orderBy"><option value="desc">{{ t('siteUsage.desc') }}</option><option value="asc">{{ t('siteUsage.asc') }}</option></select></label>
		</form>
		<p
			v-if="access.isPending.value || access.isFetching.value || (allowed && (usage.isPending.value || usage.isFetching.value))"
			role="status"
		>
			{{ t('siteUsage.loading') }}
		</p>
		<Message
			v-else-if="access.isError.value || (allowed && usage.isError.value)"
			variant="danger"
		>
			{{ t('siteUsage.loadFailed') }}
		</Message>
		<Message
			v-else-if="!allowed"
			variant="danger"
		>
			{{ t('siteUsage.forbidden') }}
		</Message>
		<template v-else-if="result && overview">
			<div
				class="usage-overview"
				data-testid="usage-overview"
			>
				<div><span>{{ t('siteUsage.accounts') }}</span><strong>{{ number(overview.users) }}</strong><small>{{ t('siteUsage.activeCount', {count: number(overview.active_users)}) }}</small></div>
				<div><span>{{ t('siteUsage.counts.projects_owned') }}</span><strong>{{ number(overview.projects_owned) }}</strong><small>{{ t('siteUsage.counts.tasks_owned') }} · {{ number(overview.tasks_owned) }}</small></div>
				<div><span>{{ t('siteUsage.storage') }}</span><strong>{{ overview.snapshot_complete ? '' : '≥ ' }}{{ bytes(overview.total_storage_bytes) }}</strong><small>{{ t(overview.snapshot_complete ? 'siteUsage.measured' : 'siteUsage.incomplete') }}</small></div>
				<div><span>{{ t('siteUsage.flagged') }}</span><strong>{{ number(overview.flagged_users) }}</strong><small>{{ t('siteUsage.flagHint') }}</small></div>
			</div>
			<p
				class="usage-snapshot"
				role="status"
			>
				{{ t('siteUsage.asOf', {time: date(result.as_of)}) }} · {{ t('siteUsage.snapshotHint') }} <span v-if="usage.isFetching.value">· {{ t('siteUsage.refreshing') }}</span>
			</p>
			<p
				v-if="!result.items?.length"
				class="usage-empty"
			>
				{{ t('siteUsage.noMatches') }}
			</p>
			<ul
				v-else
				class="usage-users"
				:aria-label="t('siteUsage.accounts')"
				:aria-busy="usage.isFetching.value"
			>
				<li
					v-for="account in result.items ?? []"
					:key="account.id"
					class="usage-account"
					data-testid="usage-account"
				>
					<div class="usage-account-head">
						<div class="usage-identity">
							<strong>{{ account.name || account.username }}</strong><span>{{ account.username }} · #{{ account.id }}</span>
						</div>
						<div class="usage-badges">
							<span>{{ t(`siteUsage.statuses.${['active', 'email_confirmation_required', 'disabled', 'account_locked'][account.status] || 'unknown'}`) }}</span><span>{{ t(account.is_bot ? 'siteUsage.roles.bot' : 'siteUsage.roles.human') }}</span><span v-if="account.is_usage_admin">{{ t('siteUsage.roles.usage_admin') }}</span><span v-if="account.is_instance_admin">{{ t('siteUsage.roles.instance_admin') }}</span><span v-if="account.deletion_scheduled">{{ t('siteUsage.deletionScheduled') }}</span>
						</div>
					</div>
					<div
						v-if="account.anomalies?.length"
						class="usage-flags"
					>
						<span
							v-for="flag in account.anomalies ?? []"
							:key="flag"
						>{{ t(`siteUsage.anomalies.${flag}`) }}</span>
					</div>
					<dl class="usage-primary">
						<div><dt>{{ t('siteUsage.counts.projects_owned') }}</dt><dd>{{ number(account.projects_owned) }}</dd></div>
						<div><dt>{{ t('siteUsage.counts.tasks_owned') }}</dt><dd>{{ number(account.tasks_owned) }}</dd></div>
						<div><dt>{{ t('siteUsage.storage') }}</dt><dd>{{ account.ai_scan_complete ? '' : '≥ ' }}{{ bytes(account.total_storage_bytes) }}<small v-if="!account.ai_scan_complete">{{ t('siteUsage.incomplete') }}</small></dd></div>
						<div><dt>{{ t('siteUsage.counts.ai_bytes') }}</dt><dd>{{ account.ai_scan_complete ? '' : '≥ ' }}{{ bytes(account.ai_bytes) }}</dd></div>
					</dl>
					<details class="usage-details">
						<summary>{{ t('siteUsage.details') }}</summary>
						<dl>
							<div
								v-for="key in details"
								:key="key"
							>
								<dt>{{ t(`siteUsage.counts.${key}`) }}</dt><dd>{{ key.startsWith('ai_') && !account.ai_scan_complete ? '≥ ' : '' }}{{ key.endsWith('bytes') ? bytes(account[key]) : number(account[key]) }}</dd>
							</div><div><dt>{{ t('siteUsage.counts.created') }}</dt><dd>{{ date(account.created) }}</dd></div>
						</dl>
					</details>
				</li>
			</ul>
			<details class="usage-notes">
				<summary>{{ t('siteUsage.definitions') }}</summary><p
					v-for="key in ['ownership', 'storage', 'ai', 'thresholds', 'roles', 'scope']"
					:key="key"
				>
					{{ t(`siteUsage.notes.${key}`) }}
				</p>
			</details>
		</template>
		<nav
			v-if="canFilter"
			class="usage-pagination"
			:aria-label="t('siteUsage.pagination')"
		>
			<XButton
				variant="secondary"
				:shadow="false"
				:aria-disabled="!result || page <= 1 || busy"
				@click="changePage(-1)"
			>
				{{ t('siteUsage.previous') }}
			</XButton>
			<span v-if="result">{{ t('siteUsage.page', {page: result.page, total: Math.max(1, result.total_pages), count: result.total}) }}</span><span v-else-if="busy">{{ t('siteUsage.refreshing') }}</span>
			<XButton
				variant="secondary"
				:shadow="false"
				:aria-disabled="!result || page >= result.total_pages || busy"
				@click="changePage(1)"
			>
				{{ t('siteUsage.next') }}
			</XButton>
		</nav>
	</div>
</template>

<style scoped lang="scss">
.usage-page {
	max-inline-size: 88rem;
	margin-inline: auto;
}
.usage-page :deep(.button) {
	min-block-size: 2.75rem;
}
.usage-boundary, .usage-snapshot {
	color: var(--text-secondary);
	font-size: .875rem;
	line-height: 1.6;
	margin-block: 1rem;
}
.usage-overview {
	display: grid;
	grid-template-columns: repeat(4, minmax(0, 1fr));
	gap: .75rem;
}
.usage-overview > div {
	display: flex;
	flex-direction: column;
	gap: .4rem;
	padding: 1rem;
	border: 1px solid var(--border-subtle);
	border-radius: .75rem;
	background: var(--surface-raised);
}
.usage-overview strong {
	font-size: 1.6rem;
	font-variant-numeric: tabular-nums;
}
.usage-overview small {
	color: var(--text-secondary);
}
.usage-filters {
	display: flex;
	flex-wrap: wrap;
	align-items: end;
	gap: .75rem;
	margin-block: 1rem;
}
.usage-filters label {
	display: flex;
	flex: 1 1 8rem;
	flex-direction: column;
	gap: .4rem;
	min-inline-size: 0;
	font-size: .875rem;
}
.usage-filters .usage-search {
	flex-grow: 2;
	flex-basis: 13rem;
}
.usage-filters select {
	min-inline-size: 0;
	inline-size: 100%;
	block-size: 2.5rem;
	padding: .4rem;
	color: var(--text-primary);
	background: var(--surface-raised);
	border: 1px solid var(--border-subtle);
	border-radius: .4rem;
}
.usage-users {
	list-style: none;
	margin: 0;
	padding: 0;
	display: grid;
	gap: .75rem;
}
.usage-account {
	padding: 1rem;
	border: 1px solid var(--border-subtle);
	border-radius: .75rem;
	background: var(--surface-raised);
}
.usage-account-head {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	justify-content: space-between;
	gap: .75rem;
}
.usage-identity {
	display: flex;
	flex-direction: column;
	min-inline-size: 0;
	overflow-wrap: anywhere;
}
.usage-identity span {
	color: var(--text-secondary);
	font-size: .8rem;
}
.usage-badges, .usage-flags {
	display: flex;
	flex-wrap: wrap;
	gap: .4rem;
	font-size: .75rem;
}
.usage-badges span {
	background: var(--surface-sunken);
	color: var(--text-secondary);
	border-radius: 1rem;
	padding: .2rem .6rem;
}
.usage-flags {
	margin-block-start: .75rem;
	color: var(--text-primary);
}
.usage-flags span {
	border-inline-start: 3px solid var(--warning);
	padding-inline-start: .5rem;
}
.usage-primary {
	display: grid;
	grid-template-columns: repeat(4, minmax(0, 1fr));
	gap: 1rem;
	margin-block: 1rem;
}
.usage-primary dt {
	color: var(--text-secondary);
	font-size: .8rem;
}
.usage-primary dd {
	margin: .25rem 0 0;
	font-size: 1.2rem;
	font-variant-numeric: tabular-nums;
	overflow-wrap: anywhere;
}
.usage-primary small {
	display: block;
	font-size: .75rem;
}
.usage-details {
	border-block-start: 1px solid var(--border-subtle);
	padding-block-start: .75rem;
}
.usage-details summary, .usage-notes summary {
	cursor: pointer;
	font-size: .875rem;
}
.usage-details dl {
	display: grid;
	grid-template-columns: repeat(3, minmax(0, 1fr));
	gap: .75rem;
	margin-block-end: 0;
	font-size: .85rem;
}
.usage-details dt {
	color: var(--text-secondary);
}
.usage-details dd {
	margin: .25rem 0 0;
	overflow-wrap: anywhere;
}
.usage-pagination {
	display: flex;
	flex-wrap: wrap;
	justify-content: center;
	align-items: center;
	gap: .75rem;
	margin-block: 1.25rem;
	font-size: .85rem;
}
.usage-notes {
	padding: 1rem;
	background: var(--surface-raised);
	border-radius: .75rem;
	font-size: .85rem;
	line-height: 1.7;
}
.usage-empty {
	padding: 2rem;
	text-align: center;
}
@media (width <= 767px) {
	.usage-overview, .usage-primary {
		grid-template-columns: repeat(2, minmax(0, 1fr));
	}
	.usage-details dl {
		grid-template-columns: repeat(2, minmax(0, 1fr));
	}
	.usage-filters label {
		flex-basis: calc(50% - .75rem);
	}
	.usage-filters .usage-search {
		flex-basis: 100%;
	}
}
</style>
