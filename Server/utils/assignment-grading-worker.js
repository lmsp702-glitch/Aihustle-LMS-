import { randomUUID } from 'node:crypto'

export const ASSIGNMENT_GRADING_POLL_INTERVAL_MS = 1000
export const ASSIGNMENT_GRADING_JOB_LEASE_MS = 5 * 60 * 1000
export const MAX_AUTOMATIC_GRADING_RETRIES = 3
export const INITIAL_AUTOMATIC_RETRY_DELAY_MS = 2000
export const MAX_AUTOMATIC_RETRY_DELAY_MS = 30000

let activeWorker = null

function logGradingEvent({ event, traceId, attempt, category, httpStatus = null, providerCode = null }) {
  const diagnostic = JSON.stringify({ event, traceId, attempt, category, httpStatus, providerCode })
  if (event.endsWith('_failure')) console.error(diagnostic)
  else console.info(diagnostic)
}

function retryDelay(retryCount) {
  return Math.min(
    INITIAL_AUTOMATIC_RETRY_DELAY_MS * (2 ** retryCount),
    MAX_AUTOMATIC_RETRY_DELAY_MS,
  )
}

export function createAssignmentGradingWorker({
  submissionModel,
  processSubmission,
  pollIntervalMs = ASSIGNMENT_GRADING_POLL_INTERVAL_MS,
  leaseMs = ASSIGNMENT_GRADING_JOB_LEASE_MS,
}) {
  let intervalId = null
  let processing = false
  let stopped = true

  async function processNext(force = false) {
    if ((stopped && !force) || processing) return
    processing = true
    try {
      const now = new Date()
      const submission = await submissionModel.findOneAndUpdate(
        {
          aiEvaluation: { $exists: false },
          activeSubmissionKey: { $type: 'string' },
          $or: [
            { gradingStatus: 'Submitted' },
            {
              gradingStatus: 'AI Grading',
              $and: [
                { $or: [{ gradingLeaseUntil: { $lte: now } }, { gradingLeaseUntil: { $exists: false } }] },
                { $or: [{ gradingNextRetryAt: { $lte: now } }, { gradingNextRetryAt: { $exists: false } }] },
              ],
            },
          ],
        },
        {
          $set: {
            gradingStatus: 'AI Grading',
            gradingError: '',
            gradingLeaseUntil: new Date(now.getTime() + leaseMs),
            gradingLeaseToken: randomUUID(),
          },
          $unset: { gradingNextRetryAt: '' },
        },
        { returnDocument: 'after', sort: { submittedAt: 1, _id: 1 }, runValidators: true },
      ).select('+fileData +gradingLeaseToken')

      if (!submission) return
      const traceId = submission.gradingTraceId || randomUUID()
      if (!submission.gradingTraceId) {
        await submissionModel.updateOne(
          { _id: submission._id, gradingStatus: 'AI Grading', gradingLeaseToken: submission.gradingLeaseToken },
          { $set: { gradingTraceId: traceId } },
        )
        submission.gradingTraceId = traceId
      }

      try {
        await processSubmission(submission)
      } catch (error) {
        const retryCount = Number.isInteger(submission.gradingRetryCount)
          ? submission.gradingRetryCount
          : 0
        const retryable = error?.retryable === true
        const shouldRetry = retryable && retryCount < MAX_AUTOMATIC_GRADING_RETRIES
        const retryAt = shouldRetry
          ? new Date(Date.now() + retryDelay(retryCount))
          : null
        const trace = error?.traceId || traceId
        await submissionModel.updateOne(
          {
            _id: submission._id,
            gradingStatus: 'AI Grading',
            gradingLeaseToken: submission.gradingLeaseToken,
          },
          shouldRetry
            ? {
              $set: {
                gradingStatus: 'AI Grading',
                gradingError: '',
                gradingRetryCount: retryCount + 1,
                gradingNextRetryAt: retryAt,
                gradingLeaseUntil: retryAt,
              },
              $unset: { gradingLeaseToken: '' },
            }
            : {
              $set: {
                gradingStatus: 'AI Grading Failed',
                gradingError: 'AI grading could not complete. No marks were assigned.',
              },
              $unset: {
                activeSubmissionKey: '',
                gradingLeaseUntil: '',
                gradingLeaseToken: '',
                gradingNextRetryAt: '',
              },
            },
        )
        logGradingEvent({
          event: shouldRetry
            ? 'gemini.assignment.automatic_retry_scheduled'
            : 'gemini.assignment.automatic_failure',
          traceId: trace,
          attempt: retryCount + 1,
          category: error?.category || 'internal_grading_error',
          httpStatus: error?.httpStatus ?? null,
          providerCode: error?.providerCode ?? null,
        })
      }
    } catch {
      logGradingEvent({
        event: 'assignment.grading_worker_failure',
        traceId: null,
        attempt: 0,
        category: 'worker_error',
        httpStatus: null,
        providerCode: null,
      })
    } finally {
      processing = false
    }
  }

  return {
    start() {
      if (!stopped) return
      stopped = false
      intervalId = setInterval(() => { void processNext() }, pollIntervalMs)
      void processNext()
    },
    wake() {
      void processNext()
    },
    stop() {
      stopped = true
      if (intervalId) clearInterval(intervalId)
      intervalId = null
    },
    runOnce: () => processNext(true),
  }
}

export function startAssignmentGradingWorker(options) {
  if (!activeWorker) activeWorker = createAssignmentGradingWorker(options)
  activeWorker.start()
  return activeWorker
}

export function wakeAssignmentGradingWorker() {
  activeWorker?.wake()
}

export function stopAssignmentGradingWorker() {
  activeWorker?.stop()
  activeWorker = null
}
