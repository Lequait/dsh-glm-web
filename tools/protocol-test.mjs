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
import { createAdapter, parseToolCalls } from '../lib/adapter.js'

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

server.close()
console.log(failed === 0 ? '\nRESULT: PASS' : '\nRESULT: FAIL (' + failed + ')')
process.exitCode = failed === 0 ? 0 : 1
