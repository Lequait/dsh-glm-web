/**
 * 智谱清言（chatglm.cn）网页版私有接口客户端。
 *
 * 接口事实（端点、签名算法、请求体字段、SSE 帧结构）来自现有开源实现：
 *   - xiaoY233/GLM-Free-API (GPL-3.0，智谱清言逆向，已停更)
 *   - uicaster/GLM-WebApi  (Python，2026-07)
 * 本文件按这些事实独立重写，不复制其源码。
 *
 * 用途：个人自用，把网页版登录态作为 DSH 的模型通道。风险自担（可能违反服务条款）。
 */
import { createHash, randomUUID } from 'node:crypto'

export const ORIGIN = 'https://chatglm.cn'
/** 智谱网页端签名密钥（公开在多个开源实现中，变更时需同步）。 */
const SIGN_SECRET = '8a1317a7468aa3ad86e997d08f3f31cb'
/** 默认智能体 id（清言「AllTools」）。 */
export const DEFAULT_ASSISTANT_ID = '65940acff94777010aa6b796'
/**
 * access_token 名义有效期。实测线上前端：刷新成功后把过期时间写成 dayjs().add(2,"hour")，
 * 即 2 小时；这里按 2 小时缓存、提前 5 分钟重刷，避免每次调用都白打一次 refresh。
 */
const TOKEN_TTL_MS = 2 * 60 * 60 * 1000
/** 提前量：到期前 5 分钟就当作过期，避免边界上打到服务端。 */
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
]

const FAKE_HEADERS = {
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6',
  'App-Name': 'chatglm',
  'Cache-Control': 'no-cache',
  'Content-Type': 'application/json',
  Origin: ORIGIN,
  Pragma: 'no-cache',
  'Sec-Ch-Ua': '"Microsoft Edge";v="143", "Chromium";v="143", "Not A(Brand";v="24"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"Windows"',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
  'X-App-Fr': 'browser_extension',
  'X-App-Platform': 'pc',
  'X-App-Version': '0.0.1',
  'X-Device-Brand': '',
  'X-Device-Model': '',
  'X-Lang': 'zh',
  'X-Exp-Groups':
    'na_android_config:exp:NA,na_4o_config:exp:4o_A,tts_config:exp:tts_config_a,na_glm4plus_config:exp:open,mainchat_server_app:exp:A,mobile_history_daycheck:exp:a,desktop_toolbar:exp:A,chat_drawing_server:exp:A,drawing_server_cogview:exp:cogview4,app_welcome_v2:exp:A,chat_drawing_streamv2:exp:A,mainchat_rm_fc:exp:add,mainchat_dr:exp:open,chat_auto_entrance:exp:A,drawing_server_hi_dream:control:A,homepage_square:exp:close,assistant_recommend_prompt:exp:3,app_home_regular_user:exp:A,memory_common:exp:enable,mainchat_moe:exp:300,assistant_greet_user:exp:greet_user,app_welcome_personalize:exp:A,assistant_model_exp_group:exp:glm4.5,ai_wallet:exp:ai_wallet_enable',
}

/** 本插件抛出的稳定错误：code 供上层分流（AUTH / RATE_LIMIT / TRANSPORT / PROTOCOL）。 */
export class GlmWebError extends Error {
  constructor(message, code = 'GLMWEB_ERROR') {
    super(message)
    this.name = 'GlmWebError'
    this.code = code
  }
}

function md5(value) {
  return createHash('md5').update(value).digest('hex')
}

function uuid() {
  return randomUUID().replace(/-/g, '')
}

function pickUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]
}

function fakeHeaders() {
  return { ...FAKE_HEADERS, 'User-Agent': pickUserAgent() }
}

/**
 * 生成请求签名。智谱前端的时间戳做过一次「校验位」改写，必须照做。
 * @returns {{timestamp: string, nonce: string, sign: string}}
 */
export function generateSign(now = Date.now()) {
  const A = String(now)
  const t = A.length
  const digits = A.split('').map((ch) => Number(ch))
  const partial = digits.reduce((acc, n) => acc + n, 0) - digits[t - 2]
  const checksum = partial % 10
  const timestamp = A.substring(0, t - 2) + checksum + A.substring(t - 1, t)
  const nonce = uuid()
  return { timestamp, nonce, sign: md5(`${timestamp}-${nonce}-${SIGN_SECRET}`) }
}

function signHeaders() {
  const { timestamp, nonce, sign } = generateSign()
  return { 'X-Device-Id': uuid(), 'X-Request-Id': uuid(), 'X-Nonce': nonce, 'X-Sign': sign, 'X-Timestamp': timestamp }
}

