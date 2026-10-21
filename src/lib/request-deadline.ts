/** Bound new operational I/O even when a transport ignores cancellation. */
export async function withDeadline<T>(milliseconds: number, work: (signal: AbortSignal) => PromiseLike<T>): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new Error('request_deadline_exceeded'))
    }, milliseconds)
  })
  try {
    return await Promise.race([Promise.resolve().then(() => work(controller.signal)), deadline])
  } finally {
    clearTimeout(timer)
  }
}
