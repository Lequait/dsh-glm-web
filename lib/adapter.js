/**
 * dsh-llm 适配器：provider `glm-web`。
 *
 * 契约按 dsh-deepseek-web-login（Apache-2.0）的鸭子类型实现方式对齐：
 * providerInfo / providerRetryPolicy / imageRequestPricing / listModels /
 * resolveModel / prepareCall / stream。
 *
 * 网页端没有原生 function calling，工具调用走「提示词信封 + 流式解析」桥。
 */
import { DEFAULT_ASSISTANT_ID } from './chatglm.js'

export const PROVIDER = 'glm-web'

/**
 * 工具调用信封。主格式对齐 Chat2API（★1.7k，GLM 变体）的方括号协议：
 *   [function_calls]
 *   [call:工具名]{"参数":"值"}[/call]
 *   [/function_calls]
 * 同时容忍本插件早期用的 JSON 信封（历史会话/模型自由发挥时仍能解析）。
 */
const BRACKET_OPEN = '[function_calls]'
const BRACKET_CLOSE = '[/function_calls]'
const TOOL_OPEN = '<<<TOOL_CALLS>>>'
const TOOL_CLOSE = '<<<END_TOOL_CALLS>>>'
const OPENERS = [BRACKET_OPEN, TOOL_OPEN]
const MAX_OPENER_LEN = Math.max(...OPENERS.map((marker) => marker.length))
const CLOSER_FOR = new Map([
  [BRACKET_OPEN, BRACKET_CLOSE],
  [TOOL_OPEN, TOOL_CLOSE],
])

const EFFORT_OFF = 'off'
const EFFORT_HIGH = 'high'
const REASONING_EFFORTS = [
  { id: EFFORT_OFF, name: 'Off', description: '关闭思考通道（更快）' },
  { id: EFFORT_HIGH, name: 'High', description: '开启思考通道（默认）' },
]

/** 目录里的模型档位。model id 也可以用清言的智能体 id（24 位以上小写字母数字）。 */
export const MODEL_SPECS = [
  {
    id: 'glm-web/chat',
    name: '清言网页 · 通用',
    description: 'chatglm.cn 网页版登录态；消耗网页版积分，不消耗开放平台 API 额度',
    contextWindow: 128000,
    maxOutputTokens: 8192,
    assistantId: DEFAULT_ASSISTANT_ID,
    chatMode: 'zero',
  },
  {
    id: 'glm-web/deep',
    name: '清言网页 · 沉思（DeepResearch）',
    description: '网页端沉思模式，出结果更慢、更耗积分',
    contextWindow: 128000,
    maxOutputTokens: 16384,
    assistantId: DEFAULT_ASSISTANT_ID,
    chatMode: 'deep_research',
  },
]

function modelInfoFor(spec, requestedId) {
  return {
    provider: PROVIDER,
    id: requestedId ?? spec.id,
    name: spec.name,
    description: spec.description,
    inputModalities: ['text'],
  }
}

function resolvedModelInfo(spec, requestedId) {
  return {
    ...modelInfoFor(spec, requestedId),
    context: { contextWindow: spec.contextWindow },
    defaultMaxTokens: spec.maxOutputTokens,
    reasoning: { efforts: REASONING_EFFORTS, defaultEffort: EFFORT_HIGH },
  }
}

export function resolveSpec(model) {
  const requested = String(model ?? '')
  const direct = MODEL_SPECS.find((spec) => spec.id === requested)
  if (direct) return direct
  // 智能体 id 直通：清言里任意智能体都能当模型用。
  if (/^[a-z0-9]{24,}$/.test(requested)) {
    return { ...MODEL_SPECS[0], id: requested, name: '清言网页 · 智能体', assistantId: requested }
  }
  return MODEL_SPECS[0]
}

function textOf(block) {
  if (block === null || block === undefined) return ''
  if (typeof block === 'string') return block
  if (block.type === 'text' && typeof block.text === 'string') return block.text
  return ''
}

