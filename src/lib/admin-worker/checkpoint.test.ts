import assert from 'node:assert/strict'
import { test } from 'node:test'
import { advanceWorkerCheckpoint, initialWorkerCheckpoint, isResumableCheckpoint, isResumableWorkerRun, parseWorkerCheckpoint } from './checkpoint'

test('checkpoint accepts only compact version 1 values within batch bounds', () => {
  assert.deepEqual(parseWorkerCheckpoint({ version: 1, nextIndex: 20, batchSize: 50 }), {
    version: 1, nextIndex: 20, batchSize: 50,
  })
  for (const malformed of [
    null, [], {}, { version: 2, nextIndex: 0, batchSize: 50 },
    { version: 1, nextIndex: -1, batchSize: 50 }, { version: 1, nextIndex: 51, batchSize: 50 },
    { version: 1, nextIndex: 0, batchSize: 301 }, { version: 1, nextIndex: 0.5, batchSize: 50 },
    { version: 1, nextIndex: 10, batchSize: 50, items: [] },
  ]) assert.equal(parseWorkerCheckpoint(malformed), null)
  assert.deepEqual(parseWorkerCheckpoint({ version: 1, nextIndex: 300, batchSize: 300 }), {
    version: 1, nextIndex: 300, batchSize: 300,
  })
})

test('only stopped or failed nonterminal logical batches are resumable', () => {
  const checkpoint = { version: 1 as const, nextIndex: 299, batchSize: 300 }
  assert.equal(isResumableWorkerRun('stopped', null, checkpoint, 300), true)
  assert.equal(isResumableWorkerRun('failed', null, checkpoint, 300), true)
  assert.equal(isResumableWorkerRun('completed', null, checkpoint, 300), false)
  assert.equal(isResumableWorkerRun('stopped', 'deadline_reached', checkpoint, 300), false)
})

test('checkpoint advances monotonically without crossing the batch bound', () => {
  const initial = initialWorkerCheckpoint(50)
  const twenty = advanceWorkerCheckpoint(advanceWorkerCheckpoint(initial, 10), 10)
  assert.deepEqual(twenty, { version: 1, nextIndex: 20, batchSize: 50 })
  assert.deepEqual(advanceWorkerCheckpoint({ version: 1, nextIndex: 48, batchSize: 50 }, 10), {
    version: 1, nextIndex: 50, batchSize: 50,
  })
  assert.throws(() => advanceWorkerCheckpoint(initial, 0), /worker_chunk_size_invalid/)
})

test('only a strict interior checkpoint is resumable', () => {
  assert.equal(isResumableCheckpoint({ version: 1, nextIndex: 10, batchSize: 50 }, 50), true)
  assert.equal(isResumableCheckpoint({ version: 1, nextIndex: 0, batchSize: 50 }, 50), false)
  assert.equal(isResumableCheckpoint({ version: 1, nextIndex: 50, batchSize: 50 }, 50), false)
  assert.equal(isResumableCheckpoint({ version: 1, nextIndex: 10, batchSize: 40 }, 50), false)
})
