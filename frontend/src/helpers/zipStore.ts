/**
 * A minimal ZIP writer for exports: files are stored without compression (images already are compressed,
 * and Markdown is small), names are UTF-8. No ZIP64, so an archive stays below 4 GiB and 65,535 files.
 */

export type ZipFile = {
	// Relative path with forward slashes, e.g. "images/12.webp".
	name: string
	data: Uint8Array<ArrayBuffer>
}

export class ZipTooLargeError extends Error {
	constructor() {
		super('The archive would exceed the ZIP size limits')
		this.name = 'ZipTooLargeError'
	}
}

const LIMIT_32 = 0xFFFF_FFFF
const LIMIT_16 = 0xFFFF
const UTF8_NAMES = 0x0800
const VERSION = 20

let crcTable: Uint32Array | undefined

function table(): Uint32Array {
	if (!crcTable) {
		crcTable = new Uint32Array(256)
		for (let n = 0; n < 256; n++) {
			let c = n
			for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB8_8320 ^ (c >>> 1) : c >>> 1
			crcTable[n] = c >>> 0
		}
	}
	return crcTable
}

export function crc32(data: Uint8Array): number {
	const lookup = table()
	let crc = 0xFFFF_FFFF
	for (let i = 0; i < data.length; i++) crc = lookup[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8)
	return (crc ^ 0xFFFF_FFFF) >>> 0
}

/** MS-DOS date and time in local time, as ZIP readers show them; clamped to 1980, the format's epoch. */
export function dosDateTime(date: Date): {time: number, date: number} {
	const year = Math.min(2107, Math.max(1980, date.getFullYear()))
	const early = date.getFullYear() < 1980
	return {
		time: early ? 0 : (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
		date: early ? (1 << 5) | 1 : ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
	}
}

function safeName(name: string): string {
	const normalized = name.replace(/\\/g, '/')
	if (normalized === '' || normalized.startsWith('/') || normalized.split('/').some(part => part === '..' || part === '')) {
		throw new Error(`Invalid file name in archive: ${name}`)
	}
	return normalized
}

/** Builds the archive. Throws ZipTooLargeError past the classic format's limits. */
export function createStoredZip(files: readonly ZipFile[], modified = new Date()): Blob {
	if (files.length > LIMIT_16) throw new ZipTooLargeError()
	const encoder = new TextEncoder()
	const {time, date} = dosDateTime(modified)
	const parts: BlobPart[] = []
	const central: Uint8Array<ArrayBuffer>[] = []
	let offset = 0
	for (const file of files) {
		const name = encoder.encode(safeName(file.name))
		if (name.length > LIMIT_16 || file.data.length > LIMIT_32) throw new ZipTooLargeError()
		const crc = crc32(file.data)
		const local = new DataView(new ArrayBuffer(30))
		local.setUint32(0, 0x0403_4B50, true)
		local.setUint16(4, VERSION, true)
		local.setUint16(6, UTF8_NAMES, true)
		local.setUint16(8, 0, true)
		local.setUint16(10, time, true)
		local.setUint16(12, date, true)
		local.setUint32(14, crc, true)
		local.setUint32(18, file.data.length, true)
		local.setUint32(22, file.data.length, true)
		local.setUint16(26, name.length, true)
		local.setUint16(28, 0, true)

		const header = new DataView(new ArrayBuffer(46))
		header.setUint32(0, 0x0201_4B50, true)
		header.setUint16(4, VERSION, true)
		header.setUint16(6, VERSION, true)
		header.setUint16(8, UTF8_NAMES, true)
		header.setUint16(10, 0, true)
		header.setUint16(12, time, true)
		header.setUint16(14, date, true)
		header.setUint32(16, crc, true)
		header.setUint32(20, file.data.length, true)
		header.setUint32(24, file.data.length, true)
		header.setUint16(28, name.length, true)
		// Extra field, comment, disk number, internal and external attributes stay 0.
		header.setUint32(42, offset, true)
		central.push(new Uint8Array(header.buffer), name)

		parts.push(local.buffer, name, file.data)
		offset += 30 + name.length + file.data.length
		if (offset > LIMIT_32) throw new ZipTooLargeError()
	}
	const centralSize = central.reduce((sum, part) => sum + part.length, 0)
	if (offset + centralSize > LIMIT_32) throw new ZipTooLargeError()
	const end = new DataView(new ArrayBuffer(22))
	end.setUint32(0, 0x0605_4B50, true)
	end.setUint16(8, files.length, true)
	end.setUint16(10, files.length, true)
	end.setUint32(12, centralSize, true)
	end.setUint32(16, offset, true)
	parts.push(...central, end.buffer)
	return new Blob(parts, {type: 'application/zip'})
}
