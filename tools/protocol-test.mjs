/*
 * 协议回归测试：用一个「假 chatglm.cn」跑通 取token → 流式对话 → 会话回收 的完整链路。
 *
 * 它不碰真实服务，因此可以在没有任何登录态的情况下验证：
 *   · 请求头/请求体形状（Authorization、X-Sign、assistant_id、chat_mode、messages[].content 必须是块数组）
 *   · SSE 分帧（parts 既可能是增量片段，也可能是全量快照）
 *   · 提问回显剥离（网页端会把用户提问作为 part 回显）
 *   · 结束后删除临时会话（delete 必须带 assistant_id）
 *
 *   node tools/protocol-test.mjs
 */
import http from 'node:http'
import { createGlmWebClient } from '../lib/chatglm.js'
import { ACTION_INTENT_RE, createAdapter, parseToolCalls, renderToolInstructions } from '../lib/adapter.js'

const ANSWER = '读数完成，a.txt 里是 hello。'
const THINK = '正在想…'
const seen = []

/** 请求体里的 content 现在是内容块数组（实测 2026-09-26：传字符串会被服务端判 400 invalid param）。 */
function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter((c) => c && c.type === 'text' && typeof c.text === 'string').map((c) => c.text).join('')
}

const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    seen.push({ url: req.url, headers: req.headers, body })
    if (req.url.includes('user/refresh')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ code: 0, result: { access_token: 'ACCESS_FAKE', refresh_token: 'REFRESH_ROTATED' } }))
      return
    }
    if (req.url.includes('conversation/delete')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ code: 0, result: {} }))
      return
    }
    if (req.url.includes('assistant/stream')) {
      const prompt = textOf(JSON.parse(body || '{}')?.messages?.[0]?.content)
      const echo = { content: [{ type: 'text', text: prompt }] }
      const reply = (text) => ({ content: [{ type: 'think', think: THINK }, { type: 'text', text }] })
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const frame = (status, parts) => res.write('data: ' + JSON.stringify({ conversation_id: 'conv-fake-1', status, parts }) + '\n')
      frame('', [echo])
      setTimeout(() => frame('', [echo, reply('读数完成，')]), 40)
      setTimeout(() => frame('', [echo, reply(ANSWER)]), 80)
      setTimeout(() => { frame('finish', [echo, reply(ANSWER)]); res.end() }, 120)
      return
    }
    res.writeHead(404)
    res.end()
  })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port

const realFetch = fetch
const client = createGlmWebClient({
  fetchImpl: (url, init) => realFetch(String(url).replace('https://chatglm.cn', 'http://127.0.0.1:' + port), init),
  logger: { info() {}, warn() {} },
  minIntervalMs: 0,
})
const adapter = createAdapter({ client, getRefreshToken: async () => 'REFRESH_FAKE', logger: { info() {}, warn() {} } })

const chunks = []
for await (const chunk of adapter.stream({
  model: 'glm-web/chat',
  messages: [
    { role: 'system', content: [{ type: 'text', text: '你是测试助手' }] },
    { role: 'user', content: [{ type: 'text', text: '读 a.txt' }] },
  ],
  tools: [{ name: 'read_file', description: '读文件', parameters: { type: 'object', properties: { path: { type: 'string' } } } }],
})) chunks.push(chunk)
await new Promise((resolve) => setTimeout(resolve, 120))

const text = chunks.filter((c) => c.type === 'text-delta').filter((c) => chunks.find((b) => b.type === 'block-start' && b.index === c.index)?.blockType !== 'reasoning').map((c) => c.text).join('')
const reasoning = chunks.filter((c) => c.type === 'text-delta').filter((c) => chunks.find((b) => b.type === 'block-start' && b.index === c.index)?.blockType === 'reasoning').map((c) => c.text).join('')
const streamReq = seen.find((s) => s.url.includes('assistant/stream'))
const payload = JSON.parse(streamReq?.body ?? '{}')
const promptText = textOf(payload.messages?.[0]?.content)
const finish = chunks.find((c) => c.type === 'finish')

let failed = 0
const check = (label, ok, detail = '') => {
  if (!ok) failed += 1
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? ' — ' + detail : ''))
}

