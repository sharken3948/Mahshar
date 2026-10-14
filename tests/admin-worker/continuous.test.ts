import assert from 'node:assert/strict'
import { test } from 'node:test'
import { NextRequest } from 'next/server'
import { alice, origin, reset, sessionHeaders, state } from '../marketplace/fixtures'
import { boundary } from '../admin/fixture'
import { startWorkerCommand, stopWorkerCommand } from '../../src/lib/admin-worker/runtime'
import { workerControlRepository } from '../../src/lib/admin-worker/repository'
import { workerControlAvailability } from '../../src/lib/admin-worker/availability'
import type { WorkerRunDto, WorkerStatusDto } from '../../src/lib/admin-worker/types'
import * as startRoute from '../../src/app/api/admin/worker/start/route'

async function mode(canary: boolean, continuous: boolean, action: () => Promise<void>) {
  const keys = ['ADMIN_ACQUISITION_MODE', 'ADMIN_ACQUISITION_CANARY', 'ADMIN_ACQUISITION_CONTINUOUS', 'VERCEL_ENV', 'ADMIN_WALLETS']
  const saved = keys.map(key => process.env[key])
  reset(); boundary.unavailable = false; boundary.unavailableTable = null
  process.env.ADMIN_ACQUISITION_MODE = 'true'; process.env.ADMIN_ACQUISITION_CANARY = String(canary)
  process.env.ADMIN_ACQUISITION_CONTINUOUS = String(continuous); process.env.VERCEL_ENV = 'production'
  process.env.ADMIN_WALLETS = alice.address
  try { await action() } finally {
    keys.forEach((key, i) => { if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i] })
    boundary.rpcOverride = null; boundary.workflowStart = null
  }
}

test('conflicting acquisition modes reject authorized Start before creating any run', async () => {
  await mode(true, true, async () => {
    const response = await startRoute.POST(new NextRequest(origin + '/api/admin/worker/start', {
      method: 'POST', headers: sessionHeaders(alice),
    }))
    assert.equal(response.status, 409)
    assert.deepEqual(await response.json(), { error: 'acquisition_modes_conflict' })
    assert.equal(state.tables.worker_runs?.length ?? 0, 0)
  })
})

test('authorized continuous Start after a consumed canary launches non-canary without clearing history', async () => {
  await mode(false, true, async () => {
    const control = { id: 1, desired_state: 'stopped', epoch: 'old', canary_used_at: '2026-10-14T18:57:34Z', canary_run_id: 'historical-canary' }
    state.tables.admin_acquisition_control = [control]; state.tables.worker_runs = []
    const original = { ...workerControlRepository }; let launched: unknown[] | undefined
    workerControlRepository.createRun = async () => ({ id: 'continuous', status: 'queued' } as WorkerRunDto)
    workerControlRepository.attachWorkflowRunId = async id => ({ id, status: 'queued' } as WorkerRunDto)
    boundary.rpcOverride = async (name, args) => {
      assert.equal(name, 'mahshar_acquisition_set_state'); assert.equal(args.p_canary, false)
      control.desired_state = 'running'; control.epoch = 'continuous-epoch'
      return { data: control, error: null }
    }
    boundary.workflowStart = async (...args) => { launched = args; return { runId: 'mock-cloud-run' } }
    try {
      const response = await startRoute.POST(new NextRequest(origin + '/api/admin/worker/start', {
        method: 'POST', headers: sessionHeaders(alice),
      }))
      assert.equal(response.status, 202)
      assert.deepEqual(launched?.[1], ['continuous', 'continuous-epoch', false])
      assert.equal(control.canary_run_id, 'historical-canary')
      assert.equal(control.canary_used_at, '2026-10-14T18:57:34Z')
    } finally { Object.assign(workerControlRepository, original) }
  })
})

test('consumed canary still rejects Start and Stop clears acquisition before Worker stop', async () => {
  await mode(true, false, async () => {
    state.tables.admin_acquisition_control = [{ id: 1, desired_state: 'stopped', epoch: 'old', canary_used_at: 'used' }]
    await assert.rejects(startWorkerCommand('start'), /acquisition_canary_used/)
  })
  await mode(false, true, async () => {
    const events: string[] = []; const original = workerControlRepository.requestStop
    boundary.rpcOverride = async (_name, args) => {
      assert.equal(args.p_running, false); events.push('clear-intent')
      return { data: { epoch: 'old' }, error: null }
    }
    workerControlRepository.requestStop = async () => { events.push('worker-stop'); return null }
    try { await stopWorkerCommand(); assert.deepEqual(events, ['clear-intent', 'worker-stop']) }
    finally { workerControlRepository.requestStop = original }
  })
})

test('continuous controls preserve canary history and expose Stop during sleep and Resume after completion', () => {
  const status = { latest_run: { status: 'completed', completion_reason: 'source_exhausted' }, can_resume: true,
    acquisition: { running: true, continuous_mode: true, canary_mode: false, canary_used: true } } as WorkerStatusDto
  assert.deepEqual(workerControlAvailability(status), { canStart: false, canStop: true, canResume: false })
  status.acquisition!.running = false
  assert.deepEqual(workerControlAvailability(status), { canStart: true, canStop: false, canResume: true })
})
