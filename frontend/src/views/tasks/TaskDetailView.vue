<template>
	<div
		ref="taskViewContainer"
		class="task-view-container"
		:class="{
			'is-modal': isModal,
			'is-wide': isWideLayout,
		}"
	>
		<div
			v-if="isDeleted"
			class="task-view-deleted"
		>
			<p
				class="task-view-deleted__message"
				role="alert"
			>
				<Icon
					icon="trash-alt"
					class="task-view-deleted__icon"
				/>
				{{ $t('task.detail.deletedNotice') }}
			</p>
			<XButton
				variant="secondary"
				class="is-small"
				:shadow="false"
				@click="leaveDeletedTask"
			>
				{{ leaveDeletedTaskLabel }}
			</XButton>
		</div>

		<template v-else-if="!visible">
			<LoadError
				v-if="loadFailed"
				class="task-view-load-error"
				:retry="retryLoad"
			/>
			<div
				v-else
				class="task-view-skeleton"
				aria-busy="true"
			>
				<span
					class="is-sr-only"
					role="status"
				>{{ $t('misc.loading') }}</span>
				<div class="task-view-skeleton__header">
					<span class="skeleton-block skeleton-block--chip" />
					<span class="skeleton-block skeleton-block--title" />
					<span class="skeleton-block skeleton-block--meta" />
				</div>
				<div class="task-view-skeleton__layout">
					<div class="task-view-skeleton__main">
						<span class="skeleton-block skeleton-block--panel" />
						<span class="skeleton-block skeleton-block--line" />
						<span class="skeleton-block skeleton-block--line" />
						<span class="skeleton-block skeleton-block--line is-short" />
					</div>
					<span class="skeleton-block skeleton-block--rail" />
				</div>
			</div>
		</template>

		<div
			v-else
			class="task-view"
			:class="{'is-switching': isSwitchingTask}"
			:aria-busy="isSwitchingTask || undefined"
		>
			<div class="task-header">
				<BaseButton
					v-if="!isModal"
					class="back-button"
					@click="lastProject ? router.back() : router.push(projectRoute)"
				>
					<Icon icon="arrow-left" />
					{{ $t('task.detail.back') }}
				</BaseButton>
				<Heading
					ref="heading"
					:task="task"
					:can-write="canWrite"
					:has-close="isModal"
					@close="$emit('close')"
				/>
				<div class="task-header__bar">
					<div class="task-header__meta">
						<nav
							v-if="project?.id"
							:aria-label="$t('tcymc.breadcrumb')"
							class="subtitle task-breadcrumb"
						>
							<template
								v-for="p in projectList.getAncestors(project)"
								:key="p.id"
							>
								<a
									v-if="backReturnsTo(p)"
									v-shortcut="p.id === project?.id ? SHORTCUTS.taskDetail.openProject : ''"
									:href="router.resolve(projectLocation(p)).href"
									@click.prevent="router.back()"
								>
									{{ getProjectTitle(p) }}
								</a>
								<RouterLink
									v-else
									v-shortcut="p.id === project?.id ? SHORTCUTS.taskDetail.openProject : ''"
									:to="projectLocation(p)"
								>
									{{ getProjectTitle(p) }}
								</RouterLink>
								<Icon
									v-if="p.id !== project?.id"
									icon="chevron-right"
									class="task-breadcrumb__separator"
								/>
							</template>
							<BucketSelect
								:task="task"
								:can-write="canWrite"
							/>
						</nav>
						<ChecklistSummary :task="task" />
						<RoutineStatusChip
							v-if="isRoutine"
							:task="task"
							class="task-header__routine"
						/>
					</div>

					<div
						v-if="canWrite || authStore.authUser"
						class="task-primary-actions d-print-none"
						role="group"
						:aria-label="$t('task.detail.quickActions')"
					>
						<template v-if="canWrite">
							<!-- An enabled routine is checked in for today; its done flag never moves. -->
							<template v-if="isRoutine">
								<XButton
									v-if="canEditRoutine"
									v-shortcut="SHORTCUTS.taskDetail.done"
									:class="{'is-pending': routineState !== 'done'}"
									class="button--routine-check-in"
									:icon="routineButtonIcon"
									variant="secondary"
									:shadow="false"
									:loading="routineCheckingIn"
									:aria-disabled="routineState === 'paused' || routineCheckingIn || undefined"
									:aria-describedby="routineState === 'paused' ? routinePausedNoteId : undefined"
									@click="toggleRoutineCheckIn"
								>
									{{ routineState === 'done' ? $t('task.routine.detail.undoCheckIn') : $t('task.routine.detail.checkIn') }}
								</XButton>
								<span
									v-if="canEditRoutine && routineState === 'paused'"
									:id="routinePausedNoteId"
									class="task-primary-actions__note"
								>
									<Icon icon="pause" />
									{{ $t('task.routine.pausedNoCheckIn') }}
								</span>
							</template>
							<XButton
								v-else
								v-shortcut="SHORTCUTS.taskDetail.done"
								:class="{'is-pending': !task.done}"
								class="button--mark-done"
								:icon="task.done ? 'circle-check' : ['far', 'circle']"
								variant="secondary"
								:shadow="false"
								:loading="isFieldSaving('done')"
								@click="toggleTaskDone()"
							>
								{{ task.done ? $t('task.detail.undone') : $t('task.detail.done') }}
							</XButton>
							<XButton
								v-shortcut="SHORTCUTS.taskDetail.favorite"
								v-tooltip="favoriteLabel"
								class="task-favorite-button"
								variant="secondary"
								icon-only
								:shadow="false"
								:icon="task.is_favorite ? 'star' : ['far', 'star']"
								@click="toggleFavorite"
							>
								{{ favoriteLabel }}
							</XButton>
							<TaskSubscription
								class="task-subscription-button"
								entity="task"
								:entity-id="task.id"
								:model-value="task.subscription ?? null"
								@toggle="toggleSubscription"
							/>
						</template>
						<XButton
							v-if="authStore.authUser"
							v-tooltip="isWideLayout ? undefined : $t('agent.fromTask')"
							class="task-ai-button"
							variant="secondary"
							icon="robot"
							:icon-only="!isWideLayout"
							:shadow="false"
							:to="{name: 'tcy-ai', query: {project: task.project_id, task: task.id}}"
						>
							{{ $t('agent.fromTask') }}
						</XButton>
						<XButton
							v-if="canWrite && !isWideLayout"
							v-tooltip="$t('task.detail.moreActions')"
							class="task-more-button"
							variant="secondary"
							icon="ellipsis-h"
							icon-only
							:shadow="false"
							:aria-controls="actionRailId"
							@click="showAllActions"
						>
							{{ $t('task.detail.moreActions') }}
						</XButton>
					</div>
				</div>
			</div>

			<div class="columns task-layout">
				<div class="column detail-content">
					<p
						v-if="unsavedFieldLabels.length > 0"
						class="task-fields-not-saved"
						role="alert"
					>
						<Icon
							icon="exclamation-circle"
							aria-hidden="true"
						/>
						<span>{{ $t('task.detail.fieldsNotSaved', {fields: unsavedFieldLabels.join(', ')}) }}</span>
						<BaseButton
							class="task-fields-not-saved__retry"
							@click="retryFailedSave"
						>
							{{ $t('misc.retry') }}
						</BaseButton>
					</p>
					<div
						v-if="hasFieldPanel"
						class="task-fields"
					>
						<div class="columns details">
							<div
								v-if="activeFields.assignees"
								class="column assignees"
							>
								<div class="detail-title">
									<Icon icon="users" />
									{{ $t('task.attributes.assignees') }}
								</div>
								<EditAssignees
									v-if="canWrite"
									:ref="e => setFieldRef('assignees', e)"
									v-model="task.assignees"
									:project-id="task.project_id"
									:task-id="task.id"
								/>
								<AssigneeList
									v-else
									:assignees="task.assignees ?? []"
									class="mbs-2"
								/>
							</div>
							<CustomTransition
								name="flash-background"
								appear
							>
								<div
									v-if="activeFields.priority"
									class="column"
									:aria-busy="isFieldSaving('priority') || undefined"
								>
									<div class="detail-title">
										<Icon icon="exclamation-circle" />
										{{ $t('task.attributes.priority') }}
										<Icon
											v-if="isFieldSaving('priority')"
											icon="spinner"
											spin
											class="detail-title__saving"
										/>
									</div>
									<PrioritySelect
										:ref="e => setFieldRef('priority', e)"
										v-model="task.priority"
										:disabled="!canWrite"
										@update:modelValue="setPriority"
									/>
								</div>
							</CustomTransition>
							<CustomTransition
								name="flash-background"
								appear
							>
								<div
									v-if="activeFields.dueDate"
									class="column"
									:aria-busy="isFieldSaving('dueDate') || undefined"
								>
									<div class="detail-title">
										<Icon icon="calendar" />
										{{ $t('task.attributes.dueDate') }}
										<Icon
											v-if="isFieldSaving('dueDate')"
											icon="spinner"
											spin
											class="detail-title__saving"
										/>
									</div>
									<div class="date-input">
										<Datepicker
											ref="dueDatePicker"
											v-model="dueDateInput"
											:choose-date-label="$t('task.detail.chooseDueDate')"
											:title="$t('task.attributes.dueDate')"
											:disabled="!canWrite"
											@closeOnChange="saveDate('dueDate')"
										/>
										<BaseButton
											v-if="task.due_date && canWrite"
											class="remove"
											:aria-label="$t('task.detail.removeDueDate')"
											@click="clearDate('dueDate')"
										>
											<Icon icon="times" />
										</BaseButton>
									</div>
								</div>
							</CustomTransition>
							<CustomTransition
								name="flash-background"
								appear
							>
								<div
									v-if="activeFields.percentDone"
									class="column"
									:aria-busy="percentDoneSaving || undefined"
								>
									<div class="detail-title">
										<Icon icon="percent" />
										{{ $t('task.attributes.percentDone') }}
									</div>
									<div class="progress-input">
										<PercentDoneSelect
											:ref="e => setFieldRef('percentDone', e)"
											:model-value="task.percent_done"
											:disabled="!canWrite || percentDoneSaving"
											@update:modelValue="setPercentDone"
										/>
										<BaseButton
											v-if="canWrite"
											class="remove-progress"
											:disabled="percentDoneSaving"
											:aria-busy="percentDoneSaving"
											@click="setPercentDone(0)"
										>
											<Icon
												:icon="percentDoneSaving ? 'spinner' : 'times'"
												:spin="percentDoneSaving"
											/>
											{{ $t('task.detail.removeProgress') }}
										</BaseButton>
									</div>
								</div>
							</CustomTransition>
							<CustomTransition
								name="flash-background"
								appear
							>
								<div
									v-if="activeFields.startDate"
									class="column"
									:aria-busy="isFieldSaving('startDate') || undefined"
								>
									<div class="detail-title">
										<Icon icon="play" />
										{{ $t('task.attributes.startDate') }}
										<Icon
											v-if="isFieldSaving('startDate')"
											icon="spinner"
											spin
											class="detail-title__saving"
										/>
									</div>
									<div class="date-input">
										<Datepicker
											ref="startDatePicker"
											v-model="startDateInput"
											:choose-date-label="$t('task.detail.chooseStartDate')"
											:title="$t('task.attributes.startDate')"
											:disabled="!canWrite"
											@closeOnChange="saveDate('startDate')"
										/>
										<BaseButton
											v-if="task.start_date && canWrite"
											class="remove"
											:aria-label="$t('task.detail.removeStartDate')"
											@click="clearDate('startDate')"
										>
											<Icon icon="times" />
										</BaseButton>
									</div>
								</div>
							</CustomTransition>
							<CustomTransition
								name="flash-background"
								appear
							>
								<div
									v-if="activeFields.endDate"
									class="column"
									:aria-busy="isFieldSaving('endDate') || undefined"
								>
									<div class="detail-title">
										<Icon icon="stop" />
										{{ $t('task.attributes.endDate') }}
										<Icon
											v-if="isFieldSaving('endDate')"
											icon="spinner"
											spin
											class="detail-title__saving"
										/>
									</div>
									<div class="date-input">
										<Datepicker
											ref="endDatePicker"
											v-model="endDateInput"
											:choose-date-label="$t('task.detail.chooseEndDate')"
											:title="$t('task.attributes.endDate')"
											:disabled="!canWrite"
											@closeOnChange="saveDate('endDate')"
										/>
										<BaseButton
											v-if="task.end_date && canWrite"
											class="remove"
											:aria-label="$t('task.detail.removeEndDate')"
											@click="clearDate('endDate')"
										>
											<Icon icon="times" />
										</BaseButton>
									</div>
								</div>
							</CustomTransition>
							<CustomTransition
								name="flash-background"
								appear
							>
								<div
									v-if="activeFields.color"
									class="column"
									:aria-busy="isFieldSaving('color') || undefined"
								>
									<div class="detail-title">
										<Icon icon="fill-drip" />
										{{ $t('task.attributes.color') }}
										<Icon
											v-if="isFieldSaving('color')"
											icon="spinner"
											spin
											class="detail-title__saving"
										/>
									</div>
									<ColorPicker
										:ref="e => setFieldRef('color', e)"
										v-model="taskColor"
										:label="$t('task.attributes.color')"
										menu-position="bottom"
										@update:modelValue="saveColor"
									/>
								</div>
							</CustomTransition>
							<CustomTransition
								name="flash-background"
								appear
							>
								<div
									v-if="activeFields.reminders"
									class="column is-full-row"
									:aria-busy="isFieldSaving('reminders') || undefined"
								>
									<div class="detail-title">
										<Icon :icon="['far', 'clock']" />
										{{ $t('task.attributes.reminders') }}
										<Icon
											v-if="isFieldSaving('reminders')"
											icon="spinner"
											spin
											class="detail-title__saving"
										/>
									</div>
									<Reminders
										:ref="e => setFieldRef('reminders', e)"
										v-model="task.reminders"
										:default-relative-to="remindersDefaultRelativeTo"
										:disabled="!canWrite"
										@update:modelValue="saveReminders"
									/>
								</div>
							</CustomTransition>
							<CustomTransition
								name="flash-background"
								appear
							>
								<div
									v-if="activeFields.repeatAfter"
									class="column is-full-row"
									:aria-busy="isFieldSaving('repeatAfter') || undefined"
								>
									<div class="detail-title">
										<Icon icon="history" />
										{{ $t('task.attributes.repeat') }}
										<Icon
											v-if="isFieldSaving('repeatAfter')"
											icon="spinner"
											spin
											class="detail-title__saving"
										/>
										<BaseButton
											v-if="canWrite && !isRoutine"
											class="remove detail-title__action"
											:aria-label="$t('task.detail.removeRepeat')"
											@click="removeRepeatAfter"
										>
											<Icon icon="times" />
										</BaseButton>
									</div>
									<RepeatAfter
										:ref="e => setFieldRef('repeatAfter', e)"
										:model-value="task"
										:disabled="!canWrite || isRoutine"
										@update:modelValue="saveRepeat"
									/>
									<p
										v-if="isRoutine"
										class="detail-field-note"
									>
										{{ $t('task.routine.detail.repeatBlockedField') }}
									</p>
								</div>
							</CustomTransition>
						</div>

						<div
							v-if="activeFields.labels"
							class="labels-list details"
						>
							<div class="detail-title">
								<span class="icon is-grey">
									<Icon icon="tags" />
								</span>
								{{ $t('task.attributes.labels') }}
							</div>
							<EditLabels
								:ref="e => setFieldRef('labels', e)"
								v-model="task.labels"
								:disabled="!canWrite"
								:task-id="taskId"
								:creatable="!authStore.isLinkShareAuth"
								:creation-disabled-message="authStore.isLinkShareAuth ? $t('task.label.linkShareCannotCreate') : ''"
							/>
						</div>
					</div>

					<TaskRoutinePanel
						v-if="showRoutinePanel"
						:key="task.id"
						ref="routinePanel"
						:task="task"
						:can-edit="canEditRoutine"
						:reopen-pending="isFieldPending('done')"
						:remove-repeat-pending="isFieldPending('repeatAfter')"
						@reopen="reopenForRoutine"
						@removeRepeat="removeRepeatForRoutine"
						@close="routinePanelTaskId = undefined"
						@taskStale="taskQuery.refetch()"
					/>

					<div class="details content description">
						<Description
							ref="descriptionRef"
							:model-value="task"
							:can-write="canWrite"
						/>
					</div>

					<Reactions
						:model-value="task.reactions"
						entity-kind="tasks"
						:entity-id="task.id"
						class="details d-print-none"
						:disabled="!canWrite"
					/>

					<div
						v-show="activeFields.attachments || hasAttachments || canWrite"
						class="content attachments"
					>
						<Attachments
							:ref="e => { setFieldRef('attachments', e); attachmentsRef = e as any }"
							:edit-enabled="canWrite"
							:task="task"
						/>
					</div>

					<div
						v-if="timeTrackingEnabled && activeFields.timeTracking"
						:ref="e => setFieldRef('timeTracking', e)"
						class="content time-tracking"
					>
						<TaskTimeTracking :task-id="task.id" />
					</div>

					<div
						v-if="activeFields.relatedTasks"
						class="content details"
					>
						<RelatedTasks
							:ref="e => { setFieldRef('relatedTasks', e); relatedTasksRef = e as any }"
							:edit-enabled="canWrite"
							:initial-related-tasks="task.related_tasks"
							:project-id="task.project_id"
							:show-no-relations-notice="true"
							:task-id="taskId"
						/>
					</div>

					<div
						v-if="activeFields.moveProject"
						class="content details"
						:aria-busy="isFieldSaving('moveProject') || undefined"
					>
						<h2 class="task-section-title">
							<span class="icon is-grey">
								<Icon icon="list" />
							</span>
							{{ $t('task.detail.move') }}
						</h2>
						<div class="field has-addons">
							<div class="control is-expanded">
								<ProjectSearch
									:ref="e => setFieldRef('moveProject', e)"
									:filter="project => project.id !== task.project_id"
									@update:modelValue="changeProject"
								/>
							</div>
						</div>
					</div>

					<Comments
						:can-write="canWrite"
						:task-id="taskId"
						:project-id="task.project_id"
					/>

					<!-- Marker element for scroll-to-bottom button visibility -->
					<div
						ref="contentBottomMarker"
						class="content-bottom-marker"
					/>
				</div>

				<aside
					v-if="canWrite || isModal"
					:id="actionRailId"
					ref="actionRail"
					class="column action-buttons d-print-none"
					:aria-label="$t('task.detail.actionsLabel')"
				>
					<template v-if="canWrite">
						<div
							class="action-group"
							role="group"
							:aria-labelledby="`${actionRailId}-organization`"
						>
							<span
								:id="`${actionRailId}-organization`"
								class="action-heading"
							>{{ $t('task.detail.organization') }}</span>
							<XButton
								v-shortcut="SHORTCUTS.taskDetail.labels"
								variant="tertiary"
								icon="tags"
								@click="setFieldActive('labels')"
							>
								{{ $t('task.detail.actions.label') }}
							</XButton>
							<XButton
								v-shortcut="SHORTCUTS.taskDetail.priority"
								variant="tertiary"
								icon="exclamation-circle"
								@click="setFieldActive('priority')"
							>
								{{ $t('task.detail.actions.priority') }}
							</XButton>
							<XButton
								variant="tertiary"
								icon="percent"
								@click="setFieldActive('percentDone')"
							>
								{{ $t('task.detail.actions.percentDone') }}
							</XButton>
							<XButton
								v-shortcut="SHORTCUTS.taskDetail.color"
								variant="tertiary"
								icon="fill-drip"
								:icon-color="color"
								@click="setFieldActive('color')"
							>
								{{ $t('task.detail.actions.color') }}
							</XButton>
						</div>

						<div
							class="action-group"
							role="group"
							:aria-labelledby="`${actionRailId}-management`"
						>
							<span
								:id="`${actionRailId}-management`"
								class="action-heading"
							>{{ $t('task.detail.management') }}</span>
							<XButton
								v-shortcut="SHORTCUTS.taskDetail.assignees"
								v-cy="'taskDetail.assign'"
								variant="tertiary"
								icon="users"
								@click="setFieldActive('assignees')"
							>
								{{ $t('task.detail.actions.assign') }}
							</XButton>
							<XButton
								v-shortcut="SHORTCUTS.taskDetail.attachments"
								variant="tertiary"
								icon="paperclip"
								@click="openAttachments()"
							>
								{{ $t('task.detail.actions.attachments') }}
							</XButton>
							<XButton
								v-shortcut="SHORTCUTS.taskDetail.relatedTasks"
								variant="tertiary"
								icon="sitemap"
								@click="setRelatedTasksActive()"
							>
								{{ $t('task.detail.actions.relatedTasks') }}
							</XButton>
							<XButton
								v-shortcut="SHORTCUTS.taskDetail.moveProject"
								variant="tertiary"
								icon="list"
								@click="setFieldActive('moveProject')"
							>
								{{ $t('task.detail.actions.moveProject') }}
							</XButton>
							<XButton
								variant="tertiary"
								icon="copy"
								:loading="duplicateTask.isPending.value"
								@click="duplicateCurrentTask"
							>
								{{ $t('task.detail.actions.duplicate') }}
							</XButton>
						</div>

						<div
							class="action-group"
							role="group"
							:aria-labelledby="`${actionRailId}-date-and-time`"
						>
							<span
								:id="`${actionRailId}-date-and-time`"
								class="action-heading"
							>{{ $t('task.detail.dateAndTime') }}</span>
							<XButton
								v-if="timeTrackingEnabled"
								v-cy="'taskTrackTimeAction'"
								variant="tertiary"
								:icon="['far', 'clock']"
								@click="setFieldActive('timeTracking')"
							>
								{{ $t('task.detail.actions.timeTracking') }}
							</XButton>
							<XButton
								v-shortcut="SHORTCUTS.taskDetail.dueDate"
								variant="tertiary"
								icon="calendar"
								@click="setFieldActive('dueDate')"
							>
								{{ $t('task.detail.actions.dueDate') }}
							</XButton>
							<XButton
								variant="tertiary"
								icon="play"
								@click="setFieldActive('startDate')"
							>
								{{ $t('task.detail.actions.startDate') }}
							</XButton>
							<XButton
								variant="tertiary"
								icon="stop"
								@click="setFieldActive('endDate')"
							>
								{{ $t('task.detail.actions.endDate') }}
							</XButton>
							<XButton
								v-shortcut="SHORTCUTS.taskDetail.reminder"
								variant="tertiary"
								:icon="['far', 'clock']"
								@click="setFieldActive('reminders')"
							>
								{{ $t('task.detail.actions.reminders') }}
							</XButton>
							<XButton
								variant="tertiary"
								icon="history"
								:aria-disabled="isRoutine || undefined"
								:aria-describedby="isRoutine ? `${actionRailId}-repeat-blocked` : undefined"
								@click="openRepeat"
							>
								{{ $t('task.detail.actions.repeatAfter') }}
							</XButton>
							<p
								v-if="isRoutine"
								:id="`${actionRailId}-repeat-blocked`"
								class="action-note"
							>
								{{ $t('task.routine.detail.repeatBlocked') }}
							</p>
							<XButton
								v-if="canEditRoutine || hasRoutineRecord"
								variant="tertiary"
								class="task-routine-action"
								:icon="['far', 'sun']"
								@click="openRoutinePanel"
							>
								{{ isRoutine || !canEditRoutine
									? $t('task.routine.detail.settingsAction')
									: $t('task.routine.detail.enableAction') }}
							</XButton>
						</div>

						<div class="action-group action-group--danger">
							<XButton
								v-shortcut="SHORTCUTS.taskDetail.delete"
								variant="tertiary"
								icon="trash-alt"
								danger
								@click="openDeleteModal"
							>
								{{ $t('task.detail.actions.delete') }}
							</XButton>
						</div>
					</template>

					<!-- Created / Updated [by] -->
					<CreatedUpdated :task="task" />
				</aside>
			</div>
			<!-- Created / Updated [by] -->
			<CreatedUpdated
				v-if="!canWrite && !isModal"
				:task="task"
			/>
		</div>

		<BaseButton
			v-if="showScrollToCommentsButton && !isDeleted"
			v-tooltip="$t('task.detail.scrollToBottom')"
			class="scroll-to-comments-button d-print-none"
			:aria-label="$t('task.detail.scrollToBottom')"
			@click="scrollToBottom"
		>
			<Icon icon="chevron-down" />
		</BaseButton>

		<UnsavedLeaveDialog
			:open="leaveTarget !== null"
			@stay="stay"
			@discard="discardAndLeave"
		/>

		<Modal
			:enabled="showDeleteModal"
			danger
			:confirm-label="$t('task.detail.delete.confirm')"
			@close="closeDeleteModal"
			@submit="deleteTask"
		>
			<template #header>
				<span>{{ $t('task.detail.delete.header') }}</span>
			</template>

			<template #text>
				<p class="tw:text-balance">
					{{ $t('task.detail.delete.subject', {task: task.title}) }}
				</p>
				<p class="tw:text-balance">
					{{ $t('task.detail.delete.text2') }}
				</p>
			</template>
		</Modal>
	</div>
