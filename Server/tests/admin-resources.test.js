import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import jwt from 'jsonwebtoken'
import mongoose from 'mongoose'
import { v2 as cloudinary } from 'cloudinary'

process.env.JWT_SECRET = 'test-admin-resources-jwt-secret'
process.env.NODE_ENV = 'test'
process.env.CLOUDINARY_CLOUD_NAME = 'test-cloud'
process.env.CLOUDINARY_API_KEY = 'test-key'
process.env.CLOUDINARY_API_SECRET = 'test-secret'

const [
  { default: adminRouter },
  { default: learningRouter },
  { default: Resource },
  { default: Course },
  { default: Enrollment },
  { Admin, Student },
] = await Promise.all([
  import('../routes/admin.js'),
  import('../routes/learning.js'),
  import('../models/Resource.js'),
  import('../models/Course.js'),
  import('../models/Enrollment.js'),
  import('../models/account-models.js'),
])

const app = express()
app.use(express.json())
app.use('/api/admin', adminRouter)
app.use('/api', learningRouter)

function mockRequest(expressApp, { method = 'GET', url = '/', headers = {}, body = null, file = null }) {
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
      file: file || undefined,
    }

    const resHeaders = {}
    let statusCode = 200
    const chunks = []

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
        const jsonStr = JSON.stringify(data)
        resolve({
          status: statusCode,
          headers: resHeaders,
          json: async () => data,
          text: async () => jsonStr,
        })
        return this
      },
      send(data) {
        let resBuffer
        let resBody
        if (Buffer.isBuffer(data)) {
          resBuffer = data
          resBody = data.toString('utf8')
        } else if (typeof data === 'string') {
          resBody = data
          resBuffer = Buffer.from(data)
        } else {
          resBody = JSON.stringify(data)
          resBuffer = Buffer.from(resBody)
        }
        resolve({
          status: statusCode,
          headers: resHeaders,
          buffer: async () => resBuffer,
          json: async () => (resBody ? JSON.parse(resBody) : {}),
          text: async () => resBody,
        })
        return this
      },
      write(chunk) {
        if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
        return true
      },
      end(data) {
        if (data) chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(data))
        const resBuffer = Buffer.concat(chunks)
        const resBody = resBuffer.toString('utf8')
        resolve({
          status: statusCode,
          headers: resHeaders,
          buffer: async () => resBuffer,
          json: async () => {
            try { return JSON.parse(resBody) } catch { return {} }
          },
          text: async () => resBody,
        })
      },
      on() { return this },
      once() { return this },
      emit() { return true },
    }

    expressApp(req, res, (err) => {
      if (err) {
        resolve({
          status: err.status || 500,
          headers: {},
          json: async () => ({ message: err.message }),
          text: async () => err.message,
        })
      }
    })
  })
}

function buildQuery(getData) {
  const p = Promise.resolve().then(() => getData())
  p.select = () => p
  p.lean = () => p
  p.sort = () => p
  p.populate = () => p
  return p
}