check('登录态刷新被调用一次', seen.filter((s) => s.url.includes('user/refresh')).length === 1)
check('Authorization 用的是刷新出来的 access_token', streamReq?.headers.authorization === 'Bearer ACCESS_FAKE')
check('签名头齐全（X-Sign 32 位 + X-Nonce + X-Timestamp）', String(streamReq?.headers['x-sign'] ?? '').length === 32 && Boolean(streamReq?.headers['x-nonce']) && Boolean(streamReq?.headers['x-timestamp']))
check('messages[].content 是内容块数组（传字符串会被判 400）', Array.isArray(payload.messages?.[0]?.content))
check('请求体字段正确', payload.assistant_id === '65940acff94777010aa6b796' && payload.meta_data?.chat_mode === 'zero' && payload.conversation_id === '')
check('工具说明书进入提示词（方括号协议）', promptText.includes('[function_calls]') && promptText.includes('[call:') && promptText.includes('TOOL_RESULT for'))
check('正文不含提问回显', !text.includes('读 a.txt') && text.includes(ANSWER), JSON.stringify(text))
check('思考通道单独成流', reasoning.includes(THINK))
check('finish = stop（本轮无工具调用）', finish?.reason?.kind === 'stop')
check('结束后删除临时会话', seen.some((s) => s.url.includes('conversation/delete')))
check('删除请求带 assistant_id（缺它服务端会 400）', (() => { const d = seen.find((s) => s.url.includes('conversation/delete')); return d ? Boolean(JSON.parse(d.body).assistant_id) : false })())

// 场景 2：历史里带工具调用 + 工具结果（真实 agent 第一轮之后的样子）
const streamCountBefore = seen.filter((s) => s.url.includes('assistant/stream')).length
for await (const _chunk of adapter.stream({
  model: 'glm-web/chat',
  messages: [
    { role: 'user', content: [{ type: 'text', text: '读 a.txt' }] },
    { role: 'assistant', content: [{ type: 'tool-call', id: 'call_1', name: 'read_file', arguments: '{"path":"a.txt"}' }] },
    { role: 'user', content: [{ type: 'tool-result', toolCallId: 'call_1', content: [{ type: 'text', text: 'hello' }] }] },
  ],
  tools: [{ name: 'read_file', description: '读文件', parameters: { type: 'object', properties: { path: { type: 'string' } } } }],
})) { /* 消费 */ }
await new Promise((resolve) => setTimeout(resolve, 80))
const secondReq = seen.filter((s) => s.url.includes('assistant/stream'))[streamCountBefore]
const prompt2 = textOf(JSON.parse(secondReq?.body ?? '{}').messages?.[0]?.content)
const secondSent = Boolean(secondReq) && secondReq.body.length > 0
check('第二轮请求确实发到了 stream 端点', secondSent)
check('历史里的工具调用渲染成方括号协议', secondSent && prompt2.includes('[call:read_file]{"path":"a.txt"}[/call]'))
check('工具结果以 [TOOL_RESULT for 调用 id] 回灌', secondSent && prompt2.includes('[TOOL_RESULT for call_1]') && prompt2.includes('hello'))
check('历史里不再夹带 tool-result 原始块结构', secondSent && !prompt2.includes('toolCallId'))

// 场景 3：解析器对真实遇到的畸形输出的容错（实测 2026-09-26 抓到过）
const malformed = '[function_calls]\n[call:echo]{"text":"ping"}[/call[function_calls]\n[call:echo]{"text":"ping"}[/call]\n[/function_calls]'
const parsedMalformed = parseToolCalls(malformed)
check('畸形「半截+完整」重复块仍能取到参数', parsedMalformed?.[0]?.arguments === '{"text":"ping"}', JSON.stringify(parsedMalformed))
check('纯垃圾输入不产生伪解析', parseToolCalls('今天天气不错') === null)

// 场景 3.5：分片流 + 汇总快照不得把正文吐两遍（真机 2026-09-26 实测到的观感缺陷）
const dupServer = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => (b += c))
  req.on('end', () => {
    if (req.url.includes('user/refresh')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ code: 0, result: { access_token: 'A', refresh_token: 'R' } })); return }
    if (req.url.includes('conversation/delete')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); return }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const emit = (parts, status = '') => res.write('data: ' + JSON.stringify({ conversation_id: 'c', status, parts }) + '\n')
    const acc = []
    for (const ch of '你好世界') { acc.push(ch); emit([{ content: [{ type: 'text', text: acc.join('\n') }] }]) }
    emit([{ content: [{ type: 'text', text: '你好世界' }] }], 'finish')
    res.end()
  })
})
await new Promise((resolve) => dupServer.listen(0, '127.0.0.1', resolve))
const dupPort = dupServer.address().port
const dupClient = createGlmWebClient({
  fetchImpl: (url, init) => realFetch(String(url).replace('https://chatglm.cn', 'http://127.0.0.1:' + dupPort), init),
  logger: { info() {}, warn() {} }, minIntervalMs: 0,
})
let duplicated = ''
for await (const ev of dupClient.chat({ refreshToken: 'R', assistantId: '65940acff94777010aa6b796', chatMode: 'zero', prompt: 'P' })) if (ev.kind === 'text') duplicated += ev.delta
dupServer.close()
check('分片流+汇总快照不重复吐字', duplicated.replace(/\s+/g, '') === '你好世界', JSON.stringify(duplicated.replace(/\s+/g, '')))

