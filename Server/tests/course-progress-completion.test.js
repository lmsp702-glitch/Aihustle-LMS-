import assert from 'node:assert/strict'
import { test } from 'node:test'
import express from 'express'
import jwt from 'jsonwebtoken'
import mongoose from 'mongoose'

const [
  { config },
  { Student },
  { default: Course },
  { default: Enrollment },
  { default: Progress },
  { default: QuizAttempt },
  { default: AssignmentSubmission },
  { default: Certificate },
  { default: learningRouter },
  { default: adminRouter },
  {
    buildCourseActivitySequence,
    calculateCourseProgress,
    getCourseAllLessons,
    getAllCourseQuizzes,
    getAllCourseAssessments,
    findSequencedQuiz,
    findSequencedAssessment,
  },
] = await Promise.all([
  import('../config/env.js'),
  import('../models/account-models.js'),
  import('../models/Course.js'),
  import('../models/Enrollment.js'),
  import('../models/Progress.js'),
  import('../models/QuizAttempt.js'),
  import('../models/AssignmentSubmission.js'),
  import('../models/Certificate.js'),
  import('../routes/learning.js'),
  import('../routes/admin.js'),
  import('../utils/course-sequencing.js'),
])

function mockRequest(app, { method = 'GET', url = '/', headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const reqHeaders = Object.fromEntries(
      Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])
    )
    if (body && !reqHeaders['content-type']) {
      reqHeaders['content-type'] = 'application/json'
    }

    const req = {
      method,
      url,
      headers: reqHeaders,
      get(name) { return this.headers[name.toLowerCase()] },
      header(name) { return this.headers[name.toLowerCase()] },
      body: body || {},
      _body: Boolean(body),
    }

    const resHeaders = {}
    let statusCode = 200
    let resBody = ''

    const res = {
      statusCode: 200,
      setHeader(k, v) { resHeaders[k.toLowerCase()] = v },
      getHeader(k) { return resHeaders[k.toLowerCase()] },
      status(code) {
        statusCode = code
        this.statusCode = code
        return this
      },
      json(data) {
        resBody = JSON.stringify(data)
        resolve({
          status: statusCode,
          headers: resHeaders,
          json: async () => data,
          text: async () => resBody,
        })
        return this
      },
      send(data) {
        resBody = typeof data === 'string' ? data : JSON.stringify(data)
        resolve({
          status: statusCode,
          headers: resHeaders,
          json: async () => JSON.parse(resBody),
          text: async () => resBody,
        })
        return this
      },
      end(data) {
        if (data) resBody = data.toString()
        resolve({
          status: statusCode,
          headers: resHeaders,
          json: async () => (resBody ? JSON.parse(resBody) : {}),
          text: async () => resBody,
        })
        return this
      },
    }

    try {
      app(req, res, (err) => {
        if (err) reject(err)
        else resolve({ status: 404, headers: {}, json: async () => ({ message: 'Not Found' }) })
      })
    } catch (err) {
      reject(err)
    }
  })
}

