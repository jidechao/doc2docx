/**
 * doc2docx HTTP 转换服务 —— 把库包装成与语言无关的 HTTP 微服务（裸 node:http，零依赖）。
 *
 * 两个核心约束决定设计：
 * 1. 每次转换 spawn 一个原生进程 —— 由 queue.js 的有界队列兜底：并发上限 +
 *    排队 + 队列溢出拒绝（503 + Retry-After）。
 * 2. 库 API 要求整个输入在内存中拼成 Buffer —— 必须限制单请求体积（默认
 *    100MB），且在读取 body 的过程中一旦超限立即掐断，不等到拼完。
 *
 * 内存账：最坏情况 ≈ 并发上限 ×（输入 + 输出）≈ 并发上限 × 2 × MAX_UPLOAD_MB。
 * 内存紧张的机器调低 DOC2DOCX_SERVICE_CONCURRENCY 即可。
 *
 * 已知边界：优雅停机若在超时后强制退出（process.exit），在途转换 spawn 的
 * doc2x 原生子进程不会被带走（Windows 上父子进程无信号关联），%TEMP%\doc2x-*
 * 临时目录可能残留。常驻服务场景可接受，重启后由操作系统清理临时目录。
 */
const http = require('node:http')
const os = require('node:os')
const { convertDocToDocx } = require('../src/index')
const { createQueue } = require('./queue')

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

// src/index.js 的 classifyInput 在转换开始前抛出的错误，属于"客户端给了不该给的
// 文件"，映射 400；其余（转换器报错、产物校验不过、转换超时）是服务端转换失败，
// 映射 422。靠前缀匹配区分，这些消息在库中是稳定契约。
const CLIENT_ERROR_PREFIXES = [
  '文件内容为空',
  '该文件既不是',
  '该文件受密码保护',
  '该文件是旧版 Office',
]

/**
 * 读取数值型环境变量：非法值（如 MAX_UPLOAD_MB=abc 得 NaN）回退默认并告警。
 * 不做这层校验的话，NaN 参与的比较恒为 false，上传上限/队列上限会静默失效——
 * 防护层悄悄消失比直接启动失败更危险。
 */
function envInt(name, fallback) {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  const v = Number(raw)
  if (!Number.isFinite(v)) {
    console.warn(`[doc2docx-service] 环境变量 ${name}=${raw} 非法，回退默认值 ${fallback}`)
    return fallback
  }
  return v
}

function defaultConfig() {
  return {
    port: envInt('PORT', 3100),
    host: process.env.HOST || '0.0.0.0',
    concurrency: envInt('DOC2DOCX_SERVICE_CONCURRENCY', os.cpus().length),
    queueMax: envInt('DOC2DOCX_SERVICE_QUEUE_MAX', 100),
    queueWaitMs: envInt('DOC2DOCX_SERVICE_QUEUE_WAIT_MS', 300000),
    maxUploadBytes: envInt('MAX_UPLOAD_MB', 100) * 1024 * 1024,
    convertTimeoutMs: envInt('DOC2DOCX_TIMEOUT_MS', 120000),
    shutdownTimeoutMs: envInt('DOC2DOCX_SERVICE_SHUTDOWN_MS', 30000),
  }
}

/**
 * 分块收集请求体，累计超限立即掐断（错误码 PAYLOAD_TOO_LARGE），
 * 不把超限的部分读进内存。Content-Length 已超限时不读 body 直接拒绝。
 *
 * 超限分支用 req.pause() 而不是 req.destroy()：reject 只是把拒绝排入微任务队列，
 * 若同步销毁底层 socket，等调用方拿到拒绝时再写 413 响应已经写不进去了——客户端
 * 看到的会是连接重置而不是 413。socket 的销毁统一由 handleConvert 在 413 响应
 * 发完之后（Connection: close + afterEnd）负责。
 */
function readBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'])
    if (Number.isFinite(declared) && declared > limitBytes) {
      const err = new Error(`请求体 ${formatMb(declared)} 超过上限 ${formatMb(limitBytes)}`)
      err.code = 'PAYLOAD_TOO_LARGE'
      reject(err)
      return
    }
    const chunks = []
    let total = 0
    let settled = false
    req.on('data', (chunk) => {
      if (settled) return
      total += chunk.length
      if (total > limitBytes) {
        settled = true
        const err = new Error(`请求体超过上限 ${formatMb(limitBytes)}`)
        err.code = 'PAYLOAD_TOO_LARGE'
        req.pause() // 停止流入；socket 由 handleConvert 的 413 分支在响应后销毁
        reject(err)
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (!settled) { settled = true; resolve(Buffer.concat(chunks)) }
    })
    req.on('error', (e) => {
      if (!settled) { settled = true; reject(e) }
    })
    // 客户端中途断连：部分场景只发 close 不发 error，不兜底的话 Promise 会
    // 悬挂到 requestTimeout 才被掐
    req.on('close', () => {
      if (!settled) { settled = true; reject(new Error('客户端在请求体传输完成前断开了连接')) }
    })
  })
}

