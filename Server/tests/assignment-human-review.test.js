import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  HUMAN_REVIEW_OTHER_REASON,
  HUMAN_REVIEW_REASON_OPTIONS,
  normalizeHumanReviewRequest,
} from '../utils/assignment-human-review.js'

test('human-review requests accept multiple reasons and optional comments', () => {
  const result = normalizeHumanReviewRequest({
    reasons: [HUMAN_REVIEW_REASON_OPTIONS[0], HUMAN_REVIEW_REASON_OPTIONS[2]],
    comments: 'Please consider the alternate example.',
  })

  assert.equal(result.error, undefined)
  assert.deepEqual(result.reasons, [HUMAN_REVIEW_REASON_OPTIONS[0], HUMAN_REVIEW_REASON_OPTIONS[2]])
  assert.equal(result.comments, 'Please consider the alternate example.')
})

test('selecting Other requires an explanation and preserves it with comments', () => {
  assert.match(
    normalizeHumanReviewRequest({ reasons: [HUMAN_REVIEW_OTHER_REASON] }).error,
    /explain/i,
  )

  const result = normalizeHumanReviewRequest({
    reasons: [HUMAN_REVIEW_OTHER_REASON, HUMAN_REVIEW_REASON_OPTIONS[6]],
    otherExplanation: 'A required rubric element was present in my appendix.',
    comments: 'Thank you for reviewing.',
  })
  assert.equal(result.error, undefined)
  assert.equal(result.otherExplanation, 'A required rubric element was present in my appendix.')
  assert.equal(result.comments, 'Thank you for reviewing.')
  assert.match(result.reason, /required rubric element/)
})

test('human-review requests reject missing, duplicate, or unknown reasons', () => {
  assert.match(normalizeHumanReviewRequest({ reasons: [] }).error, /at least one/i)
  assert.match(normalizeHumanReviewRequest({
    reasons: [HUMAN_REVIEW_REASON_OPTIONS[0], HUMAN_REVIEW_REASON_OPTIONS[0]],
  }).error, /valid reason/i)
  assert.match(normalizeHumanReviewRequest({ reasons: ['Unknown reason'] }).error, /valid reason/i)
})
