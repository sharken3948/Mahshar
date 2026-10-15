import assert from 'node:assert/strict'
import { test } from 'node:test'
import { NextRequest } from 'next/server'
import { alice, bob, origin, reset, sessionHeaders, state } from '../marketplace/fixtures'
import { boundary } from '../admin/fixture'
import { workerCommandErrorMessage } from '../../src/lib/admin-worker/presentation'
import * as start from '../../src/app/api/admin/worker/start/route'
import * as resume from '../../src/app/api/admin/worker/resume/route'

test('Start and Resume explain the daily quota without creating a run, changing controls or launching Workflow', async context => {
  context.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-15T14:56:25.122Z') })
  const flags = { ADMIN_ACQUISITION_MODE: 'true', ADMIN_ACQUISITION_CANARY: 'false',
    ADMIN_ACQUISITION_CONTINUOUS: 'true', ADMIN_WALLETS: alice.address }
  const previous = Object.fromEntries(Object.keys(flags).map(key => [key, process.env[key]]))
  reset(); boundary.unavailable = false; boundary.unavailableTable = null; boundary.external = 0
  Object.assign(process.env, flags)
  state.tables.worker_control = [{ id: 1, desired_state: 'stopped', current_checkpoint: { saved: true } }]
  state.tables.admin_acquisition_control = [{ id: 1, desired_state: 'stopped', epoch: 'saved-epoch', canary_used_at: '2026-10-14T18:00:00Z' }]
  // Reproduce the six persisted Production creation times, without production IDs or content.
  state.tables.worker_runs = ['08:19:18.488', '09:09:07.785', '11:21:11.770', '11:22:13.461', '12:26:06.204', '13:38:00.394']
    .map((time, index) => ({ id: `saved-${index}`, status: 'stopped', created_at: `2026-10-15T${time}Z` }))
  state.tables.worker_runs.push(...Array.from({ length: 14 }, (_, index) => ({
    id: `additional-${index}`, status: 'stopped', created_at: '2026-10-15T14:00:00.000Z',
  })))
  const adminHeaders = sessionHeaders(alice); const deniedHeaders = sessionHeaders(bob)
  const before = JSON.stringify(state.tables)
  let mutations = 0; let launches = 0
  boundary.rpcOverride = async () => { mutations++; throw new Error('Mutation forbidden') }
  boundary.workflowStart = async () => { launches++; throw new Error('Workflow launch forbidden') }
  try {
    for (const [action, route] of [['start', start], ['resume', resume]] as const) {
      for (const [account, expected] of [[undefined, 403], [bob, 403], [alice, 429]] as const) {
        const response = await route.POST(new NextRequest(`${origin}/api/admin/worker/${action}`, {
          method: 'POST', headers: account === alice ? adminHeaders : account === bob ? deniedHeaders : undefined,
        }))
        assert.equal(response.status, expected)
        if (account === alice) {
          const body = await response.json()
          assert.deepEqual(body, { error: 'worker_daily_limit' })
          assert.equal(response.headers.get('Cache-Control'), 'no-store')
          const message = workerCommandErrorMessage(body.error)
          assert.match(message, /daily Worker run limit/)
          assert.match(message, /Start or Resume after 00:00 UTC/)
          assert.match(message, /No new Worker run was started/)
        }
      }
    }
    assert.equal(JSON.stringify(state.tables), before)
    assert.equal(mutations, 0); assert.equal(launches, 0); assert.equal(boundary.external, 0)
  } finally {
    boundary.rpcOverride = null; boundary.workflowStart = null
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value
    }
  }
})

test('existing command errors remain specific and unknown responses never expose server details', () => {
  assert.equal(workerCommandErrorMessage('worker_already_active'), 'A Worker batch is already active.')
  assert.equal(workerCommandErrorMessage('worker_not_resumable'), 'No safe resumable checkpoint is available.')
  for (const code of [undefined, null, {}, '<script>private server detail</script>', 'worker_start_unavailable']) {
    assert.equal(workerCommandErrorMessage(code), 'The Worker command could not be completed.')
  }
})
