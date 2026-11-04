<script setup lang="ts">
import {useI18n} from 'vue-i18n'
const {t} = useI18n({useScope: 'global'})
</script>

<template>
	<a
		class="tcy-brand"
		href="https://github.com/KanameMadoka520/Astering"
		target="_blank"
		rel="noopener noreferrer"
	>
		<svg
			viewBox="0 0 24 24"
			width="18"
			height="18"
			aria-hidden="true"
			fill="currentColor"
		>
			<path d="M12 .5a12 12 0 0 0-3.79 23.39c.6.11.82-.26.82-.58v-2.23c-3.34.73-4.04-1.42-4.04-1.42-.55-1.39-1.33-1.76-1.33-1.76-1.09-.75.08-.73.08-.73 1.2.08 1.84 1.23 1.84 1.23 1.07 1.83 2.81 1.3 3.49.99.11-.78.42-1.3.76-1.6-2.67-.3-5.47-1.33-5.47-5.93 0-1.31.47-2.38 1.24-3.22-.12-.3-.54-1.52.12-3.18 0 0 1.01-.32 3.3 1.23a11.5 11.5 0 0 1 6 0c2.29-1.55 3.3-1.23 3.3-1.23.66 1.66.24 2.88.12 3.18.77.84 1.24 1.91 1.24 3.22 0 4.61-2.81 5.62-5.49 5.92.43.37.82 1.1.82 2.22v3.31c0 .32.22.7.83.58A12 12 0 0 0 12 .5Z" />
		</svg>
		<span>{{ t('brand.source') }}</span>
	</a>
</template>

<style scoped>
.tcy-brand {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	gap: var(--space-2);
	padding: var(--space-2);
	border-radius: var(--radius-sm);
	color: var(--text-secondary);
	font-size: var(--text-sm);
	transition: color var(--motion-fast) var(--ease-standard);
}

.tcy-brand:hover {
	color: var(--text-primary);
}
</style>
