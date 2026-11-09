import {isNativeAndroid} from '@/helpers/nativeAndroid'
import {useLiveNoteRecording} from './useLiveNoteRecording'
import {useNativeNoteRecording} from './useNativeNoteRecording'

export function useNoteRecording(options: Parameters<typeof useLiveNoteRecording>[0]) {
	return isNativeAndroid()
		? useNativeNoteRecording(options)
		: useLiveNoteRecording(options)
}