function normalizeCode(payload) {
  const code = payload?.code
  if (code === undefined || code === null) return 0
  return Number(code)
}

/**
 * 用 refresh_token 换 access_token。
 * @param {string} refreshToken chatglm.cn cookie 里的 chatglm_refresh_token
 */
export async function fetchAccessToken(refreshToken, { fetchImpl = fetch, signal } = {}) {
  const res = await fetchImpl(`${ORIGIN}/chatglm/user-api/user/refresh`, {
    method: 'POST',
    headers: { ...fakeHeaders(), Authorization: `Bearer ${refreshToken}`, ...signHeaders() },
    body: '{}',
    signal,
  })
  let payload
  try {
    payload = await res.json()
  } catch {
    throw new GlmWebError(`刷新登录态失败：响应不是 JSON（HTTP ${res.status}）`, 'TRANSPORT')
  }
  // 服务端用 status 字段报业务码（实测：40102 = 未授权用户，40001 = 请求非法）。
  const code = normalizeCode(payload?.code ?? payload?.status)
  if (code !== 0 || !payload?.result?.access_token) {
    const message = String(payload?.message ?? payload?.msg ?? '')
    const expired =
      res.status === 401 ||
      res.status === 403 ||
      code === 401 ||
      code === 403 ||
      code === 1001 ||
      code === 40102 ||
      /(unauthorized|登录|授权|失效|过期)/i.test(message)
    throw new GlmWebError(
      expired
        ? `清言登录态已失效（code=${code} ${message}）：重新登录 chatglm.cn → F12 → Application → Local Storage（或 Cookies）取 chatglm_refresh_token，写进 ~/.dsh/storages/glm-web/token.txt`
        : `刷新登录态失败（HTTP ${res.status} code=${code} ${message}）`,
      expired ? 'AUTH' : 'TRANSPORT',
    )
  }
  return {
    accessToken: payload.result.access_token,
    refreshToken: payload.result.refresh_token ?? refreshToken,
    expiresAt: Date.now() + TOKEN_TTL_MS,
  }
}

/** 逐行切出 SSE 的 data: 负载（忽略 event:/id:/注释行）。 */
async function* ssePayloads(body, signal) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let index
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).replace(/\r$/, '')
        buffer = buffer.slice(index + 1)
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) continue
        const payload = trimmed.slice(5).trim()
        if (payload.length === 0 || payload === '[DONE]') continue
        yield payload
      }
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      /* 正常路径：流已结束。 */
    }
  }
}

/**
 * 把一帧 parts 快照压成 { text, reasoning }。
 *
 * parts 每帧是全量快照，且**同一段内容可能同时以「进行中」和「已完成」两份出现**
 * （实测 2026-09-26：工具信封被拼成
 * `[/call[function_calls]\n[call:echo]{…}[/call]\n[/function_calls]` —— 直接把两份拼起来
 * 会把调用块切成两半，解析必然失败）。所以按「逐段归并」而不是「直接拼接」：
 * 若新段落是已有段落的延长（或反之），取更长的那份，而不是叠加。
 */
function mergeSnapshots(pieces, candidate) {
  if (candidate.length === 0) return
  for (let i = pieces.length - 1; i >= 0; i -= 1) {
    const piece = pieces[i]
    if (piece === candidate) return
    // candidate 是已有段落的延长（同一 part 的「完成态」覆盖「进行态」）
    if (candidate.startsWith(piece)) {
      if (candidate.length > piece.length) pieces[i] = candidate
      return
    }
    // candidate 是已有段落的更短拷贝（迟到的「进行态」）→ 整段丢弃
    if (piece.startsWith(candidate)) return
  }
  pieces.push(candidate)
}

function flattenParts(parts) {
  const textPieces = []
  const reasoningPieces = []
  if (!Array.isArray(parts)) return { text: '', reasoning: '' }
  for (const part of parts) {
    if (!part || !Array.isArray(part.content)) continue
    let partText = ''
    let partReasoning = ''
    for (const item of part.content) {
      if (!item) continue
      if (item.type === 'text' && typeof item.text === 'string') partText += item.text
      else if (item.type === 'think' && typeof item.think === 'string') partReasoning += item.think
    }
    mergeSnapshots(textPieces, partText)
    mergeSnapshots(reasoningPieces, partReasoning)
  }
  return { text: textPieces.join(''), reasoning: reasoningPieces.join('') }
}