</template>

<script lang="ts" setup>
import {parseDateOrNull} from '@/helpers/parseDateOrNull'
import {
	ref,
	shallowRef,
	reactive,
	computed,
	watch,
	nextTick,
	onBeforeUnmount,
	onMounted,
	useId,
	useTemplateRef,
	type ComponentPublicInstance,
} from 'vue'
import {useRouter, useRoute, type RouteLocation, type RouteLocationRaw, onBeforeRouteLeave} from 'vue-router'
import {useI18n} from 'vue-i18n'
import {useDebounceFn, useElementSize, useIntersectionObserver, useMutationObserver} from '@vueuse/core'
import {klona} from 'klona/lite'
import type {IconProp} from '@fortawesome/fontawesome-svg-core'

import {useTask} from '@/composables/useTask'
import {getHexColor} from '@/helpers/task'
import {createTaskDraft, mergeTask} from '@/helpers/task'

import type {Task as ITask} from '@/client/generated'
import type {ProjectResponse} from '@/client/queries/projects'

import {PRIORITIES} from '@/constants/priorities'
import {PERMISSIONS} from '@/constants/permissions'
import {PRO_FEATURE} from '@/constants/proFeatures'
import {SHORTCUTS} from '@/constants/shortcuts'

import BaseButton from '@/components/base/BaseButton.vue'
import LoadError from '@/components/misc/state/LoadError.vue'
import UnsavedLeaveDialog from '@/components/misc/UnsavedLeaveDialog.vue'
import {useUnsavedLeaveGuard} from '@/composables/useUnsavedLeaveGuard'
import {useIsAlive} from '@/composables/useIsAlive'
import {
	captureClientRequestContext,
	isClientRequestContextCurrent,
	type ClientRequestContext,
} from '@/client/requestContext'

