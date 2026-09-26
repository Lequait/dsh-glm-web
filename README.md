# dsh-glm-web

把**智谱清言（chatglm.cn）网页版登录态**接成 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）的原生模型 provider：
在模型选择器里直接选「清言网页 · 通用」，用**网页版积分**跑 agent（含工具调用），不消耗开放平台 API 额度。

## ⚠️ 免责声明（先读这一段）

- 本项目是**非官方客户端**，通过抓包分析得到的私有网页接口通信，**与智谱官方无关，未经其许可或认可**。
- 使用者需自行承担**账号被风控、限流或封禁**的风险，并自行确认使用方式符合服务方条款与当地法律。
- 仅供**个人学习研究**使用。**禁止商用、禁止对外提供服务、禁止用于批量或自动化滥用**。
- 本项目**不包含**任何来自其他开源实现的源码。接口事实（端点、签名算法、请求体字段）来自公开的社区实现与线上前端代码，
  代码为独立重写。详见「协议来源」一节。
- 软件按「原样」提供，不附带任何担保。作者不对因使用本项目造成的任何损失负责。

## 使用方法（三步）

1. **装插件**（三选一）：

   ```powershell
   dsh plugin --profile desktop add github:<owner>/dsh-glm-web   # 从 GitHub
   dsh plugin --profile desktop add dsh-glm-web                  # 从 npm（若已发布）
   dsh plugin --profile desktop add link:H:\dsh-plugins\dsh-glm-web  # 本地目录
   ```

2. **放登录态**（任选其一）：

   - 浏览器登录 chatglm.cn → F12 → Application → **Cookies** → 复制 `chatglm_refresh_token`（180 天）；
     或在该标签页控制台跑 `copy(document.cookie.match(/chatglm_refresh_token=([^;]+)/)[1])`；
   - 粘进 `~/.dsh/storages/glm-web/token.txt`，或在 **DSH 设置 → 插件 → dsh-glm-web** 里填 `refreshToken` 字段。
   - 只拿得到访问令牌（`chatglm_token`，约 2 小时）也能用：把那串填进去，并把 `authMode` 改成 `access`。

3. **重启 DSH**（bundle 在冷启动挂载），然后在模型选择器里选 **`清言网页 · 通用`**。
   `glm-web/deep` 是网页端沉思模式，更慢更耗积分；model id 也可以直接填清言智能体 id（24 位以上小写字母数字）。

---
**Unofficial Zhipu Qingyan (chatglm.cn) web provider for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`).**

It turns your logged-in Qingyan web account into a native DSH model provider, so the agent runs on web-app credits
instead of open-platform API quota. No DOM automation, no browser kept open — one refresh token is enough.

Verified against a real account: token refresh, streaming chat, and a real tool call (parsed arguments included).

> Not affiliated with Zhipu. Uses private web endpoints; account risk is yours. Research/personal use only.

---
# dsh-glm-web

把 **智谱清言（chatglm.cn）网页版登录态**接成 DSH 的原生模型 provider：在模型选择器里直接选
「清言网页 · 通用」，用**网页版积分**跑 DSH 的 agent（含工具调用），不消耗开放平台 API 额度。

## 它是什么 / 不是什么

- **是**：一个 DSH 插件（Cordis plugin），通过 `ctx.llm.registerAdapter` 注册 `glm-web` provider，
  自己构造请求直连清言网页端私有接口（`assistant/stream`）。
- **不是**：DOM 自动化，也不需要浏览器一直开着；登录态只用一个 refresh_token。
- **不是**：开放平台 API。走的是网页端通道，**风险自担**（可能违反服务方条款、可能被风控）。

## 协议来源

接口事实（端点、签名算法、请求体字段、SSE 帧结构）取自现有开源实现：

| 项目 | 语言 | 说明 |
| --- | --- | --- |
| [xiaoY233/GLM-Free-API](https://github.com/xiaoY233/GLM-Free-API) | TypeScript | 智谱清言逆向 OpenAI 代理；已停更并指向 Chat2API |
| [uicaster/GLM-WebApi](https://github.com/uicaster/GLM-WebApi) | Python | 同类实现，2026-07 更新 |
| [xiaoY233/Chat2API](https://github.com/xiaoY233/Chat2API) | TypeScript/Electron | 多平台网页版统一管理工具（GLM 渠道支持 OAuth） |

本插件**没有**复制它们的源码，按接口事实独立重写：

- 签名：`sign = md5(timestamp-checkdigit + nonce + SIGN_SECRET)`（已对线上 `main.<hash>.js` 的前端函数逐字符核对）
- 鉴权头：前端把 cookie 值读出来后再拼前缀，即 `Authorization: "Bearer " + token`（access 与 refresh 都一样）
- 访问令牌有效期：刷新成功后写 `dayjs().add(2,"hour")`，即 2 小时
- 取 token：`POST /chatglm/user-api/user/refresh`
- 对话：`POST /chatglm/backend-api/assistant/stream`（SSE，`parts` 全量快照，按前缀差分）
- 收尾：`POST /chatglm/backend-api/assistant/conversation/delete`（每次新会话，用完即删）

## 安装

```powershell
# 方式一：从 npm（发布后）
dsh plugin --profile desktop add dsh-glm-web

