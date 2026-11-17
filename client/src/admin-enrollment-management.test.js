import assert from 'node:assert/strict'
import { test } from 'node:test'

const mockEnrollments = [
  {
    _id: 'enr-1',
    createdAt: '2026-10-01T10:00:00.000Z',
    status: 'active',
    userId: {
      _id: 'usr-1',
      fullName: 'Alice Johnson',
      email: 'alice@example.com',
      username: 'alicej',
      studentType: 'independent',
    },
    courseId: {
      _id: 'crs-1',
      title: 'Python for Beginners',
      category: 'Programming',
    },
    progress: {
      completedCount: 1,
      totalLessons: 4,
      percentage: 25,
    },
  },
  {
    _id: 'enr-2',
    createdAt: '2026-10-15T10:00:00.000Z',
    status: 'completed',
    userId: {
      _id: 'usr-2',
      fullName: 'Bob Smith',
      email: 'bob@example.com',
      username: 'bobsmith',
      studentType: 'college',
      collegeId: 'clg-1',
    },
    collegeId: {
      _id: 'clg-1',
      name: 'Oxford College',
    },
    courseId: {
      _id: 'crs-2',
      title: 'Digital Marketing Fundamentals',
      category: 'Marketing',
    },
    progress: {
      completedCount: 3,
      totalLessons: 3,
      percentage: 100,
    },
  },
  {
    _id: 'enr-3',
    createdAt: '2026-11-01T10:00:00.000Z',
    status: 'active',
    userId: {
      _id: 'usr-3',
      fullName: 'Charlie Davis',
      email: 'charlie@example.com',
      username: 'charlied',
      studentType: 'college',
      collegeId: 'clg-2',
    },
    collegeId: {
      _id: 'clg-2',
      name: 'Cambridge Institute',
    },
    courseId: {
      _id: 'crs-1',
      title: 'Python for Beginners',
      category: 'Programming',
    },
    progress: {
      completedCount: 2,
      totalLessons: 4,
      percentage: 50,
    },
  },
]

function computeAnalytics(enrollments) {
  const total = enrollments.length
  let active = 0
  let completed = 0
  let totalProgressSum = 0

  for (const entry of enrollments) {
    const totalLessons = entry.progress?.totalLessons || 0
    const completedCount = entry.progress?.completedCount || 0
    const isComplete = (totalLessons > 0 && completedCount >= totalLessons) || entry.status === 'completed'

    if (isComplete) completed++
    else if (entry.status === 'active') active++

    const pct = entry.progress?.percentage || 0
    totalProgressSum += pct
  }

  const avgCompletion = total > 0 ? Math.round(totalProgressSum / total) : 0
  return { total, active, completed, avgCompletion }
}

function filterEnrollments(enrollments, { query = '', status = 'all', type = 'all', college = 'all', sortBy = 'newest' }) {
  const q = query.trim().toLowerCase()
  return enrollments
    .filter((entry) => {
      if (q) {
        const studentName = (entry.userId?.fullName || '').toLowerCase()
        const studentEmail = (entry.userId?.email || '').toLowerCase()
        const studentUsername = (entry.userId?.username || '').toLowerCase()
        const courseTitle = (entry.courseId?.title || '').toLowerCase()
        const courseCategory = (entry.courseId?.category || '').toLowerCase()
        const collegeName = (entry.collegeId?.name || '').toLowerCase()

        const matches =
          studentName.includes(q) ||
          studentEmail.includes(q) ||
          studentUsername.includes(q) ||
          courseTitle.includes(q) ||
          courseCategory.includes(q) ||
          collegeName.includes(q)
        if (!matches) return false
      }

      if (status !== 'all') {
        const totalLessons = entry.progress?.totalLessons || 0
        const completedCount = entry.progress?.completedCount || 0
        const isComplete = (totalLessons > 0 && completedCount >= totalLessons) || entry.status === 'completed'

        if (status === 'completed' && !isComplete) return false
        if (status === 'active' && (isComplete || entry.status !== 'active')) return false
      }

      if (type !== 'all') {
        const isCollege = entry.userId?.studentType === 'college' || Boolean(entry.collegeId)
        if (type === 'college' && !isCollege) return false
        if (type === 'independent' && isCollege) return false
      }

      if (college !== 'all') {
        const entryCollegeId = String(entry.collegeId?._id || '')
        const entryCollegeName = String(entry.collegeId?.name || '')
        if (entryCollegeId !== college && entryCollegeName !== college) return false
      }

      return true
    })
    .sort((a, b) => {
      if (sortBy === 'newest') return new Date(b.createdAt) - new Date(a.createdAt)
      if (sortBy === 'oldest') return new Date(a.createdAt) - new Date(b.createdAt)
      if (sortBy === 'progress-high') return (b.progress?.percentage || 0) - (a.progress?.percentage || 0)
      if (sortBy === 'progress-low') return (a.progress?.percentage || 0) - (b.progress?.percentage || 0)
      return 0
    })
}

