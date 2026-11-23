import { getAssignmentAcademicResult } from './assignment-result.js'

export const MAX_ASSIGNMENT_ATTEMPTS = 3
export const ASSIGNMENT_ATTEMPT_WINDOW_MS = 24 * 60 * 60 * 1000
export const ASSIGNMENT_GRADING_LEASE_MS = 5 * 60 * 1000

function getEvaluationTimestamp(submission) {
  const timestamp = new Date(submission.evaluatedAt || submission.aiEvaluation?.evaluatedAt || submission.submittedAt || 0)
  return Number.isFinite(timestamp.getTime()) ? timestamp.getTime() : 0
}

function getSubmissionOrder(left, right) {
  const leftTime = new Date(left.submittedAt || 0).getTime()
  const rightTime = new Date(right.submittedAt || 0).getTime()
  return rightTime - leftTime || String(right._id || '').localeCompare(String(left._id || ''))
}

export function getAssignmentAttemptState(submissions = [], maximumMarks, now = new Date()) {
  const nowTime = now instanceof Date ? now.getTime() : new Date(now).getTime()
  const cutoff = nowTime - ASSIGNMENT_ATTEMPT_WINDOW_MS
  const gradingLeaseCutoff = nowTime - ASSIGNMENT_GRADING_LEASE_MS
  const orderedSubmissions = submissions.slice().sort(getSubmissionOrder)
  const latestSubmission = orderedSubmissions[0] || null
  const hasPendingGrading = orderedSubmissions.some((submission) => (
    ['AI Grading', 'Submitted'].includes(submission.gradingStatus)
    && Boolean(submission.activeSubmissionKey)
    && (
      (submission.gradingLeaseUntil && new Date(submission.gradingLeaseUntil).getTime() > nowTime)
      || (submission.gradingNextRetryAt && new Date(submission.gradingNextRetryAt).getTime() > nowTime)
      || new Date(submission.updatedAt || submission.submittedAt || 0).getTime() > gradingLeaseCutoff
    )
    && !getAssignmentAcademicResult(submission, maximumMarks)
    && !(submission.gradingStatus === 'Submitted' && submission.gradingError)
  ))
  const hasPendingHumanReview = orderedSubmissions.some((submission) => (
    ['Re-evaluation Requested', 'Human Review'].includes(submission.gradingStatus)
  ))
  const latestEvaluatedSubmission = orderedSubmissions.find((submission) => (
    getAssignmentAcademicResult(submission, maximumMarks)
  )) || null
  const recentFailedSubmissions = orderedSubmissions.filter((submission) => (
    getAssignmentAcademicResult(submission, maximumMarks)?.academicStatus === 'Failed'
    && getEvaluationTimestamp(submission) > cutoff
  ))
  const failedAttempts = recentFailedSubmissions.length
  const lastFailure = recentFailedSubmissions
    .slice()
    .sort((left, right) => getEvaluationTimestamp(right) - getEvaluationTimestamp(left))[0]
  const derivedLockoutUntil = failedAttempts >= MAX_ASSIGNMENT_ATTEMPTS && lastFailure
    ? new Date(getEvaluationTimestamp(lastFailure) + ASSIGNMENT_ATTEMPT_WINDOW_MS)
    : null
  const storedLockoutUntil = failedAttempts >= MAX_ASSIGNMENT_ATTEMPTS
    ? recentFailedSubmissions
      .map((submission) => new Date(submission.lockoutUntil || 0))
      .find((date) => Number.isFinite(date.getTime()) && date.getTime() > nowTime)
    : null
  const lockoutUntil = storedLockoutUntil || derivedLockoutUntil
  const isLocked = Boolean(lockoutUntil && lockoutUntil.getTime() > nowTime)
  const latestResult = latestEvaluatedSubmission
    ? getAssignmentAcademicResult(latestEvaluatedSubmission, maximumMarks)
    : null
  const isPassed = latestResult?.academicStatus === 'Passed'
  const attemptsUsed = isPassed
    ? Math.min(
      MAX_ASSIGNMENT_ATTEMPTS,
      getEvaluationTimestamp(latestEvaluatedSubmission) > cutoff
        ? Math.max(failedAttempts + 1, Number(latestEvaluatedSubmission.attemptNumber) || 1)
        : Number(latestEvaluatedSubmission.attemptNumber) || 1,
    )
    : failedAttempts
  const hasTechnicalFailure = Boolean(
    latestSubmission
    && (
      latestSubmission.gradingStatus === 'AI Grading Failed'
      || (latestSubmission.gradingStatus === 'Submitted' && latestSubmission.gradingError)
    )
    && !getAssignmentAcademicResult(latestSubmission, maximumMarks),
  )
  const remainingAttempts = Math.max(0, MAX_ASSIGNMENT_ATTEMPTS - attemptsUsed)

  return {
    maxAttempts: MAX_ASSIGNMENT_ATTEMPTS,
    attemptsUsed,
    failedAttempts,
    remainingAttempts,
    nextAttemptNumber: Math.min(MAX_ASSIGNMENT_ATTEMPTS, failedAttempts + 1),
    currentAttemptNumber: latestSubmission?.attemptNumber
      ?? latestEvaluatedSubmission?.attemptNumber
      ?? 0,
    latestSubmissionId: latestSubmission?._id ? String(latestSubmission._id) : null,
    latestEvaluatedSubmissionId: latestEvaluatedSubmission?._id
      ? String(latestEvaluatedSubmission._id)
      : null,
    hasPassed: isPassed,
    hasTechnicalFailure,
    hasPendingGrading,
    hasPendingHumanReview,
    lockoutStartedAt: isLocked && lastFailure
      ? new Date(getEvaluationTimestamp(lastFailure)).toISOString()
      : null,
    lockoutUntil: lockoutUntil?.toISOString() || null,
    isLocked,
    canSubmit: !isPassed && !isLocked && !hasPendingGrading && !hasPendingHumanReview
      && failedAttempts < MAX_ASSIGNMENT_ATTEMPTS,
    retrySubmissionId: hasTechnicalFailure && latestSubmission?._id
      ? String(latestSubmission._id)
      : null,
  }
}
