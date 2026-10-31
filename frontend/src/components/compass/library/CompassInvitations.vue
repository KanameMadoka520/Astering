<template>
	<div class="compass-invitations">
		<p class="compass-invitations__lead">
			{{ t('compass.invite.lead') }}
		</p>
		<ol
			class="compass-invitations__list"
			:aria-label="t('compass.invite.label')"
		>
			<li
				v-for="kind in COMPASS_KINDS"
				:key="kind"
				class="compass-invitations__item"
			>
				<CompassGlyph
					class="compass-invitations__glyph"
					:kind="kind"
				/>
				<div class="compass-invitations__text">
					<span class="compass-invitations__kind">{{ t(`compass.kind.${kind}`) }}</span>
					<p class="compass-invitations__question">
						{{ t(`compass.invite.question.${kind}`) }}
					</p>
					<RouterLink
						class="compass-invitations__link"
						:to="{name: 'compass.entry.new', params: {spaceId}, query: {kind}}"
					>
						{{ t(`compass.invite.write.${kind}`) }}
					</RouterLink>
				</div>
			</li>
		</ol>
		<p class="compass-invitations__note">
			{{ t('compass.invite.note') }}
		</p>
	</div>
</template>

<script setup lang="ts">
import {useI18n} from 'vue-i18n'
import CompassGlyph from '@/components/compass/base/CompassGlyph.vue'
import {COMPASS_KINDS} from '@/helpers/compass/constants'

defineProps<{
	spaceId: number
}>()

const {t} = useI18n({useScope: 'global'})
</script>

<style lang="scss" scoped>
.compass-invitations {
	display: flex;
	flex-direction: column;
	gap: var(--space-4);
	max-inline-size: 44rem;
	padding-block: var(--space-2) var(--space-4);
}

.compass-invitations__lead {
	color: var(--compass-ink);
	font-family: var(--compass-serif);
	font-size: 1.15rem;
	line-height: 1.6;
}

.compass-invitations__list {
	margin: 0;
	padding: 0;
	list-style: none;
}

.compass-invitations__item {
	--compass-glyph-size: 1.5rem;

	display: grid;
	grid-template-columns: auto minmax(0, 1fr);
	gap: var(--space-4);
	padding-block: var(--space-4);
	border-block-start: 1px solid var(--compass-rule);

	&:last-child {
		border-block-end: 1px solid var(--compass-rule);
	}
}

.compass-invitations__glyph {
	margin-block-start: .15rem;
}

.compass-invitations__text {
	display: flex;
	flex-direction: column;
	align-items: flex-start;
	gap: var(--space-1);
	min-inline-size: 0;
}

.compass-invitations__kind {
	color: var(--compass-ink-soft);
	font-size: var(--text-xs);
	font-weight: var(--weight-semibold);
	letter-spacing: .06em;
	text-transform: uppercase;
}

.compass-invitations__question {
	color: var(--compass-ink);
	font-family: var(--compass-serif);
	font-size: 1.2rem;
	line-height: 1.5;
	text-wrap: pretty;
}

.compass-invitations__link {
	display: inline-flex;
	align-items: center;
	min-block-size: var(--target-min);
	color: var(--compass-accent);
	font-size: var(--text-md);
	font-weight: var(--weight-medium);
	text-decoration: underline;
	text-decoration-thickness: 1px;
	text-underline-offset: .22em;

	&:hover {
		text-decoration-thickness: 2px;
	}

	&:focus-visible {
		@include focus-ring;
	}
}

.compass-invitations__note {
	color: var(--compass-ink-faint);
	font-size: var(--text-sm);
}
</style>
