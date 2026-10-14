import assert from 'node:assert/strict'
import test from 'node:test'
import { workerBatchWorkflow } from '../../src/workflows/admin-worker-batch'
import { canaryFixture, resetCanaryFixture } from './canary-fixture'

test('single canary Workflow pass stops without discovery, Groq, sleep or continuation', async () => {
  resetCanaryFixture()
  const result = await workerBatchWorkflow('run', 'epoch', true)
  assert.deepEqual(result, { runId: 'run', status: 'stopped' })
  assert.deepEqual(canaryFixture.events, ['claim', 'acquire:true', 'stop-intent-and-run', 'claim'])
  assert.equal(canaryFixture.sleepCalls, 0)
})

test('Stop before the canary claim dispatches no provider work', async () => {
  resetCanaryFixture()
  canaryFixture.claimStatus = 'stopped'
  assert.deepEqual(await workerBatchWorkflow('run', 'epoch', true), { runId: 'run', status: 'stopped' })
  assert.deepEqual(canaryFixture.events, ['claim'])
})

test('canary provider failure fails its Worker and acquisition intent without a new batch', async () => {
  resetCanaryFixture()
  canaryFixture.acquisitionFails = true
  await assert.rejects(() => workerBatchWorkflow('run', 'epoch', true), /fixture failure/)
  assert.deepEqual(canaryFixture.events, ['claim', 'acquire:true', 'fail-worker', 'fail-acquisition'])
})

test('legacy Worker invocation keeps its existing discovery branch', async () => {
  resetCanaryFixture()
  assert.deepEqual(await workerBatchWorkflow('run'), { runId: 'run', status: 'completed' })
  assert.deepEqual(canaryFixture.events, ['claim', 'discovery'])
})
