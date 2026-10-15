import 'server-only'
import { start } from 'workflow/api'
import { workerBatchWorkflow } from '@/workflows/admin-worker-batch'
import { startWorkerBatch, stopWorkerBatch, type WorkerStartMode } from './control'
import { workerControlRepository } from './repository'
import { acquisitionCanaryEnabled, acquisitionContinuousEnabled, acquisitionModeEnabled, acquisitionState, setAcquisitionState, stopAcquisitionEpoch } from './acquisition-runtime'
import { WorkerControlError } from './control'
import { createServiceClient } from '@/lib/supabase/server'
import { WORKER_DAILY_RUN_LIMIT } from './constants'

async function launchWorkerWorkflow(runId: string): Promise<string> {
  if (!acquisitionModeEnabled()) {
    const run = await start(workerBatchWorkflow, [runId])
    return run.runId
  }
  const canary = acquisitionCanaryEnabled()
  const epoch = await setAcquisitionState(true, canary ? runId : null)
  try {
    const run = await start(workerBatchWorkflow, [runId, epoch, canary])
    return run.runId
  } catch (error) {
    await stopAcquisitionEpoch(epoch)
    throw error
  }
}

export async function startWorkerCommand(mode: WorkerStartMode) {
  if (acquisitionModeEnabled() && acquisitionCanaryEnabled() && process.env.ADMIN_ACQUISITION_CONTINUOUS === 'true') {
    throw new WorkerControlError('acquisition_modes_conflict', 409)
  }
  if (acquisitionModeEnabled() && !acquisitionCanaryEnabled() && !acquisitionContinuousEnabled()) {
    throw new WorkerControlError('acquisition_canary_required', 409)
  }
  if (acquisitionModeEnabled()) {
    const state = await acquisitionState()
    if (state.running) throw new WorkerControlError('worker_already_active', 409)
    if (acquisitionCanaryEnabled() && state.canaryUsed) throw new WorkerControlError('acquisition_canary_used', 409)
    if (acquisitionCanaryEnabled() && mode !== 'start') throw new WorkerControlError('acquisition_canary_start_only', 409)
  }
  if (acquisitionModeEnabled()) {
    const count = await createServiceClient().from('worker_runs').select('id', { count: 'exact', head: true })
      .gte('created_at', `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`)
    if (count.error) throw new WorkerControlError('worker_control_unavailable', 503)
    if ((count.count ?? 0) >= WORKER_DAILY_RUN_LIMIT) throw new WorkerControlError('worker_daily_limit', 429)
  }
  try {
    return await startWorkerBatch(mode, workerControlRepository, launchWorkerWorkflow)
  } catch (error) {
    if (acquisitionModeEnabled() && !acquisitionCanaryEnabled() && mode === 'resume' && error instanceof WorkerControlError
      && error.code === 'worker_not_resumable') {
      return startWorkerBatch('start', workerControlRepository, launchWorkerWorkflow)
    }
    throw error
  }
}

export async function stopWorkerCommand() {
  if (acquisitionModeEnabled()) await setAcquisitionState(false)
  return stopWorkerBatch(workerControlRepository)
}