// partials
import Attachments from '@/components/tasks/partials/Attachments.vue'
import TaskTimeTracking from '@/components/time-tracking/TaskTimeTracking.vue'
import ChecklistSummary from '@/components/tasks/partials/ChecklistSummary.vue'
import ColorPicker from '@/components/input/ColorPicker.vue'
import Comments from '@/components/tasks/partials/Comments.vue'
import CreatedUpdated from '@/components/tasks/partials/CreatedUpdated.vue'
import Datepicker from '@/components/input/Datepicker.vue'
import Description from '@/components/tasks/partials/Description.vue'
import EditAssignees from '@/components/tasks/partials/EditAssignees.vue'
import EditLabels from '@/components/tasks/partials/EditLabels.vue'
import Heading from '@/components/tasks/partials/Heading.vue'
import ProjectSearch from '@/components/tasks/partials/ProjectSearch.vue'
import PercentDoneSelect from '@/components/tasks/partials/PercentDoneSelect.vue'
import PrioritySelect from '@/components/tasks/partials/PrioritySelect.vue'
import RelatedTasks from '@/components/tasks/partials/RelatedTasks.vue'
import Reminders from '@/components/tasks/partials/Reminders.vue'
import RepeatAfter from '@/components/tasks/partials/RepeatAfter.vue'
import TaskSubscription from '@/components/misc/Subscription.vue'
import CustomTransition from '@/components/misc/CustomTransition.vue'
import AssigneeList from '@/components/tasks/partials/AssigneeList.vue'
import BucketSelect from '@/components/tasks/partials/BucketSelect.vue'
import Reactions from '@/components/input/Reactions.vue'
import RoutineStatusChip from '@/components/tasks/partials/RoutineStatusChip.vue'
import TaskRoutinePanel from '@/components/tasks/partials/routine/TaskRoutinePanel.vue'

