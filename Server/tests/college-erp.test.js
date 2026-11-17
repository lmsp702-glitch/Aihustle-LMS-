import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import express from 'express'
import jwt from 'jsonwebtoken'
import mongoose from 'mongoose'

process.env.JWT_SECRET = 'test-college-erp-secret-key-1234567890'
process.env.CLIENT_ORIGIN = 'http://localhost:5173'

const [
  { default: collegeRouter },
  { CollegeAdmin, CollegeStudent },
  { default: College },
  { default: Department },
  { default: Batch },
  { default: Semester },
  { default: Faculty },
  { default: Attendance },
  { default: AcademicEvent },
  { default: Examination },
  { default: PlacementDrive },
  { default: CollegeDocument },
  { default: Course },
  { default: Enrollment },
  { default: Progress },
  { default: Notification },
] = await Promise.all([
  import('../routes/college.js'),
  import('../models/account-models.js'),
  import('../models/College.js'),
  import('../models/Department.js'),
  import('../models/Batch.js'),
  import('../models/Semester.js'),
  import('../models/Faculty.js'),
  import('../models/Attendance.js'),
  import('../models/AcademicEvent.js'),
  import('../models/Examination.js'),
  import('../models/PlacementDrive.js'),
  import('../models/CollegeDocument.js'),
  import('../models/Course.js'),
  import('../models/Enrollment.js'),
  import('../models/Progress.js'),
  import('../models/Notification.js'),
])

const app = express()
app.use(express.json())
app.use('/api/college', collegeRouter)

Notification.create = async (doc) => ({ _id: new mongoose.Types.ObjectId(), ...doc })
Semester.updateMany = async () => ({ modifiedCount: 0 })

const server = app.listen(0)
await new Promise((resolve) => server.once('listening', resolve))
const baseUrl = `http://127.0.0.1:${server.address().port}/api/college`

after(async () => {
  await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
})

function stub(target, name, implementation) {
  const original = target[name]
  target[name] = implementation
  return () => {
    target[name] = original
  }
}

function queryResult(value) {
  const result = Promise.resolve(value)
  result.select = () => result
  result.lean = () => result
  result.session = () => result
  result.collation = () => result
  result.sort = () => result
  result.skip = () => result
  result.limit = () => result
  result.populate = () => result
  return result
}

function tokenFor(role, subject, collegeId) {
  return jwt.sign(
    { role, accountCollection: 'sub_admins', ...(collegeId ? { collegeId } : {}) },
    process.env.JWT_SECRET,
    { subject, expiresIn: '15m' },
  )
}

