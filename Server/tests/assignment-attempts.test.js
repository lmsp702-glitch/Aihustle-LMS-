import assert from 'node:assert/strict'
import { test } from 'node:test'
import { getAssignmentAttemptState } from '../utils/assignment-attempts.js'
import { removeLegacyUniqueAssignmentSubmissionIndexes } from '../utils/assignment-submission-indexes.js'
import AssignmentSubmission from '../models/AssignmentSubmission.js'

const now = new Date('2026-11-20T12:00:00.000Z')

function failedSubmission(id, attemptNumber, evaluatedAt, gradingStatus = 'AI Graded') {
  return {
    _id: id,
    submittedAt: evaluatedAt,
    evaluatedAt,
    attemptNumber,
    gradingStatus,
    academicStatus: 'Failed',
    marksObtained: 74,
    aiEvaluation: { totalMarks: 74, maximumMarks: 100 },
  }
}

test('attempt state offers three submissions and counts only academic failures', () => {
  assert.deepEqual(getAssignmentAttemptState([], 100, now), {
    maxAttempts: 3,
    attemptsUsed: 0,
    failedAttempts: 0,
    remainingAttempts: 3,
    nextAttemptNumber: 1,
    currentAttemptNumber: 0,
    latestSubmissionId: null,
    latestEvaluatedSubmissionId: null,
    hasPassed: false,
    hasTechnicalFailure: false,
    hasPendingGrading: false,
    hasPendingHumanReview: false,
    lockoutStartedAt: null,
    lockoutUntil: null,
    isLocked: false,
    canSubmit: true,
    retrySubmissionId: null,
  })

  const technicalFailure = {
    _id: 'technical',
    submittedAt: new Date('2026-11-20T11:00:00Z'),
    attemptNumber: 1,
    gradingStatus: 'AI Grading Failed',
    gradingError: 'Temporary API failure.',
  }
  const state = getAssignmentAttemptState([technicalFailure], 100, now)
  assert.equal(state.failedAttempts, 0)
  assert.equal(state.attemptsUsed, 0)
  assert.equal(state.remainingAttempts, 3)
  assert.equal(state.canSubmit, true)
  assert.equal(state.retrySubmissionId, 'technical')
  assert.equal(state.hasTechnicalFailure, true)
  assert.equal(state.hasPendingGrading, false)
})

test('active grading is not presented as a technical failure or resubmission opportunity', () => {
  for (const gradingStatus of ['Submitted', 'AI Grading']) {
    const state = getAssignmentAttemptState([{
      _id: gradingStatus,
      submittedAt: now,
      updatedAt: now,
      attemptNumber: 1,
      gradingStatus,
      activeSubmissionKey: 'enrollment:assignment',
    }], 100, now)
    assert.equal(state.hasTechnicalFailure, false)
    assert.equal(state.hasPendingGrading, true)
    assert.equal(state.retrySubmissionId, null)
    assert.equal(state.canSubmit, false)
  }
})

test('stale or unreserved grading statuses do not block another attempt', () => {
  for (const submission of [
    { gradingStatus: 'Submitted', submittedAt: now },
    {
      gradingStatus: 'AI Grading',
      submittedAt: now,
      updatedAt: new Date(now.getTime() - 6 * 60 * 1000),
      activeSubmissionKey: 'enrollment:assignment',
    },
  ]) {
    const state = getAssignmentAttemptState([{
      _id: 'stale-grading',
      attemptNumber: 1,
      ...submission,
    }], 100, now)
    assert.equal(state.hasPendingGrading, false)
    assert.equal(state.canSubmit, true)
  }
})

test('three recent academic failures lock submissions until 24 hours after the third failure', () => {
  const submissions = [
    failedSubmission('one', 1, new Date('2026-11-20T09:00:00Z')),
    failedSubmission('two', 2, new Date('2026-11-20T10:00:00Z')),
    failedSubmission('three', 3, new Date('2026-11-20T11:00:00Z')),
  ]
  const locked = getAssignmentAttemptState(submissions, 100, now)
  assert.equal(locked.attemptsUsed, 3)
  assert.equal(locked.failedAttempts, 3)
  assert.equal(locked.remainingAttempts, 0)
  assert.equal(locked.canSubmit, false)
  assert.equal(locked.isLocked, true)
  assert.equal(locked.lockoutUntil, '2026-11-21T11:00:00.000Z')

  const unlocked = getAssignmentAttemptState(
    submissions,
    100,
    new Date('2026-11-21T11:00:00.001Z'),
  )
  assert.equal(unlocked.failedAttempts, 0)
  assert.equal(unlocked.attemptsUsed, 0)
  assert.equal(unlocked.remainingAttempts, 3)
  assert.equal(unlocked.canSubmit, true)
  assert.equal(unlocked.isLocked, false)
})

