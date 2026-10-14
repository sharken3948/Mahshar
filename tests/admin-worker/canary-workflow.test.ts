import assert from 'node:assert/strict'
import test from 'node:test'
import { workerBatchWorkflow } from '../../src/workflows/admin-worker-batch'
import { canaryFixture, resetCanaryFixture } from './canary-fixture'
import { mockCanaryAcquisitionDraft, processAcquisitionBatch, type AcquisitionCandidate, type AcquisitionPort } from '../../src/lib/admin-worker/acquisition'

test('single canary Workflow pass stops without discovery, Groq, sleep or continuation', async () => {
  resetCanaryFixture()
  const result = await workerBatchWorkflow('run', 'epoch', true)
  assert.deepEqual(result, { runId: 'run', status: 'stopped' })
  assert.deepEqual(canaryFixture.events, ['claim', 'acquire:true', 'stop-intent-and-run', 'claim'])
  assert.equal(canaryFixture.sleepCalls, 0)
  assert.deepEqual(canaryFixture.finishArgs, ['run', 'epoch'])
})

test('Stop before the canary claim dispatches no provider work', async () => {
  resetCanaryFixture()
  canaryFixture.claimStatus = 'stopped'
  assert.deepEqual(await workerBatchWorkflow('run', 'epoch', true), { runId: 'run', status: 'stopped' })
  assert.deepEqual(canaryFixture.events, ['claim', 'stop-intent-and-run'])
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

test('Stop during durable sleep produces no next batch or acquisition pass', async () => {
  resetCanaryFixture()
  canaryFixture.stopDuringSleep = true
  assert.deepEqual(await workerBatchWorkflow('run', 'epoch'), { runId: 'run', status: 'stopped' })
  assert.deepEqual(canaryFixture.events, ['claim', 'acquire:false', 'discovery', 'continuation-check', 'continuation-check'])
  assert.equal(canaryFixture.sleepCalls, 1)
})

test('continuous mode completes two batches with durable waits and stops without a third batch', async () => {
  resetCanaryFixture()
  canaryFixture.allowSleep = true; canaryFixture.stopAfterSleeps = 2
  canaryFixture.nextRunIds = ['child']
  assert.deepEqual(await workerBatchWorkflow('run', 'epoch'), { runId: 'child', status: 'stopped' })
  assert.equal(canaryFixture.sleepCalls, 2)
  assert.equal(canaryFixture.events.filter(e => e === 'discovery').length, 2)
  assert.equal(canaryFixture.events.filter(e => e === 'next-batch').length, 1)
  assert.equal(canaryFixture.events.filter(e => e === 'acquire:false').length, 2)
})

test('two continuous cloud batches simulate delivery once per provider and preserve history across the wait', async () => {
  resetCanaryFixture()
  canaryFixture.allowSleep = true; canaryFixture.stopAfterSleeps = 2
  canaryFixture.nextRunIds = ['child']
  const history = new Map<string, string>(); const sends: string[] = []; const outcomes: string[] = []
  const candidate = (id: string): AcquisitionCandidate => ({ providerId: id, leadId: id, provider: id,
    product: 'Weather API', email: 'team@example.com', emailObserved: true, emailValid: true,
    evidenceVerified: true, recipientEligible: true, channelApproved: true, evidence: ['https://example.com/docs'] })
  canaryFixture.discoveryHook = async runId => {
    const queue = runId === 'run' ? [candidate('one')] : [candidate('one'), candidate('two')]
    const port: AcquisitionPort = {
      running: async () => canaryFixture.running, next: async () => queue.shift() ?? null,
      priorOutreach: async id => history.has(id), draft: async item => mockCanaryAcquisitionDraft(item),
      reserve: async item => { assert.equal(history.has(item.providerId), false); history.set(item.providerId, 'reserved'); return item.providerId },
      dispatch: async id => { sends.push(id); return 'simulated:' + id },
      delivered: async (id, messageId) => { history.set(id, messageId) },
      ambiguous: async id => { history.set(id, 'uncertain') }, record: async (_item, outcome) => { outcomes.push(outcome) },
    }
    await processAcquisitionBatch(port, 3)
  }
  await workerBatchWorkflow('run', 'epoch')
  assert.deepEqual(sends, ['one', 'two'])
  assert.deepEqual(outcomes, ['sent', 'prior_outreach', 'sent'])
  assert.deepEqual([...history.values()], ['simulated:one', 'simulated:two'])
  assert.equal(canaryFixture.sleepCalls, 2)
})

test('replay of a completed continuous batch resumes continuation without reprocessing the parent', async () => {
  resetCanaryFixture()
  canaryFixture.claimStatuses = ['completed', 'running']
  canaryFixture.allowSleep = true; canaryFixture.stopAfterSleeps = 2
  canaryFixture.nextRunIds = ['child']
  await workerBatchWorkflow('run', 'epoch')
  assert.equal(canaryFixture.events.filter(e => e === 'discovery').length, 1)
  assert.equal(canaryFixture.events.filter(e => e === 'acquire:false').length, 1)
})

test('daily batch quota exhaustion waits durably and claims only when the next batch becomes due', async () => {
  resetCanaryFixture()
  canaryFixture.allowSleep = true; canaryFixture.stopAfterSleeps = 3
  canaryFixture.nextRunIds = [null, 'child']
  await workerBatchWorkflow('run', 'epoch')
  assert.equal(canaryFixture.sleepCalls, 3)
  assert.equal(canaryFixture.events.filter(e => e === 'next-batch').length, 2)
  assert.equal(canaryFixture.events.filter(e => e === 'discovery').length, 2)
})

test('restart uses the saved discovery position and Stop before scheduling avoids even durable sleep', async () => {
  resetCanaryFixture()
  canaryFixture.checkpointIndex = 20; canaryFixture.running = false
  assert.deepEqual(await workerBatchWorkflow('resumed', 'epoch'), { runId: 'resumed', status: 'stopped' })
  assert.deepEqual(canaryFixture.checkpoints, [20])
  assert.equal(canaryFixture.sleepCalls, 0)
  assert.equal(canaryFixture.events.includes('next-batch'), false)
})

test('Worker failure-persistence outage still attempts acquisition shutdown', async () => {
  resetCanaryFixture()
  canaryFixture.acquisitionFails = true
  canaryFixture.failurePersistenceFails = true
  await assert.rejects(() => workerBatchWorkflow('run', 'epoch', true), /failure persistence unavailable/)
  assert.deepEqual(canaryFixture.events, ['claim', 'acquire:true', 'fail-worker', 'fail-acquisition'])
})
