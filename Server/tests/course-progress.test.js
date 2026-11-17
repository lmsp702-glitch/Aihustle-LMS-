import assert from 'node:assert/strict'
import { test } from 'node:test'
import mongoose from 'mongoose'
import Course from '../models/Course.js'
import Enrollment from '../models/Enrollment.js'
import { calculateCourseProgress, recalculateEnrollmentsCourseProgress } from '../utils/course-progress.js'
import AssignmentSubmission from '../models/AssignmentSubmission.js'
import QuizAttempt from '../models/QuizAttempt.js'

const ids = {
  video: '68a000000000000000000001',
  optionalVideo: '68a000000000000000000002',
  quiz: '68a000000000000000000003',
  optionalQuiz: '68a000000000000000000004',
  assignment: '68a000000000000000000005',
  optionalAssignment: '68a000000000000000000006',
}

function courseWithRequiredActivities() {
  return {
    modules: [{
      contentItems: [
        { _id: ids.video, type: 'video-lesson', title: 'Video' },
        { _id: ids.optionalVideo, type: 'video-lesson', title: 'Optional video', requiredForCertificate: false },
        {
          _id: ids.quiz,
          type: 'quiz',
          title: 'Quiz',
          quiz: { questions: [{ prompt: 'Question' }] },
        },
        {
          _id: ids.optionalQuiz,
          type: 'quiz',
          title: 'Optional quiz',
          requiredForCertificate: false,
          quiz: { questions: [{ prompt: 'Question' }] },
        },
        { _id: ids.assignment, type: 'assignment', title: 'Assignment' },
        {
          _id: ids.optionalAssignment,
          type: 'assignment',
          title: 'Optional assignment',
          requiredForCertificate: false,
        },
        { _id: '68a000000000000000000007', type: 'note', title: 'Notes' },
      ],
    }],
  }
}

function queryResult(value) {
  const result = Promise.resolve(value)
  result.select = () => result
  result.lean = () => result
  return result
}

function stub(target, name, implementation) {
  const original = target[name]
  target[name] = implementation
  return () => { target[name] = original }
}

test('course progress excludes optional activities and notes and never rounds incomplete progress to 100%', () => {
  const progress = calculateCourseProgress({
    course: courseWithRequiredActivities(),
    enrollment: { completedLessonIds: [ids.video] },
    quizAttempts: [
      { quizId: ids.quiz, status: 'started', passed: true },
      { quizId: ids.optionalQuiz, status: 'submitted', passed: true },
    ],
    assignmentSubmissions: [
      { assignmentId: ids.assignment, reviewStatus: 'pending', submittedAt: new Date() },
      { assignmentId: ids.optionalAssignment, reviewStatus: 'approved', submittedAt: new Date() },
    ],
  })

  assert.deepEqual(progress, {
    completedActivities: 1,
    totalActivities: 3,
    percentage: 33,
    isComplete: false,
    videos: { completed: 1, total: 1 },
    quizzes: { completed: 0, total: 1 },
    assignments: { completed: 0, total: 1 },
  })
})

test('course progress requires a submitted passed quiz and the latest assignment submission to be approved', () => {
  const course = courseWithRequiredActivities()
  const enrollment = { completedLessonIds: [ids.video] }
  const incompleteQuizAttempts = [
    { quizId: ids.quiz, status: 'started', passed: true },
    { quizId: ids.quiz, status: 'submitted', passed: false },
  ]
  const approvedThenRejected = [
    { _id: '68a000000000000000000011', assignmentId: ids.assignment, reviewStatus: 'approved', submittedAt: new Date('2026-01-01T00:00:00Z') },
    { _id: '68a000000000000000000012', assignmentId: ids.assignment, reviewStatus: 'rejected', submittedAt: new Date('2026-01-02T00:00:00Z') },
  ]

  const incomplete = calculateCourseProgress({
    course,
    enrollment,
    quizAttempts: incompleteQuizAttempts,
    assignmentSubmissions: approvedThenRejected,
  })
  assert.equal(incomplete.percentage, 33)
  assert.equal(incomplete.isComplete, false)

  const complete = calculateCourseProgress({
    course,
    enrollment,
    quizAttempts: [{ quizId: ids.quiz, status: 'submitted', passed: true }],
    assignmentSubmissions: [approvedThenRejected[0]],
  })
  assert.equal(complete.percentage, 100)
  assert.equal(complete.isComplete, true)
})