/** 把历史消息压成一段转写文本（网页端每次都是新会话，历史必须自己带全）。 */
export function renderTranscript(messages) {
  const lines = []
  for (const message of messages ?? []) {
    const role = String(message?.role ?? 'user')
    const blocks = Array.isArray(message?.content) ? message.content : [{ type: 'text', text: String(message?.content ?? '') }]
    if (role === 'system') {
      const text = blocks.map(textOf).join('').trim()
      if (text.length > 0) lines.push(`<|system|>\n${text}`)
      continue
    }
    if (role === 'assistant') {
      const parts = []
      for (const block of blocks) {
        if (!block) continue
        if (block.type === 'reasoning') continue // 思考过程不回灌，省 token
        if (block.type === 'tool-call') {
          parts.push(`${BRACKET_OPEN}\n[call:${block.name}]${JSON.stringify(safeParse(block.arguments))}[/call]\n${BRACKET_CLOSE}`)
          continue
        }
        const text = textOf(block)
        if (text.length > 0) parts.push(text)
      }
      const joined = parts.join('').trim()
      if (joined.length > 0) lines.push(`<|assistant|>\n${joined}`)
      continue
    }
    // user / tool：工具结果按 DSH 词汇夹在 user 消息里
    for (const block of blocks) {
      if (block?.type === 'tool-result') {
        // 与工具说明书里承诺的回灌格式保持一致（对齐 Chat2API 的 [TOOL_RESULT for id]）
        lines.push(`[TOOL_RESULT for ${String(block.toolCallId ?? '')}]${block.isError ? '（失败）' : ''}\n${flattenResult(block.content)}`)
      }
    }
    const text = blocks.map(textOf).join('').trim()
    if (text.length > 0) lines.push(`<|user|>\n${text}`)
  }
  return lines.join('\n\n')
}

function flattenResult(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((item) => (item?.type === 'text' && typeof item.text === 'string' ? item.text : `[${String(item?.type ?? '内容')}]`))
    .join('\n')
}

function safeParse(value) {
  if (value && typeof value === 'object') return value
  try {
    return JSON.parse(String(value ?? '{}'))
  } catch {
    return {}
  }
}

/**
 * 工具说明书：模型唯一合法的调用格式。
 *
 * 格式与规则对齐 Chat2API 的 GLM 变体（src/main/proxy/prompt/variants/glm.ts）——
 * 那是目前仍在维护、且在 GLM 网页通道上经过大量真实调用的实现；网页端没有原生
 * function calling，两边都只能靠提示词约定 + 流式解析。
 */
export function renderToolInstructions(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return ''
  const entries = tools
    .map((tool) => {
      const name = String(tool?.name ?? tool?.function?.name ?? '')
      if (name.length === 0) return ''
      const description = String(tool?.description ?? tool?.function?.description ?? '')
      const schema = tool?.parameters ?? tool?.input_schema ?? tool?.function?.parameters ?? {}
      return `- ${name}：${description}\n  参数 JSON Schema：${JSON.stringify(schema)}`
    })
    .filter((line) => line.length > 0)
    .join('\n')
  if (entries.length === 0) return ''
  return [
    '## 可用工具',
    '仅在确实需要时调用工具，参数必须严格符合下面的 JSON Schema。工具名大小写敏感，必须与列表完全一致。',
    '',
    entries,
    '',
    '## 工具调用协议',
    '决定调用工具时，你的回复除了下面这一个块之外不能有任何其他内容：',
    BRACKET_OPEN,
    `[call:列表里的确切工具名]{"参数":"值"}[/call]`,
    BRACKET_CLOSE,
    '',
    '硬性规则：',
    '1. 每次调用都必须以 [call:确切工具名] 开头、以 [/call] 结尾；',
    '2. JSON 必须压成一行，不要在 JSON 里换行，也不要用 markdown 代码围栏包起来；',
    '3. 需要在同一个块里调用多个工具时，每个调用各占一对 [call:...]…[/call]；',
    '4. 不要在块前后写解释、思考或任何其他文字；',
    '5. 路径/正则里的反斜杠和引号必须正确转义；',
    '6. 不需要调用工具时，正常用中文回答，不要输出这个块。',
    '',
    '工具执行结果会以下面的格式回灌给你：',
    '[TOOL_RESULT for 调用 id] 结果内容',
  ].join('\n')
}

function estimateTokens(text) {
  return Math.ceil(String(text ?? '').length / 3.2)
}

/** 修掉模型最常写的坏 JSON：Windows 路径里的单反斜杠（\A 非法、\r 却合法会把路径吃掉）。 */
/** 从乱文本里取出第一个「括号平衡」的 JSON 对象（字符串内的括号不计数）。 */
function firstBalancedJson(raw) {
  const text = String(raw ?? '')
  const start = text.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}

