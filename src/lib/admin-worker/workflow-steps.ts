import 'server-only'
import { advanceWorkerCheckpoint, parseWorkerCheckpoint } from './checkpoint'
import { WORKER_CHUNK_SIZE } from './constants'
import { advanceWorkerRun, claimWorkerRun, completeWorkerRun, failWorkerRun } from './repository'
import type { WorkerRunDto } from './types'

export async function claimWorkerRunStep(runId: string): Promise<WorkerRunDto> {
  'use step'
  return claimWorkerRun(runId)
}

export async function processSyntheticChunkStep(runId: string, checkpointValue: unknown): Promise<WorkerRunDto> {
  'use step'
  const checkpoint = parseWorkerCheckpoint(checkpointValue)
  if (!checkpoint) throw new Error('worker_checkpoint_invalid')
  const next = advanceWorkerCheckpoint(checkpoint, WORKER_CHUNK_SIZE)

  // Foundation-only deterministic work. Candidate identifiers live only for
  // this bounded step and are never stored as providers, products, or leads.
  for (let index = checkpoint.nextIndex; index < next.nextIndex; index += 1) {
    const candidateId = `candidate-${String(index + 1).padStart(4, '0')}`
    if (!/^candidate-\d{4}$/.test(candidateId)) throw new Error('synthetic_candidate_invalid')
  }
  return advanceWorkerRun(runId, checkpoint.nextIndex, next.nextIndex)
}

export async function completeWorkerRunStep(runId: string): Promise<WorkerRunDto> {
  'use step'
  return completeWorkerRun(runId)
}

export async function failWorkerRunStep(runId: string): Promise<void> {
  'use step'
  await failWorkerRun(runId, 'workflow_execution_failed')
}
