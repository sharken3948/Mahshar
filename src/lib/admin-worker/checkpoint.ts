import { WORKER_MAX_BATCH_SIZE } from './constants'
import type { WorkerCheckpoint } from './types'

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value)
}

export function parseWorkerCheckpoint(value: unknown): WorkerCheckpoint | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const checkpoint = value as Record<string, unknown>
  if (Object.keys(checkpoint).some(key => !['version', 'nextIndex', 'batchSize'].includes(key))) return null
  if (checkpoint.version !== 1 || !isInteger(checkpoint.nextIndex) || !isInteger(checkpoint.batchSize)) return null
  if (checkpoint.batchSize < 1 || checkpoint.batchSize > WORKER_MAX_BATCH_SIZE) return null
  if (checkpoint.nextIndex < 0 || checkpoint.nextIndex > checkpoint.batchSize) return null
  return { version: 1, nextIndex: checkpoint.nextIndex, batchSize: checkpoint.batchSize }
}

export function initialWorkerCheckpoint(batchSize: number): WorkerCheckpoint {
  const checkpoint = parseWorkerCheckpoint({ version: 1, nextIndex: 0, batchSize })
  if (!checkpoint) throw new Error('worker_batch_size_invalid')
  return checkpoint
}

export function isResumableCheckpoint(value: unknown, configuredBatchSize?: number): value is WorkerCheckpoint {
  const checkpoint = parseWorkerCheckpoint(value)
  return checkpoint !== null
    && (configuredBatchSize === undefined || checkpoint.batchSize === configuredBatchSize)
    && checkpoint.nextIndex > 0
    && checkpoint.nextIndex < checkpoint.batchSize
}

export function advanceWorkerCheckpoint(checkpoint: WorkerCheckpoint, chunkSize: number): WorkerCheckpoint {
  if (!Number.isInteger(chunkSize) || chunkSize < 1) throw new Error('worker_chunk_size_invalid')
  return {
    version: 1,
    nextIndex: Math.min(checkpoint.batchSize, checkpoint.nextIndex + chunkSize),
    batchSize: checkpoint.batchSize,
  }
}
