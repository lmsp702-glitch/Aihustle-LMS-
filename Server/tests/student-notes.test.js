import assert from 'node:assert/strict'
import { test } from 'node:test'
import express from 'express'
import jwt from 'jsonwebtoken'
import mongoose from 'mongoose'

process.env.JWT_SECRET = 'test-student-notes-jwt-secret'
process.env.NODE_ENV = 'test'

const [
  { default: learningRouter },
  { default: StudentNote },
  { default: Enrollment },
  { default: Course },
  { Student, CollegeStudent },
] = await Promise.all([
  import('../routes/learning.js'),
  import('../models/StudentNote.js'),
  import('../models/Enrollment.js'),
  import('../models/Course.js'),
  import('../models/account-models.js'),
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

test('Student Notes System - Complete Suite', async (t) => {
  const student1Id = new mongoose.Types.ObjectId().toString()
  const student2Id = new mongoose.Types.ObjectId().toString()
  const courseId = new mongoose.Types.ObjectId().toString()
  const lesson1Id = 'lesson-101'
  const lesson2Id = 'lesson-102'

  const token1 = jwt.sign(
    { sub: student1Id, role: 'student', accountCollection: 'students' },
    process.env.JWT_SECRET,
  )
  const token2 = jwt.sign(
    { sub: student2Id, role: 'student', accountCollection: 'students' },
    process.env.JWT_SECRET,
  )

  const student1User = {
    _id: student1Id,
    fullName: 'Alice Student',
    email: 'alice@example.com',
    role: 'student',
    studentType: 'independent',
    status: 'active',
    approvalStatus: 'approved',
    isActive: true,
  }

  const student2User = {
    _id: student2Id,
    fullName: 'Bob Student',
    email: 'bob@example.com',
    role: 'student',
    studentType: 'independent',
    status: 'active',
    approvalStatus: 'approved',
    isActive: true,
  }

  const courseDoc = {
    _id: courseId,
    title: 'Advanced Machine Learning & AI',
  }

  const enrollment1 = {
    _id: new mongoose.Types.ObjectId().toString(),
    userId: student1Id,
    courseId,
    status: 'active',
  }

  // In-memory notes store for mock testing
  let inMemoryNotes = []

  // Mock Student and CollegeStudent lookups
  const origStudentFindById = Student.findById
  Student.findById = (id) => {
    if (String(id) === student1Id) return Promise.resolve(student1User)
    if (String(id) === student2Id) return Promise.resolve(student2User)
    return Promise.resolve(null)
  }

  // Mock Course lookup
  const origCourseFindById = Course.findById
  Course.findById = (id) => buildQuery(() => (String(id) === courseId ? courseDoc : null))

  // Mock Enrollment lookup
  const origEnrollmentFindOne = Enrollment.findOne
  Enrollment.findOne = (query) => buildQuery(() => {
    if (String(query.userId) === student1Id && String(query.courseId) === courseId) {
      return enrollment1
    }
    return null
  })

  // Mock StudentNote methods
  const origStudentNoteFind = StudentNote.find
  const origStudentNoteFindOne = StudentNote.findOne
  const origStudentNoteCreate = StudentNote.create
  const origStudentNoteDeleteOne = StudentNote.deleteOne

  StudentNote.find = (query = {}) => buildQuery(() => {
    return inMemoryNotes.filter((n) => {
      if (query.studentId && String(n.studentId) !== String(query.studentId)) return false
      if (query.courseId && String(n.courseId) !== String(query.courseId)) return false
      return true
    }).map((n) => ({ ...n }))
  })

  StudentNote.findOne = (query = {}) => {
    const found = inMemoryNotes.find((n) => {
      if (query._id && String(n._id) !== String(query._id)) return false
      if (query.studentId && String(n.studentId) !== String(query.studentId)) return false
      return true
    })
    if (!found) return buildQuery(() => null)
    const doc = {
      ...found,
      save: async function () {
        const idx = inMemoryNotes.findIndex((x) => String(x._id) === String(this._id))
        if (idx !== -1) inMemoryNotes[idx] = { ...this }
        return this
      },
    }
    return buildQuery(() => doc)
  }

  StudentNote.create = async (data) => {
    const newNote = {
      _id: new mongoose.Types.ObjectId().toString(),
      ...data,
      isPinned: Boolean(data.isPinned),
      createdAt: new Date(),
      updatedAt: new Date(),
    }
    inMemoryNotes.push(newNote)
    return newNote
  }

  StudentNote.deleteOne = async (query) => {
    const prevLen = inMemoryNotes.length
    inMemoryNotes = inMemoryNotes.filter((n) => {
      if (query._id && String(n._id) === String(query._id)) {
        if (query.studentId && String(n.studentId) !== String(query.studentId)) return true
        return false
      }
      return true
    })
    return { deletedCount: prevLen - inMemoryNotes.length }
  }

  t.after(() => {
    Student.findById = origStudentFindById
    Course.findById = origCourseFindById
    Enrollment.findOne = origEnrollmentFindOne
    StudentNote.find = origStudentNoteFind
    StudentNote.findOne = origStudentNoteFindOne
    StudentNote.create = origStudentNoteCreate
    StudentNote.deleteOne = origStudentNoteDeleteOne
  })

  let createdNoteId = null

  await t.test('1. Create note with lesson association and video timestamp', async () => {
    const res = await mockRequest(app, {
      method: 'POST',
      url: `/api/courses/${courseId}/notes`,
      headers: { Authorization: `Bearer ${token1}` },
      body: {
        title: 'Neural Networks Basics',
        content: '<p>Key takeaways: <b>Backpropagation</b> is essential for gradient descent.</p>',
        lessonId: lesson1Id,
        lessonTitle: 'Introduction to Deep Learning',
        videoTimestamp: 125,
        videoTimestampDisplay: '02:05',
        isPinned: false,
      },
    })

    assert.equal(res.status, 201)
    const body = await res.json()
    assert.equal(body.note.title, 'Neural Networks Basics')
    assert.equal(body.note.lessonId, lesson1Id)
    assert.equal(body.note.videoTimestamp, 125)
    assert.equal(body.note.videoTimestampDisplay, '02:05')
    assert.equal(body.note.isPinned, false)
    assert.ok(body.note._id)
    createdNoteId = body.note._id
  })

  await t.test('2. Reject creating note with empty title', async () => {
    const res = await mockRequest(app, {
      method: 'POST',
      url: `/api/courses/${courseId}/notes`,
      headers: { Authorization: `Bearer ${token1}` },
      body: {
        title: '   ',
        content: 'Some content',
      },
    })

    assert.equal(res.status, 400)
    const body = await res.json()
    assert.match(body.message, /title is required/i)
  })

  await t.test('3. Reject creating note if student is not enrolled', async () => {
    const res = await mockRequest(app, {
      method: 'POST',
      url: `/api/courses/${courseId}/notes`,
      headers: { Authorization: `Bearer ${token2}` },
      body: {
        title: 'Unauthorized Note',
        content: 'Bob is not enrolled',
      },
    })

    assert.equal(res.status, 403)
    const body = await res.json()
    assert.match(body.message, /enroll in this course/i)
  })

  await t.test('4. Fetch course notes with total count and lessons covered count', async () => {
    // Add a second note for lesson 2
    await mockRequest(app, {
      method: 'POST',
      url: `/api/courses/${courseId}/notes`,
      headers: { Authorization: `Bearer ${token1}` },
      body: {
        title: 'Convolutional Filters',
        content: '<p>Kernel sizes: 3x3 or 5x5.</p>',
        lessonId: lesson2Id,
        lessonTitle: 'CNN Architectures',
        videoTimestamp: 340,
        videoTimestampDisplay: '05:40',
        isPinned: true,
      },
    })

    const res = await mockRequest(app, {
      method: 'GET',
      url: `/api/courses/${courseId}/notes`,
      headers: { Authorization: `Bearer ${token1}` },
    })

    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.totalCount, 2)
    assert.equal(body.lessonsCoveredCount, 2)
    assert.equal(body.pinnedCount, 1)
    assert.equal(body.notes.length, 2)
    // Pinned note should appear first
    assert.equal(body.notes[0].isPinned, true)
    assert.equal(body.notes[0].title, 'Convolutional Filters')
  })

  await t.test('5. Filter notes by search keyword and lessonId', async () => {
    // Search by title/content
    const resSearch = await mockRequest(app, {
      method: 'GET',
      url: `/api/courses/${courseId}/notes?search=neural`,
      headers: { Authorization: `Bearer ${token1}` },
    })
    assert.equal(resSearch.status, 200)
    const bodySearch = await resSearch.json()
    assert.equal(bodySearch.notes.length, 1)
    assert.equal(bodySearch.notes[0].title, 'Neural Networks Basics')

    // Filter by lesson
    const resLesson = await mockRequest(app, {
      method: 'GET',
      url: `/api/courses/${courseId}/notes?lessonId=${lesson2Id}`,
      headers: { Authorization: `Bearer ${token1}` },
    })
    assert.equal(resLesson.status, 200)
    const bodyLesson = await resLesson.json()
    assert.equal(bodyLesson.notes.length, 1)
    assert.equal(bodyLesson.notes[0].lessonId, lesson2Id)
  })

  await t.test('6. Update existing note without creating duplicate', async () => {
    const res = await mockRequest(app, {
      method: 'PUT',
      url: `/api/notes/${createdNoteId}`,
      headers: { Authorization: `Bearer ${token1}` },
      body: {
        title: 'Neural Networks Basics (Updated)',
        content: '<p>Updated content with <b>Adam optimizer</b> details.</p>',
        videoTimestamp: 150,
        videoTimestampDisplay: '02:30',
      },
    })

    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.note.title, 'Neural Networks Basics (Updated)')
    assert.equal(body.note.videoTimestamp, 150)
    assert.equal(body.note.videoTimestampDisplay, '02:30')
    assert.equal(inMemoryNotes.length, 2) // No duplicate created
  })

  await t.test('7. Toggle pin status on note', async () => {
    const res = await mockRequest(app, {
      method: 'PATCH',
      url: `/api/notes/${createdNoteId}/pin`,
      headers: { Authorization: `Bearer ${token1}` },
      body: { isPinned: true },
    })

    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.note.isPinned, true)

    // Toggle back
    const resToggle = await mockRequest(app, {
      method: 'PATCH',
      url: `/api/notes/${createdNoteId}/pin`,
      headers: { Authorization: `Bearer ${token1}` },
    })
    assert.equal(resToggle.status, 200)
    const bodyToggle = await resToggle.json()
    assert.equal(bodyToggle.note.isPinned, false)
  })

  await t.test('8. Security: Student 2 cannot update or delete Student 1 note', async () => {
    // Try to update
    const resUpdate = await mockRequest(app, {
      method: 'PUT',
      url: `/api/notes/${createdNoteId}`,
      headers: { Authorization: `Bearer ${token2}` },
      body: { title: 'Hacked Title' },
    })
    assert.equal(resUpdate.status, 404)

    // Try to delete
    const resDelete = await mockRequest(app, {
      method: 'DELETE',
      url: `/api/notes/${createdNoteId}`,
      headers: { Authorization: `Bearer ${token2}` },
    })
    assert.equal(resDelete.status, 404)

    // Verify note is still in store
    const checkNote = inMemoryNotes.find((n) => String(n._id) === createdNoteId)
    assert.ok(checkNote)
    assert.notEqual(checkNote.title, 'Hacked Title')
  })

  await t.test('9. Export notes as clean PDF with proper headers', async () => {
    const res = await mockRequest(app, {
      method: 'GET',
      url: `/api/courses/${courseId}/notes/export`,
      headers: { Authorization: `Bearer ${token1}` },
    })

    assert.equal(res.status, 200)
    assert.equal(res.headers['content-type'], 'application/pdf')
    assert.match(res.headers['content-disposition'], /attachment; filename="aiHustle-.*-Notes\.pdf"/i)
    const pdfBuffer = await res.buffer()
    assert.ok(pdfBuffer.length > 500)
    // Check PDF magic header %PDF
    assert.equal(pdfBuffer.slice(0, 4).toString(), '%PDF')
  })

  await t.test('10. Delete note by owner', async () => {
    const res = await mockRequest(app, {
      method: 'DELETE',
      url: `/api/notes/${createdNoteId}`,
      headers: { Authorization: `Bearer ${token1}` },
    })

    assert.equal(res.status, 200)
    const body = await res.json()
    assert.match(body.message, /deleted successfully/i)
    assert.equal(inMemoryNotes.length, 1)
  })
})

