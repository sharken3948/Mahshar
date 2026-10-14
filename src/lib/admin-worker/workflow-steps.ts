import 'server-only'
import { advanceWorkerCheckpoint, parseWorkerCheckpoint } from './checkpoint'
import { WORKER_CHUNK_SIZE } from './constants'
import { processDiscoveryRange } from './discovery/processor'
import { processAcquisitionBatch } from './acquisition'
import { acquisitionPort } from './acquisition-runtime'
import { advanceWorkerDiscoveryRun, claimWorkerRun, completeWorkerRun, failWorkerRun } from './repository'
import type { WorkerRunDto } from './types'
import type { CandidateOutcome } from './discovery/types'

export function aggregateDiscoveryCounters(outcomes: CandidateOutcome[]) {
  return outcomes.reduce((sum, item) => ({
    discovered: sum.discovered + item.discovered,
    duplicate: sum.duplicate + item.duplicate,
    filtered: sum.filtered + item.filtered,
    qualified: sum.qualified + item.qualified,
    persisted: sum.persisted + item.persisted,
    reviewCandidate: sum.reviewCandidate + item.reviewCandidate,
    deferred: sum.deferred + item.deferred,
    tractionScored: sum.tractionScored + item.tractionScored,
  }), { discovered: 0, duplicate: 0, filtered: 0, qualified: 0, persisted: 0, reviewCandidate: 0, deferred: 0, tractionScored: 0 })
}

export async function claimWorkerRunStep(runId: string): Promise<WorkerRunDto> {
  'use step'
  return claimWorkerRun(runId)
}

type ChunkDependencies = {
  discover: typeof processDiscoveryRange
  acquire: (runId: string, epoch: string) => Promise<unknown>
  advance: typeof advanceWorkerDiscoveryRun
}

export async function processDiscoveryChunkStep(runId: string, checkpointValue: unknown, acquisitionEpoch?: string,
  dependencies: Partial<ChunkDependencies> = {}): Promise<WorkerRunDto> {
  'use step'
  const deps: ChunkDependencies = { discover: processDiscoveryRange,
    acquire: (id, epoch) => processAcquisitionBatch(acquisitionPort(id, epoch), WORKER_CHUNK_SIZE),
    advance: advanceWorkerDiscoveryRun, ...dependencies }
  const checkpoint = parseWorkerCheckpoint(checkpointValue)
  if (!checkpoint) throw new Error('worker_checkpoint_invalid')
  const requested = advanceWorkerCheckpoint(checkpoint, WORKER_CHUNK_SIZE)
  const result = await deps.discover(runId, checkpoint.nextIndex, requested.nextIndex)
  if (acquisitionEpoch) await deps.acquire(runId, acquisitionEpoch)
  const counters = aggregateDiscoveryCounters(result.outcomes)
  return deps.advance(runId, checkpoint.nextIndex, result.nextIndex, counters, result)
}

export async function completeWorkerRunStep(runId: string): Promise<WorkerRunDto> {
  'use step'
  return completeWorkerRun(runId)
}

export async function failWorkerRunStep(runId: string): Promise<void> {
  'use step'
  await failWorkerRun(runId, 'workflow_execution_failed')
}
