import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import bcrypt from 'bcryptjs'
import express from 'express'
import jwt from 'jsonwebtoken'
import mongoose from 'mongoose'

process.env.JWT_SECRET = 'test-college-secret-key-1234567890'
process.env.SMTP_HOST = ''
process.env.CLIENT_ORIGIN = 'http://localhost:5173'

const [
  { default: collegeRouter },
  { default: authRouter },
  { default: adminRouter },
  { AccountIdentity },
  { CollegeAdmin, Admin, CollegeStudent, Student },
  { default: College },
  { default: Course },
  { default: Enrollment },
  { default: Department },
  { default: Batch },
  { default: Notification },
  { default: Progress },
  { default: Faculty },
  { default: Attendance },
  { default: Examination },
  { default: PlacementDrive },
  { default: AcademicEvent },
  { default: Semester },
  { default: CollegeDocument },
] = await Promise.all([
  import('../routes/college.js'),
  import('../routes/auth.js'),
  import('../routes/admin.js'),
  import('../models/AccountIdentity.js').then((m) => ({ AccountIdentity: m.default })),
  import('../models/account-models.js'),
  import('../models/College.js'),
  import('../models/Course.js'),
  import('../models/Enrollment.js'),
  import('../models/Department.js'),
  import('../models/Batch.js'),
  import('../models/Notification.js'),
  import('../models/Progress.js'),
  import('../models/Faculty.js'),
  import('../models/Attendance.js'),
  import('../models/Examination.js'),
  import('../models/PlacementDrive.js'),
  import('../models/AcademicEvent.js'),
  import('../models/Semester.js'),
  import('../models/CollegeDocument.js'),
])

const app = express()
app.use(express.json())
app.use('/api/college', collegeRouter)
app.use('/api/auth', authRouter)
app.use('/api/admin', adminRouter)

// Global test stubs to prevent unbuffered DB calls in unit tests
Notification.create = async (doc) => ({ _id: new mongoose.Types.ObjectId(), ...doc })
if (mongoose.models.RefreshSession) {
  mongoose.models.RefreshSession.create = async () => ({})
}
Faculty.countDocuments = async () => 0
Faculty.aggregate = async () => []
Faculty.find = () => queryResult([])
Attendance.find = () => queryResult([])
Examination.find = () => queryResult([])
PlacementDrive.find = () => queryResult([])
AcademicEvent.find = () => queryResult([])
Semester.find = () => queryResult([])
CollegeDocument.find = () => queryResult([])

const server = app.listen(0)
await new Promise((resolve) => server.once('listening', resolve))
const baseUrl = `http://127.0.0.1:${server.address().port}/api`

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

function tokenFor(role, subject, collegeId, accountCollection) {
  const collection =
    accountCollection ||
    {
      main_admin: 'admin',
      college_admin: 'sub_admins',
      student: 'clg_students',
    }[role]
  return jwt.sign(
    { role, accountCollection: collection, ...(collegeId ? { collegeId } : {}) },
    process.env.JWT_SECRET,
    { subject, expiresIn: '15m' },
  )
}