// 场景 4：凭据缺失（例如 token.txt 里只有占位说明行）——必须直接报缺失，且不发任何网络请求
const seenBeforeMissing = seen.length
const adapterNoCred = createAdapter({ client, getRefreshToken: async () => undefined, logger: { info() {}, warn() {} } })
const missing = []
for await (const chunk of adapterNoCred.stream({ model: 'glm-web/chat', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })) missing.push(chunk)
const missingFinish = missing.find((c) => c.type === 'finish')
check('缺凭据时报 MISSING_CREDENTIAL', missingFinish?.reason?.failure?.code === 'MISSING_CREDENTIAL', JSON.stringify(missingFinish?.reason))
check('缺凭据时不发任何请求（避免把占位文本当令牌发出去）', seen.length === seenBeforeMissing)

// 场景 5：协议块位置 / 预算裁剪 / 截断抢救 / 空调用重试
check('协议块排在用户内容之后（尾部指令，避免被长上下文埋掉）', promptText.lastIndexOf('[function_calls]') > promptText.indexOf('读 a.txt'))
check('工具结果回灌带工具名', prompt2.includes('[TOOL_RESULT for call_1] (read_file)'))

const manyTools = Array.from({ length: 60 }, (_, i) => ({
  name: 'tool_' + i,
  description: '第 ' + i + ' 个工具',
  parameters: { type: 'object', properties: { a: { type: 'string', description: 'x'.repeat(120) } } },
}))
const realTools = [
  { name: 'read', description: '读取文件', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'glob', description: '查找文件', parameters: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] } },
]
const realInstr = renderToolInstructions(realTools)
check('示例使用会话里真实存在的工具名与参数', realInstr.includes('[call:read]{"path"'), realInstr.slice(realInstr.indexOf('正确示例'), realInstr.indexOf('正确示例') + 90).replace(/\n/g, ' '))
check('含「漏参数」反例与「编造工具名」反例', realInstr.includes('参数不能省') && realInstr.includes('open_url'))
check('含「没有浏览器/联网/file:// 能力」的否定说明', realInstr.includes('没有浏览器、联网抓取或 file:// 协议能力'))
check('意图正则能识别跑偏形态（file:// / open_url / 联网检索）', ACTION_INTENT_RE.test('我尝试通过 open_url 访问 file:///H:/x.md') && ACTION_INTENT_RE.test('需要联网检索一下'))
const dupCalls = parseToolCalls('[function_calls]\\n[call:read]{"path":"a.md"}[/call]\\n[/function_calls]\\n[function_calls]\\n[call:read]{"path":"a.md"}[/call]\\n[/function_calls]')
check('完全重复的调用被去重（半截+完整两份）', dupCalls?.length === 1, JSON.stringify(dupCalls))
const twoCalls = parseToolCalls('[function_calls][call:read]{"path":"a.md"}[/call][call:read]{"path":"b.md"}[/call][/function_calls]')
check('两个不同的调用都要保留', twoCalls?.length === 2, String(twoCalls?.length))

const budgetPrompt = renderToolInstructions(manyTools, { budgetChars: 3000 })
check('工具定义按预算裁剪并显式列出未展开项', budgetPrompt.includes('未展开的工具') && budgetPrompt.length < 6000, String(budgetPrompt.length))

