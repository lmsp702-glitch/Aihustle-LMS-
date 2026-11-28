export function getQuestionKey(question) {
  const id = question?._id == null ? '' : String(question._id).trim()
  return /^[a-f\d]{24}$/i.test(id) ? id.toLowerCase() : id
}

export function validateQuizQuestions(questions) {
  if (!Array.isArray(questions) || !questions.length) {
    return { error: 'The quiz has no saved questions.' }
  }
  const questionIds = new Set()
  for (const [index, question] of questions.entries()) {
    const questionId = getQuestionKey(question)
    if (!/^[a-f\d]{24}$/.test(questionId)) {
      return { error: `Question ${index + 1} is missing a valid saved question ID.` }
    }
    if (questionIds.has(questionId)) {
      return { error: `Question ${index + 1} has a duplicate saved question ID.` }
    }
    questionIds.add(questionId)
  }
  return {}
}

export function updateQuizAnswerMap(answerMap, question, optionIndex) {
  const questionId = getQuestionKey(question)
  if (!/^[a-f\d]{24}$/.test(questionId)) {
    throw new Error('This question does not have a valid saved ID.')
  }
  if (
    !Array.isArray(question.options)
    || !Number.isInteger(optionIndex)
    || optionIndex < 0
    || optionIndex >= question.options.length
  ) {
    throw new Error('The selected option is invalid.')
  }

  const selected = new Set(answerMap[questionId] || [])
  if (question.type === 'multiple-select' && selected.has(optionIndex)) selected.delete(optionIndex)
  else if (question.type === 'multiple-select') selected.add(optionIndex)
  else {
    return { ...answerMap, [questionId]: [optionIndex] }
  }
  return { ...answerMap, [questionId]: [...selected].sort((a, b) => a - b) }
}

export function isQuizAnswerSaved(question, selectedAnswers, savedAnswers) {
  const questionId = getQuestionKey(question)
  if (!Object.prototype.hasOwnProperty.call(savedAnswers, questionId)) return false
  const selected = selectedAnswers[questionId] || []
  const saved = savedAnswers[questionId] || []
  return selected.length === saved.length && selected.every((optionIndex, index) => optionIndex === saved[index])
}

export function canNavigateToQuestion(questions, selectedAnswers, savedAnswers, currentIndex, targetIndex) {
  if (targetIndex <= currentIndex) return true
  return questions.slice(0, targetIndex).every((question) => (
    (selectedAnswers[getQuestionKey(question)] || []).length > 0
    && isQuizAnswerSaved(question, selectedAnswers, savedAnswers)
  ))
}

export function buildQuizSubmissionAnswers(questions, answerMap, { allowUnanswered = false } = {}) {
  const validation = validateQuizQuestions(questions)
  if (validation.error) return validation

  const answers = []

  for (const [index, question] of questions.entries()) {
    const questionId = getQuestionKey(question)
    const selectedOptionIndices = answerMap[questionId]

    if ((!Array.isArray(selectedOptionIndices) || selectedOptionIndices.length === 0) && !allowUnanswered) {
      return { error: `Please answer Question ${index + 1} before submitting.` }
    }

    const selected = selectedOptionIndices || []
    if (
      !Array.isArray(question.options)
      || (selectedOptionIndices !== undefined && !Array.isArray(selectedOptionIndices))
      || selected.some((optionIndex) => (
        !Number.isInteger(optionIndex)
        || optionIndex < 0
        || optionIndex >= question.options.length
      ))
      || (question.type === 'multiple-select'
        ? new Set(selected).size !== selected.length
        : selected.length > 1)
    ) {
      return { error: `The answer selected for Question ${index + 1} is invalid. Please review it and try again.` }
    }

    answers.push({
      questionId,
      selectedOptionIndices: [...selected].sort((a, b) => a - b),
    })
  }

  return { answers }
}