function repairJsonArguments(raw) {
  const text = String(raw ?? '').trim()
  if (text.length === 0) return null
  // 实测（2026-09-26）：模型偶尔把工具块输出成「半截 + 完整」两遍，捕获到的参数里会混进
  // `[/call[function_calls]…` 这类垃圾。按原样 → 修单反斜杠 → 取第一个平衡 JSON 对象，三级尝试。
  const attempts = [text, text.replace(/\\(?![\\"/bfnrtu])/g, '\\\\'), firstBalancedJson(text)]
  for (const candidate of attempts) {
    try {
      const parsed = JSON.parse(candidate)
      if (parsed !== null && typeof parsed === 'object') return JSON.stringify(parsed)
    } catch {
      /* 试下一个候选 */
    }
  }
  return null
}

/**
 * 从信封里解析工具调用，宽容两种格式：
 *   ① [function_calls][call:名字]{json}[/call][/function_calls]  ← 主格式
 *   ② <<<TOOL_CALLS>>>[{"name":..,"arguments":{..}}]<<<END_TOOL_CALLS>>>  ← 兼容旧格式
 * 解析失败返回 null（调用方把原文当正文上屏，绝不静默丢内容）。
 */
export function parseToolCalls(raw) {
  const text = String(raw ?? '')
  if (text.trim().length === 0) return null
  const calls = []

  const callPattern = /\[call:\s*([^\]]+?)\s*\]([\s\S]*?)\[\/call\]/g
  let match
  while ((match = callPattern.exec(text)) !== null) {
    const name = match[1].trim()
    if (name.length === 0) continue
    const args = repairJsonArguments(match[2]) ?? '{}'
    calls.push({ id: `call_${Math.random().toString(36).slice(2, 10)}`, name, arguments: args })
  }
  if (calls.length > 0) return calls

  // 旧格式 / 模型自由发挥成裸 JSON 数组
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  const body = start >= 0 && end > start ? text.slice(start, end + 1) : text.trim()
  let parsed
  try {
    parsed = JSON.parse(body)
  } catch {
    return null
  }
  if (!Array.isArray(parsed)) return null
  for (const item of parsed) {
    const name = String(item?.name ?? item?.tool ?? '')
    if (name.length === 0) continue
    const args = item?.arguments ?? item?.parameters ?? {}
    calls.push({
      id: `call_${Math.random().toString(36).slice(2, 10)}`,
      name,
      arguments: typeof args === 'string' ? args : JSON.stringify(args),
    })
  }
  return calls.length > 0 ? calls : null
}

/**
 * 创建适配器。
 * @param {{client: any, getConfig: () => any, logger?: any}} deps
 */
export function createAdapter(deps) {
  const logger = deps.logger

  async function* runStream(options) {
    const refreshToken = await deps.getRefreshToken(options?.signal)
    const spec = resolveSpec(options?.model)
    const messages = options?.messages ?? []
    const tools = options?.tools ?? []
    const instructions = renderToolInstructions(tools)
    const transcript = renderTranscript(instructions.length > 0 ? [{ role: 'system', content: [{ type: 'text', text: instructions }] }, ...messages] : messages)
    const requested = String(options?.model ?? spec.id)

    if (!refreshToken) {
      yield { type: 'finish', reason: { kind: 'error', failure: { message: '未配置清言登录态：把 chatglm_refresh_token 写进 ~/.dsh/storages/glm-web/token.txt（或在插件设置/环境变量 GLM_WEB_REFRESH_TOKEN 里配置）', code: 'MISSING_CREDENTIAL' } } }
      return
    }
    if (transcript.trim().length === 0) {
      yield { type: 'finish', reason: { kind: 'error', failure: { message: '没有可发送的内容', code: 'EMPTY_REQUEST' } } }
      return
    }

    let nextIndex = 0
    let textBlock = null
    let reasoningBlock = null
    let buffer = '' // 尚未决定归属的输出
    let toolMode = false
    let activeCloser = BRACKET_CLOSE
    let toolRaw = ''
    let textStarted = false
    let reasoningStarted = false
    let outputChars = 0
    let toolCallCount = 0

    const openText = () => {
      if (textBlock === null) textBlock = { index: nextIndex++, text: '' }
      return textBlock
    }
    const openReasoning = () => {
      if (reasoningBlock === null) reasoningBlock = { index: nextIndex++, text: '' }
      return reasoningBlock
    }

    try {
      for await (const event of deps.client.chat({
        refreshToken,
        assistantId: spec.assistantId,
        chatMode: spec.chatMode,
        prompt: transcript,
        signal: options?.signal,
      })) {
        if (event.kind === 'reasoning') {
          if (toolMode) continue
          const block = openReasoning()
          if (!reasoningStarted) {
            reasoningStarted = true
            yield { type: 'block-start', index: block.index, blockType: 'reasoning' }
          }
          block.text += event.delta
          outputChars += event.delta.length
          yield { type: 'text-delta', index: block.index, text: event.delta }
          continue
        }
        if (event.kind !== 'text') continue
        buffer += event.delta
        outputChars += event.delta.length

        if (!toolMode) {
          // 两种信封任取最先出现者
          let openerAt = -1
          let matchedOpener = ''
          for (const marker of OPENERS) {
            const at = buffer.indexOf(marker)
            if (at >= 0 && (openerAt === -1 || at < openerAt)) {
              openerAt = at
              matchedOpener = marker
            }
          }
          if (openerAt >= 0) {
            const head = buffer.slice(0, openerAt)
            buffer = buffer.slice(openerAt + matchedOpener.length)
            if (head.length > 0) {
              const block = openText()
              if (!textStarted) {
                textStarted = true
                yield { type: 'block-start', index: block.index, blockType: 'text' }
              }
              block.text += head
              yield { type: 'text-delta', index: block.index, text: head }
            }
            toolMode = true
            activeCloser = CLOSER_FOR.get(matchedOpener) ?? TOOL_CLOSE
            toolRaw = ''
          } else if (buffer.length > MAX_OPENER_LEN) {
            // 只有确认尾部不可能是任一种信封开头，才把前面的正文放出去
            const safeLength = buffer.length - (MAX_OPENER_LEN - 1)
            const head = buffer.slice(0, safeLength)
            buffer = buffer.slice(safeLength)
            const block = openText()
            if (!textStarted) {
              textStarted = true
              yield { type: 'block-start', index: block.index, blockType: 'text' }
            }
            block.text += head
            yield { type: 'text-delta', index: block.index, text: head }
          }
        }
        if (toolMode) {
          toolRaw += buffer
          buffer = ''
        }
      }

      // 流结束：补齐未上屏的正文
      if (!toolMode && buffer.length > 0) {
        const block = openText()
        if (!textStarted) {
          textStarted = true
          yield { type: 'block-start', index: block.index, blockType: 'text' }
        }
        block.text += buffer
        yield { type: 'text-delta', index: block.index, text: buffer }
      }
      if (toolMode) {
        const closeAt = toolRaw.indexOf(activeCloser)
        const body = closeAt >= 0 ? toolRaw.slice(0, closeAt) : toolRaw
        const calls = parseToolCalls(body)
        if (calls !== null) {
          for (const call of calls) {
            toolCallCount += 1
            const index = nextIndex++
            yield { type: 'block-start', index, blockType: 'tool-call' }
            yield { type: 'tool-call-delta', index, id: call.id, name: call.name, argumentsDelta: call.arguments }
            yield { type: 'block-end', index, block: { type: 'tool-call', id: call.id, name: call.name, arguments: call.arguments } }
          }
        } else {
          // 解析失败：绝不静默丢内容，把原始信封当正文上屏，让用户看见发生了什么
          const fallback = `\n${BRACKET_OPEN}\n${body}`
          const block = openText()
          if (!textStarted) {
            textStarted = true
            yield { type: 'block-start', index: block.index, blockType: 'text' }
          }
          block.text += fallback
          yield { type: 'text-delta', index: block.index, text: fallback }
        }
      }
    } catch (error) {
      const code = error?.code === 'AUTH' ? 'AUTH' : error?.code === 'RATE_LIMIT' ? 'RATE_LIMIT' : error?.code === 'TRANSPORT' ? 'TRANSPORT' : 'SERVER'
      logger?.warn?.(`[glm-web] 调用失败：${error?.message ?? error}`)
      yield { type: 'finish', reason: { kind: 'error', failure: { message: String(error?.message ?? error), code } } }
      return
    }

    if (reasoningBlock !== null && reasoningStarted) {
      yield { type: 'block-end', index: reasoningBlock.index, block: { type: 'reasoning', text: reasoningBlock.text } }
    }
    if (textBlock !== null && textStarted) {
      yield { type: 'block-end', index: textBlock.index, block: { type: 'text', text: textBlock.text } }
    }

    const inputTokens = estimateTokens(transcript)
    const outputTokens = estimateTokens((textBlock?.text ?? '') + (reasoningBlock?.text ?? ''))
    yield { type: 'usage', usage: { inputTokens, outputTokens, ...(reasoningBlock ? { reasoningTokens: estimateTokens(reasoningBlock.text) } : {}) } }

    yield { type: 'finish', reason: { kind: toolCallCount > 0 ? 'tool-calls' : 'stop' } }
  }

  return {
    providerInfo() {
      return { id: PROVIDER, name: '智谱清言 网页版（积分）' }
    },
    providerRetryPolicy() {
      return undefined
    },
    imageRequestPricing() {
      return undefined
    },
    listModels() {
      return Promise.resolve(MODEL_SPECS.map((spec) => modelInfoFor(spec)))
    },
    resolveModel(_provider, model) {
      const requested = String(model ?? '')
      return Promise.resolve(resolvedModelInfo(resolveSpec(requested), requested))
    },
    prepareCall(_provider, model) {
      const requested = String(model ?? '')
      return Promise.resolve({
        model: resolvedModelInfo(resolveSpec(requested), requested),
        stream: (options) => runStream(options),
      })
    },
    stream(options) {
      return runStream(options)
    },
  }
}