// 假服务器：首轮只给"意图句"（不输出信封），收到重试提示后才输出（且故意不闭合 [/call]）——一次覆盖重试与截断抢救
let retryServerStreams = 0
const retryServer = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    if (req.url.includes('user/refresh')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ code: 0, result: { access_token: 'A', refresh_token: 'R' } })); return }
    if (req.url.includes('conversation/delete')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); return }
    retryServerStreams += 1
    const prompt = textOf(JSON.parse(body || '{}')?.messages?.[0]?.content)
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const emit = (text, status = '') => res.write('data: ' + JSON.stringify({ conversation_id: 'c', status, parts: [{ content: [{ type: 'text', text }] }] }) + '\n')
    if (prompt.includes('上一轮你没有按协议输出')) {
      emit('[function_calls]\n[call:echo]{"text":"ping"}', '') // 故意缺 [/call]，考验截断抢救
    } else {
      emit('好的，我来读取文件。', '') // 只有意图句，没有信封
    }
    emit('', 'finish')
    res.end()
  })
})
await new Promise((resolve) => retryServer.listen(0, '127.0.0.1', resolve))
const retryPort = retryServer.address().port
const retryClient = createGlmWebClient({
  fetchImpl: (url, init) => realFetch(String(url).replace('https://chatglm.cn', 'http://127.0.0.1:' + retryPort), init),
  logger: { info() {}, warn() {} }, minIntervalMs: 0,
})
const retryAdapter = createAdapter({ client: retryClient, getRefreshToken: async () => 'R', logger: { info() {}, warn() {} } })
const retryChunks = []
for await (const chunk of retryAdapter.stream({
  model: 'glm-web/chat',
  messages: [{ role: 'user', content: [{ type: 'text', text: '读 a.txt' }] }],
  tools: [{ name: 'echo', description: '回显', parameters: { type: 'object', properties: { text: { type: 'string' } } } }],
})) retryChunks.push(chunk)
retryServer.close()
const retryCall = retryChunks.find((c) => c.type === 'block-end' && c.block?.type === 'tool-call')
check('首轮只说不做时自动追加一次严格重试', retryServerStreams === 2, '实际 stream 次数 ' + retryServerStreams)
check('重试后拿到工具调用', retryCall?.block?.name === 'echo', JSON.stringify(retryCall?.block?.name))
check('信封被截断时仍能抢救出参数', retryCall?.block?.arguments === '{"text":"ping"}', String(retryCall?.block?.arguments))
check('重试成功的回合以 tool-calls 收尾', retryChunks.find((c) => c.type === 'finish')?.reason?.kind === 'tool-calls')

// 场景 6：快照/分片去重的四种形态（真机都遇到过）
async function streamFrames(frames) {
  const srv = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      if (req.url.includes('user/refresh')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ code: 0, result: { access_token: 'A', refresh_token: 'R' } })); return }
      if (req.url.includes('conversation/delete')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); return }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      frames.forEach((t, i) => res.write('data: ' + JSON.stringify({ conversation_id: 'c', status: i === frames.length - 1 ? 'finish' : '', parts: [{ content: [{ type: 'text', text: t }] }] }) + '\n'))
      res.end()
    })
  })
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve))
  const port = srv.address().port
  const c = createGlmWebClient({
    fetchImpl: (url, init) => realFetch(String(url).replace('https://chatglm.cn', 'http://127.0.0.1:' + port), init),
    logger: { info() {}, warn() {} }, minIntervalMs: 0,
  })
  let out = ''
  for await (const ev of c.chat({ refreshToken: 'R', assistantId: '65940acff94777010aa6b796', chatMode: '', prompt: 'P' })) if (ev.kind === 'text') out += ev.delta
  srv.close()
  return out
}
const norm = (s) => String(s).replace(/\s+/g, '')
const dedupeCases = [
  ['完整→短回退→完整', ['HELLO_FROM_FILE_12345', 'HELLO_FROM', 'HELLO_FROM_FILE_12345'], 'HELLO_FROM_FILE_12345'],
  ['递增分片', ['1', '1+', '1+1', '1+1 等于', '1+1 等于 **2**。'], '1+1 等于 **2**。'],
  ['带换行分片+干净快照', ['你\n', '你好\n', '你好世界'], '你好世界'],
  ['逐字分片（真机常见）', ['1\n', '+\n', '1\n', ' \n', '等\n', '于\n', ' **\n', '2\n', '**\n', '。\n'], '1+1 等于 **2**。'],
]
for (const [label, frames, expected] of dedupeCases) {
  const got = norm(await streamFrames(frames))
  check('去重形态：' + label, got === norm(expected), JSON.stringify(got).slice(0, 60))
}

server.close()
console.log(failed === 0 ? '\nRESULT: PASS' : '\nRESULT: FAIL (' + failed + ')')
process.exitCode = failed === 0 ? 0 : 1
