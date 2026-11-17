import assert from 'node:assert/strict'
import { test } from 'node:test'
import express from 'express'
import jwt from 'jsonwebtoken'
import mongoose from 'mongoose'
import bcrypt from 'bcryptjs'
import { createHash } from 'node:crypto'

process.env.JWT_SECRET = 'test-account-deletion-jwt-secret'
process.env.NODE_ENV = 'test'

const [
  { default: settingsRouter },
  { default: authRouter },
  { default: referralsRouter },
  { Student, CollegeStudent, Admin, CollegeAdmin },
  { default: AccountIdentity },
  { default: Enrollment },
  { default: Progress },
  { default: LearningActivity },
  { default: QuizAttempt },
  { default: QuizAttemptState },
  { default: AssignmentSubmission },
  { default: VideoAttentionResponse },
  { default: Notification },
  { default: NotificationPreference },
  { default: RefreshSession },
  { default: ReferralCode },
  { default: Certificate },
  { default: SupportTicket },
] = await Promise.all([
  import('../routes/settings.js'),
  import('../routes/auth.js'),
  import('../routes/referrals.js'),
  import('../models/account-models.js'),
  import('../models/AccountIdentity.js'),
  import('../models/Enrollment.js'),
  import('../models/Progress.js'),
  import('../models/LearningActivity.js'),
  import('../models/QuizAttempt.js'),
  import('../models/QuizAttemptState.js'),
  import('../models/AssignmentSubmission.js'),
  import('../models/VideoAttentionResponse.js'),
  import('../models/Notification.js'),
  import('../models/NotificationPreference.js'),
  import('../models/RefreshSession.js'),
  import('../models/ReferralCode.js'),
  import('../models/Certificate.js'),
  import('../models/SupportTicket.js'),
])

const app = express()
app.use(express.json())
app.use('/api/settings', settingsRouter)
app.use('/api/auth', authRouter)
app.use('/api/referrals', referralsRouter)