import {getProjectTitle} from '@/helpers/getProjectTitle'
import {scrollIntoView, smoothScrollBehavior} from '@/helpers/scrollIntoView'
import {getScrollParent} from '@/helpers/getScrollParent'
import {TASK_REPEAT_MODES} from '@/types/IRepeatMode'
import {REMINDER_PERIOD_RELATIVE_TO_TYPES} from '@/types/IReminderPeriodRelativeTo'
import {playPopSound} from '@/helpers/playPop'
import {taskLoadErrorAction} from './taskDetailError'
import {
	draftValues,
	followServerValue,
	mergeServerDraft,
	settleSubmitted,
	unsavedDraftChanges,
	type DraftField,
	type DraftValues,
} from './taskDraftMerge'

import {
	useUpdateTaskMutation,
	useDeleteTaskMutation,
	useFavoriteTaskMutation,
	useDuplicateTaskMutation,
	useMarkTaskReadMutation,
} from '@/client/queries/taskMutations'
import {useProjects} from '@/composables/useProjects'
import {useAuthStore} from '@/stores/auth'
import {useBaseStore} from '@/stores/base'
import {useConfigStore} from '@/stores/config'

import {useTitle} from '@/composables/useTitle'
import {useTaskDetailShortcuts} from '@/composables/useTaskDetailShortcuts'
import {useDelayedLoading} from '@/composables/useDelayedLoading'
import {useGlobalNow} from '@/composables/useGlobalNow'
import {useRoutineCheckIn} from '@/composables/useRoutineCheckIn'
import {routineOf, routineStatus} from '@/helpers/taskRoutine'

import {error, success} from '@/message'
import type {Action as MessageAction} from '@/message'
import {useSetTaskSubscriptionMutation} from '@/client/queries/subscriptions'
import {isOvertakenByServerWrite, serverWriteMark} from '@/client/queries/taskCache'
import {useQueryClient} from '@tanstack/vue-query'

const props = defineProps<{
	taskId: number,
	backdropView?: RouteLocation['fullPath'],
}>()

const emit = defineEmits<{
	'close': [],
}>()

const router = useRouter()
const route = useRoute()
const alive = useIsAlive()
const {t} = useI18n({useScope: 'global'})

const projectList = useProjects()
const queryClient = useQueryClient()
const updateTask = useUpdateTaskMutation()
const deleteTaskMutation = useDeleteTaskMutation()
const favoriteTask = useFavoriteTaskMutation()
const duplicateTask = useDuplicateTaskMutation()
const markTaskRead = useMarkTaskReadMutation()
const subscriptionMutation = useSetTaskSubscriptionMutation()
const configStore = useConfigStore()
const authStore = useAuthStore()
const timeTrackingEnabled = computed(() => configStore.isProFeatureEnabled(PRO_FEATURE.TIME_TRACKING)
	&& !authStore.isLinkShareAuth)
const baseStore = useBaseStore()

const taskQuery = useTask(
	() => props.taskId ?? 0,
	() => [
		'reactions',
		'is_unread',
		'buckets',
		...(timeTrackingEnabled.value ? ['time_entries_count' as const] : []),
	],
)
const task = ref(createTaskDraft())

// The server values the draft was last reconciled with: a field that differs from them is an unsaved local edit.
let draftBaseline = draftValues(createTaskDraft())

// The colour picker writes `taskColor`, so it is the local value of hex_color; task.hex_color shows the server's.
function localDraft(): DraftValues {
	return {
		...draftValues(task.value),
		hex_color: taskColor.value,
	}
}

function seedTask(loaded: ITask) {
	task.value = createTaskDraft(klona(loaded))
	taskColor.value = task.value.hex_color ?? ''
	draftBaseline = draftValues(task.value)
}

// Fields the user is editing keep their local value; every other field shows the server's.
function followServerTask(loaded: ITask) {
	const server = createTaskDraft(klona(loaded))
	taskColor.value = followServerValue('hex_color', taskColor.value, draftBaseline.hex_color, server.hex_color) ?? ''
	task.value = mergeServerDraft(task.value, draftBaseline, server)
	draftBaseline = draftValues(server)
	revealFilledFields()
}

function dateInput(key: 'due_date' | 'start_date' | 'end_date') {
	return computed({
		// The same instant keeps its Date: a new one resets an open picker on every live update.
		get: (previous?: Date | null) => {
			const date = parseDateOrNull(task.value[key])
			return date && previous && date.getTime() === previous.getTime() ? previous : date
		},
		set: (date: Date | string | null) => {
			task.value[key] = parseDateOrNull(date)?.toISOString() ?? ''
		},
	})
}
const dueDateInput = dateInput('due_date')
const startDateInput = dateInput('start_date')
const endDateInput = dateInput('end_date')
const hasAttachments = computed(() => (task.value.attachments?.length ?? 0) > 0)
const remindersDefaultRelativeTo = computed(() => {
	if (parseDateOrNull(task.value.due_date)) {
		return REMINDER_PERIOD_RELATIVE_TO_TYPES.DUEDATE
	}
	if (parseDateOrNull(task.value.start_date)) {
		return REMINDER_PERIOD_RELATIVE_TO_TYPES.STARTDATE
	}
	if (parseDateOrNull(task.value.end_date)) {
		return REMINDER_PERIOD_RELATIVE_TO_TYPES.ENDDATE
	}
	return null
})
const taskNotFound = ref(false)
const taskTitle = computed(() => task.value.title)
useTitle(taskTitle)

const lastProject = computed(() => {
	const backRoute = router.options.history.state?.back
	if (!backRoute || typeof backRoute !== 'string') {
		return null
	}

	const projectMatch = backRoute.match(/\/projects\/(-?\d+)/)
	if (!projectMatch || !projectMatch[1]) {
		return null
	}

	const id = parseInt(projectMatch[1])

	return projectList.projects[id] ?? null
})

const lastProjectOrTaskProject = computed(() => lastProject.value ?? project.value)

onBeforeRouteLeave(async () => {
	if (taskNotFound.value) {
		return
	}

	if (!lastProjectOrTaskProject.value) {
		await new Promise<void>((resolve) => {
			const timeout = setTimeout(() => {
				stop()
				resolve()
			}, 5000) // 5 second timeout

			const stop = watch(lastProjectOrTaskProject, (p) => {
				if (p) {
					clearTimeout(timeout)
					stop()
					resolve()
				}
			})
		})
	}

	if (lastProjectOrTaskProject.value) {
		baseStore.setCurrentProjectIfNotSet(lastProjectOrTaskProject.value)
	}
})

// We doubled the task color property here because verte does not have a real change property, leading
// to the color property change being triggered when the # is removed from it, leading to an update,
// which leads in turn to a change... This creates an infinite loop in which the task is updated, changed,
// updated, changed, updated and so on.
// To prevent this, we put the task color property in a separate value which is set to the task color
// when it is saved and loaded.
const taskColor = ref('')

// Used to avoid flashing of empty elements if the task content is not yet loaded.
const visible = ref(false)
const loadFailed = ref(false)

// Deleted elsewhere (an Arona receipt) while open: say so instead of routing to not-found or staying editable.
const deletedTaskId = ref<number>()
const isDeleted = computed(() => deletedTaskId.value !== undefined && deletedTaskId.value === props.taskId)

// The previous task stays on screen until the next one arrives.
const isSwitchingTask = computed(() => visible.value && task.value.id !== props.taskId)

const project = computed(() => projectList.projects[task.value.project_id ?? 0])

const projectRoute = computed(() => ({
	name: 'project.index',
	params: {projectId: task.value.project_id},
	hash: route.hash,
}))

function projectLocation(p: ProjectResponse): RouteLocationRaw {
	return {
		name: 'project.index',
		params: {projectId: p.id},
	}
}

function backReturnsTo(p: ProjectResponse) {
	const back = router.options.history.state.back
	return typeof back === 'string' && back.includes(`/projects/${p.id}/`)
}

const leaveDeletedTaskLabel = computed(() => {
	if (isModal.value) return t('task.detail.closeTaskDetail')
	return task.value.project_id ? t('task.detail.back') : t('task.detail.deletedGoBack')
})

function leaveDeletedTask() {
	if (isModal.value) {
		emit('close')
		return
	}
	if (lastProject.value || !task.value.project_id) {
		router.back()
		return
	}
	router.push(projectRoute.value)
}

const canWrite = computed(() => (
	(taskQuery.task.value?.max_permission ?? 0) > PERMISSIONS.READ
))

// Daily routine: while enabled, today's check-in replaces Done and ordinary repeating is off. Neither the
// done flag nor the repeat settings are ever changed for it; the user clears them explicitly first.
const {now} = useGlobalNow()
const routineCheckIn = useRoutineCheckIn()
const taskRoutine = computed(() => routineOf(task.value))
const isRoutine = computed(() => taskRoutine.value?.enabled === true)
// A routine that was turned off keeps its configuration and history.
const hasRoutineRecord = computed(() => (taskRoutine.value?.revision ?? 0) > 0)
const routineState = computed(() => routineStatus(taskRoutine.value, now.value))
const routineCheckingIn = computed(() => routineCheckIn.isPending(task.value.id))
const routinePausedNoteId = useId()

// The API refuses routine writes in an archived project (or below an archived parent).
const isProjectArchived = computed(() => {
	const current = project.value
	return current ? projectList.getAncestors(current).some(p => p.is_archived) : false
})
const canEditRoutine = computed(() => canWrite.value && !isProjectArchived.value)

const routineButtonIcon = computed<IconProp>(() => {
	switch (routineState.value) {
		case 'done': return 'circle-check'
		case 'paused': return 'pause'
		default: return ['far', 'sun']
	}
})

function toggleRoutineCheckIn() {
	if (!canEditRoutine.value || routineCheckingIn.value || routineState.value === 'paused') return
	void routineCheckIn.setCheckedIn(task.value, routineState.value !== 'done')
}

const routinePanel = useTemplateRef<InstanceType<typeof TaskRoutinePanel>>('routinePanel')
// Set from the actions rail on a task without a routine yet; tied to that task so the next one starts closed.
const routinePanelTaskId = ref<number>()
const showRoutinePanel = computed(() => isRoutine.value
	|| hasRoutineRecord.value
	|| (canEditRoutine.value && routinePanelTaskId.value === task.value.id))

