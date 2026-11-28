import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildQuizSubmissionAnswers,
  canNavigateToQuestion,
  getQuestionKey,
  isQuizAnswerSaved,
  updateQuizAnswerMap,
  validateQuizQuestions,
} from './student-quiz-answers.js'

test('quiz submission payload includes all ten answers using canonical question IDs', () => {
  const questions = [
    { _id: 'ABCDEF0123456789ABCDEF01', type: 'multiple-choice', options: ['A', 'B'] },
    { _id: 'abcdef0123456789abcdef02', type: 'multiple-select', options: ['A', 'B', 'C'] },
    { _id: 'abcdef0123456789abcdef03', type: 'true-false', options: ['True', 'False'] },
    ...Array.from({ length: 7 }, (_, index) => ({
      _id: `abcdef0123456789abcde${String(index + 4).padStart(3, '0')}`,
      type: 'multiple-choice',
      options: ['A', 'B'],
    })),
  ]
  const answersByQuestionId = Object.fromEntries(questions.map((question, index) => [
    getQuestionKey(question),
    index === 1 ? [0, 2] : [index % question.options.length],
  ]))

  const result = buildQuizSubmissionAnswers(questions, answersByQuestionId)

  assert.equal(result.error, undefined)
  assert.equal(result.answers.length, 10)
  assert.deepEqual(result.answers[0], {
    questionId: 'abcdef0123456789abcdef01',
    selectedOptionIndices: [0],
  })
  assert.deepEqual(result.answers[1], {
    questionId: 'abcdef0123456789abcdef02',
    selectedOptionIndices: [0, 2],
  })
  assert.deepEqual(result.answers.map((answer) => answer.questionId), questions.map(getQuestionKey))
})

test('quiz submission reports a genuinely missing answer by question number', () => {
  const questions = [
    { _id: 'abcdef0123456789abcdef01', type: 'multiple-choice', options: ['A', 'B'] },
    { _id: 'abcdef0123456789abcdef02', type: 'true-false', options: ['True', 'False'] },
  ]

  assert.deepEqual(
    buildQuizSubmissionAnswers(questions, { [getQuestionKey(questions[1])]: [1] }),
    { error: 'Please answer Question 1 before submitting.' },
  )
})

test('keeps five answers independent after navigating forward and backward', () => {
  const questions = Array.from({ length: 5 }, (_, index) => ({
    _id: `abcdef0123456789abcdef0${index}`,
    type: 'multiple-choice',
    options: ['A', 'B', 'C', 'D'],
  }))
  const selections = [0, 1, 2, 3, 0]
  let answers = {}

  questions.forEach((question, index) => {
    answers = updateQuizAnswerMap(answers, question, selections[index])
  })

  const answersWhenNavigatingBackward = [...questions].reverse().map((question) => (
    answers[getQuestionKey(question)]
  ))
  assert.deepEqual(answersWhenNavigatingBackward, [[0], [3], [2], [1], [0]])

  answers = updateQuizAnswerMap(answers, questions[1], 1)
  answers = updateQuizAnswerMap(answers, questions[0], 0)

  assert.deepEqual(
    buildQuizSubmissionAnswers(questions, answers).answers.map((answer) => answer.selectedOptionIndices),
    [[0], [1], [2], [3], [0]],
  )
  assert.deepEqual(validateQuizQuestions(questions), {})
})

test('blocks forward navigation until every preceding answer is saved', () => {
  const questions = Array.from({ length: 3 }, (_, index) => ({
    _id: `abcdef0123456789abcdef0${index}`,
    type: 'multiple-choice',
    options: ['A', 'B'],
  }))
  let selectedAnswers = {}
  let savedAnswers = {}

  assert.equal(canNavigateToQuestion(questions, selectedAnswers, savedAnswers, 0, 1), false)
  assert.equal(canNavigateToQuestion(questions, selectedAnswers, savedAnswers, 1, 0), true)

  selectedAnswers = updateQuizAnswerMap(selectedAnswers, questions[0], 0)
  savedAnswers = { [getQuestionKey(questions[0])]: selectedAnswers[getQuestionKey(questions[0])] }
  assert.equal(canNavigateToQuestion(questions, selectedAnswers, savedAnswers, 0, 1), true)
  assert.equal(canNavigateToQuestion(questions, selectedAnswers, savedAnswers, 0, 2), false)

  selectedAnswers = updateQuizAnswerMap(selectedAnswers, questions[1], 1)
  savedAnswers = {
    ...savedAnswers,
    [getQuestionKey(questions[1])]: selectedAnswers[getQuestionKey(questions[1])],
  }
  assert.equal(canNavigateToQuestion(questions, selectedAnswers, savedAnswers, 1, 2), true)
})

test('rejects a missing saved question ID before submitting answers', () => {
  assert.match(validateQuizQuestions([{ _id: 'local-question' }]).error, /valid saved question ID/)
})

test('switches from Save Answer to Next only after the current selection is confirmed saved', () => {
  const question = {
    _id: 'abcdef0123456789abcdef01',
    type: 'multiple-select',
    options: ['A', 'B', 'C'],
  }
  const selectedAnswers = { [getQuestionKey(question)]: [0, 2] }

  assert.equal(isQuizAnswerSaved(question, selectedAnswers, {}), false)
  assert.equal(isQuizAnswerSaved(question, selectedAnswers, { [getQuestionKey(question)]: [0, 2] }), true)
  assert.equal(isQuizAnswerSaved(question, selectedAnswers, { [getQuestionKey(question)]: [1] }), false)

  const changedAnswers = updateQuizAnswerMap(selectedAnswers, question, 1)
  assert.equal(isQuizAnswerSaved(question, changedAnswers, { [getQuestionKey(question)]: [0, 2] }), false)
  assert.equal(
    isQuizAnswerSaved(question, changedAnswers, { [getQuestionKey(question)]: changedAnswers[getQuestionKey(question)] }),
    true,
  )
})