function generateCsv(records) {
  const headers = [
    'Enrollment ID',
    'Student Name',
    'Student Email',
    'Student Username',
    'Student Type',
    'College Name',
    'Course Title',
    'Course Category',
    'Enrollment Date',
    'Completed Lessons',
    'Total Lessons',
    'Progress (%)',
    'Status',
  ]

  const rows = records.map((entry) => {
    const student = entry.userId || {}
    const course = entry.courseId || {}
    const college = entry.collegeId || {}
    const progress = entry.progress || {}
    const isCollege = student.studentType === 'college' || Boolean(entry.collegeId)

    return [
      entry._id || '',
      student.fullName || '',
      student.email || '',
      student.username || '',
      isCollege ? 'College Student' : 'Independent Student',
      college.name || 'N/A',
      course.title || '',
      course.category || '',
      entry.createdAt ? new Date(entry.createdAt).toISOString().split('T')[0] : '',
      progress.completedCount ?? 0,
      progress.totalLessons ?? 0,
      `${progress.percentage ?? 0}%`,
      entry.status || 'active',
    ]
  })

  return [
    headers.map((h) => `"${h.replace(/"/g, '""')}"`).join(','),
    ...rows.map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(',')),
  ].join('\r\n')
}

test('Analytics metrics compute correctly from actual enrollment records', () => {
  const metrics = computeAnalytics(mockEnrollments)
  assert.equal(metrics.total, 3)
  assert.equal(metrics.active, 2)
  assert.equal(metrics.completed, 1)
  // (25 + 100 + 50) / 3 = 175 / 3 = 58.33 -> 58%
  assert.equal(metrics.avgCompletion, 58)
})

test('Search filter matches student name, username, email, and course title', () => {
  // Search by name
  const res1 = filterEnrollments(mockEnrollments, { query: 'Alice' })
  assert.equal(res1.length, 1)
  assert.equal(res1[0]._id, 'enr-1')

  // Search by email
  const res2 = filterEnrollments(mockEnrollments, { query: 'bob@example.com' })
  assert.equal(res2.length, 1)
  assert.equal(res2[0]._id, 'enr-2')

  // Search by course title
  const res3 = filterEnrollments(mockEnrollments, { query: 'Marketing' })
  assert.equal(res3.length, 1)
  assert.equal(res3[0]._id, 'enr-2')

  // Search by Python (2 enrollments)
  const res4 = filterEnrollments(mockEnrollments, { query: 'Python' })
  assert.equal(res4.length, 2)
})

test('Filters correctly isolate student type and college', () => {
  // Independent students
  const independent = filterEnrollments(mockEnrollments, { type: 'independent' })
  assert.equal(independent.length, 1)
  assert.equal(independent[0].userId.fullName, 'Alice Johnson')

  // College students
  const college = filterEnrollments(mockEnrollments, { type: 'college' })
  assert.equal(college.length, 2)

  // Specific college
  const oxford = filterEnrollments(mockEnrollments, { college: 'clg-1' })
  assert.equal(oxford.length, 1)
  assert.equal(oxford[0].collegeId.name, 'Oxford College')
})

test('Sorting sorts by newest, oldest, and progress', () => {
  // Newest first (enr-3 is Nov 01)
  const newest = filterEnrollments(mockEnrollments, { sortBy: 'newest' })
  assert.equal(newest[0]._id, 'enr-3')
  assert.equal(newest[2]._id, 'enr-1')

  // Oldest first (enr-1 is Oct 01)
  const oldest = filterEnrollments(mockEnrollments, { sortBy: 'oldest' })
  assert.equal(oldest[0]._id, 'enr-1')

  // Highest progress first (enr-2 is 100%)
  const highProg = filterEnrollments(mockEnrollments, { sortBy: 'progress-high' })
  assert.equal(highProg[0]._id, 'enr-2')
  assert.equal(highProg[0].progress.percentage, 100)
})

test('CSV export generates valid CSV format with proper quoting and content', () => {
  const csv = generateCsv(mockEnrollments)
  assert.ok(csv.includes('"Enrollment ID","Student Name","Student Email"'))
  assert.ok(csv.includes('"Alice Johnson","alice@example.com"'))
  assert.ok(csv.includes('"Independent Student"'))
  assert.ok(csv.includes('"College Student","Oxford College"'))
  assert.ok(csv.includes('"Digital Marketing Fundamentals"'))
  assert.ok(csv.includes('"100%"'))
})

