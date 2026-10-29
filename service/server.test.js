/**
 * server.js 集成测试 —— 通过注入假转换器与利用库的 passthrough/判型分支，
 * 覆盖全部端点行为，不依赖真实 doc2x 二进制（真实转换冒烟见 README）。
 */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const net = require('node:net')
const { createService } = require('./server')

// ZIP 本地文件头魔数开头即可触发库的 passthrough 分支（输入被当作已是 .docx）
const FAKE_DOCX = Buffer.concat([Buffer.from([0x50, 0x4b]), Buffer.from('fake-docx-content')])
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

function deferred() {
  let resolve, reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

async function startService(t, options = {}) {
  const { server, queue, config } = createService({ port: 0, ...options })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  t.after(async () => {
    if (server.closeIdleConnections) server.closeIdleConnections()
    await new Promise((resolve) => server.close(resolve))
  })
  return { server, queue, config, base: `http://127.0.0.1:${port}` }
}

test('GET /health 返回状态与队列统计', async (t) => {
  const { base } = await startService(t)
  const res = await fetch(`${base}/health`)
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.status, 'ok')
  assert.equal(typeof body.uptimeSeconds, 'number')
  assert.ok(body.queue.concurrency >= 1)
  assert.equal(body.queue.running, 0)
})

test('POST /convert 透传已是 .docx 的输入', async (t) => {
  const { base } = await startService(t)
  const res = await fetch(`${base}/convert`, { method: 'POST', body: FAKE_DOCX })
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), DOCX_MIME)
  assert.equal(res.headers.get('x-passthrough'), 'true')
  assert.equal(res.headers.get('x-duration-ms'), '0')
  const buf = Buffer.from(await res.arrayBuffer())
  assert.ok(buf.equals(FAKE_DOCX))
})

test('空请求体返回 400', async (t) => {
  const { base } = await startService(t)
  const res = await fetch(`${base}/convert`, { method: 'POST', body: Buffer.alloc(0) })
  assert.equal(res.status, 400)
  const body = await res.json()
  assert.match(body.error, /为空或过短/)
})

test('既不是 .doc 也不是 .docx 的内容返回 400', async (t) => {
  const { base } = await startService(t)
  const res = await fetch(`${base}/convert`, { method: 'POST', body: Buffer.from('definitely not a word document') })
  assert.equal(res.status, 400)
  const body = await res.json()
  assert.match(body.error, /既不是 \.doc/)
})

test('超过上传上限返回 413（按 Content-Length 快速拒绝）', async (t) => {
  const { base } = await startService(t, { maxUploadBytes: 8 })
  const res = await fetch(`${base}/convert`, { method: 'POST', body: Buffer.alloc(64, 1) })
  assert.equal(res.status, 413)
  const body = await res.json()
  assert.match(body.error, /超过上限/)
})

test('队列满时返回 503 与 Retry-After', async (t) => {
  const gate = deferred()
  const slowConvert = async () => {
    await gate.promise
    return { buffer: FAKE_DOCX, durationMs: 1, passthrough: false }
  }
  const { base } = await startService(t, { convert: slowConvert, concurrency: 1, queueMax: 1, queueWaitMs: 5000 })

  const p1 = fetch(`${base}/convert`, { method: 'POST', body: Buffer.from('a') })
  await new Promise((r) => setTimeout(r, 50)) // 等第一个请求占住转换名额
  const p2 = fetch(`${base}/convert`, { method: 'POST', body: Buffer.from('b') })
  await new Promise((r) => setTimeout(r, 50)) // 等第二个请求进入等待队列

  const res3 = await fetch(`${base}/convert`, { method: 'POST', body: Buffer.from('c') })
  assert.equal(res3.status, 503)
  assert.equal(res3.headers.get('retry-after'), '5')
  const body3 = await res3.json()
  assert.match(body3.error, /队列已满/)

  gate.resolve()
  assert.equal((await p1).status, 200)
  assert.equal((await p2).status, 200)
})

test('转换失败（库抛 422 类错误）映射为 422', async (t) => {
  const failConvert = async () => { throw new Error('doc2x 转换失败：模拟错误') }
  const { base } = await startService(t, { convert: failConvert })
  const res = await fetch(`${base}/convert`, { method: 'POST', body: Buffer.from('x') })
  assert.equal(res.status, 422)
  const body = await res.json()
  assert.match(body.error, /模拟错误/)
})

test('未知路径返回 404', async (t) => {
  const { base } = await startService(t)
  const res = await fetch(`${base}/nope`)
  assert.equal(res.status, 404)
})

test('/convert 只允许 POST', async (t) => {
  const { base } = await startService(t)
  const res = await fetch(`${base}/convert`, { method: 'GET' })
  assert.equal(res.status, 405)
  assert.equal(res.headers.get('allow'), 'POST')
})

test('chunked 传输中流式超限返回 413 JSON 而非连接重置', async (t) => {
  const { base } = await startService(t, { maxUploadBytes: 8 })
  const port = new URL(base).port

  // 用原生 http 客户端发 Transfer-Encoding: chunked 的请求（无 Content-Length，
  // 走 readBody 的流式超限路径），分多块写，确保超限发生在读取过程中
  const { status, body } = await new Promise((resolve, reject) => {
    const req = http.request({
      port, host: '127.0.0.1', path: '/convert', method: 'POST',
      headers: { 'Transfer-Encoding': 'chunked' },
    }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }))
    })
    req.on('error', reject)
    let i = 0
    const timer = setInterval(() => {
      i++
      if (i > 4) { clearInterval(timer); req.end(); return }
      req.write(Buffer.alloc(16, i)) // 写到第二块即超限（16 > 8）
    }, 20)
  })
  assert.equal(status, 413)
  assert.match(JSON.parse(body).error, /超过上限/)
})

test('畸形 request-target 不会导致进程崩溃', async (t) => {
  const { base } = await startService(t)
  const port = Number(new URL(base).port)

  // 用裸 socket 发 absolute-form 的非法 request-target（曾导致 new URL 抛
  // 未捕获异常杀掉进程），断言拿到的是正常 HTTP 响应而非连接断开
  const response = await new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1', () => {
      sock.write('GET http://[ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n')
    })
    const chunks = []
    sock.on('data', (c) => chunks.push(c))
    sock.on('end', () => resolve(Buffer.concat(chunks).toString()))
    sock.on('error', reject)
  })
  assert.match(response, /^HTTP\/1\.1 404 /)

  // 服务仍然活着
  const health = await fetch(`${base}/health`)
  assert.equal(health.status, 200)
})

test('排队超时映射为 503 与 Retry-After', async (t) => {
  const gate = deferred()
  const slowConvert = async () => {
    await gate.promise
    return { buffer: FAKE_DOCX, durationMs: 1, passthrough: false }
  }
  const { base } = await startService(t, { convert: slowConvert, concurrency: 1, queueMax: 10, queueWaitMs: 50 })

  const p1 = fetch(`${base}/convert`, { method: 'POST', body: Buffer.from('a') })
  await new Promise((r) => setTimeout(r, 30)) // 占住转换名额
  const res2 = await fetch(`${base}/convert`, { method: 'POST', body: Buffer.from('b') })
  assert.equal(res2.status, 503)
  assert.equal(res2.headers.get('retry-after'), '5')
  assert.match((await res2.json()).error, /排队超过/)

  gate.resolve()
  assert.equal((await p1).status, 200)
})
