import assert from 'node:assert/strict'
import { test } from 'node:test'
import express from 'express'
import jwt from 'jsonwebtoken'
import mongoose from 'mongoose'

process.env.JWT_SECRET = 'test-notification-pref-jwt-secret'
process.env.NODE_ENV = 'test'

const [
  { default: settingsRouter },
  { default: notificationsRouter },
  { default: authRouter },
  { default: NotificationPreference, DEFAULT_NOTIFICATION_PREFERENCES },
  { default: Notification },
  { Student, CollegeStudent, Admin, CollegeAdmin },
  { default: ReferralCode },
  { default: Course },
  { default: Enrollment },
  {
    getStudentNotificationPreferences,
    canDeliverNotification,
    sendNotification,
    sanitizePreferences,
    normalizeCategoryKey,
  },
] = await Promise.all([
  import('../routes/settings.js'),
  import('../routes/notifications.js'),
  import('../routes/auth.js'),
  import('../models/NotificationPreference.js'),
  import('../models/Notification.js'),
  import('../models/account-models.js'),
  import('../models/ReferralCode.js'),
  import('../models/Course.js'),
  import('../models/Enrollment.js'),
  import('../utils/notification-service.js'),
])

const app = express()
app.use(express.json())
app.use('/api/settings', settingsRouter)
app.use('/api/notifications', notificationsRouter)
app.use('/api/auth', authRouter)

function mockRequest(expressApp, { method = 'GET', url = '/', headers = {}, body = null }) {
  return new Promise((resolve) => {
    const reqHeaders = Object.fromEntries(
      Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
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
          json: async () => (resBody ? JSON.parse(resBody) : {}),
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
      },
      clearCookie() {},
      cookie() {},
    }

    expressApp(req, res, (err) => {
      if (err) {
        const code = err.statusCode || err.status || 500
        resolve({
          status: code,
          headers: resHeaders,
          json: async () => ({ message: err.message }),
          text: async () => JSON.stringify({ message: err.message }),
        })
      } else {
        resolve({
          status: 404,
          headers: {},
          json: async () => ({ message: 'Not Found' }),
          text: async () => 'Not Found',
        })
      }
    })
  })
}

function issueTestToken(userId, role = 'student', accountCollection = 'students') {
  return jwt.sign(
    { sub: String(userId), role, accountCollection, permissions: [] },
    process.env.JWT_SECRET,
    { expiresIn: '1h' },
  )
}

