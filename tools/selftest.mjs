/**
 * dsh-glm-web 自检：用真实登录态跑通「取 token → 流式对话 → 工具信封」三步。
 *
 *   node tools/selftest.mjs              # 从环境变量/凭据文件/token.txt 读
 *   node tools/selftest.mjs --token XXX  # 直接给 refresh_token
 *
 * 退出码 0 = 三步全过；1 = 有步骤失败（逐行打印原因）。
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createGlmWebClient } from '../lib/chatglm.js'
import { parseToolCalls, renderToolInstructions } from '../lib/adapter.js'

const args = process.argv.slice(2)
const tokenFlag = args.indexOf('--token')
const inlineToken = tokenFlag >= 0 ? args[tokenFlag + 1] : ''

function dshHome() {
  const envHome = process.env.DSH_HOME
  return envHome !== undefined && envHome.trim().length > 0 ? envHome : join(homedir(), '.dsh')
}
function fromCredentialsFile(ref) {
  try {
    const lines = readFileSync(join(dshHome(), '.credentials.yaml'), 'utf8').split(/\r?\n/)
    let inRefs = false
    for (const line of lines) {
      if (!inRefs) { if (/^refs:\s*(?:#.*)?$/.test(line)) inRefs = true; continue }
      if (line.length > 0 && !/^\s/.test(line)) break
      const m = line.match(/^\s+([A-Za-z_][A-Za-z0-9_-]*):\s*(.*?)\s*$/)
      if (m !== null && m[1] === ref) return m[2].replace(/^['"]|['"]$/g, '')
    }
  } catch { /* 忽略 */ }
  return ''
}
function fromTokenFile() {
  try {
    return readFileSync(join(dshHome(), 'storages', 'glm-web', 'token.txt'), 'utf8')
      .split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0 && !l.startsWith('<')) ?? ''
  } catch { return '' }
}

const token = inlineToken || process.env.GLM_WEB_REFRESH_TOKEN || fromCredentialsFile('GLM_WEB_REFRESH_TOKEN') || fromTokenFile()
if (token.length === 0) {
  console.log('FAIL 没找到 chatglm_refresh_token')
  console.log('  期望来源：$GLM_WEB_REFRESH_TOKEN / ~/.dsh/.credentials.yaml refs 段 / ~/.dsh/storages/glm-web/token.txt / --token')
  process.exitCode = 1
}
console.log(`[1/3] 登录态来源 OK（长度 ${token.length}，指纹 ${token.slice(0, 6)}…${token.slice(-4)}）`)

// 自检用短间隔，避免不必要的等待；插件运行时的默认值是 1500ms。
const client = createGlmWebClient({ logger: { info: (m) => console.log('   · ' + m), warn: (m) => console.log('   ! ' + m) }, minIntervalMs: 300 })
let failed = false

try {
  await client.check(token)
  console.log('[1/3] PASS 刷新 access_token')
} catch (error) {
  failed = true
  console.log(`[1/3] FAIL ${error?.code ?? ''} ${error?.message ?? error}`)
}

if (!failed) {
  process.stdout.write('[2/3] 流式对话：')
  let text = ''
  try {
    for await (const event of client.chat({ refreshToken: token, assistantId: '65940acff94777010aa6b796', chatMode: 'zero', prompt: '用一句话回答：1+1 等于几？' })) {
      if (event.kind === 'text') { text += event.delta; process.stdout.write(event.delta) }
    }
    console.log('')
    if (text.trim().length > 0) console.log('[2/3] PASS 收到正文 ' + text.trim().length + ' 字')
    else { failed = true; console.log('[2/3] FAIL 没有正文') }
  } catch (error) {
    failed = true
    console.log('\n[2/3] FAIL ' + (error?.code ?? '') + ' ' + (error?.message ?? error))
  }
}

if (!failed) {
  const tools = [{ name: 'echo', description: '把 text 原样返回', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }]
  const prompt = renderToolInstructions(tools) + '\n\n<|user|>\n请调用 echo 工具，参数 text 传 "ping"。'
  let raw = ''
  try {
    for await (const event of client.chat({ refreshToken: token, assistantId: '65940acff94777010aa6b796', chatMode: 'zero', prompt })) {
      if (event.kind === 'text') raw += event.delta
    }
    const calls = parseToolCalls(raw)
    if (calls !== null && calls.length > 0) {
      console.log(`[3/3] PASS 工具信封可解析：${calls.map((c) => c.name + '(' + c.arguments + ')').join(', ')}`)
    } else {
      failed = true
      console.log('[3/3] FAIL 没解析出工具调用，原始输出：' + raw.slice(0, 300))
    }
  } catch (error) {
    failed = true
    console.log('[3/3] FAIL ' + (error?.code ?? '') + ' ' + (error?.message ?? error))
  }
}

console.log(failed ? 'RESULT: FAIL' : 'RESULT: PASS')
process.exitCode = failed ? 1 : 0
