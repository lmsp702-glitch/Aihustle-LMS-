import assert from 'node:assert/strict'
import { test } from 'node:test'
import mongoose from 'mongoose'
import Course from '../models/Course.js'
import Enrollment from '../models/Enrollment.js'
import {
  calculateCourseActivityProgress,
  calculateCourseProgress,
  recalculateEnrollmentsCourseProgress,
  summarizeCourseProgress,
} from '../utils/course-progress.js'
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

test('activity progress uses each course structure and counts only latest approved work once', () => {
  const videoIds = Array.from({ length: 8 }, () => new mongoose.Types.ObjectId().toString())
  const quizIds = Array.from({ length: 2 }, () => new mongoose.Types.ObjectId().toString())
  const assignmentIds = Array.from({ length: 2 }, () => new mongoose.Types.ObjectId().toString())
  const course = {
    modules: [{
      contentItems: [
        ...videoIds.map((_id, index) => ({
          _id,
          type: 'video-lesson',
          ...(index === 7 ? { requiredForCertificate: false } : {}),
        })),
        ...quizIds.map((_id) => ({ _id, type: 'quiz' })),
        ...assignmentIds.map((_id) => ({ _id, type: 'assignment' })),
      ],
    }],
    quizzes: [{ _id: quizIds[0] }],
    assignments: [{ _id: assignmentIds[0] }],
  }
  const progress = calculateCourseActivityProgress(
    course,
    { completedLessonIds: [...videoIds.slice(0, 6), videoIds[0]] },
    [
      { quizId: quizIds[0], status: 'submitted', passed: false },
      { quizId: quizIds[0], status: 'submitted', passed: true },
      { quizId: quizIds[0], status: 'submitted', passed: true },
      { quizId: quizIds[1], status: 'submitted', passed: false },
    ],
    [
      {
        assignmentId: assignmentIds[0],
        reviewStatus: 'approved',
        submittedAt: new Date('2026-01-02T00:00:00Z'),
      },
      {
        assignmentId: assignmentIds[0],
        reviewStatus: 'pending',
        submittedAt: new Date('2026-01-01T00:00:00Z'),
      },
      {
        assignmentId: assignmentIds[1],
        reviewStatus: 'pending',
        submittedAt: new Date('2026-01-03T00:00:00Z'),
      },
    ],
  )

  assert.deepEqual(progress, {
    completedActivities: 8,
    totalActivities: 11,
    percentage: 72,
    isComplete: false,
    videos: { completed: 6, total: 7 },
    quizzes: { completed: 1, total: 2 },
    assignments: { completed: 1, total: 2 },
  })

  const otherCourse = {
    modules: [{
      contentItems: [
        { _id: '68a000000000000000000101', type: 'video-lesson' },
        { _id: '68a000000000000000000102', type: 'quiz' },
        { _id: '68a000000000000000000103', type: 'quiz' },
        { _id: '68a000000000000000000104', type: 'quiz' },
      ],
    }],
  }
  const otherProgress = calculateCourseActivityProgress(otherCourse, {
    completedLessonIds: ['68a000000000000000000101'],
  }, [
    { quizId: '68a000000000000000000102', status: 'submitted', passed: false },
  ])
  assert.equal(otherProgress.totalActivities, 4)
  assert.equal(otherProgress.completedActivities, 1)
  assert.equal(otherProgress.percentage, 25)
})

test('activity progress counts videos, passed quizzes, and approved assignments only', () => {
  const videoIds = ['video-1', 'video-2', 'video-3']
  const quizId = 'quiz'
  const assignmentId = 'assignment'
  const course = {
    modules: [{
      contentItems: [
        ...videoIds.map((_id) => ({ _id, type: 'video-lesson' })),
        { _id: quizId, type: 'quiz' },
        { _id: assignmentId, type: 'assignment' },
      ],
    }],
  }
  const enrollment = { completedLessonIds: videoIds }
  const failedAttempts = [{ quizId, status: 'submitted', passed: false }]
  const pendingSubmission = [{ assignmentId, reviewStatus: 'pending', submittedAt: new Date('2026-01-01T00:00:00Z') }]
  const pendingProgress = calculateCourseActivityProgress(course, enrollment, failedAttempts, pendingSubmission)
  assert.equal(pendingProgress.completedActivities, 3)
  assert.equal(pendingProgress.totalActivities, 5)
  assert.equal(pendingProgress.percentage, 60)

  const passedProgress = calculateCourseActivityProgress(course, enrollment, [
    ...failedAttempts,
    { quizId, status: 'submitted', passed: true },
    { quizId, status: 'submitted', passed: true },
  ], pendingSubmission)
  assert.equal(passedProgress.completedActivities, 4)
  assert.equal(passedProgress.percentage, 80)

  const approvedProgress = calculateCourseActivityProgress(course, enrollment, [
    ...failedAttempts,
    { quizId, status: 'submitted', passed: true },
    { quizId, status: 'submitted', passed: true },
  ], [
    ...pendingSubmission,
    { assignmentId, reviewStatus: 'approved', submittedAt: new Date('2026-01-02T00:00:00Z') },
  ])
  assert.equal(approvedProgress.completedActivities, 5)
  assert.equal(approvedProgress.percentage, 100)
  assert.equal(approvedProgress.isComplete, true)
})

