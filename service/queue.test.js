/**
 * queue.js 单元测试 —— 全部用假任务覆盖，不依赖真实 doc2x 二进制。
 */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createQueue } = require('./queue')

function deferred() {
  let resolve, reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

test('同时在途任务不超过并发上限', async () => {
  const queue = createQueue({ concurrency: 2 })
  let active = 0
  let peak = 0
  const task = async () => {
    active++
    peak = Math.max(peak, active)
    await new Promise((r) => setTimeout(r, 20))
    active--
  }
  await Promise.all(Array.from({ length: 6 }, () => queue.run(task)))
  assert.equal(peak, 2)
})

test('等待任务按 FIFO 顺序执行', async () => {
  const queue = createQueue({ concurrency: 1 })
  const order = []
  const gate = deferred()
  const first = queue.run(async () => { await gate.promise; order.push('first') })
  const second = queue.run(async () => { order.push('second') })
  const third = queue.run(async () => { order.push('third') })
  gate.resolve()
  await Promise.all([first, second, third])
  assert.deepEqual(order, ['first', 'second', 'third'])
})

test('等待队列满时以 QUEUE_FULL 拒绝', async () => {
  const queue = createQueue({ concurrency: 1, maxWaiting: 1 })
  const gate = deferred()
  const running = queue.run(() => gate.promise)
  const queued = queue.run(() => gate.promise)
  await assert.rejects(queue.run(() => Promise.resolve()), { code: 'QUEUE_FULL' })
  gate.resolve()
  await Promise.all([running, queued])
})

test('排队超时以 QUEUE_TIMEOUT 拒绝', async () => {
  const queue = createQueue({ concurrency: 1, maxWaiting: 10, waitTimeoutMs: 50 })
  const gate = deferred()
  const running = queue.run(() => gate.promise)
  await assert.rejects(queue.run(() => Promise.resolve()), { code: 'QUEUE_TIMEOUT' })
  gate.resolve()
  await running
})

test('stats() 反映在途与排队数量', async () => {
  const queue = createQueue({ concurrency: 1, maxWaiting: 10 })
  const gate = deferred()
  const running = queue.run(() => gate.promise)
  const queued = queue.run(() => Promise.resolve())
  assert.deepEqual(queue.stats(), { running: 1, waiting: 1, concurrency: 1, maxWaiting: 10 })
  gate.resolve()
  await Promise.all([running, queued])
  assert.deepEqual(queue.stats(), { running: 0, waiting: 0, concurrency: 1, maxWaiting: 10 })
})

test('任务抛错会传播给调用方且释放并发名额', async () => {
  const queue = createQueue({ concurrency: 1 })
  await assert.rejects(queue.run(async () => { throw new Error('boom') }), { message: 'boom' })
  assert.equal(queue.stats().running, 0)
  // 名额已释放，后续任务能正常执行
  assert.equal(await queue.run(async () => 'ok'), 'ok')
})

test('非法并发数直接抛错', () => {
  assert.throws(() => createQueue({ concurrency: 0 }), RangeError)
})
