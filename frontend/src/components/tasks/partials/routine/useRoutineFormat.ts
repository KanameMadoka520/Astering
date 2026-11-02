import {useI18n} from 'vue-i18n'

import {useTimeFormat} from '@/composables/useTimeFormat'
import {TIME_FORMAT} from '@/constants/timeFormat'
import {calendarDayFormatter} from '@/helpers/projectHistoryFormat'
import {useAuthStore} from '@/stores/auth'

/** Labels shared by the routine panel and its history: times in a recorded zone, zones and who checked in. */
export function useRoutineFormat() {
	const {t, locale} = useI18n({useScope: 'global'})
	const authStore = useAuthStore()
	const {store: timeFormat} = useTimeFormat()

	function hourCycle(): Intl.DateTimeFormatOptions['hourCycle'] {
		if (timeFormat.value === TIME_FORMAT.HOURS_12) return 'h12'
		if (timeFormat.value === TIME_FORMAT.HOURS_24) return 'h23'
		return undefined
	}

	/** The wall-clock time of `value` in `timeZone`: a record keeps the zone it was checked in under. */
	function time(value: string, timeZone: string): string {
		const date = new Date(value)
		if (!value || Number.isNaN(date.getTime())) return ''
		const options: Intl.DateTimeFormatOptions = {
			hour: '2-digit',
			minute: '2-digit',
			hourCycle: hourCycle(),
		}
		try {
			return new Intl.DateTimeFormat(locale.value, {
				...options,
				timeZone: timeZone || 'UTC',
			}).format(date)
		} catch {
			// A zone this browser does not know: say UTC rather than silently using the viewer's zone.
			return `${new Intl.DateTimeFormat(locale.value, {
				...options,
				timeZone: 'UTC',
			}).format(date)} UTC`
		}
	}

	function zone(timeZone: string): string {
		return timeZone.replace(/_/g, ' ')
	}
	function instant(value: string, timeZone: string): string {
		const date = new Date(value)
		if (!value || Number.isNaN(date.getTime())) return '–'
		const options: Intl.DateTimeFormatOptions = {
			year: 'numeric',
			month: 'short',
			day: 'numeric',
			hour: '2-digit',
			minute: '2-digit',
			hourCycle: hourCycle(),
		}
		try {
			return new Intl.DateTimeFormat(locale.value, {...options, timeZone: timeZone || 'UTC'}).format(date)
		} catch {
			return `${new Intl.DateTimeFormat(locale.value, {...options, timeZone: 'UTC'}).format(date)} UTC`
		}
	}

	/** Records only carry an id, and there is no user-by-id read, so other members are named by id. */
	function operator(id: number): string {
		if (id !== 0 && id === authStore.info?.id) return t('task.routine.settings.you')
		if (id < 0) return t('task.routine.settings.linkShare')
		if (id === 0) return t('task.routine.settings.unknownMember')
		return t('task.routine.settings.member', {id})
	}

	function day(date: string, options: Intl.DateTimeFormatOptions = {
		weekday: 'short',
		month: 'long',
		day: 'numeric',
	}): string {
		return calendarDayFormatter(locale.value, options)(date)
	}

	return {
		time,
		instant,
		zone,
		operator,
		day,
	}
}
