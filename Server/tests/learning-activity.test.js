import assert from 'node:assert/strict'
import { test } from 'node:test'
import express from 'express'
import jwt from 'jsonwebtoken'
import mongoose from 'mongoose'

const [
  { config },
  { Student, CollegeStudent },
  { default: Course },
  { default: Enrollment },
  { default: Progress },
  { default: LearningActivity },
  { default: learningRouter },
] = await Promise.all([
  import('../config/env.js'),
  import('../models/account-models.js'),
  import('../models/Course.js'),
  import('../models/Enrollment.js'),
  import('../models/Progress.js'),
  import('../models/LearningActivity.js'),
  import('../routes/learning.js'),
])

const app = express()
app.use(express.json({ limit: '10mb' }))
app.use('/api', learningRouter)

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
      get(name) {
        return this.headers[name.toLowerCase()]
      },
      header(name) {
        return this.headers[name.toLowerCase()]
      },
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
    } catch (e) {
      reject(e)
    }
  })
}

test('Daily & Weekly Learning Activity and Progress Tracking System', async (t) => {
  // Test 1: Models & Schema structure
  await t.test('1. LearningActivity schema structure and default properties', () => {
    const activity = new LearningActivity({
      studentId: new mongoose.Types.ObjectId(),
      courseId: new mongoose.Types.ObjectId(),
      sessionId: 'sess-12345',
      date: '2026-11-09',
    })
    const validationError = activity.validateSync()
    assert.equal(validationError, undefined, 'Valid LearningActivity should pass validation')
    assert.equal(activity.durationSeconds, 0, 'Initial durationSeconds must be 0')
    assert.equal(activity.activityType, 'lesson_reading', 'Default activityType must be lesson_reading')
    assert.equal(activity.completed, false, 'Initial completed must be false')
  })

  await t.test('2. Progress model supports independent students with optional collegeId', () => {
    const prog = new Progress({
      userId: new mongoose.Types.ObjectId(),
      courseId: new mongoose.Types.ObjectId(),
      collegeId: null, // Nullable for independent students
    })
    const validationError = prog.validateSync()
    assert.equal(validationError, undefined, 'Progress with null collegeId should be valid')
    assert.equal(prog.status, 'in_progress')
    assert.equal(prog.progressPercentage, 0)
  })

  await t.test('3. Student and CollegeStudent models contain dailyLearningGoalMinutes', () => {
    const indStudent = new Student({
      username: 'student_' + Date.now(),
      email: `student_${Date.now()}@example.com`,
    })
    assert.equal(indStudent.dailyLearningGoalMinutes, 60, 'Default daily goal must be 60')

    const clgStudent = new CollegeStudent({
      username: 'clg_' + Date.now(),
      email: `clg_${Date.now()}@example.com`,
      collegeId: new mongoose.Types.ObjectId(),
    })
    assert.equal(clgStudent.dailyLearningGoalMinutes, 60, 'Default college student goal must be 60')
  })

  // Test 4-10: Endpoints with In-Memory Mock Store
  const studentId = new mongoose.Types.ObjectId()
  const studentUser = {
    _id: studentId,
    role: 'student',
    status: 'active',
    isActive: true,
    fullName: 'John Learner',
    username: 'john_learner',
    email: 'john@learning.org',
    studentType: 'independent',
    dailyLearningGoalMinutes: 60,
  }

  // Stubs for Auth
  Student.findById = (id) => ({
    select: (fields) => ({
      lean: async () => (String(id) === String(studentId) ? studentUser : null),
    }),
    then(onFulfilled) {
      return Promise.resolve(String(id) === String(studentId) ? studentUser : null).then(onFulfilled)
    },
  })

  Student.findByIdAndUpdate = async (id, update) => {
    if (String(id) === String(studentId)) {
      Object.assign(studentUser, update)
      return studentUser
    }
    return null
  }

  const token = jwt.sign(
    { sub: studentId.toString(), role: 'student', accountCollection: 'students' },
    config.jwtSecret,
    { expiresIn: '1h' },
  )

  const courseId = new mongoose.Types.ObjectId()
  const moduleId = new mongoose.Types.ObjectId()
  const lesson1Id = new mongoose.Types.ObjectId()
  const lesson2Id = new mongoose.Types.ObjectId()

  const mockCourse = {
    _id: courseId,
    title: 'React & Node.js Mastery',
    description: 'Complete hands-on curriculum',
    status: 'published',
    modules: [
      {
        _id: moduleId,
        title: 'Module 1: Components',
        lessons: [
          { _id: lesson1Id, title: 'Lesson 1: Intro to Components', content: 'Understanding JSX' },
          {
            _id: lesson2Id,
            title: 'Lesson 2: Props & State',
            content: 'Managing state',
            videoUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
          },
        ],
      },
    ],
  }

  Course.findById = (id) => ({
    select: (fields) => ({
      lean: async () => (String(id) === String(courseId) ? mockCourse : null),
    }),
    then(onFulfilled) {
      return Promise.resolve(String(id) === String(courseId) ? mockCourse : null).then(onFulfilled)
    },
  })

  // In-memory data collections
  let enrollments = []
  let learningActivities = []
  let progresses = []

  Enrollment.findOne = (query) => ({
    select: (fields) => ({
      lean: async () =>
        enrollments.find(
          (e) => String(e.userId) === String(query.userId) && String(e.courseId) === String(query.courseId),
        ) || null,
    }),
    lean: async () =>
      enrollments.find(
        (e) => String(e.userId) === String(query.userId) && String(e.courseId) === String(query.courseId),
      ) || null,
  })

  Enrollment.find = (query) => ({
    populate: () => ({
      sort: () => ({
        lean: async () =>
          enrollments
            .filter((e) => String(e.userId) === String(query.userId))
            .map((e) => ({ ...e, courseId: mockCourse })),
      }),
    }),
  })

  LearningActivity.create = async (doc) => {
    const created = {
      _id: new mongoose.Types.ObjectId(),
      ...doc,
      save: async function () {
        return this
      },
    }
    learningActivities.push(created)
    return created
  }

  LearningActivity.findOne = async (query) => {
    const act = learningActivities.find((a) => {
      if (query.sessionId && a.sessionId !== query.sessionId) return false
      if (query.studentId && String(a.studentId) !== String(query.studentId)) return false
      if (query.lessonId && String(a.lessonId) !== String(query.lessonId)) return false
      if (query.date && a.date !== query.date) return false
      return true
    })
    return act || null
  }

  LearningActivity.find = (query) => ({
    lean: async () =>
      learningActivities.filter((a) => {
        if (query.studentId && String(a.studentId) !== String(query.studentId)) return false
        if (query.date) {
          if (typeof query.date === 'string' && a.date !== query.date) return false
          if (query.date.$gte && (a.date < query.date.$gte || a.date > query.date.$lte)) return false
        }
        return true
      }),
  })

  LearningActivity.updateMany = async (query, update) => {
    for (const a of learningActivities) {
      if (query.studentId && String(a.studentId) !== String(query.studentId)) continue
      if (query.endedAt === null && a.endedAt !== null) continue
      Object.assign(a, update.$set)
    }
    return { acknowledged: true }
  }

  LearningActivity.aggregate = async (pipeline) => {
    let totalSeconds = 0
    const distinctDates = new Set()
    for (const a of learningActivities) {
      totalSeconds += a.durationSeconds || 0
      if (a.date) distinctDates.add(a.date)
    }
    return [
      {
        totalSeconds,
        distinctDates: Array.from(distinctDates),
      },
    ]
  }

  Progress.findOne = async (query) => {
    const p = progresses.find(
      (prog) => String(prog.userId) === String(query.userId) && String(prog.courseId) === String(query.courseId),
    )
    return p || null
  }

  Progress.prototype.save = async function () {
    const existingIdx = progresses.findIndex(
      (p) => String(p.userId) === String(this.userId) && String(p.courseId) === String(this.courseId),
    )
    if (existingIdx >= 0) {
      progresses[existingIdx] = this
    } else {
      progresses.push(this)
    }
    return this
  }

  LearningActivity.prototype.save = async function () {
    const existingIdx = learningActivities.findIndex(
      (a) => a.sessionId === this.sessionId,
    )
    if (existingIdx >= 0) {
      learningActivities[existingIdx] = this
    } else {
      learningActivities.push(this)
    }
    return this
  }

  Progress.find = () => ({
    lean: async () => progresses,
  })

  Progress.updateOne = async (query, update) => {
    const p = progresses.find(
      (prog) => String(prog.userId) === String(query.userId) && String(prog.courseId) === String(query.courseId),
    )
    if (p && update.$set) {
      Object.assign(p, update.$set)
    }
    return { acknowledged: true }
  }

  await t.test('4. Session start rejects un-enrolled students (403)', async () => {
    const res = await mockRequest(app, {
      method: 'POST',
      url: '/api/learning/session/start',
      headers: { Authorization: `Bearer ${token}` },
      body: {
        courseId: String(courseId),
        moduleId: String(moduleId),
        lessonId: String(lesson1Id),
      },
    })
    assert.equal(res.status, 403)
    const data = await res.json()
    assert.match(data.message, /not enrolled/i)
  })

  // Enroll student
  enrollments.push({
    userId: studentId,
    courseId: courseId,
    status: 'active',
  })

  let activeSessionId = null

  await t.test('5. Session start succeeds when student is enrolled (201)', async () => {
    const res = await mockRequest(app, {
      method: 'POST',
      url: '/api/learning/session/start',
      headers: { Authorization: `Bearer ${token}` },
      body: {
        courseId: String(courseId),
        moduleId: String(moduleId),
        lessonId: String(lesson1Id),
        activityType: 'lesson_reading',
        timezone: 'UTC',
      },
    })
    assert.equal(res.status, 201)
    const data = await res.json()
    assert.ok(data.sessionId)
    activeSessionId = data.sessionId
    assert.equal(learningActivities.length, 1)
  })

  await t.test('6. Session heartbeat safely increments time and caps runaway deltas to 30s', async () => {
    // Normal 15s pulse
    const res1 = await mockRequest(app, {
      method: 'POST',
      url: '/api/learning/session/heartbeat',
      headers: { Authorization: `Bearer ${token}` },
      body: {
        sessionId: activeSessionId,
        durationDelta: 15,
      },
    })
    assert.equal(res1.status, 200)
    assert.equal((await res1.json()).durationSeconds, 15)

    // Runaway delta (e.g. 600s background) must be capped to 30s
    const res2 = await mockRequest(app, {
      method: 'POST',
      url: '/api/learning/session/heartbeat',
      headers: { Authorization: `Bearer ${token}` },
      body: {
        sessionId: activeSessionId,
        durationDelta: 600,
      },
    })
    assert.equal(res2.status, 200)
    // 15 + capped 30 = 45s
    assert.equal((await res2.json()).durationSeconds, 45)
  })

  await t.test('7. Session end marks endedAt and adds safe remaining delta', async () => {
    const res = await mockRequest(app, {
      method: 'POST',
      url: '/api/learning/session/end',
      headers: { Authorization: `Bearer ${token}` },
      body: {
        sessionId: activeSessionId,
        durationDelta: 10,
      },
    })
    assert.equal(res.status, 200)
    const data = await res.json()
    assert.equal(data.totalDurationSeconds, 55)

    const session = learningActivities.find((a) => a.sessionId === activeSessionId)
    assert.ok(session.endedAt)
  })

  await t.test('8. Lesson completion tracks progress and computes accurate percentages', async () => {
    // Complete Lesson 1 (1 of 2 = 50%)
    const res1 = await mockRequest(app, {
      method: 'POST',
      url: '/api/learning/lessons/complete',
      headers: { Authorization: `Bearer ${token}` },
      body: {
        courseId: String(courseId),
        moduleId: String(moduleId),
        lessonId: String(lesson1Id),
        completed: true,
        timezone: 'UTC',
      },
    })
    assert.equal(res1.status, 200)
    const data1 = await res1.json()
    assert.equal(data1.progressPercentage, 50)
    assert.equal(data1.status, 'in_progress')

    // Find progress doc created
    const progressDoc = progresses.find((p) => String(p.courseId) === String(courseId))
    assert.ok(progressDoc)
    assert.equal(progressDoc.completedLessons.length, 1)

    // Complete Lesson 2 (2 of 2 = 100%)
    const res2 = await mockRequest(app, {
      method: 'POST',
      url: '/api/learning/lessons/complete',
      headers: { Authorization: `Bearer ${token}` },
      body: {
        courseId: String(courseId),
        moduleId: String(moduleId),
        lessonId: String(lesson2Id),
        completed: true,
        timezone: 'UTC',
      },
    })
    assert.equal(res2.status, 200)
    const data2 = await res2.json()
    assert.equal(data2.progressPercentage, 100)
    assert.equal(data2.status, 'completed')

    // Toggle Lesson 2 back to incomplete (1 of 2 = 50%)
    const res3 = await mockRequest(app, {
      method: 'POST',
      url: '/api/learning/lessons/complete',
      headers: { Authorization: `Bearer ${token}` },
      body: {
        courseId: String(courseId),
        moduleId: String(moduleId),
        lessonId: String(lesson2Id),
        completed: false,
        timezone: 'UTC',
      },
    })
    assert.equal(res3.status, 200)
    const data3 = await res3.json()
    assert.equal(data3.progressPercentage, 50)
    assert.equal(data3.status, 'in_progress')
  })

  await t.test('9. Daily summary returns accurate today metrics and goal progress', async () => {
    const res = await mockRequest(app, {
      method: 'GET',
      url: '/api/learning/summary/today?timezone=UTC',
      headers: { Authorization: `Bearer ${token}` },
    })
    assert.equal(res.status, 200)
    const data = await res.json()
    assert.ok(data.today)
    assert.equal(typeof data.totalMinutes, 'number')
    assert.ok(data.lessonsCompleted >= 1)
    assert.equal(data.dailyLearningGoalMinutes, 60)
  })

  await t.test('10. Weekly activity chart provides 7-day Monday-Sunday aggregation', async () => {
    const res = await mockRequest(app, {
      method: 'GET',
      url: '/api/learning/activity/weekly?weekOffset=0&timezone=UTC',
      headers: { Authorization: `Bearer ${token}` },
    })
    assert.equal(res.status, 200)
    const data = await res.json()
    assert.equal(data.days.length, 7, 'Weekly chart must return 7 days')
    assert.equal(data.days[0].dayName, 'Mon', 'Chart begins on Monday')
    assert.equal(data.days[6].dayName, 'Sun', 'Chart ends on Sunday')
    assert.equal(typeof data.totalWeeklyMinutes, 'number')
    assert.equal(typeof data.averageDailyMinutes, 'number')
  })

  await t.test('11. Daily goal update updates account and enforces valid range (15-480)', async () => {
    // Under 15 rejects
    const resLow = await mockRequest(app, {
      method: 'PUT',
      url: '/api/learning/goal',
      headers: { Authorization: `Bearer ${token}` },
      body: { dailyLearningGoalMinutes: 10 },
    })
    assert.equal(resLow.status, 400)

    // Over 480 rejects
    const resHigh = await mockRequest(app, {
      method: 'PUT',
      url: '/api/learning/goal',
      headers: { Authorization: `Bearer ${token}` },
      body: { dailyLearningGoalMinutes: 600 },
    })
    assert.equal(resHigh.status, 400)

    // Valid 90 mins succeeds
    const resValid = await mockRequest(app, {
      method: 'PUT',
      url: '/api/learning/goal',
      headers: { Authorization: `Bearer ${token}` },
      body: { dailyLearningGoalMinutes: 90 },
    })
    assert.equal(resValid.status, 200)
    assert.equal((await resValid.json()).dailyLearningGoalMinutes, 90)
    assert.equal(studentUser.dailyLearningGoalMinutes, 90)
  })

  await t.test('12. Overview calculates all-time metrics, streak, and next uncompleted lesson', async () => {
    const res = await mockRequest(app, {
      method: 'GET',
      url: '/api/learning/overview?timezone=UTC',
      headers: { Authorization: `Bearer ${token}` },
    })
    assert.equal(res.status, 200)
    const data = await res.json()
    assert.equal(data.totalEnrolledCourses, 1)
    assert.equal(data.totalCompletedLessons, 1)
    assert.equal(data.overallProgressPercentage, 50)
    assert.ok(data.currentStreak >= 1, 'Current streak should be active from today study')
    assert.equal(data.courses.length, 1)
    assert.equal(data.courses[0].title, 'React & Node.js Mastery')
    assert.equal(data.courses[0].completedLessons, 1)
    assert.equal(data.courses[0].totalLessons, 2)
    assert.equal(String(data.courses[0].nextLessonId), String(lesson2Id), 'Next lesson should point to Lesson 2')
  })
})