test('one and two academic failures preserve the remaining attempt count', () => {
  for (const [failureCount, nextAttemptNumber, remainingAttempts] of [
    [1, 2, 2],
    [2, 3, 1],
  ]) {
    const submissions = Array.from({ length: failureCount }, (_, index) => (
      failedSubmission(
        `failure-${index + 1}`,
        index + 1,
        new Date(now.getTime() - (failureCount - index) * 60 * 60 * 1000),
      )
    ))
    const state = getAssignmentAttemptState(submissions, 100, now)
    assert.equal(state.failedAttempts, failureCount)
    assert.equal(state.attemptsUsed, failureCount)
    assert.equal(state.nextAttemptNumber, nextAttemptNumber)
    assert.equal(state.remainingAttempts, remainingAttempts)
    assert.equal(state.canSubmit, true)
  }
})

test('active submission reservation uses a unique partial index', () => {
  const activeSubmissionIndex = AssignmentSubmission.schema.indexes().find(([fields, options]) => (
    fields.activeSubmissionKey === 1 && options.name === 'unique_active_assignment_submission'
  ))
  assert.ok(activeSubmissionIndex)
  assert.equal(activeSubmissionIndex[1].unique, true)
  assert.deepEqual(activeSubmissionIndex[1].partialFilterExpression, {
    activeSubmissionKey: { $type: 'string' },
  })
})

test('passing results stop new attempts and a human-review request adds no attempt', () => {
  const passing = {
    _id: 'pass',
    attemptNumber: 2,
    submittedAt: new Date('2026-11-20T10:00:00Z'),
    evaluatedAt: new Date('2026-11-20T10:05:00Z'),
    gradingStatus: 'AI Graded',
    marksObtained: 75,
    academicStatus: 'Passed',
    aiEvaluation: { totalMarks: 75, maximumMarks: 100 },
  }
  const passedState = getAssignmentAttemptState([passing], 100, now)
  assert.equal(passedState.hasPassed, true)
  assert.equal(passedState.canSubmit, false)
  assert.equal(passedState.attemptsUsed, 2)
  assert.equal(passedState.remainingAttempts, 1)

  const passedAfterFailure = getAssignmentAttemptState([
    { ...passing, submittedAt: new Date('2026-11-20T11:30:00Z') },
    failedSubmission('prior-failure', 1, new Date('2026-11-20T10:00:00Z')),
  ], 100, now)
  assert.equal(passedAfterFailure.failedAttempts, 1)
  assert.equal(passedAfterFailure.attemptsUsed, 2)
  assert.equal(passedAfterFailure.remainingAttempts, 1)

  const requestedReview = {
    ...failedSubmission('review', 1, new Date('2026-11-20T10:00:00Z'), 'Re-evaluation Requested'),
    humanReviewRequest: { reasons: ['I believe I deserve more marks.'] },
  }
  const reviewState = getAssignmentAttemptState([requestedReview], 100, now)
  assert.equal(reviewState.failedAttempts, 1)
  assert.equal(reviewState.attemptsUsed, 1)
  assert.equal(reviewState.nextAttemptNumber, 2)
  assert.equal(reviewState.remainingAttempts, 2)
  assert.equal(reviewState.hasPendingHumanReview, true)
  assert.equal(reviewState.canSubmit, false)
})

test('startup removes only obsolete per-student assignment uniqueness indexes', async () => {
  const indexes = [
    { name: '_id_', key: { _id: 1 }, unique: true },
    { name: 'unique_active_assignment_submission', key: { activeSubmissionKey: 1 }, unique: true },
    { name: 'userId_1_assignmentId_1', key: { userId: 1, assignmentId: 1 }, unique: true },
    { name: 'enrollmentId_1_assignmentId_1', key: { enrollmentId: 1, assignmentId: 1 }, unique: true },
    { name: 'userId_1_assignmentId_1_attemptNumber_1', key: { userId: 1, assignmentId: 1, attemptNumber: 1 }, unique: true },
    { name: 'userId_1_courseId_1', key: { userId: 1, courseId: 1 }, unique: true },
  ]
  const dropped = []
  const collection = {
    indexes: async () => indexes,
    dropIndex: async (name) => { dropped.push(name) },
  }

  assert.deepEqual(
    await removeLegacyUniqueAssignmentSubmissionIndexes(collection),
    [
      'userId_1_assignmentId_1',
      'enrollmentId_1_assignmentId_1',
      'userId_1_assignmentId_1_attemptNumber_1',
    ],
  )
  assert.deepEqual(dropped, [
    'userId_1_assignmentId_1',
    'enrollmentId_1_assignmentId_1',
    'userId_1_assignmentId_1_attemptNumber_1',
  ])
})
