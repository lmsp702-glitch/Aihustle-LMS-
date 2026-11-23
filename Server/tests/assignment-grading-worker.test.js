import assert from 'node:assert/strict'
import { test } from 'node:test'
import { getAssignmentAttemptState } from '../utils/assignment-attempts.js'
import {
  createAssignmentGradingWorker,
  INITIAL_AUTOMATIC_RETRY_DELAY_MS,
  MAX_AUTOMATIC_GRADING_RETRIES,
} from '../utils/assignment-grading-worker.js'

function makeSubmission(overrides = {}) {
  return {
    _id: 'submission-1',
    submittedAt: new Date(),
    updatedAt: new Date(),
    gradingStatus: 'Submitted',
    gradingRetryCount: 0,
    activeSubmissionKey: 'enrollment-1:assignment-1',
    gradingTraceId: 'trace-1',
    ...overrides,
  }
}

function makeSubmissionModel(submission) {
  function applyUpdate(update) {
    Object.assign(submission, update.$set || {})
    Object.keys(update.$unset || {}).forEach((key) => delete submission[key])
    submission.updatedAt = new Date()
  }

  return {
    submission,
    findOneAndUpdate(_filter, update) {
      const now = Date.now()
      const leaseExpired = !submission.gradingLeaseUntil
        || new Date(submission.gradingLeaseUntil).getTime() <= now
      const retryDue = !submission.gradingNextRetryAt
        || new Date(submission.gradingNextRetryAt).getTime() <= now
      const eligible = submission.activeSubmissionKey
        && !submission.aiEvaluation
        && (
          submission.gradingStatus === 'Submitted'
          || (submission.gradingStatus === 'AI Grading' && leaseExpired && retryDue)
        )
      if (eligible) applyUpdate(update)
      return { select: async () => eligible ? submission : null }
    },
    async updateOne(filter, update) {
      const matches = String(filter._id) === String(submission._id)
        && (!filter.gradingStatus || filter.gradingStatus === submission.gradingStatus)
        && (!filter.gradingLeaseToken || filter.gradingLeaseToken === submission.gradingLeaseToken)
      if (matches) applyUpdate(update)
      return { matchedCount: matches ? 1 : 0, modifiedCount: matches ? 1 : 0 }
    },
  }
}

function temporaryProviderError() {
  return Object.assign(new Error('Temporary provider error.'), {
    retryable: true,
    category: 'provider_unavailable',
    httpStatus: 503,
    providerCode: 'UNAVAILABLE',
    traceId: 'trace-1',
  })
}

function expireScheduledRetry(submission) {
  submission.gradingNextRetryAt = new Date(Date.now() - 1)
  submission.gradingLeaseUntil = new Date(Date.now() - 1)
}

test('transient failures schedule bounded persistent retries without consuming attempts', async () => {
  const model = makeSubmissionModel(makeSubmission())
  let processingCalls = 0
  const worker = createAssignmentGradingWorker({
    submissionModel: model,
    processSubmission: async () => {
      processingCalls += 1
      throw temporaryProviderError()
    },
  })

  await worker.runOnce()
  const firstRetryDelay = new Date(model.submission.gradingNextRetryAt).getTime() - Date.now()
  assert.ok(firstRetryDelay > 0 && firstRetryDelay <= INITIAL_AUTOMATIC_RETRY_DELAY_MS)
  assert.equal(model.submission.gradingStatus, 'AI Grading')
  assert.equal(model.submission.gradingRetryCount, 1)
  assert.equal(model.submission.activeSubmissionKey, 'enrollment-1:assignment-1')
  const pendingState = getAssignmentAttemptState([model.submission], 100)
  assert.equal(pendingState.failedAttempts, 0)
  assert.equal(pendingState.remainingAttempts, 3)
  assert.equal(pendingState.hasPendingGrading, true)

  for (let retry = 1; retry < MAX_AUTOMATIC_GRADING_RETRIES; retry += 1) {
    expireScheduledRetry(model.submission)
    await worker.runOnce()
    assert.equal(model.submission.gradingRetryCount, retry + 1)
    const scheduledDelay = new Date(model.submission.gradingNextRetryAt).getTime() - Date.now()
    const expectedDelay = INITIAL_AUTOMATIC_RETRY_DELAY_MS * (2 ** retry)
    assert.ok(scheduledDelay > expectedDelay - 100 && scheduledDelay <= expectedDelay)
  }

  expireScheduledRetry(model.submission)
  await worker.runOnce()
  assert.equal(processingCalls, MAX_AUTOMATIC_GRADING_RETRIES + 1)
  assert.equal(model.submission.gradingStatus, 'AI Grading Failed')
  assert.equal(model.submission.activeSubmissionKey, undefined)
  assert.equal(model.submission.aiEvaluation, undefined)
  const finalState = getAssignmentAttemptState([model.submission], 100)
  assert.equal(finalState.failedAttempts, 0)
  assert.equal(finalState.attemptsUsed, 0)
  assert.equal(finalState.remainingAttempts, 3)
  assert.equal(finalState.canSubmit, true)
  worker.stop()
})

