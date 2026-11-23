export const ASSIGNMENT_PASSING_PERCENTAGE = 75

export function calculateAssignmentAcademicResult(marks, maximumMarks) {
  const awardedMarks = Number(marks)
  const maxMarks = Number(maximumMarks)
  if (
    !Number.isFinite(awardedMarks)
    || !Number.isFinite(maxMarks)
    || maxMarks <= 0
    || awardedMarks < 0
    || awardedMarks > maxMarks
  ) return null

  const scorePercentage = (awardedMarks / maxMarks) * 100
  return {
    scorePercentage,
    academicStatus: scorePercentage >= ASSIGNMENT_PASSING_PERCENTAGE ? 'Passed' : 'Failed',
  }
}

export function getAssignmentAcademicResult(submission, fallbackMaximumMarks) {
  if (!submission) return null
  const marks = Number.isFinite(submission.finalMarks)
    ? submission.finalMarks
    : Number.isFinite(submission.marksObtained)
      ? submission.marksObtained
      : Number.isFinite(submission.aiEvaluation?.totalMarks)
        ? submission.aiEvaluation.totalMarks
        : submission.humanEvaluation?.totalMarks
  const maximumMarks = submission.aiEvaluation?.maximumMarks
    ?? submission.humanEvaluation?.maximumMarks
    ?? fallbackMaximumMarks
  const result = calculateAssignmentAcademicResult(marks, maximumMarks)
  if (result) return result

  if (
    ['Passed', 'Failed'].includes(submission.academicStatus)
    && Number.isFinite(submission.scorePercentage)
  ) {
    return {
      scorePercentage: submission.scorePercentage,
      academicStatus: submission.academicStatus,
    }
  }
  return null
}

export function isAssignmentPassed(submission, fallbackMaximumMarks) {
  const result = getAssignmentAcademicResult(submission, fallbackMaximumMarks)
  if (result) return result.academicStatus === 'Passed'

  const hasRecordedMarks = [
    submission?.finalMarks,
    submission?.marksObtained,
    submission?.aiEvaluation?.totalMarks,
    submission?.humanEvaluation?.totalMarks,
  ].some(Number.isFinite)
  return !hasRecordedMarks
    && !submission?.gradingStatus
    && submission?.reviewStatus === 'approved'
}