test('one incomplete required activity keeps progress below 100 even when rounded percentage would be 100', () => {
  const videos = Array.from({ length: 200 }, (_value, index) => ({
    _id: index.toString(16).padStart(24, '0'),
    type: 'video-lesson',
    title: `Video ${index + 1}`,
  }))
  const progress = calculateCourseProgress({
    course: { modules: [{ contentItems: videos }] },
    enrollment: { completedLessonIds: videos.slice(0, -1).map(({ _id }) => _id) },
  })

  assert.equal(progress.percentage, 99)
  assert.equal(progress.isComplete, false)
})

test('a course with no required activities is not marked completed', () => {
  const progress = calculateCourseProgress({
    course: {
      modules: [{
        contentItems: [
          { _id: ids.optionalVideo, type: 'video-lesson', title: 'Optional video', requiredForCertificate: false },
          { _id: '68a000000000000000000007', type: 'note', title: 'Notes' },
        ],
      }],
    },
    enrollment: { completedLessonIds: [ids.optionalVideo] },
  })

  assert.equal(progress.totalActivities, 0)
  assert.equal(progress.percentage, 0)
  assert.equal(progress.isComplete, false)
})

test('required activities count without title or loaded quiz question data', () => {
  const quizId = '68a000000000000000000008'
  const progress = calculateCourseProgress({
    course: {
      modules: [{
        contentItems: [
          { _id: ids.video, type: 'video-lesson' },
          { _id: '68a000000000000000000009', type: 'quiz', quiz: { _id: quizId } },
          { _id: ids.assignment, type: 'assignment' },
        ],
      }],
    },
    enrollment: { completedLessonIds: [ids.video] },
    quizAttempts: [{ quizId, status: 'submitted', passed: true }],
    assignmentSubmissions: [{ assignmentId: ids.assignment, reviewStatus: 'approved' }],
  })

  assert.equal(progress.totalActivities, 3)
  assert.equal(progress.completedActivities, 3)
  assert.equal(progress.percentage, 100)
  assert.equal(progress.isComplete, true)
})

test('batch recalculation loads the course when enrollment courseId is an unpopulated ObjectId', async () => {
  const courseId = new mongoose.Types.ObjectId('68a000000000000000000020')
  const enrollmentId = new mongoose.Types.ObjectId('68a000000000000000000021')
  const userId = new mongoose.Types.ObjectId('68a000000000000000000022')
  const course = {
    _id: courseId,
    modules: [{ contentItems: [{ _id: ids.video, type: 'video-lesson' }] }],
  }
  const enrollment = {
    _id: enrollmentId,
    userId,
    courseId,
    status: 'active',
    completedLessonIds: [],
  }
  const restores = [
    stub(Course, 'find', (filter) => {
      assert.deepEqual(filter, { _id: { $in: [String(courseId)] } })
      return queryResult([course])
    }),
    stub(QuizAttempt, 'find', () => queryResult([])),
    stub(AssignmentSubmission, 'find', () => queryResult([])),
  ]

  try {
    const [result] = await recalculateEnrollmentsCourseProgress([enrollment])
    assert.equal(result.courseProgress.totalActivities, 1)
    assert.equal(result.courseProgress.completedActivities, 0)
    assert.equal(result.courseProgress.percentage, 0)
  } finally {
    restores.reverse().forEach((restore) => restore())
  }
})
