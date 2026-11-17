import assert from 'node:assert/strict'
import { test } from 'node:test'
import express from 'express'
import jwt from 'jsonwebtoken'
import mongoose from 'mongoose'

process.env.JWT_SECRET = 'test-achievement-certificates-jwt-secret'
process.env.NODE_ENV = 'test'

const [
  { default: learningRouter },
  { default: Certificate },
  { default: CertificateTemplate },
  { default: Enrollment },
  { default: Course },
  { Student, CollegeStudent },
  { config },
] = await Promise.all([
  import('../routes/learning.js'),
  import('../models/Certificate.js'),
  import('../models/CertificateTemplate.js'),
  import('../models/Enrollment.js'),
  import('../models/Course.js'),
  import('../models/account-models.js'),
  import('../config/env.js'),
])

const app = express()
app.use(express.json())
app.use('/api', learningRouter)

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
    let resBuffer = null
    let resBody = ''

    const res = {
      statusCode: 200,
      setHeader(k, v) { resHeaders[k.toLowerCase()] = v },
      getHeader(k) { return resHeaders[k.toLowerCase()] },
      set(k, v) {
        if (typeof k === 'object') {
          for (const [key, val] of Object.entries(k)) resHeaders[key.toLowerCase()] = val
        } else {
          resHeaders[k.toLowerCase()] = v
        }
      },
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
        if (Buffer.isBuffer(data)) {
          resBuffer = data
          resBody = data.toString('utf8')
        } else if (typeof data === 'string') {
          resBody = data
        } else {
          resBody = JSON.stringify(data)
        }
        resolve({
          status: statusCode,
          headers: resHeaders,
          buffer: async () => resBuffer || Buffer.from(resBody),
          json: async () => (resBody ? JSON.parse(resBody) : {}),
          text: async () => resBody,
        })
        return this
      },
      end(data) {
        if (data) {
          if (Buffer.isBuffer(data)) {
            resBuffer = data
            resBody = data.toString('utf8')
          } else {
            resBody = data.toString()
          }
        }
        resolve({
          status: statusCode,
          headers: resHeaders,
          buffer: async () => resBuffer || Buffer.from(resBody),
          json: async () => (resBody ? JSON.parse(resBody) : {}),
          text: async () => resBody,
        })
      },
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
    config.jwtSecret,
    { expiresIn: '1h' },
  )
}

function buildQuery(getData) {
  const promise = Promise.resolve().then(() => getData())
  promise.select = () => promise
  promise.lean = () => promise
  promise.session = () => promise
  promise.sort = () => promise
  promise.populate = () => promise
  return promise
}

