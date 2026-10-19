import assert from 'node:assert/strict'
import test from 'node:test'
import { workerBatchWorkflow } from '../../src/workflows/admin-worker-batch'
import { canaryFixture, resetCanaryFixture } from './canary-fixture'
import { mockCanaryAcquisitionDraft, processAcquisitionBatch, type AcquisitionCandidate, type AcquisitionPort } from '../../src/lib/admin-worker/acquisition'

test('single canary Workflow pass stops without discovery, Groq or continuation', async () => {
  resetCanaryFixture()
  const result = await workerBatchWorkflow('run', 'epoch', true)
  assert.deepEqual(result, { runId: 'run', status: 'stopped' })
  assert.deepEqual(canaryFixture.events, ['claim', 'acquire:true', 'stop-intent-and-run', 'claim'])
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

test('Stop between runs produces no next batch or acquisition pass', async () => {
  resetCanaryFixture()
  canaryFixture.stopBeforeContinuation = true
  assert.deepEqual(await workerBatchWorkflow('run', 'epoch'), { runId: 'run', status: 'stopped' })
  assert.deepEqual(canaryFixture.events, ['claim', 'acquire:false', 'discovery', 'continuation-check'])
})

test('Stop during execution prevents continuation after the in-flight chunk reconciles', async () => {
  resetCanaryFixture()
  canaryFixture.discoveryHook = async () => { canaryFixture.running = false }
  assert.deepEqual(await workerBatchWorkflow('run', 'epoch'), { runId: 'run', status: 'stopped' })
  assert.deepEqual(canaryFixture.events, ['claim', 'acquire:false', 'discovery', 'continuation-check'])
  assert.equal(canaryFixture.events.includes('next-batch'), false)
})

test('continuous mode immediately completes two batches and stops without a third batch', async () => {
  resetCanaryFixture()
  canaryFixture.nextRunIds = ['child', null]
  assert.deepEqual(await workerBatchWorkflow('run', 'epoch'), { runId: 'child', status: 'stopped' })
  assert.equal(canaryFixture.events.filter(e => e === 'discovery').length, 2)
  assert.equal(canaryFixture.events.filter(e => e === 'next-batch').length, 2)
  assert.equal(canaryFixture.events.filter(e => e === 'acquire:false').length, 2)
  assert.deepEqual(canaryFixture.events.slice(3, 6), ['continuation-check', 'next-batch', 'claim'])
})

test('two continuous cloud batches simulate delivery once per provider and preserve history', async () => {
  resetCanaryFixture()
  canaryFixture.nextRunIds = ['child', null]
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
  assert.equal(canaryFixture.events.filter(e => e === 'next-batch').length, 2)
})

test('replay of a completed continuous batch resumes continuation without reprocessing the parent', async () => {
  resetCanaryFixture()
  canaryFixture.claimStatuses = ['completed', 'running']
  canaryFixture.nextRunIds = ['child', null]
  await workerBatchWorkflow('run', 'epoch')
  assert.equal(canaryFixture.events.filter(e => e === 'discovery').length, 1)
  assert.equal(canaryFixture.events.filter(e => e === 'acquire:false').length, 1)
})

test('daily batch quota exhaustion stops after one refused continuation', async () => {
  resetCanaryFixture()
  canaryFixture.nextRunIds = [null, 'child']
  assert.deepEqual(await workerBatchWorkflow('run', 'epoch'), { runId: 'run', status: 'stopped' })
  assert.equal(canaryFixture.events.filter(e => e === 'next-batch').length, 1)
  assert.equal(canaryFixture.events.filter(e => e === 'discovery').length, 1)
  assert.deepEqual(canaryFixture.nextRunIds, ['child'])
})

test('an exhausted budget does not cause Workflow polling', async () => {
  resetCanaryFixture()
  canaryFixture.nextRunIds = [null, 'child']
  await workerBatchWorkflow('run', 'epoch')
  assert.equal(canaryFixture.events.filter(e => e === 'next-batch').length, 1)
})

test('restart uses the saved discovery position and Stop before scheduling avoids continuation', async () => {
  resetCanaryFixture()
  canaryFixture.checkpointIndex = 20; canaryFixture.running = false
  assert.deepEqual(await workerBatchWorkflow('resumed', 'epoch'), { runId: 'resumed', status: 'stopped' })
  assert.deepEqual(canaryFixture.checkpoints, [20])
  assert.equal(canaryFixture.events.includes('next-batch'), false)
})

test('Worker failure-persistence outage still attempts acquisition shutdown', async () => {
  resetCanaryFixture()
  canaryFixture.acquisitionFails = true
  canaryFixture.failurePersistenceFails = true
  await assert.rejects(() => workerBatchWorkflow('run', 'epoch', true), /failure persistence unavailable/)
  assert.deepEqual(canaryFixture.events, ['claim', 'acquire:true', 'fail-worker', 'fail-acquisition'])
})