test('Admin Resources Module & Student Resources API Suite', async (t) => {
  const adminId = new mongoose.Types.ObjectId().toString()
  const studentId = new mongoose.Types.ObjectId().toString()
  const course1Id = new mongoose.Types.ObjectId().toString()
  const course2Id = new mongoose.Types.ObjectId().toString()

  const adminToken = jwt.sign(
    { sub: adminId, role: 'main_admin', accountCollection: 'admin' },
    process.env.JWT_SECRET,
  )
  const studentToken = jwt.sign(
    { sub: studentId, role: 'student', accountCollection: 'students' },
    process.env.JWT_SECRET,
  )

  const adminUser = {
    _id: adminId,
    fullName: 'System Administrator',
    email: 'admin@aihustle.com',
    role: 'main_admin',
    status: 'active',
    isActive: true,
  }

  const studentUser = {
    _id: studentId,
    fullName: 'Jane Student',
    email: 'jane@example.com',
    role: 'student',
    studentType: 'independent',
    status: 'active',
    approvalStatus: 'approved',
    isActive: true,
  }

  const coursesStore = new Map([
    [
      course1Id,
      {
        _id: course1Id,
        title: 'Mastering Python & Machine Learning',
        category: 'Python',
        thumbnailUrl: 'https://example.com/python.jpg',
        resources: [],
      },
    ],
    [
      course2Id,
      {
        _id: course2Id,
        title: 'Prompt Engineering for Developers',
        category: 'Prompt Engineering',
        thumbnailUrl: 'https://example.com/prompt.jpg',
        resources: [],
      },
    ],
  ])

  let inMemoryResources = []
  let cloudinaryDestroyedPublicId = null

  // Mock Admin & Student lookups
  const origAdminFindById = Admin.findById
  Admin.findById = (id) => {
    if (String(id) === adminId) return Promise.resolve(adminUser)
    return Promise.resolve(null)
  }

  const origStudentFindById = Student.findById
  Student.findById = (id) => {
    if (String(id) === studentId) return Promise.resolve(studentUser)
    return Promise.resolve(null)
  }

  // Mock Course lookups
  const origCourseFindById = Course.findById
  const origCourseFindByIdAndUpdate = Course.findByIdAndUpdate
  const origCourseUpdateOne = Course.updateOne

  Course.findById = (id) => buildQuery(() => coursesStore.get(String(id)) || null)
  Course.findByIdAndUpdate = async (id, update) => {
    const doc = coursesStore.get(String(id))
    if (!doc) return null
    if (update.$push?.resources) {
      doc.resources.push(update.$push.resources)
    }
    if (update.$pull?.resources) {
      doc.resources = doc.resources.filter((r) => String(r._id) !== String(update.$pull.resources._id))
    }
    return doc
  }
  Course.updateOne = async () => ({ modifiedCount: 1 })

  // Mock Enrollment lookup: student is enrolled ONLY in course 1
  const origEnrollmentFind = Enrollment.find
  const origEnrollmentFindOne = Enrollment.findOne

  Enrollment.find = (query = {}) => buildQuery(() => {
    if (String(query.userId) === studentId) {
      return [{ _id: 'e1', userId: studentId, courseId: coursesStore.get(course1Id), status: 'active' }]
    }
    return []
  })

  Enrollment.findOne = (query = {}) => buildQuery(() => {
    if (String(query.userId) === studentId && String(query.courseId) === course1Id) {
      return { _id: 'e1', userId: studentId, courseId: course1Id, status: 'active' }
    }
    return null
  })

  // Mock Resource model
  const origResourceFind = Resource.find
  const origResourceFindById = Resource.findById
  const origResourceCreate = Resource.create
  const origResourceFindByIdAndDelete = Resource.findByIdAndDelete

  Resource.find = (query = {}) => buildQuery(() => {
    return inMemoryResources.filter((r) => {
      if (query.courseId) {
        if (query.courseId.$in) {
          const ids = query.courseId.$in.map(String)
          if (!ids.includes(String(r.courseId))) return false
        } else if (String(r.courseId) !== String(query.courseId)) {
          return false
        }
      }
      return true
    }).map((r) => ({
      ...r,
      courseId: coursesStore.get(String(r.courseId)) || { _id: r.courseId, title: 'Course' },
    }))
  })

  Resource.findById = (id) => {
    const found = inMemoryResources.find((r) => String(r._id) === String(id))
    if (!found) return buildQuery(() => null)
    const doc = {
      ...found,
      save: async function () {
        const idx = inMemoryResources.findIndex((x) => String(x._id) === String(this._id))
        if (idx !== -1) inMemoryResources[idx] = { ...this }
        return this
      },
    }
    return buildQuery(() => doc)
  }

  Resource.create = async (data) => {
    const newDoc = {
      _id: new mongoose.Types.ObjectId().toString(),
      ...data,
      createdAt: new Date(),
      updatedAt: new Date(),
    }
    inMemoryResources.push(newDoc)
    return newDoc
  }

  Resource.findByIdAndDelete = async (id) => {
    const idx = inMemoryResources.findIndex((r) => String(r._id) === String(id))
    if (idx !== -1) inMemoryResources.splice(idx, 1)
    return { ok: 1 }
  }

  // Mock Cloudinary upload & destroy
  const origCloudinaryUpload = cloudinary.uploader.upload
  const origCloudinaryDestroy = cloudinary.uploader.destroy

  cloudinary.uploader.upload = async (filePath, options) => {
    return {
      secure_url: `https://res.cloudinary.com/test-cloud/raw/upload/${options.public_id}`,
      public_id: options.public_id,
      bytes: 1024,
      format: 'pdf',
    }
  }

  cloudinary.uploader.destroy = async (publicId) => {
    cloudinaryDestroyedPublicId = publicId
    return { result: 'ok' }
  }

  t.after(() => {
    Admin.findById = origAdminFindById
    Student.findById = origStudentFindById
    Course.findById = origCourseFindById
    Course.findByIdAndUpdate = origCourseFindByIdAndUpdate
    Course.updateOne = origCourseUpdateOne
    Enrollment.find = origEnrollmentFind
    Enrollment.findOne = origEnrollmentFindOne
    Resource.find = origResourceFind
    Resource.findById = origResourceFindById
    Resource.create = origResourceCreate
    Resource.findByIdAndDelete = origResourceFindByIdAndDelete
    cloudinary.uploader.upload = origCloudinaryUpload
    cloudinary.uploader.destroy = origCloudinaryDestroy
  })

  let uploadedResourceId = null

  await t.test('1. Admin successfully uploads a PDF cheat sheet', async () => {
    const tempPdfPath = path.join(os.tmpdir(), `test-pdf-${Date.now()}.pdf`)
    fs.writeFileSync(tempPdfPath, '%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF')

    try {
      const res = await mockRequest(app, {
        method: 'POST',
        url: '/api/admin/resources',
        headers: { Authorization: `Bearer ${adminToken}` },
        body: {
          title: 'Python Data Structures Cheat Sheet',
          description: 'Comprehensive guide to lists, tuples, dicts, and sets.',
          courseId: course1Id,
        },
        file: {
          path: tempPdfPath,
          originalname: 'python-cheatsheet.pdf',
          mimetype: 'application/pdf',
          size: 1024,
        },
      })

      assert.equal(res.status, 201)
      const body = await res.json()
      assert.equal(body.resource.title, 'Python Data Structures Cheat Sheet')
      assert.equal(body.resource.format, 'pdf')
      assert.match(body.resource.url, /^https:\/\/res\.cloudinary\.com/)
      uploadedResourceId = body.resource._id
      assert.ok(uploadedResourceId)
    } finally {
      try { fs.unlinkSync(tempPdfPath) } catch {}
    }
  })

  await t.test('2. Reject resource upload by non-admin student (403)', async () => {
    const res = await mockRequest(app, {
      method: 'POST',
      url: '/api/admin/resources',
      headers: { Authorization: `Bearer ${studentToken}` },
      body: {
        title: 'Unauthorized Resource',
        courseId: course1Id,
      },
      file: {
        path: 'dummy.pdf',
        originalname: 'test.pdf',
        mimetype: 'application/pdf',
        size: 100,
      },
    })

    assert.equal(res.status, 403)
  })

  await t.test('3. Reject upload without valid PDF file signature (415)', async () => {
    const tempBadPath = path.join(os.tmpdir(), `test-bad-${Date.now()}.pdf`)
    fs.writeFileSync(tempBadPath, 'NOT A PDF FILE CONTENT')

    try {
      const res = await mockRequest(app, {
        method: 'POST',
        url: '/api/admin/resources',
        headers: { Authorization: `Bearer ${adminToken}` },
        body: {
          title: 'Fake PDF',
          courseId: course1Id,
        },
        file: {
          path: tempBadPath,
          originalname: 'fake.pdf',
          mimetype: 'application/pdf',
          size: 100,
        },
      })

      assert.equal(res.status, 415)
    } finally {
      try { fs.unlinkSync(tempBadPath) } catch {}
    }
  })

  await t.test('4. Admin fetches resources list with course details', async () => {
    const res = await mockRequest(app, {
      method: 'GET',
      url: '/api/admin/resources',
      headers: { Authorization: `Bearer ${adminToken}` },
    })

    assert.equal(res.status, 200)
    const body = await res.json()
    assert.ok(Array.isArray(body.resources))
    assert.equal(body.resources.length, 1)
    assert.equal(body.resources[0].title, 'Python Data Structures Cheat Sheet')
    assert.equal(body.resources[0].courseId.title, 'Mastering Python & Machine Learning')
  })

  await t.test('5. Admin updates resource details', async () => {
    const res = await mockRequest(app, {
      method: 'PUT',
      url: `/api/admin/resources/${uploadedResourceId}`,
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: {
        title: 'Python Data Structures Cheat Sheet (v2)',
        description: 'Updated with list comprehensions and generators.',
      },
    })

    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.resource.title, 'Python Data Structures Cheat Sheet (v2)')
    assert.equal(body.resource.description, 'Updated with list comprehensions and generators.')
  })

  await t.test('6. Student retrieves resources for their enrolled course', async () => {
    const res = await mockRequest(app, {
      method: 'GET',
      url: '/api/student/resources',
      headers: { Authorization: `Bearer ${studentToken}` },
    })

    assert.equal(res.status, 200)
    const body = await res.json()
    assert.ok(Array.isArray(body.resources))
    assert.equal(body.resources.length, 1)
    assert.equal(body.resources[0].title, 'Python Data Structures Cheat Sheet (v2)')
    assert.ok(Array.isArray(body.courses))
    assert.equal(body.courses.length, 1)
  })

  await t.test('7. Student cannot access resources for unenrolled course (403)', async () => {
    const res = await mockRequest(app, {
      method: 'GET',
      url: `/api/courses/${course2Id}/resources`,
      headers: { Authorization: `Bearer ${studentToken}` },
    })

    assert.equal(res.status, 403)
  })

  await t.test('8. Student previews PDF via authenticated file streaming endpoint (200, application/pdf)', async () => {
    const res = await mockRequest(app, {
      method: 'GET',
      url: `/api/resources/${uploadedResourceId}/file`,
      headers: { Authorization: `Bearer ${studentToken}` },
    })

    assert.equal(res.status, 200)
    assert.equal(res.headers['content-type'], 'application/pdf')
    assert.match(res.headers['content-disposition'], /inline; filename=/i)
    const buf = await res.buffer()
    assert.ok(buf.length > 0)
    assert.equal(buf.subarray(0, 5).toString('ascii'), '%PDF-')
  })

  await t.test('9. Student downloads PDF via attachment stream (200, Content-Disposition: attachment)', async () => {
    const res = await mockRequest(app, {
      method: 'GET',
      url: `/api/resources/${uploadedResourceId}/file?download=true`,
      headers: { Authorization: `Bearer ${studentToken}` },
    })

    assert.equal(res.status, 200)
    assert.equal(res.headers['content-type'], 'application/pdf')
    assert.match(res.headers['content-disposition'], /attachment; filename=/i)
    const buf = await res.buffer()
    assert.ok(buf.length > 0)
    assert.equal(buf.subarray(0, 5).toString('ascii'), '%PDF-')
  })

  await t.test('10. Student retrieves resource access metadata (200, signed URLs)', async () => {
    const res = await mockRequest(app, {
      method: 'GET',
      url: `/api/resources/${uploadedResourceId}/access`,
      headers: { Authorization: `Bearer ${studentToken}` },
    })

    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.success, true)
    assert.ok(body.url)
    assert.ok(body.proxyUrl)
  })

  await t.test('11. Unenrolled student cannot access resource file (403)', async () => {
    const resCourse2 = await Resource.create({
      title: 'Prompt Engineering Guide',
      courseId: course2Id,
      url: 'https://res.cloudinary.com/aihustle/raw/upload/prompt.pdf',
      publicId: 'prompt_abc123',
      format: 'pdf',
      fileSize: 5000,
      originalFileName: 'prompt.pdf',
      createdBy: adminId,
    })

    const res = await mockRequest(app, {
      method: 'GET',
      url: `/api/resources/${resCourse2._id}/file`,
      headers: { Authorization: `Bearer ${studentToken}` },
    })

    assert.equal(res.status, 403)
    inMemoryResources = inMemoryResources.filter((r) => String(r._id) !== String(resCourse2._id))
  })

  await t.test('12. Admin accesses resource file via admin endpoint (200, application/pdf)', async () => {
    const res = await mockRequest(app, {
      method: 'GET',
      url: `/api/admin/resources/${uploadedResourceId}/file`,
      headers: { Authorization: `Bearer ${adminToken}` },
    })

    assert.equal(res.status, 200)
    assert.equal(res.headers['content-type'], 'application/pdf')
    const buf = await res.buffer()
    assert.equal(buf.subarray(0, 5).toString('ascii'), '%PDF-')
  })

  await t.test('13. Non-existent resource returns 404', async () => {
    const randomId = new mongoose.Types.ObjectId().toString()
    const res = await mockRequest(app, {
      method: 'GET',
      url: `/api/resources/${randomId}/file`,
      headers: { Authorization: `Bearer ${adminToken}` },
    })

    assert.equal(res.status, 404)
  })

  await t.test('14. Admin deletes resource and triggers Cloudinary cleanup', async () => {
    const res = await mockRequest(app, {
      method: 'DELETE',
      url: `/api/admin/resources/${uploadedResourceId}`,
      headers: { Authorization: `Bearer ${adminToken}` },
    })

    assert.equal(res.status, 200)
    const body = await res.json()
    assert.match(body.message, /deleted successfully/i)
    assert.equal(inMemoryResources.length, 0)
    assert.ok(cloudinaryDestroyedPublicId)
  })
})
