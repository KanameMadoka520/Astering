<template>
	<SideNavShell
		:navigation-items="navigationItems"
		:extra-links="extraSettingsLinks"
		:extra-links-label="$t('user.settings.groups.links')"
		:label="$t('user.settings.title')"
	/>
</template>

<script setup lang="ts">
import {computed} from 'vue'
import {useQuery} from '@tanstack/vue-query'
import {currentSiteUsageData, siteUsageAccessQuery} from '@/client/queries/siteUsage'
import {captureClientRequestContext} from '@/client/requestContext'
import {mailSettingsAccessQuery} from '@/client/queries/mailSettings'
import {useI18n} from 'vue-i18n'
import {useTitle} from '@/composables/useTitle'
import {useConfigStore} from '@/stores/config'
import {useAuthStore} from '@/stores/auth'

import SideNavShell, {type SideNavItem} from '@/components/misc/SideNavShell.vue'

const {t} = useI18n({useScope: 'global'})
useTitle(() => t('user.settings.title'))

const mailAccess = useQuery(mailSettingsAccessQuery())
const configStore = useConfigStore()
const authStore = useAuthStore()
const usageAccess = useQuery(computed(() => ({
	...siteUsageAccessQuery(captureClientRequestContext()),
	enabled: authStore.authUser && Boolean(authStore.identityKey),
})))

const migratorsEnabled = computed(() => configStore.migratorsEnabled)
const isLocalUser = computed(() => authStore.info?.is_local_user)

const navigationItems = computed(() => {
	const account = t('user.settings.groups.account')
	const security = t('user.settings.groups.security')
	const notifications = t('user.settings.groups.notifications')
	const ai = t('user.settings.groups.ai')
	const integrations = t('user.settings.groups.integrations')
	const data = t('user.settings.groups.data')
	const site = t('user.settings.groups.site')

	const items: (SideNavItem & {condition?: boolean})[] = [
		{
			title: t('user.settings.general.title'),
			icon: 'sliders',
			routeName: 'user.settings.general',
			group: account,
		},
		{
			title: t('user.settings.avatar.title'),
			icon: 'image',
			routeName: 'user.settings.avatar',
			group: account,
		},
		{
			title: t('user.settings.updateEmailTitle'),
			icon: 'envelope',
			routeName: 'user.settings.email-update',
			group: account,
			condition: isLocalUser.value,
		},
		{
			title: t('tcymc.text.public_page'),
			icon: 'globe',
			routeName: 'user.settings.showcase',
			group: account,
		},
		{
			title: t('user.settings.newPasswordTitle'),
			icon: 'key',
			routeName: 'user.settings.password-update',
			group: security,
			condition: isLocalUser.value,
		},
		{
			title: t('user.settings.totp.title'),
			icon: 'shield-halved',
			routeName: 'user.settings.totp',
			group: security,
			condition: configStore.totp_enabled && isLocalUser.value,
		},
		{
			title: t('user.settings.sessions.title'),
			icon: 'history',
			routeName: 'user.settings.sessions',
			group: security,
		},
		{
			title: t('bark.title'),
			icon: 'bell',
			routeName: 'user.settings.push',
			group: notifications,
		},
		{
			title: t('user.settings.feeds.title'),
			icon: 'rss',
			routeName: 'user.settings.feeds',
			group: notifications,
		},
		{
			title: t('tcymc.text.ai_and_voice'),
			icon: 'robot',
			routeName: 'user.settings.ai',
			group: ai,
		},
		{
			title: 'MCP',
			icon: 'code',
			routeName: 'user.settings.mcp',
			group: ai,
		},
		{
			title: t('user.settings.bots.title'),
			icon: 'user-gear',
			routeName: 'user.settings.bots',
			group: ai,
		},
		{
			title: t('user.settings.apiTokens.title'),
			icon: 'lock',
			routeName: 'user.settings.apiTokens',
			group: integrations,
		},
		{
			title: t('user.settings.caldav.title'),
			icon: 'calendar',
			routeName: 'user.settings.caldav',
			group: integrations,
			condition: configStore.caldav_enabled,
		},
		{
			title: t('user.settings.webhooks.title'),
			icon: 'link',
			routeName: 'user.settings.webhooks',
			group: integrations,
			condition: configStore.webhooks_enabled,
		},
		{
			title: t('migrate.title'),
			icon: 'cloud-upload-alt',
			routeName: 'migrate.start',
			activeRouteNames: ['migrate.service', 'migrate.csv'],
			group: data,
			condition: migratorsEnabled.value,
		},
		{
			title: t('user.export.title'),
			icon: 'download',
			routeName: 'user.settings.data-export',
			group: data,
		},
		{
			title: t('user.deletion.title'),
			icon: 'trash-alt',
			routeName: 'user.settings.deletion',
			group: data,
			condition: configStore.user_deletion_enabled,
		},
		{
			title: t('siteUsage.title'),
			icon: 'chart-line',
			routeName: 'user.settings.usage',
			group: site,
			badge: t('user.settings.scope.siteBadge'),
			condition: authStore.authUser && !usageAccess.isFetching.value && !usageAccess.isError.value
				&& currentSiteUsageData(usageAccess.data.value)?.can_view_usage === true,
		},
		{
			title: t('mailServer.title'),
			icon: 'server',
			routeName: 'user.settings.mail-server',
			group: site,
			badge: t('user.settings.scope.siteBadge'),
			condition: mailAccess.data.value?.can_manage_mail === true,
		},
	]

	return items.filter(({condition}) => condition !== false)
})

const extraSettingsLinks = computed(() => Object.values(authStore.settings.extra_settings_links ?? {}))
</script>
