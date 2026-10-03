import { WORKER_CHUNK_SIZE, WORKER_MAX_BATCH_SIZE } from '@/lib/admin-worker/constants'
import {
  claimWorkerRunStep,
  completeWorkerRunStep,
  failWorkerRunStep,
  processDiscoveryChunkStep,
} from '@/lib/admin-worker/workflow-steps'
import type { WorkerRunStatus } from '@/lib/admin-worker/types'

const terminalStatuses = new Set<WorkerRunStatus>(['stopped', 'completed', 'failed'])

export async function workerBatchWorkflow(runId: string): Promise<{ runId: string; status: WorkerRunStatus }> {
  'use workflow'
  try {
    let run = await claimWorkerRunStep(runId)
    if (terminalStatuses.has(run.status)) return { runId, status: run.status }

    const maximumChunks = Math.ceil(WORKER_MAX_BATCH_SIZE / WORKER_CHUNK_SIZE)
    for (let chunk = 0; chunk < maximumChunks && run.checkpoint.nextIndex < run.batch_size; chunk += 1) {
      run = await processDiscoveryChunkStep(runId, run.checkpoint)
      if (terminalStatuses.has(run.status)) return { runId, status: run.status }
    }

    run = await completeWorkerRunStep(runId)
    return { runId, status: run.status }
  } catch (error) {
    await failWorkerRunStep(runId)
    throw error
  }
}
