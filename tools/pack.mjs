/*
 * 打一个 npm 形态的 tarball（不需要 npm/node 在 PATH 上：自己写 tar + gzip）。
 *
 *   node tools/pack.mjs
 *
 * 产物：dist/dsh-glm-web-<version>.tgz，条目以 package/ 开头（npm 约定），
 * 内容严格等于 package.json 的 files 列表 —— 打包后会立刻回读校验条目不缺不多。
 */
import { readdirSync, readFileSync, statSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { gzipSync, gunzipSync } from 'node:zlib'
import { join, relative, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const include = new Set(pkg.files)

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (/^(node_modules|\.git|dist)$/.test(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else out.push(full)
  }
  return out
}

function inFiles(rel) {
  for (const rule of include) {
    if (rel === rule || rel.startsWith(rule + '/')) return true
  }
  return false
}

function tarEntry(name, data) {
  const header = Buffer.alloc(512)
  Buffer.from(name, 'utf8').copy(header, 0, 0, Math.min(100, Buffer.byteLength(name)))
  const oct = (value, offset, length) => { Buffer.from(value.toString(8).padStart(length - 1, '0') + '\0').copy(header, offset) }
  oct(0o644, 100, 8)
  oct(0, 108, 8)
  oct(0, 116, 8)
  oct(data.length, 124, 12)
  oct(Math.floor(Date.now() / 1000), 136, 12)
  header.write('        ', 148, 8, 'ascii')
  header.write('0', 156, 1, 'ascii')
  header.write('ustar\0', 257, 6, 'ascii')
  header.write('00', 263, 2, 'ascii')
  let sum = 0
  for (const byte of header) sum += byte
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii')
  const padding = (512 - (data.length % 512)) % 512
  return Buffer.concat([header, data, Buffer.alloc(padding)])
}

const files = [...new Set(['package.json', ...walk(root).map((f) => relative(root, f).split('\\').join('/'))])]
  .filter((f) => f === 'package.json' || inFiles(f))
  .sort()
const parts = []
for (const rel of files) parts.push(tarEntry('package/' + rel, readFileSync(join(root, rel))))
parts.push(Buffer.alloc(1024))
const tgz = gzipSync(Buffer.concat(parts), { level: 9 })

mkdirSync(join(root, 'dist'), { recursive: true })
const outPath = join(root, 'dist', pkg.name + '-' + pkg.version + '.tgz')
writeFileSync(outPath, tgz)

// 回读校验：条目集合必须与 files 规则完全一致
const raw = gunzipSync(readFileSync(outPath))
const names = []
for (let offset = 0; offset + 512 <= raw.length; ) {
  const name = raw.subarray(offset, offset + 100).toString('utf8').replace(/\0+$/, '')
  if (!name) break
  const size = parseInt(raw.subarray(offset + 124, offset + 136).toString('ascii').replace(/\0.*$/, '').trim() || '0', 8)
  names.push(name)
  offset += 512 + size + ((512 - (size % 512)) % 512)
}
const expected = files.map((f) => 'package/' + f).sort()
const got = names.slice().sort()
const same = expected.length === got.length && expected.every((e, i) => e === got[i])
console.log('产物:', outPath, '(' + Math.round(tgz.length / 1024) + ' KB)')
console.log('条目 ' + got.length + ' 个:')
for (const n of got) console.log('  ' + n)
console.log(same ? '\nPASS 打包内容与 files 规则完全一致' : '\nFAIL 条目与 files 规则不一致')
if (!same) process.exitCode = 1