test('activity progress keeps a submitted assignment incomplete until its latest submission is approved', () => {
  const course = {
    modules: [{
      contentItems: [{ _id: ids.assignment, type: 'assignment' }],
    }],
  }
  const enrollment = { completedLessonIds: [] }
  const pendingSubmission = {
    assignmentId: ids.assignment,
    reviewStatus: 'pending',
    submittedAt: new Date('2026-01-01T00:00:00Z'),
  }
  const pendingProgress = calculateCourseActivityProgress(course, enrollment, [], [pendingSubmission])

  assert.equal(pendingProgress.completedActivities, 0)
  assert.equal(pendingProgress.percentage, 0)
  assert.equal(pendingProgress.isComplete, false)

  const approvedProgress = calculateCourseActivityProgress(course, enrollment, [], [
    { ...pendingSubmission, reviewStatus: 'approved', submittedAt: new Date('2026-01-02T00:00:00Z') },
  ])
  assert.equal(approvedProgress.completedActivities, 1)
  assert.equal(approvedProgress.percentage, 100)
  assert.equal(approvedProgress.isComplete, true)
})

test('activity progress for a course without videos, quizzes, or assignments is zero', () => {
  const progress = calculateCourseActivityProgress(
    { modules: [{ contentItems: [{ type: 'note', title: 'Notes' }] }] },
    { completedLessonIds: [] },
  )

  assert.deepEqual(progress, {
    completedActivities: 0,
    totalActivities: 0,
    percentage: 0,
    isComplete: false,
    videos: { completed: 0, total: 0 },
    quizzes: { completed: 0, total: 0 },
    assignments: { completed: 0, total: 0 },
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

test('course completion summary counts eligible enrollments once and excludes invalid records', () => {
  const completedVideoId = '68a000000000000000000201'
  const inProgressVideoIds = ['68a000000000000000000202', '68a000000000000000000203']
  const notStartedVideoId = '68a000000000000000000204'
  const videoCourse = (videoIds) => ({
    modules: [{
      contentItems: videoIds.map((_id) => ({ _id, type: 'video-lesson' })),
    }],
  })
  const enrollment = (overrides) => ({
    _id: new mongoose.Types.ObjectId(),
    userId: new mongoose.Types.ObjectId(),
    courseId: new mongoose.Types.ObjectId(),
    status: 'active',
    studentType: 'independent',
    studentStatus: 'active',
    studentIsActive: true,
    courseStatus: 'published',
    completedLessonIds: [],
    ...overrides,
  })
  const enrollments = [
    enrollment({
      status: 'completed',
      completedLessonIds: [completedVideoId],
      course: videoCourse([completedVideoId]),
    }),
    enrollment({
      completedLessonIds: [inProgressVideoIds[0]],
      course: videoCourse(inProgressVideoIds),
    }),
    enrollment({
      course: videoCourse([notStartedVideoId]),
    }),
    enrollment({
      status: 'cancelled',
      course: videoCourse([notStartedVideoId]),
    }),
    enrollment({
      studentStatus: 'deleted',
      studentIsActive: false,
      course: videoCourse([notStartedVideoId]),
    }),
    enrollment({
      studentStatus: 'pending',
      course: videoCourse([notStartedVideoId]),
    }),
    enrollment({
      courseStatus: 'archived',
      course: videoCourse([notStartedVideoId]),
    }),
    enrollment({
      course: null,
    }),
  ]

  const summary = summarizeCourseProgress(enrollments)
  assert.deepEqual(summary, {
    completed: 1,
    inProgress: 1,
    notStarted: 1,
    totalEnrollments: 3,
    completedActivities: 2,
    inProgressActivities: 1,
    notStartedActivities: 1,
    totalActivities: 4,
    enrolledStudents: 3,
  })
  assert.equal(summary.completed + summary.inProgress + summary.notStarted, summary.totalEnrollments)
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