async function request(path, { method = 'GET', subject, collegeId, body } = {}) {
  const headers = {
    Authorization: `Bearer ${tokenFor('college_admin', subject, collegeId)}`,
  }
  if (body) {
    headers['Content-Type'] = 'application/json'
  }
  return fetch(`${baseUrl}${path}`, {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
}

// 1. Student 360° Profile API
test('student 360 profile endpoint aggregates personal, academic, attendance, exam, and course records', async () => {
  const collegeId = new mongoose.Types.ObjectId()
  const adminId = new mongoose.Types.ObjectId()
  const studentId = new mongoose.Types.ObjectId()

  const restoreAdmin = stub(CollegeAdmin, 'findById', () =>
    Promise.resolve({ _id: adminId, collegeId, role: 'college_admin', status: 'active', isActive: true }),
  )
  const restoreStudent = stub(CollegeStudent, 'findOne', () =>
    queryResult({
      _id: studentId,
      collegeId,
      fullName: 'Aarav Patel',
      studentId: 'STU-2026-001',
      email: 'aarav@apex.edu',
      department: 'Computer Science',
      batch: '2025-2029',
      cgpa: 8.5,
      academicStanding: 'good',
    }),
  )
  const restoreEnrollments = stub(Enrollment, 'find', () => queryResult([]))
  const restoreProgress = stub(Progress, 'find', () => queryResult([]))
  const restoreAttendance = stub(Attendance, 'find', () =>
    queryResult([
      { date: new Date(), subject: 'Data Structures', batch: '2025-2029', records: [{ studentId, status: 'present' }] },
    ]),
  )
  const restoreExams = stub(Examination, 'find', () =>
    queryResult([
      {
        title: 'Mid-Term',
        examType: 'mid_term',
        subject: 'Algorithms',
        results: [{ studentId, marksObtained: 85, maxMarks: 100, grade: 'A', isPass: true, backlog: false }],
      },
    ]),
  )
  const restorePlacements = stub(PlacementDrive, 'find', () => queryResult([]))

  try {
    const res = await request(`/students/${studentId}/360`, {
      subject: String(adminId),
      collegeId: String(collegeId),
    })
    assert.equal(res.status, 200)
    const data = await res.json()
    assert.equal(data.student.fullName, 'Aarav Patel')
    assert.equal(data.student.cgpa, 8.5)
    assert.equal(data.attendance.percentage, 100)
    assert.equal(data.examinations.results.length, 1)
    assert.equal(data.examinations.results[0].grade, 'A')
  } finally {
    restorePlacements()
    restoreExams()
    restoreAttendance()
    restoreProgress()
    restoreEnrollments()
    restoreStudent()
    restoreAdmin()
  }
})

// 2. Semesters CRUD
test('college can create and retrieve academic semesters', async () => {
  const collegeId = new mongoose.Types.ObjectId()
  const adminId = new mongoose.Types.ObjectId()

  const restoreAdmin = stub(CollegeAdmin, 'findById', () =>
    Promise.resolve({ _id: adminId, collegeId, role: 'college_admin', status: 'active', isActive: true }),
  )
  const restoreSemCreate = stub(Semester, 'create', async (doc) => ({
    _id: new mongoose.Types.ObjectId(),
    ...doc,
  }))
  const restoreSemFind = stub(Semester, 'find', () =>
    queryResult([{ name: 'Semester 1', academicYear: '2025-2026', status: 'active' }]),
  )

  try {
    const createRes = await request('/semesters', {
      method: 'POST',
      subject: String(adminId),
      collegeId: String(collegeId),
      body: {
        name: 'Semester 1',
        academicYear: '2025-2026',
        department: 'Computer Science',
        isCurrent: true,
        subjects: [{ code: 'CS101', name: 'Intro to CS', credits: 4 }],
      },
    })
    assert.equal(createRes.status, 201)
    const created = await createRes.json()
    assert.equal(created.semester.name, 'Semester 1')

    const listRes = await request('/semesters', {
      subject: String(adminId),
      collegeId: String(collegeId),
    })
    assert.equal(listRes.status, 200)
    const listData = await listRes.json()
    assert.equal(listData.semesters.length, 1)
  } finally {
    restoreSemFind()
    restoreSemCreate()
    restoreAdmin()
  }
})

// 3. Faculty Management
test('college can create faculty profile with auto-generated ID', async () => {
  const collegeId = new mongoose.Types.ObjectId()
  const adminId = new mongoose.Types.ObjectId()

  const restoreAdmin = stub(CollegeAdmin, 'findById', () =>
    Promise.resolve({ _id: adminId, collegeId, role: 'college_admin', status: 'active', isActive: true }),
  )
  const restoreFacFindOne = stub(Faculty, 'findOne', () => queryResult(null))
  let createdFacultyDoc = null
  const restoreFacCreate = stub(Faculty, 'create', async (doc) => {
    createdFacultyDoc = { _id: new mongoose.Types.ObjectId(), ...doc }
    return createdFacultyDoc
  })

  try {
    const res = await request('/faculty', {
      method: 'POST',
      subject: String(adminId),
      collegeId: String(collegeId),
      body: {
        fullName: 'Dr. Alan Turing',
        email: 'alan.turing@apex.edu',
        department: 'Computer Science',
        designation: 'Professor',
        qualification: 'Ph.D. in Mathematics',
      },
    })
    assert.equal(res.status, 201)
    const data = await res.json()
    assert.equal(data.faculty.fullName, 'Dr. Alan Turing')
    assert.match(createdFacultyDoc.facultyId, /^FAC-/)
  } finally {
    restoreFacCreate()
    restoreFacFindOne()
    restoreAdmin()
  }
})

// 4. Attendance Management & Low Attendance Warning Alert
test('college can record attendance and calculate low attendance warning statistics', async () => {
  const collegeId = new mongoose.Types.ObjectId()
  const adminId = new mongoose.Types.ObjectId()
  const student1Id = new mongoose.Types.ObjectId()

  const restoreAdmin = stub(CollegeAdmin, 'findById', () =>
    Promise.resolve({ _id: adminId, collegeId, role: 'college_admin', status: 'active', isActive: true }),
  )
  const restoreAttCreate = stub(Attendance, 'create', async (doc) => ({
    _id: new mongoose.Types.ObjectId(),
    ...doc,
  }))
  const restoreAttFind = stub(Attendance, 'find', () =>
    queryResult([
      {
        department: 'Computer Science',
        batch: '2025-2029',
        subject: 'Data Structures',
        records: [
          { studentId: student1Id, studentName: 'John Low', studentRollNo: 'CS001', status: 'absent' },
        ],
      },
    ]),
  )

  try {
    // Record
    const recordRes = await request('/attendance', {
      method: 'POST',
      subject: String(adminId),
      collegeId: String(collegeId),
      body: {
        department: 'Computer Science',
        batch: '2025-2029',
        subject: 'Data Structures',
        records: [{ studentId: String(student1Id), studentName: 'John Low', status: 'absent' }],
      },
    })
    assert.equal(recordRes.status, 201)

    // Stats (< 75% warning)
    const statsRes = await request('/attendance/stats?threshold=75', {
      subject: String(adminId),
      collegeId: String(collegeId),
    })
    assert.equal(statsRes.status, 200)
    const stats = await statsRes.json()
    assert.equal(stats.lowAttendanceCount, 1)
    assert.equal(stats.lowAttendanceStudents[0].studentName, 'John Low')
    assert.equal(stats.lowAttendanceStudents[0].rate, 0)
  } finally {
    restoreAttFind()
    restoreAttCreate()
    restoreAdmin()
  }
})

// 5. Examinations, Bulk Results & Automatic Grading
test('recording exam results calculates grades (A+, A, B, etc.) and tracks backlogs', async () => {
  const collegeId = new mongoose.Types.ObjectId()
  const adminId = new mongoose.Types.ObjectId()
  const examId = new mongoose.Types.ObjectId()
  const student1Id = new mongoose.Types.ObjectId()
  const student2Id = new mongoose.Types.ObjectId()

  const examDoc = {
    _id: examId,
    collegeId,
    title: 'Mid-Term Algorithms',
    subject: 'Algorithms',
    maxMarks: 100,
    passingMarks: 40,
    results: [],
    save: async () => examDoc,
  }

  const restoreAdmin = stub(CollegeAdmin, 'findById', () =>
    Promise.resolve({ _id: adminId, collegeId, role: 'college_admin', status: 'active', isActive: true }),
  )
  const restoreExamFind = stub(Examination, 'findOne', () => Promise.resolve(examDoc))

  try {
    const res = await request(`/examinations/${examId}/results`, {
      method: 'POST',
      subject: String(adminId),
      collegeId: String(collegeId),
      body: {
        results: [
          { studentId: String(student1Id), studentName: 'High Scorer', marksObtained: 95 },
          { studentId: String(student2Id), studentName: 'Backlog Student', marksObtained: 32 },
        ],
      },
    })
    assert.equal(res.status, 200)
    assert.equal(examDoc.results.length, 2)
    assert.equal(examDoc.results[0].grade, 'A+')
    assert.equal(examDoc.results[0].isPass, true)
    assert.equal(examDoc.results[0].backlog, false)
    assert.equal(examDoc.results[1].grade, 'F')
    assert.equal(examDoc.results[1].isPass, false)
    assert.equal(examDoc.results[1].backlog, true)
  } finally {
    restoreExamFind()
    restoreAdmin()
  }
})

// 6. Placement Management & Placed Status Sync
test('marking placement application as placed updates student placementStatus', async () => {
  const collegeId = new mongoose.Types.ObjectId()
  const adminId = new mongoose.Types.ObjectId()
  const driveId = new mongoose.Types.ObjectId()
  const studentId = new mongoose.Types.ObjectId()
  const appId = new mongoose.Types.ObjectId()

  const application = {
    _id: appId,
    studentId,
    status: 'interviewing',
    offeredPackage: 0,
  }
  const driveDoc = {
    _id: driveId,
    collegeId,
    companyName: 'TechCorp Global',
    packageLpa: 12,
    applications: {
      id: () => application,
    },
    save: async () => driveDoc,
  }

  let studentUpdated = false
  const restoreAdmin = stub(CollegeAdmin, 'findById', () =>
    Promise.resolve({ _id: adminId, collegeId, role: 'college_admin', status: 'active', isActive: true }),
  )
  const restoreDriveFind = stub(PlacementDrive, 'findOne', () => Promise.resolve(driveDoc))
  const restoreStudentUpdate = stub(CollegeStudent, 'updateOne', async (query, update) => {
    if (update?.$set?.placementStatus === 'placed') studentUpdated = true
    return { modifiedCount: 1 }
  })

  try {
    const res = await request(`/placements/${driveId}/applications/${appId}`, {
      method: 'PATCH',
      subject: String(adminId),
      collegeId: String(collegeId),
      body: {
        status: 'placed',
        offeredPackage: 14,
      },
    })
    assert.equal(res.status, 200)
    assert.equal(application.status, 'placed')
    assert.equal(application.offeredPackage, 14)
    assert.equal(studentUpdated, true)
  } finally {
    restoreStudentUpdate()
    restoreDriveFind()
    restoreAdmin()
  }
})

// 7. AI College Assistant Interface
test('ai assistant natural language query engine returns verified data-backed answers with college isolation', async () => {
  const collegeId = new mongoose.Types.ObjectId()
  const adminId = new mongoose.Types.ObjectId()

  const restoreAdmin = stub(CollegeAdmin, 'findById', () =>
    Promise.resolve({ _id: adminId, collegeId, role: 'college_admin', status: 'active', isActive: true }),
  )
  const restoreStudents = stub(CollegeStudent, 'find', () =>
    queryResult([
      { _id: new mongoose.Types.ObjectId(), fullName: 'Alice', department: 'CS', batch: '2026', isActive: true },
    ]),
  )
  const restoreProgress = stub(Progress, 'find', () => queryResult([]))
  const restoreAttendance = stub(Attendance, 'find', () => queryResult([]))
  const restoreExams = stub(Examination, 'find', () => queryResult([]))
  const restoreDepts = stub(Department, 'find', () => queryResult([{ name: 'Computer Science', code: 'CS' }]))
  const restoreBatches = stub(Batch, 'find', () => queryResult([{ name: '2026', department: 'CS' }]))
  const restorePlacements = stub(PlacementDrive, 'find', () => queryResult([]))

  try {
    const res = await request('/ai-assistant', {
      method: 'POST',
      subject: String(adminId),
      collegeId: String(collegeId),
      body: {
        prompt: 'Generate weekly academic summary for our college',
      },
    })
    assert.equal(res.status, 200)
    const data = await res.json()
    assert.equal(data.isRealData, true)
    assert.equal(data.collegeId, String(collegeId))
    assert.match(data.answer, /Weekly Academic Summary/)
  } finally {
    restorePlacements()
    restoreBatches()
    restoreDepts()
    restoreExams()
    restoreAttendance()
    restoreProgress()
    restoreStudents()
    restoreAdmin()
  }
})

// 8. Reports & Documents Management
test('college can upload documents and export reports as standard CSV', async () => {
  const collegeId = new mongoose.Types.ObjectId()
  const adminId = new mongoose.Types.ObjectId()

  const restoreAdmin = stub(CollegeAdmin, 'findById', () =>
    Promise.resolve({ _id: adminId, collegeId, role: 'college_admin', status: 'active', isActive: true }),
  )
  const restoreDocCreate = stub(CollegeDocument, 'create', async (doc) => ({
    _id: new mongoose.Types.ObjectId(),
    ...doc,
  }))
  const restoreStudentsFind = stub(CollegeStudent, 'find', () =>
    queryResult([
      {
        fullName: 'Bob Smith',
        studentId: 'STU-001',
        email: 'bob@apex.edu',
        department: 'CS',
        batch: '2026',
        cgpa: 7.8,
        status: 'active',
      },
    ]),
  )

  try {
    // Document upload
    const uploadRes = await request('/documents', {
      method: 'POST',
      subject: String(adminId),
      collegeId: String(collegeId),
      body: {
        title: 'NAAC Criteria 1 Report',
        category: 'naac_nba',
        fileName: 'naac-crit1.pdf',
        fileSize: 1048576,
      },
    })
    assert.equal(uploadRes.status, 201)

    // Export report
    const exportRes = await request('/reports/export?reportType=students', {
      subject: String(adminId),
      collegeId: String(collegeId),
    })
    assert.equal(exportRes.status, 200)
    const csv = await exportRes.text()
    assert.match(csv, /Full Name,Student ID,Email/)
    assert.match(csv, /Bob Smith/)
  } finally {
    restoreStudentsFind()
    restoreDocCreate()
    restoreAdmin()
  }
})