function formatMb(bytes) {
  return `${(bytes / 1048576).toFixed(1)}MB`
}

function sendJson(res, status, obj, headers = {}, afterEnd) {
  const payload = Buffer.from(JSON.stringify(obj))
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': payload.length,
    ...headers,
  })
  res.end(payload, afterEnd)
}

async function handleConvert(req, res, ctx) {
  let body
  try {
    body = await readBody(req, ctx.config.maxUploadBytes)
  } catch (e) {
    if (e.code === 'PAYLOAD_TOO_LARGE') {
      // 请求体可能还没读完，响应后关闭连接，避免 keep-alive 复用到脏 socket
      sendJson(res, 413, { error: e.message }, { Connection: 'close' }, () => req.socket.destroy())
      return
    }
    sendJson(res, 400, { error: `读取请求体失败：${e.message}` })
    return
  }

  let result
  try {
    result = await ctx.queue.run(() => ctx.convert(body, { timeoutMs: ctx.config.convertTimeoutMs }))
  } catch (e) {
    if (e.code === 'QUEUE_FULL' || e.code === 'QUEUE_TIMEOUT') {
      sendJson(res, 503, { error: e.message }, { 'Retry-After': '5' })
      return
    }
    const isClientError = CLIENT_ERROR_PREFIXES.some((p) => e.message && e.message.startsWith(p))
    sendJson(res, isClientError ? 400 : 422, { error: e.message || String(e) })
    return
  }

  res.writeHead(200, {
    'Content-Type': DOCX_MIME,
    'Content-Length': result.buffer.length,
    'X-Passthrough': String(result.passthrough),
    'X-Duration-Ms': String(result.durationMs),
  })
  res.end(result.buffer)
}

/**
 * 创建服务实例（不自动监听，便于测试注入假转换器与自定义配置）。
 *
 * @param {object} [options] 覆盖 defaultConfig() 的任意字段；另可注入
 *   `convert`（默认 convertDocToDocx）用于测试。
 * @returns {{ server: http.Server, queue: object, config: object }}
 */
function createService(options = {}) {
  const { convert = convertDocToDocx, ...overrides } = options
  const config = { ...defaultConfig(), ...overrides }
  const queue = createQueue({
    concurrency: config.concurrency,
    maxWaiting: config.queueMax,
    waitTimeoutMs: config.queueWaitMs,
  })
  const startedAt = Date.now()
  const ctx = { config, queue, convert }

  const server = http.createServer((req, res) => {
    // 不用 new URL()：req.url 由客户端完全控制，畸形 request-target（如代理场景
    // 的 absolute-form "http://["）会让 URL 构造器抛异常，发生在 request 监听器
    // 的同步代码里、任何 catch 之外，直接升级成 uncaughtException 杀掉进程。
    // 本服务不需要解析 query，按 ? 切开即可，永不抛异常。
    const pathname = req.url.split('?')[0]

    if (pathname === '/convert') {
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: '方法不允许，请用 POST' }, { Allow: 'POST' })
        return
      }
      handleConvert(req, res, ctx).catch((e) => {
        // 兜底：任何未预期错误返回 500，不让连接悬挂
        if (!res.headersSent) sendJson(res, 500, { error: `服务内部错误：${e.message}` })
        else res.destroy()
      })
      return
    }

    if (pathname === '/health') {
      if (req.method !== 'GET') {
        sendJson(res, 405, { error: '方法不允许，请用 GET' }, { Allow: 'GET' })
        return
      }
      sendJson(res, 200, {
        status: 'ok',
        uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
        queue: queue.stats(),
      })
      return
    }

    sendJson(res, 404, { error: `未知路径：${pathname}。可用：POST /convert，GET /health` })
  })

  // 请求级超时必须覆盖 排队 + 转换 全程，否则 Node 默认 requestTimeout（300s）
  // 会在长队列等待期间掐断连接
  server.requestTimeout = config.queueWaitMs + config.convertTimeoutMs + 60000

  return { server, queue, config }
}

function main() {
  const { server, config } = createService()
  server.listen(config.port, config.host, () => {
    console.log(`doc2docx 转换服务已启动：http://${config.host}:${config.port}`)
    console.log(
      `并发上限=${config.concurrency} 队列上限=${config.queueMax} ` +
      `上传上限=${formatMb(config.maxUploadBytes)} 转换超时=${config.convertTimeoutMs}ms`,
    )
  })

  let closing = false
  function shutdown(signal) {
    if (closing) return
    closing = true
    console.log(`收到 ${signal}，停止接收新请求，等待在途转换完成（上限 ${config.shutdownTimeoutMs}ms）...`)
    server.close(() => {
      console.log('在途请求已全部完成，退出')
      process.exit(0)
    })
    if (server.closeIdleConnections) server.closeIdleConnections()
    // unref：计时器本身不阻止正常退出；若进程因在途请求还活着，到点强制退出
    setTimeout(() => {
      console.error('等待在途请求超时，强制退出')
      process.exit(1)
    }, config.shutdownTimeoutMs).unref()
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

if (require.main === module) main()

module.exports = { createService, defaultConfig }
