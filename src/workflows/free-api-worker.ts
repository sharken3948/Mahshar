import { sleep } from 'workflow'
import { workerStep } from '@/lib/free-api-worker/runtime'

export async function freeApiWorkflow(generation: string) {
  'use workflow'
  for (;;) {
    const result = await workerStep(generation)
    if (result === 'done') break
    if (typeof result === 'object') await sleep(new Date(result.waitUntil))
  }
  return { generation, status: 'finished' }
}