test('Complete Course Progress & Completion System Suite', async (t) => {
  // Build a test 8-lesson course
  const courseId = new mongoose.Types.ObjectId()
  const mod1Id = new mongoose.Types.ObjectId()
  const mod2Id = new mongoose.Types.ObjectId()

  const lessonIds = Array.from({ length: 8 }, () => new mongoose.Types.ObjectId())

  const mockCourse = {
    _id: courseId,
    title: 'Fullstack AI Development Masterclass',
    description: '8-video deep dive course',
    status: 'published',
    modules: [
      {
        _id: mod1Id,
        title: 'Module 1: Foundations',
        lessons: [
          { _id: lessonIds[0], title: 'Lesson 1: Architecture', durationSeconds: 600 },
          { _id: lessonIds[1], title: 'Lesson 2: Core Components', durationSeconds: 700 },
          { _id: lessonIds[2], title: 'Lesson 3: State Flow', durationSeconds: 800 },
          { _id: lessonIds[3], title: 'Lesson 4: Routing & Layout', durationSeconds: 900 },
        ],
      },
      {
        _id: mod2Id,
        title: 'Module 2: Advanced Topics',
        lessons: [
          { _id: lessonIds[4], title: 'Lesson 5: Backend APIs', durationSeconds: 1000 },
          { _id: lessonIds[5], title: 'Lesson 6: Database Integration', durationSeconds: 1100 },
          { _id: lessonIds[6], title: 'Lesson 7: Security & Auth', durationSeconds: 1200 },
          { _id: lessonIds[7], title: 'Lesson 8: Production Deployment', durationSeconds: 1300 },
        ],
      },
    ],
    quizzes: [],
    assignments: [],
  }

  await t.test('1. Dynamic sequence builder creates exact rule-based curriculum sequence', () => {
    const sequence = buildCourseActivitySequence(mockCourse)

    // 8 videos -> 4 quizzes (after every 2 videos) + 2 assessments (after every 4 videos) = 14 activities
    assert.equal(sequence.length, 14, 'Total sequenced activities must be exactly 14')

    const expectedTypes = [
      'video-lesson', 'video-lesson', 'quiz',
      'video-lesson', 'video-lesson', 'quiz', 'assessment',
      'video-lesson', 'video-lesson', 'quiz',
      'video-lesson', 'video-lesson', 'quiz', 'assessment',
    ]

    const actualTypes = sequence.map((act) => act.type)
    assert.deepEqual(actualTypes, expectedTypes, 'Activity sequence types must match required cadence')

    // Sequence numbers must be strictly sequential 1..14
    sequence.forEach((act, idx) => {
      assert.equal(act.sequenceNumber, idx + 1, `Activity at index ${idx} must have sequenceNumber ${idx + 1}`)
    })

    // Verify quizzes have valid passing criteria
    const quizzes = sequence.filter((act) => act.type === 'quiz')
    assert.equal(quizzes.length, 4)
    quizzes.forEach((q) => {
      assert.equal(q.passingPercentage, 70, 'Quiz passing percentage default is 70%')
      assert.ok(q.questions?.length > 0, 'Synthesized quiz must contain questions')
    })

    // Verify assessments have passing criteria
    const assessments = sequence.filter((act) => act.type === 'assessment')
    assert.equal(assessments.length, 2)
    assessments.forEach((a) => {
      assert.ok(a.passingCriteria, 'Assessment must contain passing criteria')
    })
  })

  await t.test('2. Watching all 8 videos without completing quizzes/assessments caps progress at 57% and status remains active', () => {
    const progress = calculateCourseProgress({
      course: mockCourse,
      enrollment: {
        completedLessonIds: lessonIds.map(String),
      },
      progress: {
        completedLessons: lessonIds.map((id) => ({ lessonId: id, completedAt: new Date() })),
      },
      quizAttempts: [],
      assignmentSubmissions: [],
    })

    assert.equal(progress.videoStats.completed, 8)
    assert.equal(progress.videoStats.total, 8)
    assert.equal(progress.quizStats.passed, 0)
    assert.equal(progress.quizStats.total, 4)
    assert.equal(progress.assessmentStats.completed, 0)
    assert.equal(progress.assessmentStats.total, 2)

    assert.equal(progress.totalRequiredActivities, 14)
    assert.equal(progress.completedActivities, 8)
    // 8 / 14 = 57%
    assert.equal(progress.progressPercentage, 57)
    assert.equal(progress.isCompleted, false, 'Course MUST NOT be complete if quizzes/assessments are incomplete')
    assert.equal(progress.status, 'active', 'Status must remain active')
    assert.equal(progress.nextActivity.type, 'quiz', 'Next pending activity should be Quiz 1')
  })

  await t.test('3. Failed quiz attempt does not count towards completion; retry with passing score passes quiz', () => {
    const sequence = buildCourseActivitySequence(mockCourse)
    const firstQuiz = sequence.find((a) => a.type === 'quiz')

    // Scenario A: Failed attempt (score 50%, passing 70%)
    const failedAttempt = {
      _id: new mongoose.Types.ObjectId(),
      quizId: firstQuiz.quizId || firstQuiz.id,
      scorePercentage: 50,
      passed: false,
      status: 'submitted',
      submittedAt: new Date(),
    }

    const progAfterFail = calculateCourseProgress({
      course: mockCourse,
      enrollment: { completedLessonIds: [String(lessonIds[0]), String(lessonIds[1])] },
      progress: {
        completedLessons: [
          { lessonId: lessonIds[0], completedAt: new Date() },
          { lessonId: lessonIds[1], completedAt: new Date() },
        ],
      },
      quizAttempts: [failedAttempt],
      assignmentSubmissions: [],
    })

    assert.equal(progAfterFail.quizStats.passed, 0, 'Failed quiz must not increment passed count')
    assert.equal(progAfterFail.completedActivities, 2, 'Completed activities only include the 2 videos')
    // 2 / 14 = 14%
    assert.equal(progAfterFail.progressPercentage, 14)
    assert.equal(progAfterFail.isCompleted, false)

    // Scenario B: Retry attempt with passing score (80%)
    const passedAttempt = {
      _id: new mongoose.Types.ObjectId(),
      quizId: firstQuiz.quizId || firstQuiz.id,
      scorePercentage: 80,
      passed: true,
      status: 'submitted',
      submittedAt: new Date(),
    }

    const progAfterPass = calculateCourseProgress({
      course: mockCourse,
      enrollment: { completedLessonIds: [String(lessonIds[0]), String(lessonIds[1])] },
      progress: {
        completedLessons: [
          { lessonId: lessonIds[0], completedAt: new Date() },
          { lessonId: lessonIds[1], completedAt: new Date() },
        ],
      },
      quizAttempts: [failedAttempt, passedAttempt],
      assignmentSubmissions: [],
    })

    assert.equal(progAfterPass.quizStats.passed, 1, 'Passed quiz must increment passed count')
    assert.equal(progAfterPass.completedActivities, 3, '2 videos + 1 passed quiz = 3 activities')
    // 3 / 14 = 21%
    assert.equal(progAfterPass.progressPercentage, 21)
    assert.equal(progAfterPass.isCompleted, false)
  })

  await t.test('4. All 8 videos + 4 quizzes + 1 assessment yields 93% and course status remains active', () => {
    const sequence = buildCourseActivitySequence(mockCourse)
    const quizzes = sequence.filter((a) => a.type === 'quiz')
    const assessments = sequence.filter((a) => a.type === 'assessment')

    const quizAttempts = quizzes.map((q) => ({
      _id: new mongoose.Types.ObjectId(),
      quizId: q.quizId || q.id,
      scorePercentage: 85,
      passed: true,
      status: 'submitted',
      submittedAt: new Date(),
    }))

    const assignmentSubmissions = [
      {
        _id: new mongoose.Types.ObjectId(),
        assignmentId: assessments[0].assignmentId || assessments[0].id,
        submittedAt: new Date(),
      },
    ]

    const progress = calculateCourseProgress({
      course: mockCourse,
      enrollment: { completedLessonIds: lessonIds.map(String) },
      progress: {
        completedLessons: lessonIds.map((id) => ({ lessonId: id, completedAt: new Date() })),
      },
      quizAttempts,
      assignmentSubmissions,
    })

    assert.equal(progress.videoStats.completed, 8)
    assert.equal(progress.quizStats.passed, 4)
    assert.equal(progress.assessmentStats.completed, 1)
    assert.equal(progress.totalRequiredActivities, 14)
    assert.equal(progress.completedActivities, 13)
    // 13 / 14 = 93%
    assert.equal(progress.progressPercentage, 93)
    assert.equal(progress.isCompleted, false, 'Must not be complete with 1 assessment pending')
    assert.equal(progress.status, 'active')
    assert.equal(progress.nextActivity.type, 'assessment')
    assert.equal(progress.nextActivity.id, assessments[1].id)
  })

  await t.test('5. 100% completion requires all videos, all quizzes passed, and all assessments submitted', () => {
    const sequence = buildCourseActivitySequence(mockCourse)
    const quizzes = sequence.filter((a) => a.type === 'quiz')
    const assessments = sequence.filter((a) => a.type === 'assessment')

    const quizAttempts = quizzes.map((q) => ({
      _id: new mongoose.Types.ObjectId(),
      quizId: q.quizId || q.id,
      scorePercentage: 90,
      passed: true,
      status: 'submitted',
      submittedAt: new Date(),
    }))

    const assignmentSubmissions = assessments.map((a) => ({
      _id: new mongoose.Types.ObjectId(),
      assignmentId: a.assignmentId || a.id,
      submittedAt: new Date(),
    }))

    const progress = calculateCourseProgress({
      course: mockCourse,
      enrollment: { completedLessonIds: lessonIds.map(String) },
      progress: {
        completedLessons: lessonIds.map((id) => ({ lessonId: id, completedAt: new Date() })),
      },
      quizAttempts,
      assignmentSubmissions,
    })

    assert.equal(progress.videoStats.completed, 8)
    assert.equal(progress.quizStats.passed, 4)
    assert.equal(progress.assessmentStats.completed, 2)
    assert.equal(progress.totalRequiredActivities, 14)
    assert.equal(progress.completedActivities, 14)
    assert.equal(progress.progressPercentage, 100)
    assert.equal(progress.isCompleted, true, 'isCompleted must be true when 14/14 satisfied')
    assert.equal(progress.status, 'completed', 'status must be completed')
    assert.equal(progress.nextActivity, null, 'nextActivity should be null when completed')
  })

  await t.test('6. findSequencedQuiz and findSequencedAssessment correctly retrieve derived items', () => {
    const sequence = buildCourseActivitySequence(mockCourse)
    const quizItem = sequence.find((a) => a.type === 'quiz')
    const assessmentItem = sequence.find((a) => a.type === 'assessment')

    const foundQuiz = findSequencedQuiz(mockCourse, quizItem.quizId || quizItem.id)
    assert.ok(foundQuiz, 'Must find derived quiz item')
    assert.equal(String(foundQuiz._id), String(quizItem.quizId || quizItem.id))
    assert.ok(foundQuiz.questions.length > 0)

    const foundAssessment = findSequencedAssessment(mockCourse, assessmentItem.assignmentId || assessmentItem.id)
    assert.ok(foundAssessment, 'Must find derived assessment item')
    assert.equal(String(foundAssessment._id), String(assessmentItem.assignmentId || assessmentItem.id))
  })

  await t.test('7. API integration: GET /learning-content and GET /enrollments/me return unified progress breakdown', async () => {
    const app = express()
    app.use(express.json({ limit: '10mb' }))
    app.use('/api', learningRouter)

    const studentId = new mongoose.Types.ObjectId()
    const enrollmentId = new mongoose.Types.ObjectId()

    const studentUser = {
      _id: studentId,
      fullName: 'Test Student',
      email: 'student@example.com',
      role: 'student',
      accountCollection: 'students',
      studentType: 'independent',
      status: 'active',
      isActive: true,
      approvalStatus: 'approved',
    }

    Student.findById = (id) => ({
      select: () => ({
        lean: async () => studentUser,
      }),
      lean: async () => studentUser,
      then(onFulfilled) {
        return Promise.resolve(studentUser).then(onFulfilled)
      },
    })

    const token = jwt.sign(
      { sub: studentId.toString(), role: 'student', accountCollection: 'students' },
      config.jwtSecret,
      { expiresIn: '1h' },
    )

    const mockEnrollment = {
      _id: enrollmentId,
      userId: studentId,
      courseId: mockCourse,
      status: 'active',
      completedLessonIds: lessonIds.map(String),
      createdAt: new Date(),
      updatedAt: new Date(),
    }

    Course.findById = (id) => ({
      select: () => ({
        lean: async () => mockCourse,
        then(onFulfilled) {
          return Promise.resolve(mockCourse).then(onFulfilled)
        },
      }),
      lean: async () => mockCourse,
      then(onFulfilled) {
        return Promise.resolve(mockCourse).then(onFulfilled)
      },
    })

    Enrollment.findOne = () => ({
      populate: () => ({
        sort: () => ({
          lean: async () => ({ ...mockEnrollment, courseId: mockCourse }),
        }),
        lean: async () => ({ ...mockEnrollment, courseId: mockCourse }),
      }),
      sort: () => ({
        lean: async () => ({ ...mockEnrollment, courseId: mockCourse }),
      }),
      lean: async () => ({ ...mockEnrollment, courseId: mockCourse }),
      then(onFulfilled) {
        return Promise.resolve({ ...mockEnrollment, courseId: mockCourse }).then(onFulfilled)
      },
    })

    Enrollment.find = () => ({
      populate: () => ({
        sort: () => ({
          lean: async () => [{ ...mockEnrollment, courseId: mockCourse }],
        }),
      }),
      lean: async () => [{ ...mockEnrollment, courseId: mockCourse }],
    })

    Progress.findOne = () => ({
      lean: async () => ({
        userId: studentId,
        courseId,
        completedLessons: lessonIds.map((id) => ({ lessonId: id, completedAt: new Date() })),
        progressPercentage: 57,
        status: 'in_progress',
      }),
    })

    Progress.find = () => ({
      lean: async () => [
        {
          userId: studentId,
          courseId,
          completedLessons: lessonIds.map((id) => ({ lessonId: id, completedAt: new Date() })),
          progressPercentage: 57,
          status: 'in_progress',
        },
      ],
    })

    // Submitting GET /api/courses/:courseId/learning-content
    const res = await mockRequest(app, {
      method: 'GET',
      url: `/api/courses/${courseId}/learning-content`,
      headers: { Authorization: `Bearer ${token}` },
    })

    assert.equal(res.status, 200)
    const data = await res.json()
    assert.ok(data.progress, 'Response must include progress breakdown')
    assert.equal(data.progress.videoStats.completed, 8)
    assert.equal(data.progress.videoStats.total, 8)
    assert.equal(data.progress.quizStats.total, 4)
    assert.equal(data.progress.quizStats.passed, 0)
    assert.equal(data.progress.assessmentStats.total, 2)
    assert.equal(data.progress.assessmentStats.completed, 0)
    assert.equal(data.progress.totalRequiredActivities, 14)
    assert.equal(data.progress.completedActivities, 8)
    assert.equal(data.progress.progressPercentage, 57)
    assert.equal(data.progress.isCompleted, false)
    assert.equal(data.progress.status, 'active')
    assert.equal(data.progress.sequence.length, 14)

    // Submitting GET /api/enrollments/me
    const meRes = await mockRequest(app, {
      method: 'GET',
      url: '/api/enrollments/me',
      headers: { Authorization: `Bearer ${token}` },
    })

    assert.equal(meRes.status, 200)
    const meData = await meRes.json()
    assert.ok(Array.isArray(meData.enrollments))
    assert.equal(meData.enrollments.length, 1)
    const enr = meData.enrollments[0]
    assert.ok(enr.progress)
    assert.equal(enr.progress.videoStats.completed, 8)
    assert.equal(enr.progress.progressPercentage, 57)
    assert.equal(enr.status, 'active')
  })

  await t.test('8. GET /api/learning/activities returns centralized quizzes and assignments with statistics and status rules', async () => {
    const app = express()
    app.use(express.json({ limit: '10mb' }))
    app.use('/api', learningRouter)

    const studentId = new mongoose.Types.ObjectId()
    const enrollmentId = new mongoose.Types.ObjectId()

    const studentUser = {
      _id: studentId,
      fullName: 'Activity Student',
      email: 'student.activity@example.com',
      role: 'student',
      accountCollection: 'students',
      studentType: 'independent',
      status: 'active',
      isActive: true,
      approvalStatus: 'approved',
    }

    Student.findById = () => ({
      select: () => ({ lean: async () => studentUser }),
      lean: async () => studentUser,
      then(onFulfilled) { return Promise.resolve(studentUser).then(onFulfilled) },
    })

    const token = jwt.sign(
      { sub: studentId.toString(), role: 'student', accountCollection: 'students' },
      config.jwtSecret,
      { expiresIn: '1h' },
    )

    const sequence = buildCourseActivitySequence(mockCourse)
    const quizzes = sequence.filter((a) => a.type === 'quiz')
    const assessments = sequence.filter((a) => a.type === 'assessment')

    // Quiz 1 is passed
    const passedQuizAttempt = {
      _id: new mongoose.Types.ObjectId(),
      userId: studentId,
      enrollmentId,
      courseId,
      quizId: quizzes[0].quizId || quizzes[0].id,
      status: 'submitted',
      passed: true,
      scorePercentage: 90,
      earnedPoints: 9,
      totalPoints: 10,
      submittedAt: new Date(),
    }

    // Quiz 2 is failed
    const failedQuizAttempt = {
      _id: new mongoose.Types.ObjectId(),
      userId: studentId,
      enrollmentId,
      courseId,
      quizId: quizzes[1].quizId || quizzes[1].id,
      status: 'submitted',
      passed: false,
      scorePercentage: 50,
      earnedPoints: 5,
      totalPoints: 10,
      submittedAt: new Date(),
    }

    // Assessment 1 is submitted
    const assignmentSub = {
      _id: new mongoose.Types.ObjectId(),
      userId: studentId,
      enrollmentId,
      courseId,
      assignmentId: assessments[0].assignmentId || assessments[0].id,
      fileName: 'project1_solution.pdf',
      fileSize: 10240,
      contentType: 'application/pdf',
      status: 'submitted',
      submittedAt: new Date(),
    }

    QuizAttempt.find = () => ({
      select: () => ({
        lean: async () => [passedQuizAttempt, failedQuizAttempt],
      }),
      lean: async () => [passedQuizAttempt, failedQuizAttempt],
    })

    AssignmentSubmission.find = () => ({
      select: () => ({
        lean: async () => [assignmentSub],
      }),
      lean: async () => [assignmentSub],
    })

    const mockEnrollment = {
      _id: enrollmentId,
      userId: studentId,
      courseId: mockCourse,
      status: 'active',
      completedLessonIds: lessonIds.map(String),
      createdAt: new Date(),
      updatedAt: new Date(),
    }

    Enrollment.find = () => ({
      populate: () => ({
        sort: () => ({
          lean: async () => [{ ...mockEnrollment, courseId: mockCourse }],
        }),
      }),
      lean: async () => [{ ...mockEnrollment, courseId: mockCourse }],
    })

    const res = await mockRequest(app, {
      method: 'GET',
      url: '/api/learning/activities',
      headers: { Authorization: `Bearer ${token}` },
    })

    assert.equal(res.status, 200)
    const data = await res.json()

    // 4 quizzes + 2 assessments = 6 total activities
    assert.equal(data.summary.total, 6)
    // 1 quiz passed + 1 assignment submitted = 2 completed
    assert.equal(data.summary.completed, 2)
    // 6 - 2 = 4 remaining
    assert.equal(data.summary.remaining, 4)
    assert.equal(data.summary.overdue, 0)

    // Quiz stats
    assert.equal(data.quizStats.total, 4)
    assert.equal(data.quizStats.completed, 1)
    assert.equal(data.quizStats.remaining, 3)
    assert.equal(data.quizStats.percentage, 25)

    // Assignment stats
    assert.equal(data.assignmentStats.total, 2)
    assert.equal(data.assignmentStats.completed, 1)
    assert.equal(data.assignmentStats.remaining, 1)
    assert.equal(data.assignmentStats.percentage, 50)

    // Verify activities list
    assert.equal(data.activities.length, 6)

    const q1 = data.activities.find((a) => a.id === String(quizzes[0].quizId || quizzes[0].id))
    assert.equal(q1.status, 'completed')
    assert.equal(q1.score, '90%')
    assert.ok(q1.navigationUrl.includes('/learn?activity='))

    const q2 = data.activities.find((a) => a.id === String(quizzes[1].quizId || quizzes[1].id))
    assert.equal(q2.status, 'failed', 'Failed quiz must not be marked completed')
    assert.equal(q2.score, '50%')

    const q3 = data.activities.find((a) => a.id === String(quizzes[2].quizId || quizzes[2].id))
    assert.equal(q3.status, 'pending')

    const a1 = data.activities.find((a) => a.id === String(assessments[0].assignmentId || assessments[0].id))
    assert.equal(a1.status, 'submitted')
    assert.ok(a1.latestSubmission)

    const a2 = data.activities.find((a) => a.id === String(assessments[1].assignmentId || assessments[1].id))
    assert.equal(a2.status, 'pending')
  })

  await t.test('10. GET /api/student/courses/:courseId/details returns course overview, curriculum preview, and enrollment states', async () => {
    const app = express()
    app.use(express.json())
    app.use('/api', learningRouter)

    const studentId = new mongoose.Types.ObjectId()
    const courseId = new mongoose.Types.ObjectId()
    const enrollmentId = new mongoose.Types.ObjectId()

    const studentUser = {
      _id: studentId,
      email: 'student.details@example.com',
      username: 'studentdetails',
      role: 'student',
      studentType: 'independent',
      status: 'active',
      isActive: true,
      approvalStatus: 'approved',
    }

    Student.findById = () => ({
      select: () => ({
        lean: async () => studentUser,
        then(onFulfilled) { return Promise.resolve(studentUser).then(onFulfilled) },
      }),
      lean: async () => studentUser,
      then(onFulfilled) { return Promise.resolve(studentUser).then(onFulfilled) },
    })

    const token = jwt.sign(
      { sub: studentId.toString(), role: 'student', accountCollection: 'students' },
      config.jwtSecret,
      { expiresIn: '1h' },
    )

    const detailedCourse = {
      _id: courseId,
      title: 'Advanced Full Stack Engineering',
      description: 'Master modern full stack development.',
      detailedDescription: 'In-depth modules covering React, Node.js, and MongoDB.',
      category: 'Full Stack Development',
      difficulty: 'intermediate',
      status: 'published',
      estimatedDurationMinutes: 360,
      learningObjectives: ['Build scalable APIs', 'Design responsive UIs'],
      prerequisites: ['Basic JavaScript knowledge'],
      modules: [
        {
          _id: new mongoose.Types.ObjectId(),
          title: 'Module 1: Architecture',
          description: 'System design basics',
          contentItems: [
            {
              _id: new mongoose.Types.ObjectId(),
              type: 'video-lesson',
              title: 'Clean Architecture Lesson',
              durationSeconds: 1200,
            },
          ],
        },
      ],
    }

    Course.findById = () => ({
      populate: () => ({
        lean: async () => detailedCourse,
      }),
      lean: async () => detailedCourse,
    })

    // Sub-case A: Student is NOT enrolled
    Enrollment.findOne = () => ({
      sort: () => Promise.resolve(null),
    })

    const resNotEnrolled = await mockRequest(app, {
      method: 'GET',
      url: `/api/student/courses/${courseId}/details`,
      headers: { Authorization: `Bearer ${token}` },
    })

    assert.equal(resNotEnrolled.status, 200)
    const dataNotEnrolled = await resNotEnrolled.json()
    assert.equal(dataNotEnrolled.isEnrolled, false)
    assert.equal(dataNotEnrolled.enrollment, null)
    assert.equal(dataNotEnrolled.canUnenroll, false)
    assert.equal(dataNotEnrolled.course.title, 'Advanced Full Stack Engineering')
    assert.ok(dataNotEnrolled.curriculum.length > 0)
    assert.equal(dataNotEnrolled.curriculum[0].items[0].isCompleted, false)

    // Sub-case B: Student IS enrolled (active, in progress)
    const activeEnrollment = {
      _id: enrollmentId,
      userId: studentId,
      courseId,
      status: 'active',
      completedLessonIds: [],
      createdAt: new Date(),
      save: async () => activeEnrollment,
    }

    Enrollment.findOne = () => ({
      sort: () => Promise.resolve(activeEnrollment),
    })

    QuizAttempt.find = () => ({
      select: () => ({ lean: async () => [] }),
      lean: async () => [],
    })
    AssignmentSubmission.find = () => ({
      select: () => ({ lean: async () => [] }),
      lean: async () => [],
    })
    Progress.findOne = () => ({
      lean: async () => null,
    })

    const resEnrolled = await mockRequest(app, {
      method: 'GET',
      url: `/api/student/courses/${courseId}/details`,
      headers: { Authorization: `Bearer ${token}` },
    })

    assert.equal(resEnrolled.status, 200)
    const dataEnrolled = await resEnrolled.json()
    assert.equal(dataEnrolled.isEnrolled, true)
    assert.ok(dataEnrolled.enrollment)
    assert.equal(dataEnrolled.canUnenroll, true, 'Incomplete course can be unenrolled')
    assert.equal(dataEnrolled.progress.isCompleted, false)

    // Sub-case C: Student IS enrolled (completed) -> canUnenroll MUST be false
    const completedEnrollment = {
      _id: enrollmentId,
      userId: studentId,
      courseId,
      status: 'completed',
      completedLessonIds: [detailedCourse.modules[0].contentItems[0]._id],
      createdAt: new Date(),
      completedAt: new Date(),
      save: async () => completedEnrollment,
    }

    Enrollment.findOne = () => ({
      sort: () => Promise.resolve(completedEnrollment),
    })

    Progress.findOne = () => ({
      lean: async () => ({
        userId: studentId,
        courseId,
        completedLessons: [{ moduleId: detailedCourse.modules[0]._id, lessonId: detailedCourse.modules[0].contentItems[0]._id }],
        quizSubmissions: [],
        progressPercentage: 100,
        status: 'completed',
      }),
    })

    Certificate.findOne = () => ({
      lean: async () => ({
        certificateId: 'AH-2026-TEST1234',
        studentName: 'Student Details',
        courseTitle: detailedCourse.title,
        status: 'issued',
      }),
    })

    const resCompleted = await mockRequest(app, {
      method: 'GET',
      url: `/api/courses/${courseId}/details`,
      headers: { Authorization: `Bearer ${token}` },
    })

    assert.equal(resCompleted.status, 200)
    const dataCompleted = await resCompleted.json()
    assert.equal(dataCompleted.isEnrolled, true)
    assert.equal(dataCompleted.canUnenroll, false, 'Unenroll must be completely disabled for completed courses')
    assert.ok(dataCompleted.certificate, 'Certificate must be returned for completed course')

    // Test with specific target course ID: 6af41d144ad96cf02e2b769b
    const targetCourseId = '6af41d144ad96cf02e2b769b'
    const targetCourse = { ...detailedCourse, _id: new mongoose.Types.ObjectId(targetCourseId), title: 'Digital Marketing' }
    Course.findById = (id) => {
      const match = String(id) === targetCourseId ? targetCourse : detailedCourse
      return {
        populate: () => ({ lean: async () => match }),
        lean: async () => match,
      }
    }

    const resTarget = await mockRequest(app, {
      method: 'GET',
      url: `/api/courses/${targetCourseId}/details`,
      headers: { Authorization: `Bearer ${token}` },
    })
    assert.equal(resTarget.status, 200)
    const dataTarget = await resTarget.json()
    assert.equal(dataTarget.course.title, 'Digital Marketing')

    // Also test alias route /api/courses/:courseId
    const resAlias = await mockRequest(app, {
      method: 'GET',
      url: `/api/courses/${targetCourseId}`,
      headers: { Authorization: `Bearer ${token}` },
    })
    assert.equal(resAlias.status, 200)

    // Genuine missing course returns 404
    Course.findById = () => ({
      populate: () => ({ lean: async () => null }),
      lean: async () => null,
    })
    const resNotFound = await mockRequest(app, {
      method: 'GET',
      url: `/api/courses/${new mongoose.Types.ObjectId()}/details`,
      headers: { Authorization: `Bearer ${token}` },
    })
    assert.equal(resNotFound.status, 404)
  })

  await t.test('11. POST /api/student/courses/:courseId/unenroll handles active and prevents completed unenrollment', async () => {
    const app = express()
    app.use(express.json())
    app.use('/api', learningRouter)

    const studentId = new mongoose.Types.ObjectId()
    const courseId = new mongoose.Types.ObjectId()
    const enrollmentId = new mongoose.Types.ObjectId()

    const studentUser = {
      _id: studentId,
      email: 'student.unenroll@example.com',
      username: 'studentunenroll',
      role: 'student',
      studentType: 'independent',
      status: 'active',
      isActive: true,
      approvalStatus: 'approved',
    }

    Student.findById = () => ({
      select: () => ({
        lean: async () => studentUser,
        then(onFulfilled) { return Promise.resolve(studentUser).then(onFulfilled) },
      }),
      lean: async () => studentUser,
      then(onFulfilled) { return Promise.resolve(studentUser).then(onFulfilled) },
    })

    const token = jwt.sign(
      { sub: studentId.toString(), role: 'student', accountCollection: 'students' },
      config.jwtSecret,
      { expiresIn: '1h' },
    )

    // Case A: Unenrolling active course succeeds
    let savedStatus = 'active'
    const activeEnrollment = {
      _id: enrollmentId,
      userId: studentId,
      courseId,
      status: 'active',
      save: async function () { savedStatus = this.status },
    }

    Enrollment.findOne = () => Promise.resolve(activeEnrollment)
    Course.findById = () => ({
      lean: async () => null,
    })

    const resActive = await mockRequest(app, {
      method: 'POST',
      url: `/api/student/courses/${courseId}/unenroll`,
      headers: { Authorization: `Bearer ${token}` },
    })

    assert.equal(resActive.status, 200)
    assert.equal(savedStatus, 'cancelled')

    // Case B: Completed course cannot be unenrolled
    const completedEnrollment = {
      _id: enrollmentId,
      userId: studentId,
      courseId,
      status: 'completed',
      save: async function () {},
    }

    Enrollment.findOne = () => Promise.resolve(completedEnrollment)

    const resCompleted = await mockRequest(app, {
      method: 'POST',
      url: `/api/student/courses/${courseId}/unenroll`,
      headers: { Authorization: `Bearer ${token}` },
    })

    assert.equal(resCompleted.status, 400)
    const errData = await resCompleted.json()
    assert.match(errData.message, /Completed courses cannot be unenrolled/i)
  })

  await t.test('12. Certificate generation: blocked for incomplete course, issued with unique ID upon verified completion', async () => {
    const app = express()
    app.use(express.json())
    app.use('/api', learningRouter)

    const studentId = new mongoose.Types.ObjectId()
    const courseId = new mongoose.Types.ObjectId()
    const enrollmentId = new mongoose.Types.ObjectId()
    const lessonId = new mongoose.Types.ObjectId()

    const studentUser = {
      _id: studentId,
      email: 'student.cert@example.com',
      username: 'studentcert',
      fullName: 'John Certificate Earner',
      role: 'student',
      studentType: 'independent',
      status: 'active',
      isActive: true,
      approvalStatus: 'approved',
    }

    Student.findById = () => ({
      select: () => ({
        lean: async () => studentUser,
        then(onFulfilled) { return Promise.resolve(studentUser).then(onFulfilled) },
      }),
      lean: async () => studentUser,
      then(onFulfilled) { return Promise.resolve(studentUser).then(onFulfilled) },
    })

    const token = jwt.sign(
      { sub: studentId.toString(), role: 'student', accountCollection: 'students' },
      config.jwtSecret,
      { expiresIn: '1h' },
    )

    const oneLessonCourse = {
      _id: courseId,
      title: 'Quick Milestone Course',
      category: 'Specialization',
      status: 'published',
      modules: [
        {
          _id: new mongoose.Types.ObjectId(),
          title: 'Module 1',
          contentItems: [
            {
              _id: lessonId,
              type: 'video-lesson',
              title: 'Only Lesson',
              durationSeconds: 600,
            },
          ],
        },
      ],
    }

    Course.findById = () => ({
      populate: () => ({
        lean: async () => oneLessonCourse,
      }),
      lean: async () => oneLessonCourse,
    })

    // Case A: Incomplete course rejects certificate with 403
    const incompleteEnrollment = {
      _id: enrollmentId,
      userId: studentId,
      courseId,
      status: 'active',
      completedLessonIds: [], // 0 lessons watched
      save: async () => {},
    }

    Enrollment.findOne = () => Promise.resolve(incompleteEnrollment)
    QuizAttempt.find = () => ({ select: () => ({ lean: async () => [] }), lean: async () => [] })
    AssignmentSubmission.find = () => ({ select: () => ({ lean: async () => [] }), lean: async () => [] })
    Progress.findOne = () => ({ lean: async () => null })

    const resIncomplete = await mockRequest(app, {
      method: 'GET',
      url: `/api/student/courses/${courseId}/certificate`,
      headers: { Authorization: `Bearer ${token}` },
    })

    assert.equal(resIncomplete.status, 403)
    const incompleteData = await resIncomplete.json()
    assert.match(incompleteData.message, /only available upon successful completion/i)

    // Case B: 100% completed course issues certificate with unique ID
    const completeEnrollment = {
      _id: enrollmentId,
      userId: studentId,
      courseId,
      status: 'completed',
      completedLessonIds: [lessonId.toString()],
      save: async () => {},
    }

    Enrollment.findOne = () => Promise.resolve(completeEnrollment)
    Certificate.findOne = () => ({
      lean: async () => ({
        certificateId: 'AH-2026-TESTCERT',
        userId: studentId,
        courseId,
        studentName: 'John Certificate Earner',
        courseTitle: 'Quick Milestone Course',
        status: 'issued',
      }),
    })
    Certificate.create = async (docs) => docs.map((d) => ({ ...d, toObject: () => d }))

    const resComplete = await mockRequest(app, {
      method: 'GET',
      url: `/api/student/courses/${courseId}/certificate`,
      headers: { Authorization: `Bearer ${token}` },
    })

    assert.equal(resComplete.status, 200)
    const certData = await resComplete.json()
    assert.ok(certData.certificate)
    assert.ok(certData.certificate.certificateId.startsWith('AH-'))
    assert.equal(certData.certificate.studentName, 'John Certificate Earner')
    assert.equal(certData.certificate.courseTitle, 'Quick Milestone Course')
  })
})
