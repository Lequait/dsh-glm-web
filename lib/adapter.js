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
    name: '清言网页 · 通用（推荐做 agent）',
    description: 'chatglm.cn 网页版登录态；普通对话模式，工具调用遵守度最好；消耗网页版积分，不消耗开放平台 API 额度',
    contextWindow: 128000,
    maxOutputTokens: 8192,
    assistantId: DEFAULT_ASSISTANT_ID,
    chatMode: 'zero',
  },
  {
    id: 'glm-web/deep',
    name: '清言网页 · 沉思（研究模式）',
    description: '网页端深度研究模式：它会自己联网检索与规划，容易无视工具协议，**不适合需要调用 DSH 工具的 agent 任务**；只用于让它自己查资料写长文',
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
  // 先建 toolCallId → 工具名 的映射：回灌时带上名字，模型更容易把结果与自己的调用对应起来
  const nameById = new Map()
  for (const message of messages ?? []) {
    if (message?.role !== 'assistant' || !Array.isArray(message.content)) continue
    for (const block of message.content) {
      if (block?.type === 'tool-call' && block.id) nameById.set(String(block.id), String(block.name ?? ''))
    }
  }
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
        const id = String(block.toolCallId ?? '')
        const toolName = nameById.get(id)
        const head = `[TOOL_RESULT for ${id}]${toolName ? ` (${toolName})` : ''}${block.isError ? '（失败）' : ''}`
        lines.push(`${head}\n${flattenResult(block.content)}`)
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
export function renderToolInstructions(tools, options = {}) {
  if (!Array.isArray(tools) || tools.length === 0) return ''
  // 预算：DSH 会话里常有 40+ 工具（含 MCP 全家桶），全量塞进去会把协议本身埋掉，
  // 模型反而更容易发明工具名或瞎猜参数（实测：它编造过一个不存在的 open_url）。
  const budget = Number.isFinite(options.budgetChars) ? Number(options.budgetChars) : 20000
  const usable = []
  for (const tool of tools) {
    const name = String(tool?.name ?? tool?.function?.name ?? '')
    if (name.length === 0) continue
    usable.push({
      name,
      description: String(tool?.description ?? tool?.function?.description ?? ''),
      schema: tool?.parameters ?? tool?.input_schema ?? tool?.function?.parameters ?? {},
    })
  }
  if (usable.length === 0) return ''
  const detailed = []
  const omitted = []
  let used = 0
  for (const tool of usable) {
    const entry = `- ${tool.name}：${tool.description}\n  参数：${JSON.stringify(tool.schema)}`
    if (used + entry.length <= budget) {
      detailed.push(entry)
      used += entry.length
    } else {
      omitted.push(tool.name)
    }
  }

  /**
   * 动态生成示例：**必须用这个会话里真实存在的工具名与参数名**。
   * 实测教训：示例里写 read_file 而会话里只有 read 时，模型会照抄形状但漏掉参数（产出 read({})）。
   */
  // PTC（程序化调用）模式：会话里只挂了 run_code 这类'执行代码'的工具时，读文件/查目录都要在 code 里用 tools.<tool>({...}) 完成。
  // 真机事故：说明书里写'调用 read/glob 之类'，而该会话根本没有这两个工具，模型于是退回自己的联网/文件协议习惯（file://、search/open）。
  const runner = usable.find((tool) => {
    const props = tool.schema && typeof tool.schema === 'object' ? tool.schema.properties : undefined
    if (!props || typeof props !== 'object') return false
    return Object.keys(props).some((k) => /^(code|script|source)$/i.test(k))
  })
  const ptcBlock = runner
    ? [
        '',
        '## 本会话是「程序化调用」模式（重要）',
        '你唯一能直接调用的工具是 __RUNNER__。想读文件、列目录、跑命令、搜索，都要在它的 code 里调用内部工具，例如：',
        BRACKET_OPEN,
        '[call:__RUNNER__]{"code":"const r = await tools.read({ file_path: \'H:/CoreStation/docs/STATE.md\' }); return r.lines" }[/call]',
        BRACKET_CLOSE,
        '要点：code 里用 await tools.<工具名>({...})（内部工具名与普通会话一致：read / glob / grep / pwsh 等）；',
        '不要写 file://、不要假设存在 search/open 这类工具、不要把「读文件」写成自然语言计划。',
      ].map((line) => line.split('__RUNNER__').join(runner.name))
    : []
  const example = pickExample(usable)
  const exampleBlock = example
    ? [
        `正确示例（用列表里真实存在的工具；注意参数一个都不能少）：`,
        BRACKET_OPEN,
        `[call:${example.name}]${example.json}[/call]`,
        BRACKET_CLOSE,
        '',
        '常见错误（都会被判失败，不要这样写）：',
        `- 漏参数：${BRACKET_OPEN} [call:${example.name}][/call] ${BRACKET_CLOSE}  ← 参数不能省`,
        '- 编造工具名：' + BRACKET_OPEN + ' [call:open_url]{"url":"..."} [/call] ' + BRACKET_CLOSE + '  ← 列表里没有的工具一律不能用',
      ]
    : []

  const header = omitted.length > 0
    ? `## 可用工具（${detailed.length} 个完整可用；另有 ${omitted.length} 个因长度限制未展开）`
    : `## 可用工具（${detailed.length} 个）`
  const parts = [
    '## 工具调用协议（必须严格遵守）',
    '需要调用工具时，你的整条回复**只能是**下面这个块，块外不要有任何解释、思考、前后缀：',
    BRACKET_OPEN,
    '[call:工具名]{"参数名":"参数值"}[/call]',
    BRACKET_CLOSE,
    '',
    '规则：',
    '1. 工具名必须与下方列表**完全一致**（大小写敏感）；**绝不允许发明工具名**。',
    '2. **参数一个都不能少**：每个必需参数都要出现在那个单行 JSON 里；缺参数的调用必然失败。',
    '3. 不要用 markdown 代码块包裹，不要输出 JSON 数组。',
    '4. 一次调用多个工具时，每个调用各占一对 [call:…]…[/call]，放在同一个块里。',
    '5. 不需要工具时，直接正常回答，不要输出这个块。',
    '6. **你没有浏览器、联网抓取或 file:// 协议能力**；要读本地文件只能调用下面列表里的工具——不要写 URL 或路径去访问，也不要使用列表之外的任何工具名。',
    '',
    ...exampleBlock,
    ...ptcBlock,
    '',
    header,
    ...detailed,
  ]
  if (omitted.length > 0) {
    parts.push('', `未展开的工具（只列名字，参数请勿猜测）：${omitted.join('、')}`)
  }
  parts.push('', '工具执行结果会以下面的格式回灌给你（括号里是工具名）：', '[TOOL_RESULT for 调用 id] (工具名)', '结果内容')
  return parts.join('\n')
}

/** 从工具列表里挑一个适合做示例的（优先"单个必填字符串参数"的工具），并填出真实参数值。 */
function pickExample(usable) {
  const scored = usable.map((tool) => {
    const props = tool.schema && typeof tool.schema === 'object' ? tool.schema.properties : undefined
    const required = Array.isArray(tool.schema?.required) ? tool.schema.required : []
    const keys = props && typeof props === 'object' ? Object.keys(props) : []
    const stringKeys = keys.filter((k) => props[k]?.type === 'string')
    const score = (required.length === 1 && stringKeys.includes(required[0]) ? 2 : 0) + (stringKeys.length > 0 ? 1 : 0)
    return { tool, keys, required, stringKeys, score }
  }).sort((a, b) => b.score - a.score)
  const best = scored[0]
  if (!best || best.score === 0) return null
  const key = best.required.find((k) => best.stringKeys.includes(k)) ?? best.stringKeys[0]
  if (!key) return null
  const value = /path|file|dir/i.test(key) ? 'H:\\CoreStation\\docs\\STATE.md' : '示例值'
  return { name: best.tool.name, json: JSON.stringify({ [key]: value }) }
}

/** 粗估 token（网页端不给 usage，用字符数/3.2 近似，仅用于 DSH 的显示与计量）。 */
function estimateTokens(text) {
  return Math.ceil(String(text ?? '').length / 3.2)
}

/** 上一轮没按协议输出时的严格重试提示（只补在末尾，短小、命令式）。 */
export function buildRetryReminder() {
  return [
    '【上一轮你没有按协议输出】',
    '你上一条回复里没有出现工具调用块。请重新判断：',
    '- 需要工具：**只**输出 [function_calls] 块，块外一个字都不要写；',
    '- 确实不需要工具：直接给出最终答案。',
    '不要解释你为什么没有输出块，也不要复述这条提示。',
  ].join('\n')
}

/** 是否像是"打算动手却没调工具"的表述（用于决定要不要重试一次）。 */
export const ACTION_INTENT_RE = /(我来|让我|我将|正在读取|正在执行|正在查询|尝试读取|尝试执行|尝试查询|准备读取|准备执行|需要先读取|下一步我|接下来我|调用工具|使用工具|无法直接读取|不能直接读取|无法访问该路径|没有权限|未开放对该|file:\/\/|open_url|联网检索|搜索引擎|我尝试通过|浏览器|web_search)/;

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
 * 信封被截断时的抢救：形如 `[call:名字]{"参数":...}`（缺 [/call] 或整块被服务端切断）。
 * 只在参数能解析成完整 JSON 对象时才认，避免把半截参数当合法调用发出去。
 */
export function salvagePartialCall(raw) {
  const match = /\[call:\s*([^\]\n]+?)\s*\]([\s\S]*)$/.exec(String(raw ?? ''))
  if (match === null) return null
  const name = match[1].trim()
  if (name.length === 0) return null
  const args = repairJsonArguments(match[2])
  if (args === null) return null
  return [{ id: `call_${Math.random().toString(36).slice(2, 10)}`, name, arguments: args }]
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
  if (calls.length > 0) return dedupeCalls(calls)

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
  return calls.length > 0 ? dedupeCalls(calls) : null
}