async function openRoutinePanel() {
	routinePanelTaskId.value = task.value.id
	await nextTick()
	const panel = routinePanel.value
	if (!panel) return
	if (canEditRoutine.value) panel.openSetup()
	const el: unknown = panel.$el
	if (!(el instanceof HTMLElement)) return
	el.focus({preventScroll: true})
	scrollIntoView(el)
}

function openRepeat() {
	if (isRoutine.value) return
	setFieldActive('repeatAfter')
}

function reopenForRoutine() {
	if (isFieldPending('done') || !task.value.done) return
	return setTaskDone(task.value.id, false)
}

function removeRepeatForRoutine() {
	if (isFieldPending('repeatAfter')) return
	return removeRepeatAfter()
}

const color = computed(() => getHexColor(task.value.hex_color))

const favoriteLabel = computed(() => task.value.is_favorite
	? t('task.detail.actions.unfavorite')
	: t('task.detail.actions.favorite'))

const isModal = computed(() => Boolean(props.backdropView))

const heading = ref<InstanceType<typeof Heading> | null>(null)
const descriptionRef = ref<InstanceType<typeof Description> | null>(null)

async function scrollToHeading() {
	const element: unknown = heading.value?.$el
	scrollIntoView(element instanceof HTMLElement ? element : null)
}

const attachmentsRef = ref<InstanceType<typeof Attachments> | null>(null)
const relatedTasksRef = ref<InstanceType<typeof RelatedTasks> | null>(null)

const taskViewContainer = ref<HTMLElement | null>(null)
const scrollContainer = ref<HTMLElement | null>(null)
const contentBottomMarker = ref<HTMLElement | null>(null)
const bottomMarkerVisible = ref(true)
const isScrollable = ref(false)

// Measured on the view itself, not the viewport: the sidebar and the modal both change the room available.
const WIDE_LAYOUT_MIN_WIDTH = 720
const {width: containerWidth} = useElementSize(taskViewContainer)
const isWideLayout = computed(() => containerWidth.value >= WIDE_LAYOUT_MIN_WIDTH)

const actionRailId = useId()
const actionRail = ref<HTMLElement | null>(null)

function showAllActions() {
	const rail = actionRail.value
	if (!rail) {
		return
	}

	rail.scrollIntoView({
		behavior: smoothScrollBehavior(),
		block: 'start',
	})
	rail.querySelector<HTMLElement>('.action-group .button')?.focus({preventScroll: true})
}

function resolveScrollContainer() {
	// Null after unmount; deferred callers must not fall back to `document` then.
	if (!taskViewContainer.value) {
		return
	}

	scrollContainer.value = getScrollParent(taskViewContainer.value)
}

function updateScrollable() {
	const scroller = scrollContainer.value
	if (!scroller) {
		isScrollable.value = false
		return
	}

	isScrollable.value = scroller.scrollHeight > scroller.clientHeight + 1
}

const showScrollToCommentsButton = computed(() => {
	return isScrollable.value && !bottomMarkerVisible.value
})

function scrollToBottom() {
	if (!contentBottomMarker.value) {
		return
	}

	contentBottomMarker.value.scrollIntoView({
		behavior: smoothScrollBehavior(),
		block: 'end',
		inline: 'nearest',
	})
}

useIntersectionObserver(
	contentBottomMarker,
	([entry]) => {
		bottomMarkerVisible.value = entry?.isIntersecting ?? true
	},
	{threshold: 0.1},
)

const debouncedMutationHandler = useDebounceFn(async () => {
	await nextTick()
	resolveScrollContainer()
	updateScrollable()
}, 100)

useMutationObserver(
	taskViewContainer,
	debouncedMutationHandler,
	{subtree: true, childList: true},
)
onBeforeUnmount(() => debouncedMutationHandler.cancel())

const {height: scrollContainerHeight} = useElementSize(scrollContainer)
watch(scrollContainerHeight, () => updateScrollable())

onMounted(async () => {
	await nextTick()
	resolveScrollContainer()
	updateScrollable()
})

type FieldType =
	| 'assignees'
	| 'attachments'
	| 'color'
	| 'dueDate'
	| 'endDate'
	| 'labels'
	| 'moveProject'
	| 'percentDone'
	| 'priority'
	| 'relatedTasks'
	| 'reminders'
	| 'repeatAfter'
	| 'startDate'
	| 'timeTracking'

type PendingField = FieldType | 'done'

const activeFields: { [type in FieldType]: boolean } = reactive({
	assignees: false,
	attachments: false,
	color: false,
	dueDate: false,
	endDate: false,
	labels: false,
	moveProject: false,
	percentDone: false,
	priority: false,
	relatedTasks: false,
	reminders: false,
	repeatAfter: false,
	startDate: false,
	timeTracking: false,
})

const PANEL_FIELDS: FieldType[] = [
	'assignees',
	'priority',
	'dueDate',
	'percentDone',
	'startDate',
	'endDate',
	'color',
	'reminders',
	'repeatAfter',
	'labels',
]
const hasFieldPanel = computed(() => PANEL_FIELDS.some(field => activeFields[field]))

// Counted per task and field: a second save of the same field must not clear the first one's pending state,
// and a save still running for the previous task must not mark the same field of the next one.
const pendingSaves = reactive(new Map<string, number>())
const showPendingSaves = useDelayedLoading(() => pendingSaves.size > 0)

function pendingKey(id: number, field: PendingField) {
	return `${id}:${field}`
}

function isFieldPending(field: PendingField) {
	return pendingSaves.has(pendingKey(task.value.id, field))
}

function isFieldSaving(field: PendingField) {
	return showPendingSaves.value && isFieldPending(field)
}

function filledFields(): Partial<Record<FieldType, boolean>> {
	return {
		assignees: (task.value.assignees?.length ?? 0) > 0,
		attachments: (task.value.attachments?.length ?? 0) > 0,
		timeTracking: (task.value.time_entries_count ?? 0) > 0,
		dueDate: Boolean(parseDateOrNull(task.value.due_date)),
		endDate: Boolean(parseDateOrNull(task.value.end_date)),
		labels: (task.value.labels?.length ?? 0) > 0,
		percentDone: (task.value.percent_done ?? 0) > 0,
		priority: task.value.priority !== PRIORITIES.UNSET,
		relatedTasks: Object.keys(task.value.related_tasks ?? {}).length > 0,
		reminders: (task.value.reminders?.length ?? 0) > 0,
		repeatAfter: (task.value.repeat_after ?? 0) > 0
			|| task.value.repeat_mode !== TASK_REPEAT_MODES.REPEAT_MODE_DEFAULT,
		startDate: Boolean(parseDateOrNull(task.value.start_date)),
	}
}

function setActiveFields() {
	Object.assign(activeFields, filledFields())
}

// A value set elsewhere (Arona, another tab) shows up; a field the user is looking at never disappears.
function revealFilledFields() {
	for (const [field, filled] of Object.entries(filledFields())) {
		if (filled) activeFields[field as FieldType] = true
	}
}

watch(taskQuery.task, async (loaded) => {
	if (!loaded) return
	const isNewTask = loaded.id !== task.value.id
	if (isNewTask) {
		seedTask(loaded)
		setActiveFields()
	} else {
		followServerTask(loaded)
	}
	if (deletedTaskId.value === loaded.id) deletedTaskId.value = undefined
	if (loaded.is_unread) markTaskRead.mutateAsync(loaded.id).catch(() => {})
	if (lastProject.value) baseStore.setCurrentProjectIfNotSet(lastProject.value)
	await nextTick()
	if (isNewTask) scrollToHeading()
	resolveScrollContainer()
	updateScrollable()
	loadFailed.value = false
	visible.value = true
}, {immediate: true})
watch(taskQuery.error, cause => {
	if (!cause) return
	const action = taskLoadErrorAction(cause)
	if (action === 'ignore') return
	if (action === 'deleted') {
		deletedTaskId.value = props.taskId
		showDeleteModal.value = false
		if (!deleteTaskMutation.isPending.value) deleteConfirmation.value = undefined
		return
	}
	// The deleted query left the cache, so a later refetch answers with the API's own 404.
	if (isDeleted.value) return
	if (action === 'notFound') {
		taskNotFound.value = true
		router.replace({name: 'not-found'})
		return
	}
	// Nothing to show yet: the inline error with Retry replaces the skeleton. Otherwise keep the task on screen.
	if (!visible.value) {
		loadFailed.value = true
		return
	}
	error(cause)
})

function retryLoad() {
	loadFailed.value = false
	taskQuery.refetch()
}

const activeFieldElements: { [id in FieldType]: HTMLElement | null } = reactive({
	assignees: null,
	attachments: null,
	color: null,
	dueDate: null,
	endDate: null,
	labels: null,
	moveProject: null,
	percentDone: null,
	priority: null,
	relatedTasks: null,
	reminders: null,
	repeatAfter: null,
	startDate: null,
	timeTracking: null,
})

const dueDatePicker = useTemplateRef<InstanceType<typeof Datepicker>>('dueDatePicker')
const startDatePicker = useTemplateRef<InstanceType<typeof Datepicker>>('startDatePicker')
const endDatePicker = useTemplateRef<InstanceType<typeof Datepicker>>('endDatePicker')

function setFieldRef(name: FieldType, e: Element | ComponentPublicInstance | null) {
	const element = e instanceof Element ? e : e?.$el
	activeFieldElements[name] = element instanceof HTMLElement ? element : null
}

