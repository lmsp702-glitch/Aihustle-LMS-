import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  ASSIGNMENT_PASSING_PERCENTAGE,
  calculateAssignmentAcademicResult,
  getAssignmentAcademicResult,
  isAssignmentPassed,
} from '../utils/assignment-result.js'

test('assignment result uses an exact 75 percent passing threshold', () => {
  assert.equal(ASSIGNMENT_PASSING_PERCENTAGE, 75)
  for (const [marks, expected] of [
    [0, 'Failed'],
    [50, 'Failed'],
    [74, 'Failed'],
    [75, 'Passed'],
    [85, 'Passed'],
    [100, 'Passed'],
  ]) {
    assert.deepEqual(calculateAssignmentAcademicResult(marks, 100), {
      scorePercentage: marks,
      academicStatus: expected,
    })
  }
})

test('human final marks take precedence over the original AI score', () => {
  assert.deepEqual(getAssignmentAcademicResult({
    marksObtained: 80,
    finalMarks: 74,
    aiEvaluation: { totalMarks: 80, maximumMarks: 100 },
  }), {
    scorePercentage: 74,
    academicStatus: 'Failed',
  })
  assert.equal(isAssignmentPassed({
    marksObtained: 74,
    finalMarks: 75,
    aiEvaluation: { totalMarks: 74, maximumMarks: 100 },
  }), true)
})

test('invalid or out-of-range marks do not produce an academic result', () => {
  assert.equal(calculateAssignmentAcademicResult(0, 0), null)
  assert.equal(calculateAssignmentAcademicResult(-1, 100), null)
  assert.equal(calculateAssignmentAcademicResult(101, 100), null)
  assert.equal(calculateAssignmentAcademicResult(Number.NaN, 100), null)
})