function mockRequest(expressApp, { method = 'GET', url = '/', headers = {}, body = null }) {
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

// In test environment without a replica set, stub startSession to return null immediately
mongoose.startSession = async () => null

test('Secure Account Deletion & Referral Lifecycle Management Suite', async (t) => {
  // Test stores
  const studentsStore = new Map()
  const collegeStudentsStore = new Map()
  const adminsStore = new Map()
  const identitiesStore = new Map()
  const refreshSessionsStore = new Map()
  const enrollmentsStore = new Map()
  const progressStore = new Map()
  const learningActivitiesStore = new Map()
  const quizAttemptsStore = new Map()
  const quizAttemptStatesStore = new Map()
  const assignmentSubmissionsStore = new Map()
  const videoResponsesStore = new Map()
  const notificationsStore = new Map()
  const notificationPreferencesStore = new Map()
  const referralCodesStore = new Map()
  const certificatesStore = new Map()
  const supportTicketsStore = new Map()

  // Helper query builder
  function buildQuery(getData) {
    return {
      select() { return this },
      lean() { return this },
      session() { return this },
      sort() { return this },
      then(resolve, reject) {
        try {
          resolve(getData())
        } catch (err) {
          reject(err)
        }
      },
    }
  }

  // Model stubs
  Student.findById = (id) => buildQuery(() => studentsStore.get(String(id)) || null)
  Student.findOne = (filter) => buildQuery(() => {
    for (const doc of studentsStore.values()) {
      if (matches(doc, filter)) return doc
    }
    return null
  })
  Student.updateOne = async (filter, update) => {
    for (const [id, doc] of studentsStore.entries()) {
      if (matches(doc, filter)) {
        if (update.$set) Object.assign(doc, update.$set)
        if (update.$unset) {
          for (const k of Object.keys(update.$unset)) delete doc[k]
        }
        return { matchedCount: 1, modifiedCount: 1 }
      }
    }
    return { matchedCount: 0, modifiedCount: 0 }
  }

  CollegeStudent.findById = (id) => buildQuery(() => collegeStudentsStore.get(String(id)) || null)
  Admin.findById = (id) => buildQuery(() => adminsStore.get(String(id)) || null)

  AccountIdentity.findOne = (filter) => buildQuery(() => {
    for (const doc of identitiesStore.values()) {
      if (matches(doc, filter)) return doc
    }
    return null
  })
  AccountIdentity.deleteOne = async (filter) => {
    for (const [id, doc] of identitiesStore.entries()) {
      if (matches(doc, filter)) {
        identitiesStore.delete(id)
        return { deletedCount: 1 }
      }
    }
    return { deletedCount: 0 }
  }

  RefreshSession.deleteMany = async (filter) => {
    let count = 0
    for (const [id, doc] of refreshSessionsStore.entries()) {
      if (matches(doc, filter)) {
        refreshSessionsStore.delete(id)
        count++
      }
    }
    return { deletedCount: count }
  }

  Enrollment.updateMany = async (filter, update) => {
    let count = 0
    for (const doc of enrollmentsStore.values()) {
      if (matches(doc, filter)) {
        if (update.$set) Object.assign(doc, update.$set)
        count++
      }
    }
    return { matchedCount: count, modifiedCount: count }
  }

  Progress.deleteMany = async (filter) => {
    let count = 0
    for (const [id, doc] of progressStore.entries()) {
      if (matches(doc, filter)) { progressStore.delete(id); count++ }
    }
    return { deletedCount: count }
  }

  LearningActivity.deleteMany = async (filter) => {
    let count = 0
    for (const [id, doc] of learningActivitiesStore.entries()) {
      if (matches(doc, filter)) { learningActivitiesStore.delete(id); count++ }
    }
    return { deletedCount: count }
  }

  QuizAttempt.deleteMany = async (filter) => {
    let count = 0
    for (const [id, doc] of quizAttemptsStore.entries()) {
      if (matches(doc, filter)) { quizAttemptsStore.delete(id); count++ }
    }
    return { deletedCount: count }
  }

  QuizAttemptState.deleteMany = async (filter) => {
    let count = 0
    for (const [id, doc] of quizAttemptStatesStore.entries()) {
      if (matches(doc, filter)) { quizAttemptStatesStore.delete(id); count++ }
    }
    return { deletedCount: count }
  }

  AssignmentSubmission.deleteMany = async (filter) => {
    let count = 0
    for (const [id, doc] of assignmentSubmissionsStore.entries()) {
      if (matches(doc, filter)) { assignmentSubmissionsStore.delete(id); count++ }
    }
    return { deletedCount: count }
  }

  VideoAttentionResponse.deleteMany = async (filter) => {
    let count = 0
    for (const [id, doc] of videoResponsesStore.entries()) {
      if (matches(doc, filter)) { videoResponsesStore.delete(id); count++ }
    }
    return { deletedCount: count }
  }

  Notification.deleteMany = async (filter) => {
    let count = 0
    for (const [id, doc] of notificationsStore.entries()) {
      if (matches(doc, filter)) { notificationsStore.delete(id); count++ }
    }
    return { deletedCount: count }
  }

  NotificationPreference.deleteMany = async (filter) => {
    let count = 0
    for (const [id, doc] of notificationPreferencesStore.entries()) {
      if (matches(doc, filter)) { notificationPreferencesStore.delete(id); count++ }
    }
    return { deletedCount: count }
  }

  SupportTicket.updateMany = async (filter, update) => {
    let count = 0
    for (const doc of supportTicketsStore.values()) {
      if (matches(doc, filter)) {
        if (update.$set) Object.assign(doc, update.$set)
        count++
      }
    }
    return { matchedCount: count, modifiedCount: count }
  }

  ReferralCode.findOne = (filter) => buildQuery(() => {
    for (const doc of referralCodesStore.values()) {
      if (matches(doc, filter)) return doc
    }
    return null
  })
  ReferralCode.find = (filter) => buildQuery(() => {
    const list = []
    for (const doc of referralCodesStore.values()) {
      if (matches(doc, filter)) list.push(doc)
    }
    return list
  })
  ReferralCode.updateMany = async (filter, update) => {
    let count = 0
    for (const doc of referralCodesStore.values()) {
      if (matches(doc, filter)) {
        if (update.$set) Object.assign(doc, update.$set)
        count++
      }
    }
    return { matchedCount: count, modifiedCount: count }
  }

  function matches(doc, filter) {
    if (!doc || !filter) return false
    for (const [k, v] of Object.entries(filter)) {
      if (k === '$or') {
        if (!v.some((subFilter) => matches(doc, subFilter))) return false
        continue
      }
      const actual = doc[k]
      if (v && typeof v === 'object' && !(v instanceof Date) && !mongoose.isValidObjectId(v)) {
        if ('$ne' in v && String(actual) === String(v.$ne)) return false
        if ('$gt' in v && !(actual > v.$gt)) return false
        if ('$lte' in v && !(actual <= v.$lte)) return false
        continue
      }
      if (String(actual) !== String(v)) return false
    }
    return true
  }

  // Common password hash for test accounts
  const testPassword = 'Password123!'
  const testPasswordHash = await bcrypt.hash(testPassword, 10)

  // 1. Setup Student A (Referrer)
  const studentAId = new mongoose.Types.ObjectId()
  const studentA = {
    _id: studentAId,
    fullName: 'Alice Walker',
    username: 'alicew',
    email: 'alice@example.com',
    role: 'student',
    studentType: 'independent',
    status: 'active',
    isActive: true,
    approvalStatus: 'approved',
    passwordHash: testPasswordHash,
  }
  studentsStore.set(String(studentAId), studentA)

  // 2. Setup Student B (Referred by Alice)
  const studentBId = new mongoose.Types.ObjectId()
  const studentB = {
    _id: studentBId,
    fullName: 'Bob Smith',
    username: 'bobsmith',
    email: 'bob@example.com',
    role: 'student',
    studentType: 'independent',
    status: 'active',
    isActive: true,
    approvalStatus: 'approved',
    passwordHash: testPasswordHash,
    referredBy: studentAId,
    referredByCode: 'LMS-ALICECODE1234567890',
  }
  studentsStore.set(String(studentBId), studentB)

  // Identities
  identitiesStore.set(String(studentAId), {
    _id: new mongoose.Types.ObjectId(),
    accountId: studentAId,
    accountCollection: 'students',
    email: 'alice@example.com',
    username: 'alicew',
  })
  identitiesStore.set(String(studentBId), {
    _id: new mongoose.Types.ObjectId(),
    accountId: studentBId,
    accountCollection: 'students',
    email: 'bob@example.com',
    username: 'bobsmith',
  })

  // Referral code generated by Alice and used by Bob
  const aliceCodeId = new mongoose.Types.ObjectId()
  const aliceCode = {
    _id: aliceCodeId,
    code: 'LMS-ALICECODE1234567890',
    generatedBy: studentAId,
    status: 'used',
    usedBy: studentBId,
    usedAt: new Date(),
    registrationStatus: 'approved',
    rewardStatus: 'pending',
    isDeactivated: false,
    referredEmailHash: null,
    expiresAt: new Date(Date.now() + 86400000),
  }
  referralCodesStore.set(String(aliceCodeId), aliceCode)

  // Referral code generated by Bob for inviting others
  const bobCodeId = new mongoose.Types.ObjectId()
  const bobCode = {
    _id: bobCodeId,
    code: 'LMS-BOBCODE12345678901234',
    generatedBy: studentBId,
    status: 'active',
    usedBy: null,
    registrationStatus: null,
    rewardStatus: null,
    isDeactivated: false,
    expiresAt: new Date(Date.now() + 86400000),
  }
  referralCodesStore.set(String(bobCodeId), bobCode)

  // Refresh sessions for Bob
  refreshSessionsStore.set('session-1', {
    _id: new mongoose.Types.ObjectId(),
    userId: studentBId,
    accountCollection: 'students',
  })

  // Enrollments for Bob
  const courseId = new mongoose.Types.ObjectId()
  enrollmentsStore.set('enrollment-1', {
    _id: new mongoose.Types.ObjectId(),
    userId: studentBId,
    courseId,
    status: 'active',
  })

  // Learning progress & activity for Bob
  progressStore.set('prog-1', { _id: new mongoose.Types.ObjectId(), userId: studentBId, courseId })
  learningActivitiesStore.set('act-1', { _id: new mongoose.Types.ObjectId(), studentId: studentBId, courseId })
  quizAttemptsStore.set('quiz-1', { _id: new mongoose.Types.ObjectId(), userId: studentBId, courseId })
  quizAttemptStatesStore.set('state-1', { _id: new mongoose.Types.ObjectId(), userId: studentBId, courseId })
  assignmentSubmissionsStore.set('sub-1', { _id: new mongoose.Types.ObjectId(), userId: studentBId, courseId })
  videoResponsesStore.set('vid-1', { _id: new mongoose.Types.ObjectId(), userId: studentBId, courseId })
  notificationsStore.set('notif-1', { _id: new mongoose.Types.ObjectId(), recipientId: studentBId })

  // Certificate for Bob (immutable)
  const certId = new mongoose.Types.ObjectId()
  certificatesStore.set(String(certId), {
    _id: certId,
    certificateId: 'AIH-0123456789ABCDEF0123456789ABCDEF',
    studentId: studentBId,
    studentName: 'Bob Smith',
    courseId,
  })

  // Support ticket by Bob
  supportTicketsStore.set('ticket-1', {
    _id: new mongoose.Types.ObjectId(),
    userId: studentBId,
    subject: 'Course issue',
    requesterName: 'Bob Smith',
    requesterEmail: 'bob@example.com',
  })

  // Setup College Student
  const collegeStudentId = new mongoose.Types.ObjectId()
  const collegeStudent = {
    _id: collegeStudentId,
    fullName: 'Charlie College',
    username: 'charliec',
    email: 'charlie@college.edu',
    role: 'student',
    studentType: 'college',
    status: 'active',
    isActive: true,
    collegeId: new mongoose.Types.ObjectId(),
  }
  collegeStudentsStore.set(String(collegeStudentId), collegeStudent)

  // Setup Admin
  const adminId = new mongoose.Types.ObjectId()
  const admin = {
    _id: adminId,
    fullName: 'Platform Admin',
    username: 'admin',
    email: 'admin@aihustle.internal',
    role: 'main_admin',
    status: 'active',
    isActive: true,
  }
  adminsStore.set(String(adminId), admin)

  // Test 1: College student cannot delete account (403 Forbidden)
  await t.test('1. College-managed student is blocked from account deletion (403)', async () => {
    const token = issueTestToken(collegeStudentId, 'student', 'clg_students')
    const res = await mockRequest(app, {
      method: 'DELETE',
      url: '/api/settings/account',
      headers: { authorization: `Bearer ${token}` },
      body: { confirmation: 'DELETE' },
    })
    assert.equal(res.status, 403)
    const data = await res.json()
    assert.match(data.message, /College-managed accounts cannot be deleted directly/i)
  })

  // Test 2: Admin cannot delete account via student deletion endpoint (403)
  await t.test('2. Admin account cannot be deleted via student settings endpoint (403)', async () => {
    const token = issueTestToken(adminId, 'main_admin', 'admin')
    const res = await mockRequest(app, {
      method: 'DELETE',
      url: '/api/settings/account',
      headers: { authorization: `Bearer ${token}` },
      body: { confirmation: 'DELETE' },
    })
    assert.equal(res.status, 403)
  })

  // Test 3: Missing or invalid confirmation text returns 400
  await t.test('3. Deletion rejected if confirmation phrase is missing or incorrect (400)', async () => {
    const token = issueTestToken(studentBId, 'student', 'students')
    const resNoConfirm = await mockRequest(app, {
      method: 'DELETE',
      url: '/api/settings/account',
      headers: { authorization: `Bearer ${token}` },
      body: { password: testPassword },
    })
    assert.equal(resNoConfirm.status, 400)
    const dataNoConfirm = await resNoConfirm.json()
    assert.match(dataNoConfirm.message, /type DELETE to confirm/i)

    const resWrongConfirm = await mockRequest(app, {
      method: 'DELETE',
      url: '/api/settings/account',
      headers: { authorization: `Bearer ${token}` },
      body: { confirmation: 'REMOVE', password: testPassword },
    })
    assert.equal(resWrongConfirm.status, 400)
  })

  // Test 4: Password check fails with wrong password
  await t.test('4. Deletion rejected with incorrect password (401)', async () => {
    const token = issueTestToken(studentBId, 'student', 'students')
    const res = await mockRequest(app, {
      method: 'DELETE',
      url: '/api/settings/account',
      headers: { authorization: `Bearer ${token}` },
      body: { confirmation: 'DELETE', password: 'WrongPassword999!' },
    })
    assert.equal(res.status, 401)
    const data = await res.json()
    assert.match(data.message, /password you entered is incorrect/i)
  })

  // Test 5: Password check requires password when account has passwordHash
  await t.test('5. Deletion rejected when password is omitted for password-protected account (400)', async () => {
    const token = issueTestToken(studentBId, 'student', 'students')
    const res = await mockRequest(app, {
      method: 'DELETE',
      url: '/api/settings/account',
      headers: { authorization: `Bearer ${token}` },
      body: { confirmation: 'DELETE' },
    })
    assert.equal(res.status, 400)
    const data = await res.json()
    assert.match(data.message, /enter your current password/i)
  })

  // Test 6: Successful account deletion for Student B
  await t.test('6. Successful account deletion for independent Student B', async () => {
    const token = issueTestToken(studentBId, 'student', 'students')
    const res = await mockRequest(app, {
      method: 'DELETE',
      url: '/api/settings/account',
      headers: { authorization: `Bearer ${token}` },
      body: { confirmation: 'DELETE', password: testPassword },
    })
    assert.equal(res.status, 200)
    const data = await res.json()
    assert.equal(data.success, true)
  })

  // Test 7: Student B record is anonymized
  await t.test('7. Student B record is completely anonymized and marked status: deleted', () => {
    const b = studentsStore.get(String(studentBId))
    assert.equal(b.fullName, 'Deleted Student')
    assert.equal(b.status, 'deleted')
    assert.equal(b.isActive, false)
    assert.equal(b.passwordHash, undefined)
    assert.ok(b.email.startsWith(`deleted_${studentBId}@`))
    assert.equal(b.username, `deleted_${studentBId}`)
    assert.ok(b.deletedAt instanceof Date)
  })

  // Test 8: AccountIdentity is deleted
  await t.test('8. AccountIdentity for Student B is permanently deleted to free up username and email', () => {
    const identity = identitiesStore.get(String(studentBId))
    assert.equal(identity, undefined)
  })

  // Test 9: Sessions are revoked
  await t.test('9. All RefreshSession records for Student B are deleted', () => {
    assert.equal(refreshSessionsStore.size, 0)
  })

  // Test 10: Enrollments cancelled
  await t.test('10. Enrollments for Student B are marked cancelled', () => {
    const enrollment = enrollmentsStore.get('enrollment-1')
    assert.equal(enrollment.status, 'cancelled')
  })

  // Test 11: Progress, attempts, submissions, and activities deleted
  await t.test('11. Progress, attempts, submissions, and learning activities are cleared', () => {
    assert.equal(progressStore.size, 0)
    assert.equal(learningActivitiesStore.size, 0)
    assert.equal(quizAttemptsStore.size, 0)
    assert.equal(quizAttemptStatesStore.size, 0)
    assert.equal(assignmentSubmissionsStore.size, 0)
    assert.equal(videoResponsesStore.size, 0)
    assert.equal(notificationsStore.size, 0)
  })

  // Test 12: Certificates are preserved
  await t.test('12. Academic Certificate records are preserved in registry', () => {
    assert.equal(certificatesStore.size, 1)
    const cert = certificatesStore.get(String(certId))
    assert.equal(cert.certificateId, 'AIH-0123456789ABCDEF0123456789ABCDEF')
  })

  // Test 13: Support tickets are anonymized
  await t.test('13. Support tickets submitted by deleted student are anonymized', () => {
    const ticket = supportTicketsStore.get('ticket-1')
    assert.equal(ticket.requesterName, 'Deleted Student')
    assert.equal(ticket.requesterEmail, 'deleted@deleted.local')
  })

  // Test 14: Scenario A - ReferralCode where Bob was the referred student
  await t.test('14. Scenario A: ReferralCode used by Bob is marked account_deleted with cancelled rewards and email hash', () => {
    const code = referralCodesStore.get(String(aliceCodeId))
    assert.equal(code.registrationStatus, 'account_deleted')
    assert.equal(code.rewardStatus, 'cancelled')
    assert.equal(code.referredUserAnonymized, true)
    const expectedHash = createHash('sha256').update('bob@example.com').digest('hex')
    assert.equal(code.referredEmailHash, expectedHash)
  })

  // Test 15: Scenario B - ReferralCode generated by Bob (referrer) deactivated
  await t.test('15. Scenario B: ReferralCode generated by Bob is deactivated and expired', () => {
    const code = referralCodesStore.get(String(bobCodeId))
    assert.equal(code.isDeactivated, true)
    assert.equal(code.status, 'expired')
  })

  // Test 16: Attempting to validate or use deactivated code returns invalid/expired
  await t.test('16. Validating a deactivated referral code fails (400)', async () => {
    const res = await mockRequest(app, {
      method: 'POST',
      url: '/api/referrals/validate',
      body: { code: bobCode.code },
    })
    assert.equal(res.status, 400)
  })

  // Test 17: Scenario C - Re-registration with the same email using a referral code is rejected
  await t.test('17. Scenario C: Deleted user re-registering with another referral code is rejected by referredEmailHash', async () => {
    // Generate new valid code from Alice
    const newAliceCodeId = new mongoose.Types.ObjectId()
    const newAliceCode = {
      _id: newAliceCodeId,
      code: 'LMS-ALICENEWCODE12345678',
      generatedBy: studentAId,
      status: 'active',
      usedBy: null,
      registrationStatus: null,
      rewardStatus: null,
      isDeactivated: false,
      expiresAt: new Date(Date.now() + 86400000),
    }
    referralCodesStore.set(String(newAliceCodeId), newAliceCode)

    // Bob tries to register again with bob@example.com and Alice's new code
    const regRes = await mockRequest(app, {
      method: 'POST',
      url: '/api/auth/register',
      body: {
        fullName: 'Bob Smith Rejoin',
        username: 'bobsmith2',
        email: 'bob@example.com',
        password: 'Password123!',
        confirmPassword: 'Password123!',
        role: 'student',
        referralCode: newAliceCode.code,
      },
    })
    assert.equal(regRes.status, 400)
    const regData = await regRes.json()
    assert.match(regData.message, /already been (used with|attributed to) a referral code/i)
  })

  // Test 18: Google-only student (no passwordHash) can delete account with DELETE confirmation
  await t.test('18. Google-only student account (no password) can delete account with DELETE confirmation', async () => {
    const googleStudentId = new mongoose.Types.ObjectId()
    const googleStudent = {
      _id: googleStudentId,
      fullName: 'Google User',
      username: 'googleuser',
      email: 'google@gmail.com',
      role: 'student',
      studentType: 'independent',
      status: 'active',
      isActive: true,
      approvalStatus: 'approved',
      passwordHash: undefined,
    }
    studentsStore.set(String(googleStudentId), googleStudent)
    identitiesStore.set(String(googleStudentId), {
      _id: new mongoose.Types.ObjectId(),
      accountId: googleStudentId,
      accountCollection: 'students',
      email: 'google@gmail.com',
      username: 'googleuser',
    })

    const token = issueTestToken(googleStudentId, 'student', 'students')
    const res = await mockRequest(app, {
      method: 'DELETE',
      url: '/api/settings/account',
      headers: { authorization: `Bearer ${token}` },
      body: { confirmation: 'DELETE' },
    })
    assert.equal(res.status, 200)
    const deletedG = studentsStore.get(String(googleStudentId))
    assert.equal(deletedG.status, 'deleted')
    assert.equal(deletedG.fullName, 'Deleted Student')
  })

  // Test 19: POST /delete-account endpoint works identically to DELETE /account
  await t.test('19. POST /delete-account endpoint works identically', async () => {
    const postStudentId = new mongoose.Types.ObjectId()
    const postStudent = {
      _id: postStudentId,
      fullName: 'Post Student',
      username: 'poststudent',
      email: 'post@example.com',
      role: 'student',
      studentType: 'independent',
      status: 'active',
      isActive: true,
      approvalStatus: 'approved',
      passwordHash: testPasswordHash,
    }
    studentsStore.set(String(postStudentId), postStudent)
    identitiesStore.set(String(postStudentId), {
      _id: new mongoose.Types.ObjectId(),
      accountId: postStudentId,
      accountCollection: 'students',
      email: 'post@example.com',
      username: 'poststudent',
    })

    const token = issueTestToken(postStudentId, 'student', 'students')
    const res = await mockRequest(app, {
      method: 'POST',
      url: '/api/settings/delete-account',
      headers: { authorization: `Bearer ${token}` },
      body: { confirmation: 'DELETE', password: testPassword },
    })
    assert.equal(res.status, 200)
    const deletedPost = studentsStore.get(String(postStudentId))
    assert.equal(deletedPost.status, 'deleted')
    assert.equal(deletedPost.fullName, 'Deleted Student')
  })
})
