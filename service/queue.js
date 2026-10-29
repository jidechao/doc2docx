/**
 * 有界并发队列 —— doc2docx 转换服务的进程护栏。
 *
 * 为什么需要它：每次转换都要 spawn 一个原生 doc2x 进程，且转换期间输入+输出
 * 两份字节同时驻留内存。并发无上限时，一波突发请求就能把 CPU、内存、文件句柄
 * 同时打满。所以这里三层防护：
 *
 *   1. concurrency  —— 同时在途的转换数上限，超出的进入 FIFO 排队而不是直接拒绝
 *                      （转换是秒级操作，短暂排队比让客户端重试体验好得多）；
 *   2. maxWaiting   —— 等待队列上限，满了立即拒绝（QUEUE_FULL）。排队不是免费的：
 *                      每个等待中的请求都持有一份完整的输入 Buffer；
 *   3. waitTimeoutMs —— 排队超时（QUEUE_TIMEOUT），防止客户端连接被无限期悬挂。
 *
 * 队列与具体任务解耦（fn 由调用方注入），因此可以在不碰真实二进制的情况下
 * 完整单测所有并发行为。
 */

/**
 * @param {{ concurrency: number, maxWaiting?: number, waitTimeoutMs?: number }} options
 * @returns {{ run: <T>(fn: () => Promise<T>) => Promise<T>, stats: () => object }}
 */
function createQueue({ concurrency, maxWaiting = Infinity, waitTimeoutMs = Infinity }) {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError(`concurrency 必须是 >= 1 的整数，收到：${concurrency}`)
  }
  let running = 0
  /** @type {Array<{ fn: Function, resolve: Function, reject: Function, timer: NodeJS.Timeout|null }>} */
  const waiting = []

  function start(item) {
    running++
    Promise.resolve()
      .then(item.fn)
      .then(item.resolve, item.reject)
      .finally(() => {
        running--
        pump()
      })
  }

  function pump() {
    while (running < concurrency && waiting.length > 0) {
      const item = waiting.shift()
      if (item.timer) clearTimeout(item.timer)
      start(item)
    }
  }

  function run(fn) {
    return new Promise((resolve, reject) => {
      if (running < concurrency) {
        start({ fn, resolve, reject, timer: null })
        return
      }
      if (waiting.length >= maxWaiting) {
        const err = new Error('转换队列已满，请稍后重试')
        err.code = 'QUEUE_FULL'
        reject(err)
        return
      }
      const item = { fn, resolve, reject, timer: null }
      if (Number.isFinite(waitTimeoutMs)) {
        item.timer = setTimeout(() => {
          const index = waiting.indexOf(item)
          if (index === -1) return // 已被 pump 取走
          waiting.splice(index, 1)
          const err = new Error(`排队超过 ${waitTimeoutMs}ms 仍未轮到，已放弃`)
          err.code = 'QUEUE_TIMEOUT'
          reject(err)
        }, waitTimeoutMs)
        // 不应因一个排队计时器阻止进程退出（优雅停机场景）
        if (item.timer.unref) item.timer.unref()
      }
      waiting.push(item)
    })
  }

  function stats() {
    return { running, waiting: waiting.length, concurrency, maxWaiting }
  }

  return { run, stats }
}

module.exports = { createQueue }