function setFieldActive(fieldName: keyof typeof activeFields) {
	activeFields[fieldName] = true
	nextTick(() => {
		let datepicker: InstanceType<typeof Datepicker> | null = null
		switch (fieldName) {
			case 'dueDate':
				datepicker = dueDatePicker.value
				break
			case 'startDate':
				datepicker = startDatePicker.value
				break
			case 'endDate':
				datepicker = endDatePicker.value
				break
		}
		const el: HTMLElement | null = datepicker?.$el ?? activeFieldElements[fieldName]

		if (!el) {
			return
		}

		el.focus()

		// Finish scrolling before the datepicker sheet locks the page.
		scrollIntoView(el, datepicker ? 'instant' : 'smooth')

		datepicker?.open()
	})
}

function openAttachments() {
	activeFields.attachments = true
	nextTick(() => {
		const el = activeFieldElements.attachments
		if (el) {
			scrollIntoView(el)
		}
		attachmentsRef.value?.openFilePicker()
	})
}

// A save sends only the given changes plus the user's other unsaved edits, so values another client or Arona
// wrote in the meantime are never overwritten with what this view loaded earlier.
type SaveOutcome = 'none' | 'saved' | 'failed'

async function saveTask(
	changes: Partial<ITask> = {},
	undoCallback?: () => void,
	id = task.value.id,
): Promise<SaveOutcome> {
	if (!canWrite.value || !id) {
		return 'none'
	}

	const isShowing = () => props.taskId === id && task.value.id === id
	const submitted: Partial<ITask> = {
		...(isShowing() ? unsavedDraftChanges(localDraft(), draftBaseline) : {}),
		...klona(changes),
	}
	if (Object.keys(submitted).length === 0) {
		// Only the save shortcut gets here: every field saves itself, so nothing is left to send.
		return 'none'
	}

	let saved: ITask
	const mark = serverWriteMark()
	try {
		saved = await updateTask.mutateAsync({...submitted, id})
	} catch {
		if (isShowing()) saveFailedFor.value = id
		return 'failed'
	}

	// The response of a task the view has since left must never reach the next one.
	if (isShowing()) {
		settleSave(submitted, saved, mark)
		setActiveFields()
		// Every save also sends the other unsaved fields, so nothing is left unsaved now.
		if (saveFailedFor.value === id) saveFailedFor.value = null
	}

	let actions: MessageAction[] = []
	if (undoCallback) {
		actions = [{
			title: t('task.undo'),
			callback: undoCallback,
		}]
	}
	success({message: t('task.detail.updateSuccess')}, actions)
	return 'saved'
}

// Ctrl/⌘+S: send the title and description still being typed plus any other unsaved field, and only claim a
// save when something was actually sent and accepted.
async function saveFromShortcut() {
	if (!canWrite.value) return
	const id = task.value.id
	const [title, description] = await Promise.all([
		heading.value?.flush() ?? Promise.resolve<SaveOutcome>('none'),
		descriptionRef.value?.flush() ?? Promise.resolve<SaveOutcome>('none'),
	])
	const fields = await saveTask({}, undefined, id)
	if (fields !== 'none' || props.taskId !== id) return
	const outcomes = [title, description]
	if (outcomes.includes('failed')) return
	success({
		message: outcomes.includes('saved')
			? t('task.detail.updateSuccess')
			: t('task.detail.nothingToSave'),
	})
}

function settleSave(submitted: Partial<ITask>, saved: ITask, mark: number) {
	draftBaseline = settleSubmitted(localDraft(), draftBaseline, submitted)
	const cached = taskQuery.task.value ?? task.value
	// The query may not have picked up the patched cache yet, so the response usually leads. A receipt
	// that arrived while the PATCH was in flight is newer still, and must not be undone.
	followServerTask(isOvertakenByServerWrite(queryClient, saved, mark) ? cached : mergeTask(cached, saved))
}

// A field whose save failed keeps showing the new value (the local draft sends it again with the next save).
// Say which fields are not saved, offer a retry, and ask before leaving the task drops them.
const saveFailedFor = ref<number | null>(null)
const DRAFT_FIELD_LABELS: Record<DraftField, string> = {
	priority: 'task.attributes.priority',
	percent_done: 'task.attributes.percentDone',
	due_date: 'task.attributes.dueDate',
	start_date: 'task.attributes.startDate',
	end_date: 'task.attributes.endDate',
	reminders: 'task.attributes.reminders',
	repeat_after: 'task.attributes.repeat',
	repeat_mode: 'task.attributes.repeat',
	hex_color: 'task.attributes.color',
}
const unsavedFieldLabels = computed(() => {
	if (saveFailedFor.value === null || saveFailedFor.value !== task.value.id) return []
	const fields = Object.keys(unsavedDraftChanges(localDraft(), draftBaseline)) as DraftField[]
	return [...new Set(fields.map(field => t(DRAFT_FIELD_LABELS[field])))]
})
const hasUnsavedFailedFields = computed(() => unsavedFieldLabels.value.length > 0)
const {leaveTarget, stay, discardAndLeave} = useUnsavedLeaveGuard(hasUnsavedFailedFields)

function retryFailedSave() {
	return saveTask({}, undefined, task.value.id)
}

// Pending state stays on the field being saved; the rest of the view stays usable.
async function saveField(
	field: PendingField,
	changes: Partial<ITask>,
	undoCallback?: () => void,
	id = task.value.id,
) {
	const key = pendingKey(id, field)
	pendingSaves.set(key, (pendingSaves.get(key) ?? 0) + 1)
	try {
		await saveTask(changes, undoCallback, id)
	} finally {
		const remaining = (pendingSaves.get(key) ?? 1) - 1
		if (remaining > 0) {
			pendingSaves.set(key, remaining)
		} else {
			pendingSaves.delete(key)
		}
	}
}

const DATE_FIELD_KEYS = {
	dueDate: 'due_date',
	startDate: 'start_date',
	endDate: 'end_date',
} as const

function saveDate(field: keyof typeof DATE_FIELD_KEYS) {
	const key = DATE_FIELD_KEYS[field]
	const changes: Partial<ITask> = {}
	changes[key] = task.value[key]
	return saveField(field, changes)
}

// Clearing never copies another date into the cleared one; readers fall back to the due date themselves.
function clearDate(field: keyof typeof DATE_FIELD_KEYS) {
	task.value[DATE_FIELD_KEYS[field]] = ''
	return saveDate(field)
}

function saveColor() {
	return saveField('color', {hex_color: taskColor.value})
}

function saveReminders() {
	return saveField('reminders', {reminders: task.value.reminders})
}

function saveRepeat(value: ITask | undefined) {
	if (!value || isRoutine.value) return
	task.value.repeat_after = value.repeat_after ?? 0
	task.value.repeat_mode = value.repeat_mode ?? TASK_REPEAT_MODES.REPEAT_MODE_DEFAULT
	return saveField('repeatAfter', {
		repeat_after: task.value.repeat_after,
		repeat_mode: task.value.repeat_mode,
	})
}

useTaskDetailShortcuts({
	task: () => task.value,
	taskTitle: () => taskTitle.value,
	onSave: () => saveFromShortcut(),
})

const showDeleteModal = ref(false)
const deleteConfirmation = shallowRef<{
	id: number,
	projectId: number,
	request: ClientRequestContext,
	route: typeof router.currentRoute.value,
}>()

function openDeleteModal() {
	if (deleteTaskMutation.isPending.value || !canWrite.value || isDeleted.value || task.value.id !== props.taskId) return
	deleteConfirmation.value = {
		id: task.value.id,
		projectId: task.value.project_id,
		request: captureClientRequestContext(),
		route: router.currentRoute.value,
	}
	showDeleteModal.value = true
}

function closeDeleteModal() {
	showDeleteModal.value = false
	deleteConfirmation.value = undefined
}

// A confirmation belongs to this task and this visit, including leaving and returning to the same id.
watch([() => props.taskId, () => router.currentRoute.value], closeDeleteModal, {flush: 'sync'})

async function deleteTask() {
	if (deleteTaskMutation.isPending.value) return
	const confirmation = deleteConfirmation.value
	if (!showDeleteModal.value || !confirmation) return
	const isCurrent = () => alive.value && deleteConfirmation.value === confirmation
		&& props.taskId === confirmation.id && task.value.id === confirmation.id
		&& router.currentRoute.value === confirmation.route && isClientRequestContextCurrent(confirmation.request)
	if (!isCurrent()) {
		closeDeleteModal()
		return
	}
	const {id, projectId} = confirmation
	try {
		await deleteTaskMutation.mutateAsync(id)
	} catch {
		return
	}
	if (!isCurrent()) return
	success({message: t('task.detail.deleteSuccess')})
	closeDeleteModal()
	// Back to where the task was opened from (Home, Upcoming, a board behind the dialog), not always its project,
	// so the browser's Back button does not lead to the deleted task's 404 page either.
	if (isModal.value) {
		emit('close')
		return
	}
	const back = router.options.history.state.back
	if (typeof back === 'string' && !back.startsWith(`/tasks/${id}`)) {
		router.back()
		return
	}
	router.push({name: 'project.index', params: {projectId}})
}

async function setTaskDone(id: number, done: boolean) {
	if (done) {
		playPopSound()
	}

	await saveField(
		'done',
		{done},
		() => setTaskDone(id, !done),
		id,
	)
}

function toggleTaskDone() {
	// The whole view no longer blocks input while saving, so a double click must not undo itself.
	if (isFieldPending('done')) return
	return setTaskDone(task.value.id, !task.value.done)
}

async function changeProject(project: ProjectResponse | null) {
	if (project === null) {
		return
	}
	const id = task.value.id
	await saveField('moveProject', {project_id: project.id})
	if (props.taskId !== id || task.value.project_id !== project.id) return
	baseStore.setCurrentProject(project)
}

function toggleSubscription(subscribed: boolean) {
	if (subscriptionMutation.isPending.value) return
	subscriptionMutation.mutate({taskId: task.value.id!, subscribed})
}