# 方式二：从 GitHub 仓库
dsh plugin --profile desktop add github:<owner>/dsh-glm-web

# 方式三：本地 tarball / 源码目录
dsh plugin --profile desktop add link:H:\dsh-plugins\dsh-glm-web
```

装完**重启一次 DSH**（bundle 在冷启动时挂载），然后在模型选择器里选「清言网页 · 通用」。

```powershell
dsh plugin --profile web add link:H:\CoreStation\.tmp\dsh-glm-web
```

## 登录态（三选一）

1. **环境变量**：`GLM_WEB_REFRESH_TOKEN=...`
2. **DSH 凭据**：`~/.dsh/.credentials.yaml` 的 `refs:` 段加 `GLM_WEB_REFRESH_TOKEN: <值>`
3. **免编辑文件**：把 token 写进 `~/.dsh/storages/glm-web/token.txt`（一行即可）
4. 或在 **DSH 设置 → 插件 → dsh-glm-web** 的 `refreshToken` 字段直接填

取 token：浏览器登录 <https://chatglm.cn> → F12 → **Application → Cookies** → 找 `chatglm_refresh_token`
（前端代码里它就是 js-cookie 写的 cookie：键 `chatglm_refresh_token`、域 `.chatglm.cn`、有效期 180 天；
访问令牌另存为 `chatglm_token`。Chat2API 的接入手册写的是 Local Storage —— 那里也看一眼，哪边有就用哪边。）

### 两种凭据都支持（`authMode`）

网页端有两个令牌，插件两种都能用：

| 凭据 | `authMode` | 来源 | 有效期 | 说明 |
| --- | --- | --- | --- | --- |
| `chatglm_refresh_token` | `refresh`（默认） | 前端 js-cookie 写的 cookie | 180 天 | 每次自动换 access_token，长期可用 |
| `chatglm_token` | `access` | 同上 | 约 2 小时 | 拿不到 refresh_token 时的兜底：直接把访问令牌当凭据，不发起刷新请求 |

`authMode` 在插件设置页实时生效（不需要重挂载插件）。实测：access 模式下刷新调用 0 次、Authorization 用的就是原令牌；
切回 refresh 模式后刷新调用 1 次、用的是新换到的令牌。

> ⚠️ 实测在某台机器上 `document.cookie` 读不到 `chatglm_refresh_token`（浏览器/登录方式不同，可能落在 HttpOnly cookie
> 或 Local Storage 里）。这时用 DevTools 的 Application 面板逐个看，或先跑下面的探针。

### 找凭据的探针（粘进控制台）

```js
(() => {
  const cookie = document.cookie;
  const ck = cookie.match(/chatglm_refresh_token=([^;]+)/);
  const ak = cookie.match(/chatglm_token=([^;]+)/);
  const info = {
    cookieNames: cookie.split('; ').filter(Boolean).map(c => c.split('=')[0]),
    refresh_in_cookie: !!ck, access_in_cookie: !!ak,
    localKeys: Object.keys(localStorage), sessionKeys: Object.keys(sessionStorage),
    refresh_in_ls: localStorage.getItem('chatglm_refresh_token'),
    access_in_ls: localStorage.getItem('chatglm_token'),
  };
  console.log(info);
  const value = (ck && ck[1]) || info.refresh_in_ls || info.access_in_ls || (ak && ak[1]);
  if (value) { copy(value); console.log('已复制（长度 ' + value.length + '）'); }
  else console.log('三处都没有，见上面清单');
  return info;
})()
```

取 token 最省事的一行式：在**你自己已登录的 chatglm.cn 标签页**的控制台里执行（js-cookie 写的 cookie 不是 HttpOnly，
所以页面自己就能读；这条只读你当前页面的 cookie，不涉及其他应用的凭据库）：

```js
copy(document.cookie.match(/chatglm_refresh_token=([^;]+)/)[1])
```

token 就直接进剪贴板了，粘进 token.txt 即可。若哪个环境把它放进了 Local Storage，对应的一行式是
`copy(localStorage.getItem('chatglm_refresh_token'))`。

## 使用

模型选择器里选 `glm-web/chat`（通用）或 `glm-web/deep`（沉思）。
model id 也可以直接填清言智能体 id（24 位以上小写字母数字），该智能体会被当作模型使用。

## 工具调用

网页端没有原生 function calling，本插件用**提示词信封**桥接，格式与规则对齐
[Chat2API](https://github.com/xiaoY233/Chat2API) 的 GLM 变体（`src/main/proxy/prompt/variants/glm.ts`，
目前仍在维护、且在 GLM 网页通道上经过大量真实调用）：

```
[function_calls]
[call:read_file]{"path":"a.txt"}[/call]
[/function_calls]
```

解析器同时容忍本插件早期用的 `<<<TOOL_CALLS>>>` JSON 信封，以及模型自由发挥成裸 JSON 数组的情况；
模型把 Windows 路径写成单反斜杠时会先做一次定向修复（`\A` 非法、而 `\r` 合法正是把路径吃掉的那类坑）。
流式解析器把信封转成 DSH 的 `tool-call` 块并以 `finish: tool-calls` 收尾；信封残缺或解析失败时
**不静默丢内容**，而是把原文当正文上屏。工具结果以 `[TOOL_RESULT for 调用 id]` 回灌，与说明书里承诺的格式一致。

## 路由存活核对（无需账号）

服务端对「路由不存在」返回 404、对「存在但需鉴权」返回 401，因此不带真实凭据也能确认端点是否还在：

| 路由 | 探测结果 |
| --- | --- |
| `/chatglm/backend-api/assistant/stream`（本插件用） | **401** `unauthorized user(40102)` → 存在 |
| `/chatglm/backend-api/assistant/conversation/delete`（本插件用） | **401** `You need to be authenticated…` → 存在 |
| `/chatglm/user-api/user/refresh`（本插件用） | 完整请求头 → **401**；只带部分请求头 → **400 40001 bad request** |
| `/chatglm/backend-api/this_route_should_not_exist_xyz`（对照） | **404** → 判定器本身有效 |

注意第三行：`user/refresh` 少带 `X-App-*` / `X-Exp-Groups` / `Sec-Ch-Ua*` 这些头时会被判 400，
带上就进到鉴权判断（401）。这从反向印证了插件当前的请求头集合是完整的。

## 验证

两个脚本都不需要真实账号即可跑：

```powershell
node tools/protocol-test.mjs   # 协议回归：假 chatglm.cn 跑通 取token → 流式 → 会话回收（9 项断言）
node tools/selftest.mjs        # 真机自检：需要真实 refresh_token，跑 取token → 流式对话 → 工具信封
```

> 两个脚本都用 `process.exitCode` 而不是 `process.exit()`——后者会截断管道下未 flush 的 stdout，
> 实测只打印第一行断言，正好把失败藏起来（假阴性）。

## 请求闸门（默认开启）

网页端同一账号通常只允许**一路输出**，DSH 又会在主对话之外并发发起标题生成/压缩等辅助调用。
客户端的闸门做两件事：同一时刻只允许一个流在跑（串行），相邻请求至少间隔 `minIntervalMs`（默认 1500ms）。
插件页可改 `minIntervalMs`。实测（三路并发、间隔设 150ms）：起始时刻 1 / 240 / 470ms，无重叠。

## 已知限制

- 单账号通常只允许一路并发；DSH 的子代理并行调用可能被限流。
- 历史每轮全量重发（网页端会话用完即删），长会话吃 token。
- 网页端改版会让协议失效，需要按新接口修 `lib/chatglm.js`。协议事实的核对方法：抓
  `https://chatglm.cn/main.<hash>.js` 搜签名常量与端点；或对照 Chat2API 的 `src/main/providers/builtin/glm.ts`
  （`chatPath: '/chatglm/backend-api/assistant/stream'`、`tokenCheckEndpoint: '/chatglm/user-api/user/refresh'`）。
- 图片输入、联网搜索的引用重编号等高级能力未实现。
