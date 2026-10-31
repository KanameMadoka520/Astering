import type {AnyExtension, Editor} from '@tiptap/core'

export type UploadCallback = (files: File[] | FileList) => Promise<string[]>

export interface BottomAction {
    title: string
    action: () => void,
}

/**
 * Images that are not task attachments (Compass bodies). The source brings its own `image` node and does
 * the uploading; the toolbar, the slash command, paste and drop all hand their files to it.
 */
export interface EditorImageSource {
	/** The node for images; it must be named `image`. */
	extension: AnyExtension
	/** For the file picker, e.g. `image/*`. */
	accept: string
	/** Files picked, pasted or dropped; inserted at the selection as they finish. */
	insertFiles: (editor: Editor, files: File[]) => void
	/** Offers another picture for the selected image. */
	replace?: (editor: Editor) => void
}