async function request(path, { method = 'GET', role, subject, collegeId, body, headers: customHeaders = {} } = {}) {
  const headers = { ...customHeaders }
  if (role) {
    headers.Authorization = `Bearer ${tokenFor(role, subject, collegeId)}`
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

// -------------------------------------------------------------
// 1. COMMON LOGIN WITH AUTOMATIC ROLE DETECTION
// -------------------------------------------------------------
test('common login auto-detects College Admin role when role is omitted', async () => {
  const collegeId = new mongoose.Types.ObjectId()
  const subAdminId = new mongoose.Types.ObjectId()
  const passwordHash = await bcrypt.hash('collegePass123', 4)

  const restoreIdentity = stub(AccountIdentity, 'findOne', () =>
    queryResult({
      accountCollection: 'sub_admins',
      accountId: subAdminId,
      email: 'dean@apex.edu',
      username: 'apex_admin',
    }),
  )
  const restoreSubAdmin = stub(CollegeAdmin, 'findById', () => {
    const res = Promise.resolve({
      _id: subAdminId,
      collegeId,
      email: 'dean@apex.edu',
      username: 'apex_admin',
      role: 'college_admin',
      status: 'active',
      isActive: true,
      passwordHash,
    })
    res.select = () => res
    return res
  })

  try {
    const res = await request('/auth/login', {
      method: 'POST',
      body: { identifier: 'dean@apex.edu', password: 'collegePass123' },
    })
    assert.equal(res.status, 200)
    const data = await res.json()
    assert.equal(data.user.role, 'college_admin')
    assert.equal(data.user.collegeId, String(collegeId))
    assert.equal(data.user.isActive, true)
    const payload = jwt.verify(data.token, process.env.JWT_SECRET)
    assert.equal(payload.role, 'college_admin')
    assert.equal(payload.accountCollection, 'sub_admins')

    const dashRes = await request('/auth/dashboard/college_admin', {
      headers: { Authorization: `Bearer ${data.token}` },
    })
    assert.equal(dashRes.status, 200)
    const dashData = await dashRes.json()
    assert.equal(dashData.user.role, 'college_admin')
    assert.equal(dashData.user.collegeId, String(collegeId))
    assert.equal(dashData.user.isActive, true)
  } finally {
    restoreSubAdmin()
    restoreIdentity()
  }
})

test('common login auto-detects Student role when role is omitted', async () => {
  const studentId = new mongoose.Types.ObjectId()
  const passwordHash = await bcrypt.hash('studentPass123', 4)

  const restoreIdentity = stub(AccountIdentity, 'findOne', () =>
    queryResult({
      accountCollection: 'clg_students',
      accountId: studentId,
      email: 'student@apex.edu',
      username: 'apex_student',
    }),
  )
  const restoreStudent = stub(CollegeStudent, 'findById', () => {
    const res = Promise.resolve({
      _id: studentId,
      email: 'student@apex.edu',
      username: 'apex_student',
      role: 'student',
      studentType: 'college',
      status: 'active',
      isActive: true,
      passwordHash,
    })
    res.select = () => res
    return res
  })

  try {
    const res = await request('/auth/login', {
      method: 'POST',
      body: { identifier: 'student@apex.edu', password: 'studentPass123' },
    })
    assert.equal(res.status, 200)
    const data = await res.json()
    assert.equal(data.user.role, 'student')
  } finally {
    restoreStudent()
    restoreIdentity()
  }
})

// -------------------------------------------------------------
// 2. COLLEGE DASHBOARD OVERVIEW
// -------------------------------------------------------------
test('college dashboard returns overview stats, department/batch lists and notifications', async () => {
  const collegeId = new mongoose.Types.ObjectId()
  const adminId = new mongoose.Types.ObjectId()

  const restoreAdmin = stub(CollegeAdmin, 'findById', () =>
    Promise.resolve({
      _id: adminId,
      collegeId,
      role: 'college_admin',
      status: 'active',
      isActive: true,
    }),
  )
  const restoreCollege = stub(College, 'findById', () =>
    queryResult({
      _id: collegeId,
      name: 'Apex Institute of Technology',
      code: 'APEX',
      status: 'active',
    }),
  )
  const restoreStudentCount = stub(CollegeStudent, 'countDocuments', async () => 120)
  const restoreDepts = stub(Department, 'find', () =>
    queryResult([{ name: 'Computer Science', code: 'CS' }]),
  )
  const restoreBatches = stub(Batch, 'find', () =>
    queryResult([{ name: '2025-2029 CS', academicYear: '2025-2029', department: 'Computer Science' }]),
  )
  const restoreEnrollments = stub(Enrollment, 'distinct', async () => ['c1', 'c2'])
  const restoreProgress = stub(Progress, 'find', () =>
    queryResult([{ progressPercentage: 80, status: 'in-progress' }]),
  )
  const restoreRecentEnroll = stub(Enrollment, 'find', () => queryResult([]))
  const restoreNotifs = stub(Notification, 'find', () => queryResult([]))
  const restoreNotifCount = stub(Notification, 'countDocuments', async () => 2)
  const restoreCourseCount = stub(Course, 'countDocuments', async () => 15)
  const restoreStudentDistinct = stub(CollegeStudent, 'distinct', async () => [])

  try {
    const res = await request('/college/dashboard', {
      role: 'college_admin',
      subject: String(adminId),
      collegeId: String(collegeId),
    })
    assert.equal(res.status, 200)
    const data = await res.json()
    assert.equal(data.college.name, 'Apex Institute of Technology')
    assert.equal(data.stats.totalStudents, 120)
    assert.equal(data.stats.totalAssignedCourses, 2)
    assert.equal(data.stats.totalPublishedCourses, 15)
    assert.equal(data.stats.unreadNotifications, 2)
    assert.equal(data.departments.length, 1)
  } finally {
    restoreStudentDistinct()
    restoreCourseCount()
    restoreNotifCount()
    restoreNotifs()
    restoreRecentEnroll()
    restoreProgress()
    restoreEnrollments()
    restoreBatches()
    restoreDepts()
    restoreStudentCount()
    restoreCollege()
    restoreAdmin()
  }
})

// -------------------------------------------------------------
// 3. DEPARTMENT MANAGEMENT & SAFE DELETION
// -------------------------------------------------------------
test('college can create and list departments', async () => {
  const collegeId = new mongoose.Types.ObjectId()
  const adminId = new mongoose.Types.ObjectId()

  const restoreAdmin = stub(CollegeAdmin, 'findById', () =>
    Promise.resolve({ _id: adminId, collegeId, role: 'college_admin', status: 'active', isActive: true }),
  )
  const restoreFindOne = stub(Department, 'findOne', () => queryResult(null))
  const restoreCreate = stub(Department, 'create', async (doc) => ({
    _id: new mongoose.Types.ObjectId(),
    ...doc,
  }))
  const restoreFind = stub(Department, 'find', () =>
    queryResult([
      { _id: new mongoose.Types.ObjectId(), name: 'Mechanical Engineering', code: 'ME', collegeId },
    ]),
  )
  const restoreAggregateBatch = stub(Batch, 'aggregate', async () => [])
  const restoreAggregateStudent = stub(CollegeStudent, 'aggregate', async () => [])

  try {
    // Create
    const createRes = await request('/college/departments', {
      method: 'POST',
      role: 'college_admin',
      subject: String(adminId),
      collegeId: String(collegeId),
      body: { name: 'Mechanical Engineering', code: 'ME', description: 'Department of ME' },
    })
    assert.equal(createRes.status, 201)
    const created = await createRes.json()
    assert.equal(created.department.name, 'Mechanical Engineering')

    // List
    const listRes = await request('/college/departments', {
      role: 'college_admin',
      subject: String(adminId),
      collegeId: String(collegeId),
    })
    assert.equal(listRes.status, 200)
    const listData = await listRes.json()
    assert.equal(listData.departments.length, 1)
    assert.equal(listData.departments[0].code, 'ME')
  } finally {
    restoreAggregateStudent()
    restoreAggregateBatch()
    restoreFind()
    restoreCreate()
    restoreFindOne()
    restoreAdmin()
  }
})

test('college cannot delete department with assigned students or batches (safe delete)', async () => {
  const collegeId = new mongoose.Types.ObjectId()
  const adminId = new mongoose.Types.ObjectId()
  const deptId = new mongoose.Types.ObjectId()

  const restoreAdmin = stub(CollegeAdmin, 'findById', () =>
    Promise.resolve({ _id: adminId, collegeId, role: 'college_admin', status: 'active', isActive: true }),
  )
  const restoreDept = stub(Department, 'findOne', () =>
    queryResult({ _id: deptId, name: 'Computer Science', code: 'CS', collegeId }),
  )
  const restoreBatchCount = stub(Batch, 'countDocuments', async () => 2)
  const restoreStudentCount = stub(CollegeStudent, 'countDocuments', async () => 45)

  try {
    const res = await request(`/college/departments/${deptId}`, {
      method: 'DELETE',
      role: 'college_admin',
      subject: String(adminId),
      collegeId: String(collegeId),
    })
    assert.equal(res.status, 409)
    const data = await res.json()
    assert.match(data.message, /Cannot delete department/)
  } finally {
    restoreStudentCount()
    restoreBatchCount()
    restoreDept()
    restoreAdmin()
  }
})

// -------------------------------------------------------------
// 4. BATCH MANAGEMENT
// -------------------------------------------------------------
test('college can create and list batches', async () => {
  const collegeId = new mongoose.Types.ObjectId()
  const adminId = new mongoose.Types.ObjectId()
  const deptId = new mongoose.Types.ObjectId()

  const restoreAdmin = stub(CollegeAdmin, 'findById', () =>
    Promise.resolve({ _id: adminId, collegeId, role: 'college_admin', status: 'active', isActive: true }),
  )
  const restoreDept = stub(Department, 'findOne', () =>
    queryResult({ _id: deptId, name: 'Electrical Engineering', collegeId }),
  )
  const restoreBatchFindOne = stub(Batch, 'findOne', () => queryResult(null))
  const restoreBatchCreate = stub(Batch, 'create', async (doc) => ({
    _id: new mongoose.Types.ObjectId(),
    ...doc,
  }))
  const restoreBatchFind = stub(Batch, 'find', () =>
    queryResult([
      {
        _id: new mongoose.Types.ObjectId(),
        name: '2024-2028 EE',
        academicYear: '2024-2028',
        department: 'Electrical Engineering',
        collegeId,
      },
    ]),
  )
  const restoreAggregateStudent = stub(CollegeStudent, 'aggregate', async () => [])

  try {
    const createRes = await request('/college/batches', {
      method: 'POST',
      role: 'college_admin',
      subject: String(adminId),
      collegeId: String(collegeId),
      body: {
        name: '2024-2028 EE',
        academicYear: '2024-2028',
        department: 'Electrical Engineering',
      },
    })
    assert.equal(createRes.status, 201)
    const created = await createRes.json()
    assert.equal(created.batch.name, '2024-2028 EE')

    const listRes = await request('/college/batches', {
      role: 'college_admin',
      subject: String(adminId),
      collegeId: String(collegeId),
    })
    assert.equal(listRes.status, 200)
    const list = await listRes.json()
    assert.equal(list.batches.length, 1)
  } finally {
    restoreAggregateStudent()
    restoreBatchFind()
    restoreBatchCreate()
    restoreBatchFindOne()
    restoreDept()
    restoreAdmin()
  }
})

// -------------------------------------------------------------
// 5. STUDENT CREATION WITH GENERATED CREDENTIALS & LOGIN
// -------------------------------------------------------------
test('college can create a student with login credentials', async () => {
  const collegeId = new mongoose.Types.ObjectId()
  const adminId = new mongoose.Types.ObjectId()
  let createdStudent = null
  let createdIdentity = null

  const restoreAdmin = stub(CollegeAdmin, 'findById', () =>
    Promise.resolve({ _id: adminId, collegeId, role: 'college_admin', status: 'active', isActive: true }),
  )
  const restoreIdentityExists = stub(AccountIdentity, 'exists', async () => null)
  const restoreStudentExists = stub(CollegeStudent, 'exists', async () => null)
  const restoreStudentFindOne = stub(CollegeStudent, 'findOne', () => queryResult(null))
  const restoreAdminExists = stub(Admin, 'exists', async () => null)
  const restoreAdminFindOne = stub(Admin, 'findOne', () => queryResult(null))
  const restoreCollegeAdminExists = stub(CollegeAdmin, 'exists', async () => null)
  const restoreCollegeAdminFindOne = stub(CollegeAdmin, 'findOne', () => queryResult(null))
  const restoreIndStudentExists = stub(Student, 'exists', async () => null)
  const restoreIndStudentFindOne = stub(Student, 'findOne', () => queryResult(null))
  const restoreSession = stub(mongoose, 'startSession', async () => ({
    withTransaction: async (fn) => fn(),
    endSession: async () => {},
  }))
  const restoreStudentCreate = stub(CollegeStudent, 'create', async (docs) => {
    createdStudent = {
      _id: new mongoose.Types.ObjectId(),
      ...docs[0],
    }
    return [createdStudent]
  })
  const restoreIdentityCreate = stub(AccountIdentity, 'create', async (docs) => {
    createdIdentity = {
      _id: new mongoose.Types.ObjectId(),
      ...docs[0],
    }
    return [createdIdentity]
  })

  try {
    const res = await request('/college/students', {
      method: 'POST',
      role: 'college_admin',
      subject: String(adminId),
      collegeId: String(collegeId),
      body: {
        fullName: 'Rahul Sharma',
        email: 'rahul.sharma@apex.edu',
        studentId: 'APEX-2025-001',
        department: 'Computer Science',
        batch: '2025-2029 CS',
        password: 'StudentSecurePass99!',
      },
    })
    assert.equal(res.status, 201)
    const data = await res.json()
    assert.equal(data.student.fullName, 'Rahul Sharma')
    assert.equal(data.credentials.email, 'rahul.sharma@apex.edu')
    assert.equal(data.credentials.temporaryPassword, 'StudentSecurePass99!')
    assert.equal(createdStudent.role, 'student')
    assert.equal(createdStudent.studentType, 'college')
    assert.equal(String(createdStudent.collegeId), String(collegeId))
    assert.equal(createdIdentity.accountCollection, 'clg_students')
  } finally {
    restoreIndStudentFindOne()
    restoreIndStudentExists()
    restoreCollegeAdminFindOne()
    restoreCollegeAdminExists()
    restoreAdminFindOne()
    restoreAdminExists()
    restoreIdentityCreate()
    restoreStudentCreate()
    restoreSession()
    restoreStudentFindOne()
    restoreStudentExists()
    restoreIdentityExists()
    restoreAdmin()
  }
})

// -------------------------------------------------------------
// 6. COURSE ASSIGNMENT TO STUDENTS, DEPARTMENTS, OR BATCHES
// -------------------------------------------------------------
test('college can assign courses to specific department or batch', async () => {
  const collegeId = new mongoose.Types.ObjectId()
  const adminId = new mongoose.Types.ObjectId()
  const courseId = new mongoose.Types.ObjectId()
  const student1Id = new mongoose.Types.ObjectId()
  const student2Id = new mongoose.Types.ObjectId()

  const restoreAdmin = stub(CollegeAdmin, 'findById', () =>
    Promise.resolve({ _id: adminId, collegeId, role: 'college_admin', status: 'active', isActive: true }),
  )
  const restoreCourse = stub(Course, 'findOne', () =>
    queryResult({ _id: courseId, title: 'Full Stack Development', status: 'published' }),
  )
  const restoreStudents = stub(CollegeStudent, 'find', () =>
    queryResult([
      { _id: student1Id, collegeId, department: 'CS', batch: '2025-2029' },
      { _id: student2Id, collegeId, department: 'CS', batch: '2025-2029' },
    ]),
  )
  const restoreEnrollmentFind = stub(Enrollment, 'find', () => queryResult([]))
  let insertedEnrollments = 0
  const restoreInsertMany = stub(Enrollment, 'insertMany', async (docs) => {
    insertedEnrollments += docs.length
    return docs
  })
  const restoreBulkWriteProg = stub(Progress, 'bulkWrite', async () => ({}))

  try {
    const res = await request('/college/courses/assign', {
      method: 'POST',
      role: 'college_admin',
      subject: String(adminId),
      collegeId: String(collegeId),
      body: {
        courseId: String(courseId),
        targetType: 'department',
        department: 'CS',
      },
    })
    assert.equal(res.status, 201)
    const data = await res.json()
    assert.equal(data.enrolledCount, 2)
    assert.equal(insertedEnrollments, 2)
  } finally {
    restoreBulkWriteProg()
    restoreInsertMany()
    restoreEnrollmentFind()
    restoreStudents()
    restoreCourse()
    restoreAdmin()
  }
})

// -------------------------------------------------------------
// 7. DATA ISOLATION BETWEEN COLLEGES
// -------------------------------------------------------------
test('college A cannot access or modify college B student', async () => {
  const collegeAId = new mongoose.Types.ObjectId()
  const collegeBId = new mongoose.Types.ObjectId()
  const adminAId = new mongoose.Types.ObjectId()
  const studentBId = new mongoose.Types.ObjectId()

  const restoreAdmin = stub(CollegeAdmin, 'findById', () =>
    Promise.resolve({ _id: adminAId, collegeId: collegeAId, role: 'college_admin', status: 'active', isActive: true }),
  )
  // Student belongs to college B
  const restoreStudent = stub(CollegeStudent, 'findOne', (query) => {
    if (String(query?.collegeId) === String(collegeBId)) {
      return queryResult({ _id: studentBId, collegeId: collegeBId, fullName: 'Bob' })
    }
    return queryResult(null) // College A finds nothing!
  })

  try {
    const res = await request(`/college/students/${studentBId}`, {
      method: 'PUT',
      role: 'college_admin',
      subject: String(adminAId),
      collegeId: String(collegeAId),
      body: { fullName: 'Hacked Name' },
    })
    assert.equal(res.status, 404)
    const data = await res.json()
    assert.match(data.message, /not found/i)
  } finally {
    restoreStudent()
    restoreAdmin()
  }
})

// -------------------------------------------------------------
// 8. NOTIFICATIONS & PROFILE SETTINGS
// -------------------------------------------------------------
test('college can list notifications and mark all as read', async () => {
  const collegeId = new mongoose.Types.ObjectId()
  const adminId = new mongoose.Types.ObjectId()

  const restoreAdmin = stub(CollegeAdmin, 'findById', () =>
    Promise.resolve({ _id: adminId, collegeId, role: 'college_admin', status: 'active', isActive: true }),
  )
  const restoreFindNotifs = stub(Notification, 'find', () =>
    queryResult([
      { _id: new mongoose.Types.ObjectId(), title: 'New Course Assigned', isRead: false },
    ]),
  )
  const restoreCountNotifs = stub(Notification, 'countDocuments', async () => 1)
  const restoreUpdateMany = stub(Notification, 'updateMany', async () => ({ modifiedCount: 1 }))

  try {
    const listRes = await request('/college/notifications', {
      role: 'college_admin',
      subject: String(adminId),
      collegeId: String(collegeId),
    })
    assert.equal(listRes.status, 200)
    const listData = await listRes.json()
    assert.equal(listData.notifications.length, 1)
    assert.equal(listData.unreadCount, 1)

    const readAllRes = await request('/college/notifications/read-all', {
      method: 'POST',
      role: 'college_admin',
      subject: String(adminId),
      collegeId: String(collegeId),
    })
    assert.equal(readAllRes.status, 200)
    const readData = await readAllRes.json()
    assert.equal(readData.message, 'All notifications marked as read.')
  } finally {
    restoreUpdateMany()
    restoreCountNotifs()
    restoreFindNotifs()
    restoreAdmin()
  }
})

// -------------------------------------------------------------
// 9. STUDENT STATUS TOGGLE & PASSWORD RESET
// -------------------------------------------------------------
test('college can toggle student status and reset student password', async () => {
  const collegeId = new mongoose.Types.ObjectId()
  const adminId = new mongoose.Types.ObjectId()
  const studentId = new mongoose.Types.ObjectId()

  const studentDoc = {
    _id: studentId,
    collegeId,
    fullName: 'Jane Doe',
    email: 'jane@apex.edu',
    username: 'jane_doe',
    isActive: true,
    status: 'active',
    save: async () => studentDoc,
  }

  const restoreAdmin = stub(CollegeAdmin, 'findById', () =>
    Promise.resolve({ _id: adminId, collegeId, role: 'college_admin', status: 'active', isActive: true }),
  )
  const restoreStudentFindOne = stub(CollegeStudent, 'findOne', () => Promise.resolve(studentDoc))

  try {
    // Toggle to inactive
    const statusRes = await request(`/college/students/${studentId}/status`, {
      method: 'PATCH',
      role: 'college_admin',
      subject: String(adminId),
      collegeId: String(collegeId),
      body: { isActive: false },
    })
    assert.equal(statusRes.status, 200)
    assert.equal(studentDoc.isActive, false)
    assert.equal(studentDoc.status, 'inactive')

    // Reset password
    const resetRes = await request(`/college/students/${studentId}/reset-password`, {
      method: 'POST',
      role: 'college_admin',
      subject: String(adminId),
      collegeId: String(collegeId),
      body: { password: 'NewSecurePassword123!' },
    })
    assert.equal(resetRes.status, 200)
    const resetData = await resetRes.json()
    assert.equal(resetData.credentials.username, 'jane_doe')
    assert.equal(resetData.credentials.password, 'NewSecurePassword123!')
    assert.equal(studentDoc.isActive, true)
  } finally {
    restoreStudentFindOne()
    restoreAdmin()
  }
})

// -------------------------------------------------------------
// 10. COLLEGE PROFILE & SETTINGS
// -------------------------------------------------------------
test('college can view and update its profile and change password', async () => {
  const collegeId = new mongoose.Types.ObjectId()
  const adminId = new mongoose.Types.ObjectId()
  const oldHash = await bcrypt.hash('OldPassword123!', 4)

  const collegeDoc = {
    _id: collegeId,
    name: 'Apex Institute',
    code: 'APEX',
    city: 'Metropolis',
    save: async () => collegeDoc,
  }
  const adminDoc = {
    _id: adminId,
    collegeId,
    fullName: 'Dr. Apex',
    email: 'admin@apex.edu',
    username: 'apex_admin',
    passwordHash: oldHash,
    role: 'college_admin',
    status: 'active',
    isActive: true,
    save: async () => adminDoc,
  }

  const restoreCollegeFind = stub(College, 'findById', () => Promise.resolve(collegeDoc))
  const restoreAdminFind = stub(CollegeAdmin, 'findById', () => {
    const res = Promise.resolve(adminDoc)
    res.select = () => res
    return res
  })

  try {
    // Update profile
    const updateRes = await request('/college/profile', {
      method: 'PUT',
      role: 'college_admin',
      subject: String(adminId),
      collegeId: String(collegeId),
      body: { city: 'New Metropolis', contactName: 'Dr. Smith' },
    })
    assert.equal(updateRes.status, 200)
    assert.equal(collegeDoc.city, 'New Metropolis')
    assert.equal(collegeDoc.contactName, 'Dr. Smith')

    // Change password
    const passRes = await request('/college/password', {
      method: 'PUT',
      role: 'college_admin',
      subject: String(adminId),
      collegeId: String(collegeId),
      body: {
        currentPassword: 'OldPassword123!',
        newPassword: 'BrandNewPassword123!',
        confirmPassword: 'BrandNewPassword123!',
      },
    })
    assert.equal(passRes.status, 200)
    const match = await bcrypt.compare('BrandNewPassword123!', adminDoc.passwordHash)
    assert.equal(match, true)
  } finally {
    restoreAdminFind()
    restoreCollegeFind()
  }
})

// -------------------------------------------------------------
// 11. ADMIN COLLEGE MANAGEMENT & DIRECT CREDENTIALS
// -------------------------------------------------------------
test('admin can set direct credentials for college and activate it', async () => {
  const collegeId = new mongoose.Types.ObjectId()
  const adminSubject = new mongoose.Types.ObjectId()

  const restoreAdmin = stub(Admin, 'findById', () =>
    Promise.resolve({ _id: adminSubject, role: 'main_admin', status: 'active', isActive: true }),
  )
  const collegeDoc = {
    _id: collegeId,
    name: 'Apex Institute',
    status: 'pending',
    save: async () => collegeDoc,
  }
  const restoreCollegeFind = stub(College, 'findById', () => Promise.resolve(collegeDoc))

  const subAdminDoc = {
    _id: new mongoose.Types.ObjectId(),
    collegeId,
    email: 'dean@apex.edu',
    username: 'apex_dean',
    role: 'college_admin',
    status: 'pending',
    isActive: false,
    save: async () => subAdminDoc,
  }
  const restoreSubAdminFind = stub(CollegeAdmin, 'findOne', () => Promise.resolve(subAdminDoc))
  const restoreIdentityUpsert = stub(AccountIdentity, 'updateOne', async () => ({}))

  try {
    const res = await request(`/admin/colleges/${collegeId}/credentials`, {
      method: 'POST',
      role: 'main_admin',
      subject: String(adminSubject),
      body: {
        password: 'DirectCollegePass123!',
      },
    })
    assert.equal(res.status, 200)
    assert.equal(collegeDoc.status, 'active')
    assert.equal(subAdminDoc.status, 'active')
    assert.equal(subAdminDoc.isActive, true)
    const match = await bcrypt.compare('DirectCollegePass123!', subAdminDoc.passwordHash)
    assert.equal(match, true)
  } finally {
    restoreIdentityUpsert()
    restoreSubAdminFind()
    restoreCollegeFind()
    restoreAdmin()
  }
})