test('pending grading jobs survive a worker restart and keep their operation trace', async () => {
  const model = makeSubmissionModel(makeSubmission())
  const traces = []
  const stoppedWorker = createAssignmentGradingWorker({
    submissionModel: model,
    processSubmission: async (submission) => {
      traces.push(submission.gradingTraceId)
      throw temporaryProviderError()
    },
  })
  await stoppedWorker.runOnce()
  stoppedWorker.stop()
  expireScheduledRetry(model.submission)

  const restartedWorker = createAssignmentGradingWorker({
    submissionModel: model,
    processSubmission: async (submission) => {
      traces.push(submission.gradingTraceId)
      await model.updateOne(
        { _id: submission._id, gradingStatus: 'AI Grading', gradingLeaseToken: submission.gradingLeaseToken },
        {
          $set: {
            gradingStatus: 'AI Graded',
            marksObtained: 80,
            aiEvaluation: { totalMarks: 80, maximumMarks: 100 },
          },
          $unset: {
            activeSubmissionKey: '',
            gradingLeaseUntil: '',
            gradingLeaseToken: '',
            gradingNextRetryAt: '',
          },
        },
      )
    },
  })
  await restartedWorker.runOnce()
  assert.equal(model.submission.gradingStatus, 'AI Graded')
  assert.equal(model.submission.marksObtained, 80)
  assert.deepEqual(traces, ['trace-1', 'trace-1'])
  restartedWorker.stop()
})

test('atomic job claims prevent duplicate grading across worker instances', async () => {
  const model = makeSubmissionModel(makeSubmission())
  let calls = 0
  let releaseProcessing
  const processingGate = new Promise((resolve) => { releaseProcessing = resolve })
  const processSubmission = async () => {
    calls += 1
    await processingGate
  }
  const firstWorker = createAssignmentGradingWorker({ submissionModel: model, processSubmission })
  const secondWorker = createAssignmentGradingWorker({ submissionModel: model, processSubmission })

  const firstRun = firstWorker.runOnce()
  await new Promise((resolve) => setImmediate(resolve))
  await secondWorker.runOnce()
  releaseProcessing()
  await firstRun

  assert.equal(calls, 1)
  firstWorker.stop()
  secondWorker.stop()
})

test('permanent provider errors are not retried', async () => {
  const model = makeSubmissionModel(makeSubmission())
  let processingCalls = 0
  const worker = createAssignmentGradingWorker({
    submissionModel: model,
    processSubmission: async () => {
      processingCalls += 1
      throw Object.assign(new Error('Daily quota exceeded.'), {
        retryable: false,
        category: 'daily_quota_exceeded',
        httpStatus: 429,
        providerCode: 'RESOURCE_EXHAUSTED',
        traceId: 'trace-1',
      })
    },
  })

  await worker.runOnce()
  await worker.runOnce()
  assert.equal(processingCalls, 1)
  assert.equal(model.submission.gradingStatus, 'AI Grading Failed')
  assert.equal(model.submission.gradingRetryCount, 0)
  worker.stop()
})