async function toggleFavorite() {
	if (favoriteTask.isPending.value) return
	await favoriteTask.mutateAsync({...task.value, id: task.value.id!})
}

async function duplicateCurrentTask() {
	if (duplicateTask.isPending.value) return
	const id = task.value.id
	let duplicatedTask: ITask | undefined
	try {
		duplicatedTask = await duplicateTask.mutateAsync(id)
	} catch {
		return
	}
	if (duplicatedTask) {
		success({message: t('task.detail.duplicateSuccess')})
		if (props.taskId !== id) return
		router.push({
			name: 'task.detail',
			params: {id: duplicatedTask.id},
		})
	}
}

function setPriority(priority: number) {
	return saveField('priority', {priority})
}

const percentDoneSavingId = ref<number>()
const percentDoneSaving = computed(() => percentDoneSavingId.value !== undefined
	&& percentDoneSavingId.value === task.value.id)

async function setPercentDone(percentDone: number) {
	if (!canWrite.value || percentDoneSaving.value) return
	if (percentDone === task.value.percent_done) {
		activeFields.percentDone = percentDone > 0
		return
	}
	const taskId = task.value.id
	percentDoneSavingId.value = taskId
	try {
		const mark = serverWriteMark()
		const updated = await updateTask.mutateAsync({id: taskId, percent_done: percentDone})
		if (props.taskId !== taskId || task.value.id !== taskId) return
		settleSave({percent_done: percentDone}, updated, mark)
		activeFields.percentDone = (task.value.percent_done ?? 0) > 0
		success({message: t('task.detail.updateSuccess')})
	} catch {
		// The mutation already reported the failure.
	} finally {
		if (percentDoneSavingId.value === taskId) percentDoneSavingId.value = undefined
	}
}

async function removeRepeatAfter() {
	task.value.repeat_after = 0
	task.value.repeat_mode = TASK_REPEAT_MODES.REPEAT_MODE_DEFAULT
	await saveField('repeatAfter', {
		repeat_after: 0,
		repeat_mode: TASK_REPEAT_MODES.REPEAT_MODE_DEFAULT,
	})
}

function setRelatedTasksActive() {
	setFieldActive('relatedTasks')
	relatedTasksRef.value?.openNewRelationForm()
}
</script>

<style lang="scss" scoped>
.task-view-container {
	// CustomTransition's flash-background reads this when a field appears.
	--primary-light: var(--surface-selected-strong);
	--task-rail-width: clamp(16.5rem, 26%, 19.5rem);

	padding-block-end: var(--space-4);
}

.task-view {
	padding: var(--space-4) var(--space-2) var(--space-6);
	background-color: var(--surface-app);
	color: var(--text-primary);
	transition: opacity var(--motion-fast) var(--ease-standard);

	@media screen and (min-width: $tablet) {
		padding-inline: var(--space-4);
	}

	&.is-switching {
		opacity: .6;
	}
}

