/**
 * dsh-glm-web —— 把智谱清言（chatglm.cn）网页版登录态接成 DSH 的模型 provider。
 *
 * 设计要点：
 *  1. 直接实现 dsh-llm 适配器（ctx.llm.registerAdapter），不另起本地服务进程；
 *  2. 登录态三层解析：插件配置字段 → credentials 服务 → 环境变量 → 凭据文件；
 *  3. 网页端没有原生 function calling，工具调用由 adapter 里的提示词信封桥提供。
 *
 * 免责声明：使用非官方接口，可能违反服务方条款并有账号风险，仅供个人自用。
 */
import { createRequire } from 'node:module'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createGlmWebClient } from './chatglm.js'
import { MODEL_SPECS, PROVIDER, createAdapter } from './adapter.js'

export const name = 'dsh-glm-web'
/** 只依赖 llm seam；credentials 服务可选（ctx.get 取不到就走环境变量/凭据文件）。 */
export const inject = ['llm']

const DEFAULT_CREDENTIAL_REF = 'GLM_WEB_REFRESH_TOKEN'
const DEFAULTS = { credentialRef: DEFAULT_CREDENTIAL_REF, refreshToken: '', minIntervalMs: 1500, authMode: 'refresh' }

const logger = {
  info: (message) => console.log(`[glm-web] ${message}`),
  warn: (message) => console.warn(`[glm-web] ${message}`),
}

/** DSH 主目录：$DSH_HOME（非空白）→ ~/.dsh。 */
function dshHome() {
  const envHome = process.env.DSH_HOME
  if (envHome !== undefined && envHome.trim().length > 0) return envHome
  return join(homedir(), '.dsh')
}

/** volatile 字段在宿主侧是引用对象：取值时现读，保证插件页改完即时生效。 */
function dereferenceConfig(source) {
  const result = {}
  for (const [key, value] of Object.entries(source ?? {})) {
    result[key] =
      value !== null && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value
  }
  return result
}

function normalizeConfig(value) {
  const source = dereferenceConfig(value)
  return {
    credentialRef:
      typeof source.credentialRef === 'string' && source.credentialRef.trim().length > 0
        ? source.credentialRef.trim()
        : DEFAULTS.credentialRef,
    refreshToken: typeof source.refreshToken === 'string' ? source.refreshToken.trim() : DEFAULTS.refreshToken,
    minIntervalMs:
      typeof source.minIntervalMs === 'number' && Number.isFinite(source.minIntervalMs) && source.minIntervalMs >= 0
        ? source.minIntervalMs
        : DEFAULTS.minIntervalMs,
    authMode: source.authMode === 'access' ? 'access' : 'refresh',
  }
}

