export const HUMAN_REVIEW_REASON_OPTIONS = Object.freeze([
  'The AI misunderstood my answer.',
  'My answer is correct, but marks were deducted.',
  'The AI did not consider all the points in my answer.',
  'My practical examples or implementation were not evaluated correctly.',
  'The marks do not match the assignment requirements.',
  'The AI feedback is incorrect or irrelevant.',
  'I believe I deserve more marks.',
  'Other (Please specify).',
])

export const HUMAN_REVIEW_OTHER_REASON = HUMAN_REVIEW_REASON_OPTIONS[7]

export function normalizeHumanReviewRequest({ reasons, otherExplanation, comments } = {}) {
  if (
    !Array.isArray(reasons)
    || reasons.length === 0
    || reasons.length > HUMAN_REVIEW_REASON_OPTIONS.length
    || reasons.some((reason) => !HUMAN_REVIEW_REASON_OPTIONS.includes(reason))
    || new Set(reasons).size !== reasons.length
  ) {
    return { error: 'Select at least one valid reason for requesting human re-evaluation.' }
  }

  if (
    (otherExplanation !== undefined && typeof otherExplanation !== 'string')
    || (comments !== undefined && typeof comments !== 'string')
  ) {
    return { error: 'The explanation and additional comments must be text.' }
  }
  const normalizedExplanation = typeof otherExplanation === 'string'
    ? otherExplanation.trim()
    : ''
  if (
    reasons.includes(HUMAN_REVIEW_OTHER_REASON)
    && (!normalizedExplanation || normalizedExplanation.length > 2000)
  ) {
    return { error: 'Explain your reason when selecting Other (up to 2,000 characters).' }
  }
  if (!reasons.includes(HUMAN_REVIEW_OTHER_REASON) && normalizedExplanation) {
    return { error: 'Remove the Other explanation or select Other (Please specify).' }
  }

  const normalizedComments = typeof comments === 'string' ? comments.trim() : ''
  if (normalizedComments.length > 2000) {
    return { error: 'Additional comments must be 2,000 characters or fewer.' }
  }

  return {
    reasons,
    otherExplanation: normalizedExplanation,
    comments: normalizedComments,
    reason: [
      ...reasons.filter((reason) => reason !== HUMAN_REVIEW_OTHER_REASON),
      ...(reasons.includes(HUMAN_REVIEW_OTHER_REASON) ? [normalizedExplanation] : []),
      ...(normalizedComments ? [`Additional comments: ${normalizedComments}`] : []),
    ].join('\n'),
  }
}
