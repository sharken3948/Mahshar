import { WORKER_CHUNK_SIZE, WORKER_MAX_BATCH_SIZE } from '@/lib/admin-worker/constants'
import { sleep } from 'workflow'
import { acquisitionStillRunningStep, createNextAcquisitionRunStep, failAcquisitionStep, finishAcquisitionCanaryStep, processAcquisitionStep } from '@/lib/admin-worker/acquisition-runtime'
import {
  claimWorkerRunStep,
  completeWorkerRunStep,
  failWorkerRunStep,
  processDiscoveryChunkStep,
} from '@/lib/admin-worker/workflow-steps'
import type { WorkerRunStatus } from '@/lib/admin-worker/types'

const terminalStatuses = new Set<WorkerRunStatus>(['stopped', 'completed', 'failed'])

export async function workerBatchWorkflow(runId: string, acquisitionEpoch?: string, canary = false): Promise<{ runId: string; status: WorkerRunStatus }> {
  'use workflow'
  let currentRunId = runId
  while (true) {
    try {
      let run = await claimWorkerRunStep(currentRunId)
      if (terminalStatuses.has(run.status)) return { runId: currentRunId, status: run.status }
      if (canary) {
        if (!acquisitionEpoch) throw new Error('acquisition_canary_epoch_missing')
        await processAcquisitionStep(currentRunId, acquisitionEpoch, true)
        await finishAcquisitionCanaryStep(acquisitionEpoch)
        run = await claimWorkerRunStep(currentRunId)
        return { runId: currentRunId, status: run.status }
      }
      if (acquisitionEpoch) await processAcquisitionStep(currentRunId, acquisitionEpoch)

      const maximumChunks = Math.ceil(WORKER_MAX_BATCH_SIZE / WORKER_CHUNK_SIZE)
      for (let chunk = 0; chunk < maximumChunks && run.checkpoint.nextIndex < run.batch_size; chunk += 1) {
        run = await processDiscoveryChunkStep(currentRunId, run.checkpoint, acquisitionEpoch)
        if (terminalStatuses.has(run.status)) break
      }

      if (!terminalStatuses.has(run.status)) run = await completeWorkerRunStep(currentRunId)
      if (!acquisitionEpoch || run.status !== 'completed') return { runId: currentRunId, status: run.status }
      // Workflow sleep is durable: the server/browser need not stay alive between batches.
      do {
        await sleep('1h')
        if (!await acquisitionStillRunningStep(acquisitionEpoch)) return { runId: currentRunId, status: 'stopped' }
        const next = await createNextAcquisitionRunStep(acquisitionEpoch)
        if (next) { currentRunId = next; break }
      } while (true)
    } catch (error) {
      await failWorkerRunStep(currentRunId)
      if (acquisitionEpoch) await failAcquisitionStep(acquisitionEpoch)
      throw error
    }
  }
}