test('Achievement Certificates Preview & Download Suite', async (t) => {
  const student1Id = new mongoose.Types.ObjectId()
  const student2Id = new mongoose.Types.ObjectId()
  const courseId = new mongoose.Types.ObjectId()
  const certMongoId = new mongoose.Types.ObjectId()
  const certIdString = 'AIH-2026-A1B2C3D4E5F6'

  const student1Token = issueTestToken(student1Id, 'student', 'students')
  const student2Token = issueTestToken(student2Id, 'student', 'students')

  const student1Doc = {
    _id: student1Id,
    fullName: 'Jane Doe',
    email: 'jane@example.com',
    role: 'student',
    studentType: 'independent',
    isActive: true,
    status: 'active',
    approvalStatus: 'approved',
  }

  const student2Doc = {
    _id: student2Id,
    fullName: 'Mark Smith',
    email: 'mark@example.com',
    role: 'student',
    studentType: 'independent',
    isActive: true,
    status: 'active',
    approvalStatus: 'approved',
  }

  const certDoc = {
    _id: certMongoId,
    certificateId: certIdString,
    studentId: student1Id,
    userId: student1Id,
    studentType: 'independent',
    studentName: 'Jane Doe',
    courseId,
    courseName: 'Digital Marketing Fundamentals',
    name: 'Digital Marketing Fundamentals Certificate of Completion',
    enrollmentId: new mongoose.Types.ObjectId(),
    templateId: 'builtin',
    completedAt: new Date('2026-05-10T12:00:00.000Z'),
    issuedAt: new Date('2026-05-10T12:00:00.000Z'),
    viewUrl: `/certificates/${certIdString}/view`,
    downloadUrl: `/certificates/${certIdString}/download`,
  }

  // Stubs
  const originalStudentFindById = Student.findById
  const originalCertFindOne = Certificate.findOne
  const originalCertFind = Certificate.find
  const originalTemplateFindById = CertificateTemplate.findById
  const originalEnrollmentFindOne = Enrollment.findOne

  Student.findById = (id) => buildQuery(() => (
    String(id) === String(student1Id) ? student1Doc : String(id) === String(student2Id) ? student2Doc : null
  ))

  Certificate.findOne = (filter) => buildQuery(() => {
    // Check ownership
    const userMatches = filter?.$or
      ? filter.$or.some((clause) => {
          const u = clause.userId || clause.studentId
          return u && String(u) === String(student1Id)
        })
      : (String(filter?.userId) === String(student1Id) || String(filter?.studentId) === String(student1Id))

    if (!userMatches) return null

    // Check ID/certificateId/courseId
    if (filter._id && String(filter._id) === String(certMongoId)) return certDoc
    if (filter.certificateId && filter.certificateId === certIdString) return certDoc
    if (filter.courseId && String(filter.courseId) === String(courseId)) return certDoc
    return null
  })

  CertificateTemplate.findById = () => buildQuery(() => null)
  Enrollment.findOne = () => buildQuery(() => null)

  t.after(() => {
    Student.findById = originalStudentFindById
    Certificate.findOne = originalCertFindOne
    Certificate.find = originalCertFind
    CertificateTemplate.findById = originalTemplateFindById
    Enrollment.findOne = originalEnrollmentFindOne
  })

  await t.test('1. Preview Certificate streams valid PDF inline with meaningful filename', async () => {
    const res = await mockRequest(app, {
      method: 'GET',
      url: `/api/certificates/${certMongoId}/preview`,
      headers: { authorization: `Bearer ${student1Token}` },
    })
    assert.equal(res.status, 200)
    assert.equal(res.headers['content-type'], 'application/pdf')
    assert.match(res.headers['content-disposition'], /^inline;\s*filename="aiHustle-Digital-Marketing-Fundamentals-Certificate\.pdf"/)
    const buf = await res.buffer()
    assert.ok(buf.length > 500)
    assert.equal(buf.subarray(0, 5).toString('ascii'), '%PDF-')
  })

  await t.test('2. Download Certificate sends valid PDF attachment with meaningful filename', async () => {
    const res = await mockRequest(app, {
      method: 'GET',
      url: `/api/certificates/${certMongoId}/download`,
      headers: { authorization: `Bearer ${student1Token}` },
    })
    assert.equal(res.status, 200)
    assert.equal(res.headers['content-type'], 'application/pdf')
    assert.match(res.headers['content-disposition'], /^attachment;\s*filename="aiHustle-Digital-Marketing-Fundamentals-Certificate\.pdf"/)
    const buf = await res.buffer()
    assert.ok(buf.length > 500)
    assert.equal(buf.subarray(0, 5).toString('ascii'), '%PDF-')
  })

  await t.test('3. /api/certificates/:id/pdf?download=true downloads attachment', async () => {
    const res = await mockRequest(app, {
      method: 'GET',
      url: `/api/certificates/${certMongoId}/pdf?download=true`,
      headers: { authorization: `Bearer ${student1Token}` },
    })
    assert.equal(res.status, 200)
    assert.match(res.headers['content-disposition'], /^attachment;/)
    const buf = await res.buffer()
    assert.equal(buf.subarray(0, 5).toString('ascii'), '%PDF-')
  })

  await t.test('4. Lookup by public certificateId string (AIH-2026-...) succeeds', async () => {
    const res = await mockRequest(app, {
      method: 'GET',
      url: `/api/certificates/${certIdString}/preview`,
      headers: { authorization: `Bearer ${student1Token}` },
    })
    assert.equal(res.status, 200)
    assert.equal(res.headers['content-type'], 'application/pdf')
    const buf = await res.buffer()
    assert.equal(buf.subarray(0, 5).toString('ascii'), '%PDF-')
  })

  await t.test('5. Unauthorized student (Student 2) cannot access Student 1 certificate (returns 404)', async () => {
    const res = await mockRequest(app, {
      method: 'GET',
      url: `/api/certificates/${certMongoId}/preview`,
      headers: { authorization: `Bearer ${student2Token}` },
    })
    assert.equal(res.status, 404)
    const body = await res.json()
    assert.match(body.message, /not found/i)
  })

  await t.test('6. Unauthenticated request is rejected with 401', async () => {
    const res = await mockRequest(app, {
      method: 'GET',
      url: `/api/certificates/${certMongoId}/preview`,
    })
    assert.equal(res.status, 401)
  })

  await t.test('7. Missing or non-existent certificate returns 404 gracefully', async () => {
    const nonExistentId = new mongoose.Types.ObjectId()
    const res = await mockRequest(app, {
      method: 'GET',
      url: `/api/certificates/${nonExistentId}/preview`,
      headers: { authorization: `Bearer ${student1Token}` },
    })
    assert.equal(res.status, 404)
  })

  await t.test('8. GET /api/enrollments/me attaches certificate details for completed courses', async () => {
    const originalEnrollmentFind = Enrollment.find
    Enrollment.find = () => buildQuery(() => [
      {
        _id: new mongoose.Types.ObjectId(),
        userId: student1Id,
        courseId: {
          _id: courseId,
          title: 'Digital Marketing Fundamentals',
          modules: [],
          assignments: [],
          quizzes: [],
          generateCertificate: true,
        },
        status: 'completed',
        completedAt: new Date('2026-05-10T12:00:00.000Z'),
        completedLessonIds: [],
      },
    ])
    Certificate.find = () => buildQuery(() => [certDoc])

    try {
      const res = await mockRequest(app, {
        method: 'GET',
        url: '/api/enrollments/me',
        headers: { authorization: `Bearer ${student1Token}` },
      })
      const data = await res.json()
      assert.equal(res.status, 200)
      assert.ok(Array.isArray(data.enrollments))
      assert.equal(data.enrollments.length, 1)
      assert.equal(data.enrollments[0].status, 'completed')
      assert.ok(data.enrollments[0].certificate)
      assert.equal(data.enrollments[0].certificate.certificateId, certIdString)
      assert.equal(data.enrollments[0].certificate.courseName, 'Digital Marketing Fundamentals')
    } finally {
      Enrollment.find = originalEnrollmentFind
      Certificate.find = originalCertFind
    }
  })
})