/**
 * 去掉快照开头对本次提问的回声。
 * 我们每次都用新会话（conversation_id: ""），用户提问会作为第一个 part 回显，
 * 必须在差分前剥掉，否则回答里会带上自己的提问。
 */
function stripPromptEcho(full, prompt) {
  const p = String(prompt ?? '').trim()
  if (p.length === 0) return full
  const idx = full.indexOf(p)
  if (idx >= 0 && idx < 8) return full.slice(idx + p.length)
  const trimmed = full.replace(/^\s+/, '')
  if (trimmed.startsWith(p.slice(0, Math.min(24, p.length)))) return trimmed.slice(p.length)
  return full
}

function diffDelta(previous, next) {
  if (next === previous) return ''
  if (next.startsWith(previous)) return next.slice(previous.length)
  return next
}

/**
 * 发起一次网页端对话，流式产出 { textDelta, reasoningDelta, kind }。
 *
 * 每次调用新建会话（conversation_id: ""），结束后尽力删除，避免污染网页端会话列表。
 */
export async function* streamChat({ accessToken, assistantId, chatMode, prompt, fetchImpl = fetch, signal }) {
  const res = await fetchImpl(`${ORIGIN}/chatglm/backend-api/assistant/stream`, {
    method: 'POST',
    headers: {
      ...fakeHeaders(),
      Accept: 'text/event-stream',
      Authorization: `Bearer ${accessToken}`,
      Referer: assistantId === DEFAULT_ASSISTANT_ID ? `${ORIGIN}/main/alltoolsdetail` : `${ORIGIN}/main/gdetail/${assistantId}`,
      ...signHeaders(),
    },
    body: JSON.stringify({
      assistant_id: assistantId,
      conversation_id: '',
      project_id: '',
      chat_type: 'user_chat',
      // 实测（2026-09-26，真实账号）：content 必须是「内容块数组」；
      // 传字符串服务端直接判 400 invalid param —— 这是从旧实现照搬时踩到的坑。
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      meta_data: {
        channel: '',
        chat_mode: chatMode || undefined,
        draft_id: '',
        if_plus_model: true,
        input_question_type: 'xxxx',
        is_networking: true,
        is_test: false,
        platform: 'pc',
        quote_log_id: '',
        cogview: { rm_label_watermark: false },
      },
    }),
    signal,
  })

  const contentType = String(res.headers.get('content-type') ?? '')
  if (!res.ok || contentType.includes('application/json')) {
    const detail = await res.text().catch(() => '')
    throw new GlmWebError(
      `清言接口拒绝请求（HTTP ${res.status}）：${detail.slice(0, 300) || contentType}`,
      res.status === 401 || res.status === 403 ? 'AUTH' : 'TRANSPORT',
    )
  }
  if (!contentType.includes('text/event-stream')) {
    throw new GlmWebError(`清言返回了非事件流内容（content-type: ${contentType}）`, 'PROTOCOL')
  }
  if (!res.body) throw new GlmWebError('清言响应没有可读流（宿主 fetch 不支持流式）', 'TRANSPORT')

  let lastText = ''
  let lastReasoning = ''
  let conversationId = ''
  let finished = false
  let sawFrame = false

  for await (const payload of ssePayloads(res.body, signal)) {
    let frame
    try {
      frame = JSON.parse(payload)
    } catch {
      continue
    }
    sawFrame = true
    if (typeof frame.conversation_id === 'string' && frame.conversation_id.length > 0) {
      conversationId = frame.conversation_id
    }
    if (frame.status === 'finish') finished = true

    const { text, reasoning } = flattenParts(frame.parts)
    const cleanText = stripPromptEcho(text, prompt)
    const textDelta = diffDelta(lastText, cleanText)
    const reasoningDelta = diffDelta(lastReasoning, reasoning)
    lastText = cleanText
    lastReasoning = reasoning

    if (reasoningDelta.length > 0) yield { kind: 'reasoning', delta: reasoningDelta }
    if (textDelta.length > 0) yield { kind: 'text', delta: textDelta }
    if (finished) break
  }

  if (!sawFrame) throw new GlmWebError('清言没有返回任何数据帧（登录态或风控异常）', 'PROTOCOL')
  yield { kind: 'done', conversationId, finished }
}

