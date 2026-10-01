import 'server-only'
import { start } from 'workflow/api'
import { workerBatchWorkflow } from '@/workflows/admin-worker-batch'
import { startWorkerBatch, stopWorkerBatch, type WorkerStartMode } from './control'
import { workerControlRepository } from './repository'

async function launchWorkerWorkflow(runId: string): Promise<string> {
  const run = await start(workerBatchWorkflow, [runId])
  return run.runId
}

export function startWorkerCommand(mode: WorkerStartMode) {
  return startWorkerBatch(mode, workerControlRepository, launchWorkerWorkflow)
}

export function stopWorkerCommand() {
  return stopWorkerBatch(workerControlRepository)
}

