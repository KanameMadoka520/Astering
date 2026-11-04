// Export desktop branding from the already-generated shared Astering asset.
// ICNS modern representations are PNG payloads with an 8-byte type/length header.
import {createRequire} from 'node:module'
import {readFile, writeFile, mkdir} from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const root = path.resolve(desktop, '..')
const require = createRequire(path.join(root, 'frontend/package.json'))
const sharp = require('sharp')
const source = path.join(root, 'frontend/public/images/brand/logo.png')
const bytes = await readFile(source)
await mkdir(path.join(desktop, 'build'), {recursive: true})
const png = await sharp(bytes).resize(1024, 1024, {fit: 'contain'}).png().toBuffer()
await writeFile(path.join(desktop, 'icon.png'), png)
await writeFile(path.join(desktop, 'build/icon.png'), png)
const types = [['icp4', 16], ['icp5', 32], ['icp6', 64], ['ic07', 128], ['ic08', 256], ['ic09', 512], ['ic10', 1024]]
const entries = await Promise.all(types.map(async ([type, size]) => {
  const data = await sharp(bytes).resize(size, size, {fit: 'contain'}).png().toBuffer()
  const header = Buffer.alloc(8)
  header.write(type, 0, 'ascii')
  header.writeUInt32BE(data.length + 8, 4)
  return Buffer.concat([header, data])
}))
const header = Buffer.alloc(8)
header.write('icns', 0, 'ascii')
header.writeUInt32BE(8 + entries.reduce((total, entry) => total + entry.length, 0), 4)
await writeFile(path.join(desktop, 'build/icon.icns'), Buffer.concat([header, ...entries]))
console.log('Astering desktop PNG and seven-size PNG-backed ICNS generated from the shared logo.')