.is-modal .task-view {
	border-radius: var(--radius-lg);
	padding: var(--space-5);
	background-color: var(--surface-app) !important;

	@media screen and (max-width: $tablet) {
		padding: var(--space-4) var(--space-3) var(--space-6);
	}

	@media screen and (width <= calc(#{$desktop} + 1px)) {
		border-radius: 0;
	}
}

// First load only: once a task is on screen it stays there through every refetch and save.
.task-view-skeleton {
	display: flex;
	flex-direction: column;
	gap: var(--space-6);
	padding: var(--space-4) var(--space-2);

	@media screen and (min-width: $tablet) {
		padding-inline: var(--space-4);
	}
}

.task-view-skeleton__header,
.task-view-skeleton__main {
	display: flex;
	flex-direction: column;
	gap: var(--space-3);
}

.task-view-skeleton__layout {
	display: grid;
	gap: var(--space-6);

	.is-wide & {
		grid-template-columns: minmax(0, 1fr) var(--task-rail-width);
	}
}

.skeleton-block {
	display: block;
	border-radius: var(--radius-sm);
	background: var(--surface-active);

	&--chip {
		inline-size: 5rem;
		block-size: var(--target-min);
		border-radius: var(--radius-full);
	}

	&--title {
		inline-size: min(28rem, 80%);
		block-size: 1.75rem;
	}

	&--meta {
		inline-size: min(18rem, 60%);
		block-size: 1rem;
	}

	&--panel {
		block-size: 5.5rem;
		border-radius: var(--radius-md);
	}

	&--line {
		block-size: .875rem;

		&.is-short {
			inline-size: 60%;
		}
	}

	&--rail {
		display: none;
		block-size: 20rem;
		border-radius: var(--radius-md);

		.is-wide & {
			display: block;
		}
	}
}

.task-view-load-error {
	margin: var(--space-4) var(--space-2);
}

.task-fields-not-saved {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: var(--space-1) var(--space-2);
	margin-block-end: var(--space-3);
	padding: var(--space-2) var(--space-3);
	border-inline-start: 3px solid var(--danger);
	border-radius: var(--radius-md);
	background: var(--tint-danger);
	color: var(--text-primary);
	font-size: var(--text-sm);
}

.task-fields-not-saved__retry {
	min-block-size: var(--target-min, 2rem);
	font-weight: var(--weight-medium);
	text-decoration: underline;
}

.task-view-deleted {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: var(--space-2) var(--space-3);
	margin: var(--space-4) var(--space-2);
	padding: var(--space-3) var(--space-4);
	border: 1px solid var(--border-subtle);
	border-inline-start: 3px solid var(--warning);
	border-radius: var(--radius-md);
	background: var(--tint-warning);
	color: var(--text-primary);
	font-size: var(--text-md);
}

.task-view-deleted__message {
	display: flex;
	flex: 1 1 14rem;
	align-items: center;
	gap: var(--space-2);
	margin: 0;
}

.task-view-deleted__icon {
	color: var(--text-secondary);
}

// Header band: identifier, title, breadcrumb and the quick actions
.task-header {
	display: flex;
	flex-direction: column;
	gap: var(--space-2);
	margin-block-end: var(--space-5);
}

// Keep the title clear of the modal's fixed close button while it sits inside the modal.
.is-modal .task-header {
	@media screen and (min-width: $tablet) and (width <= #{$desktop + $close-button-min-space}) {
		padding-inline-end: 3rem;
	}
}

.back-button {
	align-self: flex-start;
	display: inline-flex;
	align-items: center;
	gap: var(--space-2);
	min-block-size: var(--target-min);
	margin-inline-start: calc(-1 * var(--space-1));
	padding-inline: var(--space-1);
	border-radius: var(--radius-sm);
	color: var(--text-secondary);
	font-size: var(--text-sm);
	font-weight: var(--weight-medium);
	transition: color var(--motion-fast) var(--ease-standard);

	&:hover {
		color: var(--text-primary);
	}
}

.task-header__bar {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	justify-content: space-between;
	gap: var(--space-3) var(--space-4);
}

.task-header__meta {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: var(--space-1) var(--space-4);
	min-inline-size: 0;
}

.task-header .task-breadcrumb {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: var(--space-1);
	margin: 0;
	color: var(--text-secondary);
	font-size: var(--text-md);
	font-weight: var(--weight-regular);
	line-height: var(--leading-normal);

	a {
		border-radius: var(--radius-xs);
		color: var(--text-secondary);
		text-decoration: none;

		&:hover {
			color: var(--text-primary);
			text-decoration: underline;
		}
	}
}

.task-breadcrumb__separator {
	font-size: var(--text-2xs);
	color: var(--text-tertiary);
}

.task-header .checklist-summary {
	color: var(--text-secondary);
	font-size: var(--text-sm);
}

.task-primary-actions {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: var(--space-2);

	.button {
		min-block-size: var(--control-height-sm);
		font-size: var(--text-sm);
	}

	.button.is-icon-only,
	.task-subscription-button {
		min-inline-size: var(--control-height-sm);
		padding-inline: var(--space-2);
		gap: 0;
	}

	// Subscription.vue always renders its label; the icon and tooltip carry it here, the name stays for AT.
	:deep(.task-subscription-button > span:not(.icon)) {
		position: absolute;
		inline-size: 1px;
		block-size: 1px;
		margin: -1px;
		padding: 0;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
		border: 0;
	}
}

.task-primary-actions .button--mark-done,
.task-primary-actions .button--routine-check-in {
	--done-accent: color-mix(in srgb, var(--success) 70%, var(--text-primary));

	:deep(.icon) {
		color: var(--done-accent);
	}

	&:hover {
		border-color: var(--done-accent);
	}

	&:not(.is-pending) {
		border-color: hsla(var(--success-h), var(--success-s), var(--success-l), .45);
		background-color: var(--tint-success);
	}

	@media screen and (max-width: $tablet) {
		flex: 1 0 auto;
	}
}

// Paused: the check-in stays visible but inert, and this note next to it says why.
.task-primary-actions__note {
	display: inline-flex;
	align-items: center;
	gap: var(--space-1);
	color: var(--text-secondary);
	font-size: var(--text-sm);

	.icon,
	svg {
		inline-size: .75rem;
		color: var(--text-tertiary);
	}

	@media screen and (max-width: $tablet) {
		flex-basis: 100%;
		order: 1;
	}
}

.detail-field-note {
	margin: var(--space-2) 0 0;
	color: var(--text-secondary);
	font-size: var(--text-sm);
}

// Content and properties rail
.task-layout.columns {
	display: grid;
	grid-template-columns: minmax(0, 1fr);
	align-items: start;
	gap: var(--space-6);
	margin: 0;

	.is-wide & {
		grid-template-columns: minmax(0, 1fr) var(--task-rail-width);
	}

	> .column {
		inline-size: auto;
		min-inline-size: 0;
		padding: 0;
	}

	@media print {
		grid-template-columns: minmax(0, 1fr) !important;
	}
}

.task-view .detail-content {
	display: flex;
	flex-direction: column;
	gap: var(--space-6);

	> * {
		margin-block: 0;
	}

	@media print {
		inline-size: 100% !important;
	}
}

.task-fields {
	border: 1px solid var(--border-subtle);
	border-radius: var(--radius-md);
	background: var(--surface);
	box-shadow: var(--elevation-1);
}

.task-view .columns.details {
	display: grid;
	grid-template-columns: repeat(auto-fill, minmax(min(100%, 11rem), 1fr));
	gap: 0;
	margin: 0;
	padding: var(--space-1);

	&:empty {
		display: none;
	}

	> .column {
		min-inline-size: 0;
		padding: var(--space-2) var(--space-3) var(--space-3);
		border-radius: var(--radius-sm);
	}

	> .is-full-row {
		grid-column: 1 / -1;
	}
}

.task-fields .labels-list {
	padding: var(--space-2) var(--space-4) var(--space-3);
	border-block-start: 1px solid var(--border-subtle);
}

.task-fields .columns.details:empty + .labels-list {
	border-block-start: 0;
}

.detail-title {
	display: flex;
	align-items: center;
	gap: var(--space-2);
	min-block-size: 1.25rem;
	margin-block-end: var(--space-1);
	color: var(--text-secondary);
	font-size: var(--text-sm);
	font-weight: var(--weight-semibold);
	line-height: var(--leading-tight);

	> svg,
	> .icon {
		inline-size: .875rem;
		color: var(--text-tertiary);
		font-size: var(--text-xs);
	}
}

.detail-title__saving,
.detail-title__action {
	margin-inline-start: auto;
}

.detail-title__saving + .detail-title__action {
	margin-inline-start: 0;
}

.detail-title > .detail-title__saving {
	color: var(--text-tertiary);
}

.date-input {
	display: flex;
	align-items: center;
	gap: var(--space-1);
}

.progress-input {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: var(--space-1) var(--space-3);
}

.remove {
	display: inline-flex;
	flex-shrink: 0;
	align-items: center;
	justify-content: center;
	inline-size: max(1.5rem, var(--target-min));
	block-size: max(1.5rem, var(--target-min));
	border-radius: var(--radius-sm);
	color: var(--text-tertiary);
	font-size: var(--text-xs);
	transition:
		background-color var(--motion-fast) var(--ease-standard),
		color var(--motion-fast) var(--ease-standard);

	&:hover {
		background: var(--tint-danger);
		color: var(--danger-text);
	}
}

.remove-progress {
	display: inline-flex;
	align-items: center;
	gap: var(--space-1);
	min-block-size: var(--target-min);
	padding-inline: var(--space-1);
	border-radius: var(--radius-sm);
	color: var(--text-secondary);
	font-size: var(--text-sm);
	transition:
		background-color var(--motion-fast) var(--ease-standard),
		color var(--motion-fast) var(--ease-standard);

	&:hover {
		background: var(--tint-danger);
		color: var(--danger-text);
	}

	&:disabled {
		opacity: .6;
		cursor: wait;
	}
}

:deep(.datepicker) {
	inline-size: 100%;

	.show {
		display: block;
		inline-size: 100%;
		min-block-size: var(--control-height-sm);
		padding: var(--space-1) var(--space-2);
		border-radius: $radius;
		color: var(--text-primary);
		text-align: start;
		transition: background-color var(--motion-fast) var(--ease-standard);

		&:hover {
			background: var(--surface-hover);
		}
	}

	&.disabled .show:hover {
		background: transparent;
	}
}

:deep(.details) {
	.input:not(.has-defaults),
	.textarea {
		&::placeholder {
			color: var(--text-tertiary);
			opacity: 1;
			font-style: italic;
		}
	}
}

.details.labels-list,
.assignees {
	:deep(.multiselect) {
		.input-wrapper {
			&:not(:focus-within, :hover) {
				background: transparent;
				border-color: transparent;
			}
		}
	}
}

.attachments {
	table tr:last-child td {
		border-inline-end: none;
	}
}

// Properties and actions rail
.action-buttons {
	display: flex;
	flex-direction: column;
	gap: var(--space-3);
	padding: var(--space-2);
	border: 1px solid var(--border-subtle);
	border-radius: var(--radius-md);
	background: var(--surface);
	box-shadow: var(--elevation-1);
}

.is-wide .action-buttons {
	// Room left below the stuck rail. With the launcher on screen the rail ends above the dock row,
	// so neither the launcher nor the scroll button beside it covers its last rows.
	--rail-end-gap: var(--space-4);

	position: sticky;
	inset-block-start: calc(var(--header-height) + var(--space-4));
	max-block-size: calc(100dvh - var(--header-height) - var(--space-4) - var(--rail-end-gap));
	overflow-y: auto;
	overscroll-behavior: contain;

	:root:has(.arona-launcher) & {
		--rail-end-gap: var(--dock-reserve);
	}
}

.is-modal.is-wide .action-buttons {
	inset-block-start: var(--space-4);
	max-block-size: calc(100dvh - var(--space-4) - var(--rail-end-gap));

	// The modal's fixed close button sits inside the dialog here, so the stuck rail starts below it.
	@media screen and (min-width: $tablet) and (width <= #{$desktop + $close-button-min-space}) {
		inset-block-start: 3.5rem;
		max-block-size: calc(100dvh - 3.5rem - var(--rail-end-gap));
	}
}

.action-group {
	display: flex;
	flex-direction: column;
	gap: 1px;
}

.action-heading {
	padding: var(--space-1) var(--space-2) 0;
	color: var(--text-secondary);
	font-size: var(--text-2xs);
	font-weight: var(--weight-semibold);
	letter-spacing: .04em;
	line-height: var(--leading-normal);
	text-transform: uppercase;
}

.action-buttons .action-group .button {
	inline-size: 100%;
	justify-content: flex-start;
	min-block-size: max(1.875rem, var(--target-min));
	padding-block: var(--space-1);
	padding-inline: var(--space-2);
	border-radius: var(--radius-sm);
	color: var(--text-primary);
	font-size: var(--text-md);
	font-weight: var(--weight-medium);
	text-align: start;

	:deep(.icon) {
		inline-size: 1rem;
		color: var(--text-tertiary);
	}

	&:hover {
		background-color: var(--surface-hover);
		color: var(--text-primary);
	}

	&.is-danger {
		color: var(--danger-text);

		:deep(.icon) {
			color: inherit;
		}

		&:hover {
			background-color: var(--tint-danger);
		}
	}
}

.action-group--danger {
	padding-block-start: var(--space-2);
	border-block-start: 1px solid var(--border-subtle);
}

.action-note {
	margin: 0;
	padding: 0 var(--space-2) var(--space-1);
	color: var(--text-secondary);
	font-size: var(--text-xs);
	line-height: var(--leading-normal);
}

.action-buttons .created {
	margin: 0;
	padding: var(--space-2) var(--space-2) var(--space-1);
	border-block-start: 1px solid var(--border-subtle);
	text-align: start;
}

.action-buttons > .created:first-child {
	border-block-start: 0;
}

// Stacked below the content: lay the groups out in columns instead of one long list.
.task-view-container:not(.is-wide) .action-buttons {
	display: grid;
	grid-template-columns: repeat(auto-fill, minmax(min(100%, 15rem), 1fr));
	gap: var(--space-3) var(--space-4);

	.action-group {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(min(100%, 10rem), 1fr));
		align-content: start;
		gap: 1px var(--space-1);
	}

	.action-heading,
	.action-group--danger,
	.action-note,
	.created {
		grid-column: 1 / -1;
	}
}

// Bottom-end dock: the Arona launcher holds the corner and this button sits beside it on the same row.
// The upload panel and the open Arona panel stack above that row, so none of them covers another.
// Without a launcher (link shares) the button takes the corner itself.
.scroll-to-comments-button {
	--scroll-button-size: 2rem;

	position: fixed;
	inset-block-end: var(--dock-inset-block);
	inset-inline-end: var(--dock-inset-inline);
	z-index: var(--layer-sticky);
	display: flex;
	align-items: center;
	justify-content: center;
	inline-size: var(--scroll-button-size);
	block-size: var(--scroll-button-size);
	padding: 0;
	border: 1px solid var(--border-default);
	border-radius: var(--radius-full);
	background-color: var(--surface-raised);
	color: var(--text-secondary);
	box-shadow: var(--elevation-2);
	transition:
		background-color var(--motion-fast) var(--ease-standard),
		color var(--motion-fast) var(--ease-standard);

	&:hover {
		background-image: linear-gradient(var(--surface-hover), var(--surface-hover));
		color: var(--text-primary);
	}

	&:focus-visible {
		@include focus-ring;
	}

	// On the launcher's row, centred on it, with the dock's usual gap before it.
	:root:has(.arona-launcher) & {
		inset-block-end: calc(var(--dock-inset-block) + (var(--dock-launcher-size) - var(--scroll-button-size)) / 2);
		inset-inline-end: var(--dock-reserve-inline);
	}

	// The demo banner fills that row up to the launcher, so the button stacks above the launcher instead.
	:root:has(.arona-launcher):has(.demo-mode-banner) & {
		inset-block-end: var(--dock-reserve);
		inset-inline-end: calc(var(--dock-inset-inline) + (var(--dock-launcher-size) - var(--scroll-button-size)) / 2);
	}

	// Phones scroll by touch, and the narrow dock row is left to the launcher.
	@media screen and (max-width: $tablet) {
		display: none;
	}
}
</style>

<style lang="scss">
// the task card spans the full width here, so the modal's white close button sits on it instead of the scrim
@media screen and (min-width: $tablet) and (max-width: $desktop) {
	.modal-dialog:has(.task-view-container.is-modal) .modal-container > .close {
		color: var(--text-primary);
	}
}
</style>