/** 删除临时会话（尽力而为；失败不影响本次回答）。 */
export async function deleteConversation({ accessToken, conversationId, assistantId, fetchImpl = fetch }) {
  if (!conversationId) return false
  try {
    const res = await fetchImpl(`${ORIGIN}/chatglm/backend-api/assistant/conversation/delete`, {
      method: 'POST',
      headers: {
        ...fakeHeaders(),
        Authorization: `Bearer ${accessToken}`,
        Referer: `${ORIGIN}/main/alltoolsdetail`,
        ...signHeaders(),
      },
      // 实测（2026-09-26）：只传 conversation_id 会 400
      // {"validation_error":{"body_params":[{"loc":["assistant_id"],"msg":"field required"}]}} —— 必须带 assistant_id。
      body: JSON.stringify({ assistant_id: assistantId ?? DEFAULT_ASSISTANT_ID, conversation_id: conversationId }),
    })
    return res.ok
  } catch {
    return false
  }
}

/**
 * 带缓存的客户端：同一 refresh_token 复用一个 access_token。
 */
export function createGlmWebClient({ fetchImpl = fetch, logger, minIntervalMs = 1500, authMode = 'refresh' } = {}) {
  /**
   * authMode：
   *  - 'refresh'（默认）：把凭据当 refresh_token，先换 access_token 再调用；
   *  - 'access'：把凭据直接当 access_token 用（对应网页端 cookie `chatglm_token`，约 2 小时有效），
   *    不发起刷新请求。用于拿不到 refresh_token、但能拿到访问令牌的场景。
   */
  // 允许传入函数，让插件页改完即时生效（不必重挂载插件）
  const resolveAuthMode = () => (typeof authMode === 'function' ? authMode() : authMode)
  const resolveMinInterval = () => (typeof minIntervalMs === 'function' ? Number(minIntervalMs()) || 0 : minIntervalMs)
  /** @type {Map<string, {accessToken: string, refreshToken: string, expiresAt: number}>} */
  const tokens = new Map()
  /** @type {Map<string, Promise<any>>} */
  const inflight = new Map()

  /**
   * 请求闸门：网页端同一账号通常只允许一路输出，且并发容易被风控。
   * 这里做两件事：① 串行（同一时刻只允许一个流在跑）；② 相邻请求最小间隔。
   * DSH 会在主对话之外并发发起标题生成/压缩等辅助调用，没有闸门时会互相打断。
   */
  let tail = Promise.resolve()
  let lastStart = 0
  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
  async function acquire() {
    const previous = tail
    let release
    tail = new Promise((resolve) => {
      release = resolve
    })
    await previous
    const waitMs = lastStart + resolveMinInterval() - Date.now()
    if (waitMs > 0) await sleep(waitMs)
    lastStart = Date.now()
    let released = false
    return () => {
      if (released) return
      released = true
      release()
    }
  }

  async function tokenFor(refreshToken, signal) {
    if (resolveAuthMode() === 'access') {
      // 直接用访问令牌：不缓存（换令牌后立即生效），也不发刷新请求
      return { accessToken: refreshToken, refreshToken, expiresAt: Date.now() + TOKEN_TTL_MS }
    }
    const cached = tokens.get(refreshToken)
    if (cached && cached.expiresAt > Date.now() + TOKEN_REFRESH_MARGIN_MS) return cached
    const pending = inflight.get(refreshToken)
    if (pending) return pending
    const task = fetchAccessToken(refreshToken, { fetchImpl, signal })
      .then((fresh) => {
        tokens.set(refreshToken, fresh)
        // 服务端可能轮换 refresh_token：新值也登记一份，避免下一轮又走旧值。
        if (fresh.refreshToken !== refreshToken) tokens.set(fresh.refreshToken, fresh)
        logger?.info?.('[glm-web] 清言登录态已刷新')
        return fresh
      })
      .finally(() => {
        inflight.delete(refreshToken)
      })
    inflight.set(refreshToken, task)
    return task
  }

  return {
    /** 主动校验登录态（连通性测试用）。 */
    async check(refreshToken, signal) {
      await tokenFor(refreshToken, signal)
      return true
    },
    async *chat({ refreshToken, assistantId, chatMode, prompt, signal }) {
      const token = await tokenFor(refreshToken, signal)
      const release = await acquire()
      let conversationId = ''
      try {
        for await (const event of streamChat({
          accessToken: token.accessToken,
          assistantId,
          chatMode,
          prompt,
          fetchImpl,
          signal,
        })) {
          if (event.kind === 'done') conversationId = event.conversationId
          yield event
        }
      } finally {
        if (conversationId) {
          void deleteConversation({
            accessToken: token.accessToken,
            conversationId,
            assistantId,
            fetchImpl,
          })
        }
        release()
      }
    },
    invalidate(refreshToken) {
      tokens.delete(refreshToken)
    },
  }
}