test('Notification Preferences & Notification Delivery System Suite', async (t) => {
  // In-memory test stores
  const studentsStore = new Map()
  const collegeStudentsStore = new Map()
  const adminsStore = new Map()
  const preferencesStore = new Map()
  const notificationsStore = []

  function buildQuery(getData) {
    return {
      select() { return this },
      lean() { return this },
      session() { return this },
      sort() { return this },
      then(resolve, reject) {
        try { resolve(getData()) } catch (err) { reject(err) }
      },
    }
  }

  function matches(doc, filter) {
    if (!doc || !filter) return false
    for (const [k, v] of Object.entries(filter)) {
      if (k === '$or') {
        if (!v.some((sub) => matches(doc, sub))) return false
        continue
      }
      if (String(doc[k]) !== String(v)) return false
    }
    return true
  }

  // Model stubs
  Student.findById = (id) => buildQuery(() => studentsStore.get(String(id)) || null)
  CollegeStudent.findById = (id) => buildQuery(() => collegeStudentsStore.get(String(id)) || null)
  Admin.findById = (id) => buildQuery(() => adminsStore.get(String(id)) || null)

  NotificationPreference.findOne = (filter) => buildQuery(() => {
    for (const doc of preferencesStore.values()) {
      if (matches(doc, filter)) return doc
    }
    return null
  })

  NotificationPreference.findOneAndUpdate = (filter, update, options = {}) => buildQuery(() => {
    let target = null
    for (const doc of preferencesStore.values()) {
      if (matches(doc, filter)) {
        target = doc
        break
      }
    }

    if (!target && options.upsert) {
      target = {
        _id: new mongoose.Types.ObjectId(),
        userId: filter.userId,
        accountCollection: filter.accountCollection || 'students',
        studentType: 'independent',
        ...DEFAULT_NOTIFICATION_PREFERENCES,
      }
      preferencesStore.set(String(filter.userId), target)
    }

    if (target) {
      if (update.$set) Object.assign(target, update.$set)
    }
    return target
  })

  Notification.create = async (docs) => {
    const list = Array.isArray(docs) ? docs : [docs]
    const created = list.map((d) => ({
      _id: new mongoose.Types.ObjectId(),
      createdAt: new Date(),
      isRead: false,
      ...d,
    }))
    notificationsStore.push(...created)
    return Array.isArray(docs) ? created : created[0]
  }

  // Set up test accounts
  const student1Id = new mongoose.Types.ObjectId()
  const student1 = {
    _id: student1Id,
    fullName: 'David Miller',
    username: 'davidm',
    email: 'david@example.com',
    role: 'student',
    studentType: 'independent',
    status: 'active',
    isActive: true,
    approvalStatus: 'approved',
  }
  studentsStore.set(String(student1Id), student1)

  const student2Id = new mongoose.Types.ObjectId()
  const student2 = {
    _id: student2Id,
    fullName: 'Emma Watson',
    username: 'emmaw',
    email: 'emma@example.com',
    role: 'student',
    studentType: 'independent',
    status: 'active',
    isActive: true,
    approvalStatus: 'approved',
  }
  studentsStore.set(String(student2Id), student2)

  const collegeStudentId = new mongoose.Types.ObjectId()
  const collegeStudent = {
    _id: collegeStudentId,
    fullName: 'Frank College',
    username: 'frankc',
    email: 'frank@college.edu',
    role: 'student',
    studentType: 'college',
    status: 'active',
    isActive: true,
  }
  collegeStudentsStore.set(String(collegeStudentId), collegeStudent)

  const adminId = new mongoose.Types.ObjectId()
  const admin = {
    _id: adminId,
    fullName: 'Main Admin',
    username: 'admin',
    email: 'admin@aihustle.internal',
    role: 'main_admin',
    status: 'active',
    isActive: true,
  }
  adminsStore.set(String(adminId), admin)

  // 1. Default preferences when none exist
  await t.test('1. GET /api/settings/notifications returns all preferences enabled by default', async () => {
    const token = issueTestToken(student1Id, 'student', 'students')
    const res = await mockRequest(app, {
      method: 'GET',
      url: '/api/settings/notifications',
      headers: { authorization: `Bearer ${token}` },
    })
    assert.equal(res.status, 200)
    const data = await res.json()
    assert.deepEqual(data.preferences, {
      courseAnnouncements: true,
      newCourseUpdates: true,
      assignmentDeadlines: true,
      quizReminders: true,
      referralNotifications: true,
      emailNotifications: true,
    })
  })

  // 2. Default preferences via /api/notifications/preferences route
  await t.test('2. GET /api/notifications/preferences works and returns defaults', async () => {
    const token = issueTestToken(student1Id, 'student', 'students')
    const res = await mockRequest(app, {
      method: 'GET',
      url: '/api/notifications/preferences',
      headers: { authorization: `Bearer ${token}` },
    })
    assert.equal(res.status, 200)
    const data = await res.json()
    assert.equal(data.preferences.courseAnnouncements, true)
    assert.equal(data.preferences.emailNotifications, true)
  })

  // 3. Updating preferences (PATCH /api/settings/notifications)
  await t.test('3. PATCH /api/settings/notifications updates individual toggles and persists', async () => {
    const token = issueTestToken(student1Id, 'student', 'students')
    const res = await mockRequest(app, {
      method: 'PATCH',
      url: '/api/settings/notifications',
      headers: { authorization: `Bearer ${token}` },
      body: {
        referralNotifications: false,
        emailNotifications: false,
      },
    })
    assert.equal(res.status, 200)
    const data = await res.json()
    assert.equal(data.preferences.referralNotifications, false)
    assert.equal(data.preferences.emailNotifications, false)
    assert.equal(data.preferences.courseAnnouncements, true)
    assert.equal(data.preferences.newCourseUpdates, true)
    assert.equal(data.preferences.assignmentDeadlines, true)
    assert.equal(data.preferences.quizReminders, true)
  })

  // 4. Loading saved preferences verifies persistence
  await t.test('4. GET /api/settings/notifications reflects the persisted changes', async () => {
    const token = issueTestToken(student1Id, 'student', 'students')
    const res = await mockRequest(app, {
      method: 'GET',
      url: '/api/settings/notifications',
      headers: { authorization: `Bearer ${token}` },
    })
    assert.equal(res.status, 200)
    const data = await res.json()
    assert.equal(data.preferences.referralNotifications, false)
    assert.equal(data.preferences.emailNotifications, false)
  })

  // 5. Validation: non-boolean values rejected
  await t.test('5. Non-boolean values in preference update return 400 Bad Request', async () => {
    const token = issueTestToken(student1Id, 'student', 'students')
    const res = await mockRequest(app, {
      method: 'PATCH',
      url: '/api/settings/notifications',
      headers: { authorization: `Bearer ${token}` },
      body: { quizReminders: 'disabled' },
    })
    assert.equal(res.status, 400)
    const data = await res.json()
    assert.match(data.message, /must be a boolean/i)
  })

  // 6. Validation: empty payload rejected
  await t.test('6. Empty preference update returns 400 Bad Request', async () => {
    const token = issueTestToken(student1Id, 'student', 'students')
    const res = await mockRequest(app, {
      method: 'PATCH',
      url: '/api/settings/notifications',
      headers: { authorization: `Bearer ${token}` },
      body: {},
    })
    assert.equal(res.status, 400)
  })

  // 7. Unauthorized request rejected (401)
  await t.test('7. Unauthenticated request to /api/settings/notifications returns 401', async () => {
    const res = await mockRequest(app, {
      method: 'GET',
      url: '/api/settings/notifications',
    })
    assert.equal(res.status, 401)
  })

  // 8. Admin access rejected (403)
  await t.test('8. Admin access to student notification preferences returns 403', async () => {
    const token = issueTestToken(adminId, 'main_admin', 'admin')
    const res = await mockRequest(app, {
      method: 'GET',
      url: '/api/settings/notifications',
      headers: { authorization: `Bearer ${token}` },
    })
    assert.equal(res.status, 403)
  })

  // 9. College student account support
  await t.test('9. College students can read and update their notification preferences', async () => {
    const token = issueTestToken(collegeStudentId, 'student', 'clg_students')
    const getRes = await mockRequest(app, {
      method: 'GET',
      url: '/api/settings/notifications',
      headers: { authorization: `Bearer ${token}` },
    })
    assert.equal(getRes.status, 200)

    const patchRes = await mockRequest(app, {
      method: 'PATCH',
      url: '/api/settings/notifications',
      headers: { authorization: `Bearer ${token}` },
      body: { assignmentDeadlines: false },
    })
    assert.equal(patchRes.status, 200)
    const patchData = await patchRes.json()
    assert.equal(patchData.preferences.assignmentDeadlines, false)
  })

  // 10. Students cannot modify another student's preferences
  await t.test('10. Student 2 cannot modify Student 1 preferences; changes are strictly bound to caller', async () => {
    const token2 = issueTestToken(student2Id, 'student', 'students')
    await mockRequest(app, {
      method: 'PATCH',
      url: '/api/settings/notifications',
      headers: { authorization: `Bearer ${token2}` },
      body: { courseAnnouncements: false },
    })

    // Verify student 2 has courseAnnouncements: false
    const s2Pref = await mockRequest(app, {
      method: 'GET',
      url: '/api/settings/notifications',
      headers: { authorization: `Bearer ${token2}` },
    })
    const s2Data = await s2Pref.json()
    assert.equal(s2Data.preferences.courseAnnouncements, false)

    // Verify student 1 still has courseAnnouncements: true
    const token1 = issueTestToken(student1Id, 'student', 'students')
    const s1Pref = await mockRequest(app, {
      method: 'GET',
      url: '/api/settings/notifications',
      headers: { authorization: `Bearer ${token1}` },
    })
    const s1Data = await s1Pref.json()
    assert.equal(s1Data.preferences.courseAnnouncements, true)
  })

  // 11. Notification delivery respects disabled category
  await t.test('11. When referralNotifications is disabled for Student 1, referral notification is NOT created', async () => {
    notificationsStore.length = 0

    // Student 1 has referralNotifications: false
    const result = await sendNotification({
      recipientRole: 'student',
      recipientId: student1Id,
      category: 'referral_notifications',
      type: 'referral_registered',
      title: 'New referral',
      message: 'Someone joined',
    })
    assert.equal(result.inAppDelivered, false)
    assert.equal(result.notification, null)
    assert.equal(notificationsStore.length, 0)
  })

  // 12. Notification delivery respects enabled category
  await t.test('12. When assignmentDeadlines is enabled for Student 1, notification is created', async () => {
    notificationsStore.length = 0

    // Student 1 has assignmentDeadlines: true
    const result = await sendNotification({
      recipientRole: 'student',
      recipientId: student1Id,
      category: 'assignment_deadlines',
      type: 'assignment_due',
      title: 'Assignment deadline',
      message: 'Due tomorrow',
    })
    assert.equal(result.inAppDelivered, true)
    assert.ok(result.notification)
    assert.equal(notificationsStore.length, 1)
    assert.equal(notificationsStore[0].title, 'Assignment deadline')
  })

  // 13. Master email toggle: disabling email does NOT disable in-app notifications
  await t.test('13. Disabling emailNotifications stops email but in-app notification is still delivered', async () => {
    notificationsStore.length = 0

    // For Student 1, assignmentDeadlines is true, emailNotifications is false
    const result = await sendNotification({
      recipientRole: 'student',
      recipientId: student1Id,
      category: 'assignment_deadlines',
      type: 'assignment_due',
      title: 'Assignment reminder',
      message: 'Due soon',
      emailOptions: {
        to: 'david@example.com',
        subject: 'Reminder',
        text: 'Due soon',
      },
    })
    assert.equal(result.inAppDelivered, true)
    assert.equal(result.emailDelivered, false) // Email delivery suppressed by master toggle
    assert.equal(notificationsStore.length, 1)
  })

  // 14. Admin notification functionality is completely unaffected by student preferences
  await t.test('14. Notifications sent to main_admin always bypass student preferences and deliver', async () => {
    notificationsStore.length = 0

    const result = await sendNotification({
      recipientRole: 'main_admin',
      type: 'system_alert',
      title: 'System notice',
      message: 'Server notice',
    })
    assert.equal(result.inAppDelivered, true)
    assert.ok(result.notification)
    assert.equal(notificationsStore.length, 1)
    assert.equal(notificationsStore[0].recipientRole, 'main_admin')
  })

  // 15. Category key normalization utility checks
  await t.test('15. Category normalization handles various casing and snake_case correctly', () => {
    assert.equal(normalizeCategoryKey('courseAnnouncements'), 'courseAnnouncements')
    assert.equal(normalizeCategoryKey('course_announcements'), 'courseAnnouncements')
    assert.equal(normalizeCategoryKey('new_course_updates'), 'newCourseUpdates')
    assert.equal(normalizeCategoryKey('assignment-deadlines'), 'assignmentDeadlines')
    assert.equal(normalizeCategoryKey('quiz_reminders'), 'quizReminders')
    assert.equal(normalizeCategoryKey('referral_notifications'), 'referralNotifications')
    assert.equal(normalizeCategoryKey('unknown_category'), null)
  })

  // 16. Re-enabling a preference restores notifications for future events
  await t.test('16. Re-enabling referralNotifications restores delivery for future events', async () => {
    notificationsStore.length = 0

    // Re-enable referralNotifications for Student 1
    const token = issueTestToken(student1Id, 'student', 'students')
    await mockRequest(app, {
      method: 'PATCH',
      url: '/api/settings/notifications',
      headers: { authorization: `Bearer ${token}` },
      body: { referralNotifications: true },
    })

    const result = await sendNotification({
      recipientRole: 'student',
      recipientId: student1Id,
      category: 'referral_notifications',
      type: 'referral_registered',
      title: 'New referral registration',
      message: 'Someone joined',
    })
    assert.equal(result.inAppDelivered, true)
    assert.ok(result.notification)
    assert.equal(notificationsStore.length, 1)
  })
})

