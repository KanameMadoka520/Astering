import {isNativeAndroid} from '@/helpers/nativeAndroid'
import {canonicalApiBaseUrl} from '@/client/requestContext'
import {getApiBaseUrl} from '@/helpers/apiUrl'
import {useLiveNoteRecording} from './useLiveNoteRecording'
import {useNativeNoteRecording} from './useNativeNoteRecording'

export function useNoteRecording(options: Parameters<typeof useLiveNoteRecording>[0]) {
	return isNativeAndroid() && canonicalApiBaseUrl(getApiBaseUrl()) === 'https://task.tcymc.space/api/v2'
		? useNativeNoteRecording(options)
		: useLiveNoteRecording(options)
}