/**
 * 去掉完全重复的调用（同名 + 同参数）。
 * 真机实测：服务端会把工具块输出成"半截 + 完整"两份，全局正则各匹配一次，
 * 于是 DSH 会看到两个一模一样的调用并重复执行（读数类工具尤为浪费）。
 */
function dedupeCalls(calls) {
  const seen = new Set()
  const out = []
  for (const call of calls) {
    const key = call.name + '\u0000' + call.arguments
    if (seen.has(key)) continue
    seen.add(key)
    out.push(call)
  }
  return out
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
    const tools = Array.isArray(options?.tools) ? options.tools : []
    const transcript = renderTranscript(messages)
    const instructions = renderToolInstructions(tools, { budgetChars: deps.toolPromptBudget })
    // 协议块放在提示词**末尾**：实测放在最前面时会被 DSH 的超长 system prompt 与几十个工具定义埋掉，
    // 模型会直接无视它（甚至编造出 open_url 这种清言网页端自己的工具名）。
    // 真机实测：不加框定的话，模型会把整段转写当成"待分析的文档"来评论（甚至臆造工具名）。
    // 因此：① 开头说明这是它参与过的对话并要求接着写；② 结尾补一个 assistant 生成提示。
    const frameHead = '【对话记录】下面是你（assistant）与用户的完整对话，请**接着最后一条继续**作答；不要复述、评论或分析这段记录本身。'
    const frameTail = [
      '<|assistant|>',
      '（现在轮到你。要求：需要工具就按上面的协议输出调用块；否则只输出给用户的最终答案。）',
      '（禁止旁白与自述推理：不要写"我接下来要…""The conversation shows…"这类句子，不要分析这段记录；用用户使用的语言回答。）',
    ].join('\n')
    const prompt = instructions.length > 0
      ? `${frameHead}\n\n${transcript}\n\n${instructions}\n\n${frameTail}`
      : `${frameHead}\n\n${transcript}\n\n${frameTail}`

    if (!refreshToken) {
      yield { type: 'finish', reason: { kind: 'error', failure: { message: '未配置清言登录态：把 chatglm_refresh_token 写进 ~/.dsh/storages/glm-web/token.txt（或在插件设置/环境变量 GLM_WEB_REFRESH_TOKEN 里配置）', code: 'MISSING_CREDENTIAL' } } }
      return
    }
    if (prompt.trim().length === 0) {
      yield { type: 'finish', reason: { kind: 'error', failure: { message: '没有可发送的内容', code: 'EMPTY_REQUEST' } } }
      return
    }

    let nextIndex = 0

    /**
     * 跑一轮：把流式分片转成 DSH 的块协议，返回本轮正文与工具调用数。
     * silentText=true 时只取工具调用、不回吐正文 —— 供「严格重试」使用：
     * 否则用户会把同一段话看两遍（实测反馈：同样的消息会发两遍）。
     */
    async function* streamPass(promptText, passOptions = {}) {
      let textBlock = null
      let reasoningBlock = null
      let buffer = ''
      let toolMode = false
      let activeCloser = BRACKET_CLOSE
      let toolRaw = ''
      let textStarted = false
      let reasoningStarted = false
      let toolCallsInPass = 0
      const openText = () => {
        if (textBlock === null) textBlock = { index: nextIndex++, text: '' }
        return textBlock
      }
      const openReasoning = () => {
        if (reasoningBlock === null) reasoningBlock = { index: nextIndex++, text: '' }
        return reasoningBlock
      }
      const suppressText = passOptions.silentText === true
      const emitText = function* (chunk) {
        if (chunk.length === 0 || suppressText) return
        const block = openText()
        if (!textStarted) {
          textStarted = true
          yield { type: 'block-start', index: block.index, blockType: 'text' }
        }
        block.text += chunk
        yield { type: 'text-delta', index: block.index, text: chunk }
      }

      for await (const event of deps.client.chat({
        refreshToken,
        assistantId: spec.assistantId,
        chatMode: spec.chatMode,
        prompt: promptText,
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
          yield { type: 'text-delta', index: block.index, text: event.delta }
          continue
        }
        if (event.kind !== 'text') continue
        buffer += event.delta

        if (!toolMode) {
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
            yield* emitText(head)
            toolMode = true
            activeCloser = CLOSER_FOR.get(matchedOpener) ?? TOOL_CLOSE
            toolRaw = ''
          } else if (buffer.length > MAX_OPENER_LEN) {
            // 只有确认尾部不可能是任一种信封开头，才把前面的正文放出去
            const safeLength = buffer.length - (MAX_OPENER_LEN - 1)
            const head = buffer.slice(0, safeLength)
            buffer = buffer.slice(safeLength)
            yield* emitText(head)
          }
        }
        if (toolMode) {
          toolRaw += buffer
          buffer = ''
        }
      }

      // 流结束：补齐未上屏的正文
      if (!toolMode) yield* emitText(buffer)
      if (toolMode) {
        const closeAt = toolRaw.indexOf(activeCloser)
        const body = closeAt >= 0 ? toolRaw.slice(0, closeAt) : toolRaw
        let calls = parseToolCalls(body)
        if (calls === null) calls = salvagePartialCall(body) // 信封被截断：能救则救
        if (calls !== null) {
          for (const call of calls) {
            toolCallsInPass += 1
            const index = nextIndex++
            yield { type: 'block-start', index, blockType: 'tool-call' }
            yield { type: 'tool-call-delta', index, id: call.id, name: call.name, argumentsDelta: call.arguments }
            yield { type: 'block-end', index, block: { type: 'tool-call', id: call.id, name: call.name, arguments: call.arguments } }
          }
        } else {
          // 解析失败：绝不静默丢内容，把原始信封当正文上屏，让用户看见发生了什么
          yield* emitText(`\n${BRACKET_OPEN}\n${body}`)
        }
      }

      if (reasoningBlock !== null && reasoningStarted) {
        yield { type: 'block-end', index: reasoningBlock.index, block: { type: 'reasoning', text: reasoningBlock.text } }
      }
      if (textBlock !== null && textStarted) {
        yield { type: 'block-end', index: textBlock.index, block: { type: 'text', text: textBlock.text } }
      }
      return {
        text: textBlock?.text ?? '',
        reasoning: reasoningBlock?.text ?? '',
        toolCalls: toolCallsInPass,
      }
    }

    let totalText = ''
    let totalReasoning = ''
    let toolCallCount = 0
    const inputChars = prompt.length

    try {
      const first = yield* streamPass(prompt)
      totalText += first.text
      totalReasoning += first.reasoning
      toolCallCount += first.toolCalls

      // 空调用补救：这一轮给了工具、模型却只输出文字，而且文字里露出"准备动手"的意图
      // ——真机实测这是最常见的失败形态（模型用 prose 描述自己"正在读取文件"）。
      if (
        tools.length > 0 &&
        first.toolCalls === 0 &&
        first.text.length > 0 &&
        ACTION_INTENT_RE.test(first.text) &&
        options?.__retried !== true
      ) {
        logger?.info?.('[glm-web] 首轮未按协议调用工具（正文露出动作意图），追加一次严格重试')
        const retryPrompt = `${buildRetryReminder()}\n\n${instructions}`
        const second = yield* streamPass(retryPrompt, { silentText: true })
        totalText += second.text
        totalReasoning += second.reasoning
        toolCallCount += second.toolCalls
      }
    } catch (error) {
      const code = error?.code === 'AUTH' ? 'AUTH' : error?.code === 'RATE_LIMIT' ? 'RATE_LIMIT' : error?.code === 'TRANSPORT' ? 'TRANSPORT' : 'SERVER'
      logger?.warn?.(`[glm-web] 调用失败：${error?.message ?? error}`)
      yield { type: 'finish', reason: { kind: 'error', failure: { message: String(error?.message ?? error), code } } }
      return
    }

    if (totalText.length === 0 && toolCallCount === 0) {
      logger?.warn?.('[glm-web] 本轮既无正文也无工具调用（可能被风控或服务端截断）')
      yield { type: 'finish', reason: { kind: 'error', failure: { message: '清言本轮没有返回任何内容（可能被风控或截断），可直接重试', code: 'EMPTY_RESPONSE' } } }
      return
    }

    yield {
      type: 'usage',
      usage: {
        inputTokens: estimateTokens(inputChars),
        outputTokens: estimateTokens(totalText + totalReasoning),
        ...(totalReasoning.length > 0 ? { reasoningTokens: estimateTokens(totalReasoning) } : {}),
      },
    }
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
