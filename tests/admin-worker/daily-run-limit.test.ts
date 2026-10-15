import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { test } from 'node:test'
import { NextRequest } from 'next/server'
import { alice, origin, reset, sessionHeaders, state } from '../marketplace/fixtures'
import { boundary } from '../admin/fixture'
import { WorkerDailyRunQuota } from '../../src/app/admin/worker/worker-client'
import { workerControlAvailability } from '../../src/lib/admin-worker/availability'
import { workerControlRepository } from '../../src/lib/admin-worker/repository'
import type { WorkerRunDto, WorkerStatusDto } from '../../src/lib/admin-worker/types'
import * as start from '../../src/app/api/admin/worker/start/route'
import * as resume from '../../src/app/api/admin/worker/resume/route'

test('the dashboard retains six used runs and displays the new daily ceiling', () => {
  const html = renderToStaticMarkup(createElement(WorkerDailyRunQuota, { used: 6 }))
  assert.match(html, /Discovery batches today/)
  assert.match(html, /<strong>6 \/ 20<\/strong>/)
  const status = { status: 'stopped', latest_run: { status: 'stopped', completion_reason: null },
    can_resume: true, acquisition: { running: false, continuous_mode: true, daily_runs: 6 } } as WorkerStatusDto
  assert.deepEqual(workerControlAvailability(status), { canStart: true, canStop: false, canResume: true })
  assert.equal(workerControlAvailability({ ...status, latest_run: { ...status.latest_run!, status: 'running' } }).canStart, false)
})

test('authorized Start and Resume allow six and nineteen used runs, block twenty, and ignore previous UTC days', async context => {
  context.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-15T15:00:00Z') })
  const flags = { ADMIN_ACQUISITION_MODE: 'true', ADMIN_ACQUISITION_CANARY: 'false',
    ADMIN_ACQUISITION_CONTINUOUS: 'true', ADMIN_WALLETS: alice.address }
  const previous = Object.fromEntries(Object.keys(flags).map(key => [key, process.env[key]]))
  const repository = { ...workerControlRepository }
  Object.assign(process.env, flags)
  try {
    for (const [action, route] of [['start', start], ['resume', resume]] as const) {
      for (const used of [6, 19, 20]) {
        reset(); boundary.unavailable = false; boundary.unavailableTable = null; boundary.external = 0
        state.tables.admin_acquisition_control = [{ id: 1, desired_state: 'stopped', epoch: 'saved', canary_used_at: '2026-10-14T18:00:00Z' }]
        state.tables.worker_runs = [
          ...Array.from({ length: used }, (_, id) => ({ id: `today-${id}`, status: 'stopped', created_at: '2026-10-15T13:00:00Z' })),
          ...Array.from({ length: 20 }, (_, id) => ({ id: `yesterday-${id}`, status: 'completed', created_at: '2026-10-14T23:59:59.999Z' })),
        ]
        const history = JSON.stringify(state.tables.worker_runs)
        let creates = 0; let launches = 0; let mutations = 0
        workerControlRepository.createRun = async mode => {
          assert.equal(mode, action); creates++
          return { id: 'fixture-run', status: 'queued' } as WorkerRunDto
        }
        workerControlRepository.attachWorkflowRunId = async () => ({ id: 'fixture-run', status: 'queued' } as WorkerRunDto)
        boundary.rpcOverride = async (name, args) => {
          assert.equal(name, 'mahshar_acquisition_set_state'); assert.equal(args.p_running, true); mutations++
          return { data: { epoch: 'fixture-epoch' }, error: null }
        }
        boundary.workflowStart = async () => { launches++; return { runId: 'fixture-workflow' } }
        const response = await route.POST(new NextRequest(`${origin}/api/admin/worker/${action}`, {
          method: 'POST', headers: sessionHeaders(alice),
        }))
        assert.equal(response.status, used < 20 ? 202 : 429)
        if (used === 20) assert.deepEqual(await response.json(), { error: 'worker_daily_limit' })
        assert.equal(creates, used < 20 ? 1 : 0)
        assert.equal(launches, creates); assert.equal(mutations, creates)
        assert.equal(JSON.stringify(state.tables.worker_runs), history)
        assert.equal(boundary.external, 0)
      }
    }
  } finally {
    Object.assign(workerControlRepository, repository)
    boundary.rpcOverride = null; boundary.workflowStart = null
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value
    }
  }
})
