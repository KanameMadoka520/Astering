import {onScopeDispose, ref, watch, type Ref} from 'vue'
import type {Conversation} from '@/client/generated'
import {captureClientRequestContext, isClientRequestContextCurrent} from '@/client/requestContext'
import {useMarkConversationRead} from '@/client/queries/conversationRead'

/** Acknowledgement follows a visible reply end, never a background fetch or a minimized assistant. */
export function useConversationRead(options: {
	conversation: Readonly<Ref<Conversation | undefined>>,
	presenting: Readonly<Ref<boolean>>,
	sentinel: Readonly<Ref<HTMLElement | undefined>>,
	scrollRoot: Readonly<Ref<HTMLElement | undefined>>,
}) {
	const mark = useMarkConversationRead()
	const visible = ref(false)
	let observer: IntersectionObserver | undefined
	let observation = 0
	let timer: ReturnType<typeof setTimeout> | undefined
	let attempted = ''
	let disposed = false
	function blockedByModal() {
		const sentinel = options.sentinel.value
		if (!sentinel) return true
		return [...document.querySelectorAll<HTMLDialogElement>('dialog[open]')].some(dialog => {
			if (dialog.contains(sentinel)) return false
			try {
				return dialog.matches(':modal')
			} catch {
				// Older engines cannot distinguish show() from showModal(); keep unread rather than guess visibility.
				return true
			}
		})
	}
	watch([options.sentinel, options.scrollRoot], ([sentinel, root]) => {
		const generation = ++observation
		observer?.disconnect()
		visible.value = false
		if (!sentinel || !root || typeof IntersectionObserver === 'undefined') return
		observer = new IntersectionObserver(entries => {
			if (disposed || generation !== observation) return
			visible.value = entries.some(entry => entry.target === sentinel && entry.isIntersecting && entry.intersectionRatio >= 1)
		}, {root, threshold: 1})
		observer.observe(sentinel)
	}, {immediate: true, flush: 'post'})
	function schedule() {
		clearTimeout(timer)
		const conversation = options.conversation.value
		if (!options.presenting.value || !visible.value || !conversation?.id
			|| !conversation.unread || !conversation.latest_reply_id || blockedByModal()) return
		const id = conversation.id
		const replyId = conversation.latest_reply_id
		const key = `${id}/${replyId}`
		if (key === attempted) return
		const owner = captureClientRequestContext()
		timer = setTimeout(() => {
			const current = options.conversation.value
			if (disposed || !isClientRequestContextCurrent(owner) || !options.presenting.value || !visible.value
				|| current?.id !== id || current.latest_reply_id !== replyId || !current.unread || blockedByModal()) return
			attempted = key
			mark.mutate({id, replyId, owner})
		}, 700)
	}
	watch([
		() => options.conversation.value?.id,
		() => options.conversation.value?.latest_reply_id,
		() => options.conversation.value?.unread,
		options.presenting,
		visible,
	], (_value, previous) => {
		if (!options.presenting.value || options.conversation.value?.id !== previous?.[0]) attempted = ''
		schedule()
	}, {immediate: true, flush: 'post'})
	const online = () => {
		attempted = ''
		schedule()
	}
	window.addEventListener('online', online)
	// Native image/export dialogs do not affect intersection geometry. Closing one starts a fresh visibility delay.
	document.addEventListener('close', online, true)
	onScopeDispose(() => {
		disposed = true
		observation++
		clearTimeout(timer)
		observer?.disconnect()
		window.removeEventListener('online', online)
		document.removeEventListener('close', online, true)
	})
}