/** 从 ~/.dsh/.credentials.yaml 的 refs 段取一个标量（只做最小 YAML 解析）。 */
function credentialFromFile(ref, home = dshHome()) {
  try {
    const lines = readFileSync(join(home, '.credentials.yaml'), 'utf8').split(/\r?\n/)
    let inRefs = false
    for (const line of lines) {
      if (!inRefs) {
        if (/^refs:\s*(?:#.*)?$/.test(line)) inRefs = true
        continue
      }
      if (line.length > 0 && !/^\s/.test(line)) break
      const match = line.match(/^\s+([A-Za-z_][A-Za-z0-9_-]*):\s*(.*?)\s*$/)
      if (match === null || match[1] !== ref) continue
      let value = match[2]
      if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
        try {
          value = JSON.parse(value)
        } catch {
          value = value.slice(1, -1)
        }
      } else {
        value = value.replace(/\s+#.*$/, '').trim()
      }
      return value.length > 0 ? value : undefined
    }
    return undefined
  } catch {
    return undefined
  }
}

/** 插件私有凭据文件：~/.dsh/storages/glm-web/token.txt（一行一个 token）。 */
/**
 * 凭据必须"像"一个令牌，否则一律当作未配置。
 *
 * 实测事故（2026-09-26）：token.txt 里留着占位说明行「<把凭据粘贴到这一行…>」，
 * 旧实现取"第一个非空行"直接当令牌用，于是发出
 * `Authorization: Bearer <把凭据粘贴到这一行…>`，中文触发了 undici 的
 * `Cannot convert argument to a ByteString …` —— 报错里没有头名，排查成本极高。
 * 现在：长度不足、含空白或尖括号、或者连三段式结构都没有的，一概视为未配置。
 */
function looksLikeCredential(value) {
  const text = String(value ?? '').trim()
  if (text.length < 40) return false
  if (/[\s<>]/.test(text)) return false
  return text.split('.').length >= 3 || /^[A-Za-z0-9._-]{40,}$/.test(text)
}

function credentialFromStorage(home = dshHome()) {
  try {
    const raw = readFileSync(join(home, 'storages', 'glm-web', 'token.txt'), 'utf8')
    const line = raw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => looksLikeCredential(l))
    return line
  } catch {
    return undefined
  }
}

/** 同步兜底解析（配置文件 → 环境变量 → 凭据文件）；不合规的值一律忽略。 */
function resolveTokenSync(ref) {
  const env = process.env[ref]
  if (typeof env === 'string' && looksLikeCredential(env)) return env.trim()
  return credentialFromFile(ref) ?? credentialFromStorage()
}

/** 当前 profile 名（宿主以 --profile <name> 启动；默认 desktop，与 DSH Desktop 一致）。 */
function argvProfile(argv = process.argv) {
  const flag = argv.indexOf('--profile')
  if (flag !== -1 && flag + 1 < argv.length && !argv[flag + 1].startsWith('-')) return argv[flag + 1]
  const inline = argv.find((arg) => arg.startsWith('--profile='))
  if (inline !== undefined) return inline.slice('--profile='.length)
  return 'desktop'
}

/**
 * schemastery 从若干 require 上下文加载，拿到宿主同一实例的 schema 工厂。
 * 依次尝试：当前 profile → 本插件在 profile 里的落点 → 宿主 app 资源目录 → 本包自身。
 */
function loadSchemastery() {
  const ids = ['@deepseek-ai/schemastery', 'schemastery']
  const candidates = [
    join(dshHome(), 'profiles', argvProfile(), 'package.json'),
    join(dshHome(), 'profiles', argvProfile(), 'node_modules', 'dsh-glm-web', 'package.json'),
    join(process.resourcesPath ?? '', 'app', 'package.json'),
    import.meta.url,
  ]
  for (const target of candidates) {
    for (const id of ids) {
      try {
        const requireFrom = createRequire(target)
        const mod = requireFrom(id)
        const resolved = mod !== null && mod !== undefined && mod.default !== undefined ? mod.default : mod
        if (resolved !== null && resolved !== undefined && typeof resolved.object === 'function') return resolved
      } catch {
        /* 换下一个候选 */
      }
    }
  }
  return null
}

function volatileField(field) {
  if (field === null || field === undefined) return field
  if (typeof field.volatile === 'function') return field.volatile()
  field.meta = { ...(field.meta ?? {}), volatile: true }
  return field
}

function createSettingsSchema(z) {
  if (z === null || z === undefined || typeof z.object !== 'function') return undefined
  return z.object({
    credentialRef: volatileField(z.string().default(DEFAULTS.credentialRef)),
    refreshToken: volatileField(z.string().default(DEFAULTS.refreshToken)),
    minIntervalMs: volatileField(z.number().default(DEFAULTS.minIntervalMs)),
    authMode: volatileField(z.string().default(DEFAULTS.authMode)),
  })
}

export const Config = createSettingsSchema(loadSchemastery())

export function apply(ctx, config = {}) {
  const currentConfig = () => normalizeConfig(config)

  const getRefreshToken = async (signal) => {
    const settings = currentConfig()
    if (looksLikeCredential(settings.refreshToken)) return settings.refreshToken.trim()
    if (settings.refreshToken.length > 0) {
      logger.warn('插件设置里的 refreshToken 不像一个令牌（长度不足或含空白/尖括号），已忽略')
    }
    const credentials = ctx.get('credentials')
    if (credentials !== undefined && credentials !== null && typeof credentials.resolve === 'function') {
      try {
        const resolved = await credentials.resolve(settings.credentialRef)
        const value =
          typeof resolved === 'string' ? resolved : resolved?.value ?? resolved?.secret ?? resolved?.token
        if (looksLikeCredential(value)) return String(value).trim()
      } catch (error) {
        logger.warn(`凭据服务解析 ${settings.credentialRef} 失败：${error?.message ?? error}`)
      }
    }
    void signal
    return resolveTokenSync(settings.credentialRef)
  }

  const client = createGlmWebClient({
    logger,
    minIntervalMs: () => currentConfig().minIntervalMs,
    authMode: () => currentConfig().authMode,
  })
  const adapter = createAdapter({ client, getRefreshToken, getConfig: currentConfig, logger })

  // 幂等注册：bundle 行与热行可能同时存在（双行并存），重复注册同一个 provider
  // 会被 dsh-llm 以 DUPLICATE_ADAPTER 拒绝 —— 那属于预期情形，不应当成插件故障。
  try {
    ctx.llm.registerAdapter([PROVIDER], adapter)
  } catch (error) {
    const text = String(error?.code ?? '') + String(error?.message ?? error)
    if (!/(DUPLICATE|already registered|already exists)/i.test(text)) throw error
    logger.warn(`provider "${PROVIDER}" 已由另一行注册，跳过重复挂载`)
  }

  logger.info(`已注册 provider "${PROVIDER}"（${MODEL_SPECS.map((spec) => spec.id).join(', ')}）`)

  // 落一份「本插件真的被宿主应用了」的证据（诊断用；不含任何凭据）。
  try {
    const dir = join(dshHome(), 'storages', 'glm-web')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'last-apply.json'),
      JSON.stringify(
        {
          at: new Date().toISOString(),
          pid: process.pid,
          profile: argvProfile(),
          provider: PROVIDER,
          models: MODEL_SPECS.map((spec) => spec.id),
          credentialRef: currentConfig().credentialRef,
          hasInlineToken: currentConfig().refreshToken.length > 0,
        },
        null,
        2,
      ) + '\n',
      'utf8',
    )
  } catch {
    // 诊断文件是附加能力：只读环境（无写权限）下静默跳过，不影响 provider 注册。
  }
  logger.info(`登录态：插件设置 refreshToken / credentials[${currentConfig().credentialRef}] / 环境变量 / ~/.dsh/storages/glm-web/token.txt`)
}
