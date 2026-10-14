import assert from 'node:assert/strict'
import { test } from 'node:test'
import { reset, state } from '../marketplace/fixtures'
import { boundary } from '../admin/fixture'
import { startWorkerCommand } from '../../src/lib/admin-worker/runtime'
import { workerControlRepository } from '../../src/lib/admin-worker/repository'
import type { WorkerRunDto } from '../../src/lib/admin-worker/types'

test('late Workflow launch failure cannot clear a newer authorized acquisition epoch', async () => {
  reset(); boundary.unavailable = false; boundary.unavailableTable = null
  const saved = { createRun: workerControlRepository.createRun, failRun: workerControlRepository.failRun,
    mode: process.env.ADMIN_ACQUISITION_MODE, canary: process.env.ADMIN_ACQUISITION_CANARY,
    continuous: process.env.ADMIN_ACQUISITION_CONTINUOUS, vercel: process.env.VERCEL_ENV }
  process.env.ADMIN_ACQUISITION_MODE = 'true'; process.env.ADMIN_ACQUISITION_CANARY = 'false'; process.env.VERCEL_ENV = 'preview'
  process.env.ADMIN_ACQUISITION_CONTINUOUS = 'true'
  state.tables.admin_acquisition_control = [{ id: 1, desired_state: 'stopped', epoch: 'before', canary_used_at: null }]
  state.tables.worker_runs = []
  const failedRuns: string[] = []; const stops: string[] = []
  workerControlRepository.createRun = async () => ({ id: 'old-run', status: 'queued' } as WorkerRunDto)
  workerControlRepository.failRun = async id => { failedRuns.push(id); return { id, status: 'failed' } as WorkerRunDto }
  boundary.rpcOverride = async (name, args) => {
    if (name === 'mahshar_acquisition_set_state') {
      const control = state.tables.admin_acquisition_control[0]
      if (args.p_running) { control.desired_state = 'running'; control.epoch = 'old-epoch' }
      else control.desired_state = 'stopped'
      return { data: control, error: null }
    }
    if (name === 'mahshar_acquisition_stop_epoch') {
      stops.push(String(args.p_epoch))
      const control = state.tables.admin_acquisition_control[0]
      if (control.epoch === args.p_epoch) control.desired_state = 'stopped'
      return { data: true, error: null }
    }
    throw new Error('Unexpected RPC')
  }
  boundary.workflowStart = async () => {
    // Operator stopped old-run and started another session before the delayed launch response failed.
    state.tables.admin_acquisition_control[0] = { id: 1, desired_state: 'running', epoch: 'new-epoch' }
    throw new Error('Mocked delayed launch failure')
  }
  try {
    await assert.rejects(startWorkerCommand('start'), /workflow_start_failed/)
    assert.deepEqual(stops, ['old-epoch']); assert.deepEqual(failedRuns, ['old-run'])
    assert.equal(state.tables.admin_acquisition_control[0].desired_state, 'running')
    assert.equal(state.tables.admin_acquisition_control[0].epoch, 'new-epoch')
  } finally {
    workerControlRepository.createRun = saved.createRun; workerControlRepository.failRun = saved.failRun
    boundary.rpcOverride = null; boundary.workflowStart = null
    for (const [key, value] of Object.entries({ ADMIN_ACQUISITION_MODE: saved.mode, ADMIN_ACQUISITION_CANARY: saved.canary,
      ADMIN_ACQUISITION_CONTINUOUS: saved.continuous, VERCEL_ENV: saved.vercel })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value
    }
  }
})
