import { Router } from 'express'
import bcrypt from 'bcryptjs'
import { randomBytes } from 'node:crypto'
import mongoose from 'mongoose'
import AccountIdentity from '../models/AccountIdentity.js'
import College from '../models/College.js'
import Course from '../models/Course.js'
import Enrollment from '../models/Enrollment.js'
import Department from '../models/Department.js'
import Batch from '../models/Batch.js'
import Notification from '../models/Notification.js'
import Progress from '../models/Progress.js'
import Semester from '../models/Semester.js'
import Faculty from '../models/Faculty.js'
import Attendance from '../models/Attendance.js'
import AcademicEvent from '../models/AcademicEvent.js'
import Examination from '../models/Examination.js'
import PlacementDrive from '../models/PlacementDrive.js'
import CollegeDocument from '../models/CollegeDocument.js'
import { CollegeStudent, CollegeAdmin, accountModelsByCollection } from '../models/account-models.js'
import { authenticate, requireRoles } from '../middleware/auth.js'
import { parseStudentCsv } from '../utils/student-csv.js'
import {
  assertCollegeStudentCapacity,
  countCollegeStudents,
  getCollegeStudentLimit,
} from '../utils/college-student-capacity.js'

const router = Router()
const requireCollege = [authenticate, requireRoles('college_admin', 'college')]
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const usernamePattern = /^[a-zA-Z0-9._-]{3,30}$/

function getCollegeId(req) {
  const collegeId = req.auth?.user?.collegeId
  if (!collegeId || !mongoose.isValidObjectId(collegeId)) {
    return null
  }
  return new mongoose.Types.ObjectId(collegeId)
}

async function accountIdentifierExists(field, value) {
  const identity = await AccountIdentity.exists({ [field]: value })
  if (identity) return true
  for (const AccountModel of Object.values(accountModelsByCollection)) {
    if (await AccountModel.exists({ [field]: value })) return true
  }
  return false
}

function makeStudentUsername(studentId, fullName) {
  const cleanId = String(studentId || '').replace(/[^a-zA-Z0-9]/g, '').toLowerCase()
  if (cleanId.length >= 3) {
    return `st_${cleanId}`.slice(0, 30)
  }
  const cleanName = String(fullName || 'student').replace(/[^a-zA-Z0-9]/g, '').toLowerCase().slice(0, 15)
  const randomSuffix = randomBytes(3).toString('hex')
  return `${cleanName}_${randomSuffix}`
}

function calculateGrade(percentage) {
  if (percentage >= 90) return 'A+'
  if (percentage >= 80) return 'A'
  if (percentage >= 70) return 'B+'
  if (percentage >= 60) return 'B'
  if (percentage >= 50) return 'C'
  if (percentage >= 40) return 'D'
  return 'F'
}

async function addCollegeNotification(collegeId, title, message, type = 'info', recipientRole = 'college_admin') {
  try {
    await Notification.create({
      recipientRole,
      collegeId,
      title,
      message,
      type,
    })
  } catch {
    // Non-blocking notification creation
  }
}

// Helper to escape CSV values
function csvEscape(value) {
  if (value === null || value === undefined) return '""'
  const str = String(value).replace(/"/g, '""')
  return `"${str}"`
}

// -------------------------------------------------------------
// 1. PREMIUM COLLEGE DASHBOARD OVERVIEW & ANALYTICS CHARTS
// -------------------------------------------------------------
router.get('/dashboard', ...requireCollege, async (req, res, next) => {
  try {
    const collegeId = getCollegeId(req)
    if (!collegeId) {
      return res.status(403).json({ message: 'Your account is not assigned to an active college.' })
    }

    const { dateFilter, startDate: customStart, endDate: customEnd } = req.query
    const now = new Date()
    let sinceDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000) // Default 30 days

    if (dateFilter === 'today') {
      sinceDate = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    } else if (dateFilter === 'week') {
      sinceDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
    } else if (dateFilter === 'month') {
      sinceDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
    } else if (dateFilter === 'semester') {
      sinceDate = new Date(now.getTime() - 120 * 24 * 60 * 60 * 1000)
    } else if (dateFilter === 'custom' && customStart) {
      const parsed = new Date(customStart)
      if (!Number.isNaN(parsed.getTime())) sinceDate = parsed
    }

    const [
      college,
      totalStudents,
      activeStudents,
      departmentsList,
      batchesList,
      totalFaculty,
      assignedCourseIds,
      totalPublishedCourses,
      progressDocs,
      attendanceSessions,
      examinationsList,
      placementDrives,
      upcomingEvents,
      recentNotifications,
      unreadNotificationsCount,
      recentEnrollments,
    ] = await Promise.all([
      College.findById(collegeId).lean(),
      CollegeStudent.countDocuments({ role: 'student', studentType: 'college', collegeId }),
      CollegeStudent.countDocuments({ role: 'student', studentType: 'college', collegeId, isActive: true, status: 'active' }),
      Department.find({ collegeId, status: 'active' }).select('name code headOfDepartment intakeCapacity').lean(),
      Batch.find({ collegeId, status: 'active' }).select('name academicYear department semester').lean(),
      Faculty.countDocuments({ collegeId, status: 'active' }),
      Enrollment.distinct('courseId', { collegeId, status: { $ne: 'cancelled' } }),
      Course.countDocuments({ status: 'published' }),
      Progress.find({ collegeId }).select('progressPercentage status userId courseId').lean(),
      Attendance.find({ collegeId, date: { $gte: sinceDate } }).select('date department batch subject records').lean(),
      Examination.find({ collegeId }).select('title examType semester department results maxMarks passingMarks status').lean(),
      PlacementDrive.find({ collegeId }).select('companyName jobTitle opportunityType packageLpa status applications deadline').lean(),
      AcademicEvent.find({ collegeId, endDate: { $gte: now } }).sort({ startDate: 1 }).limit(6).lean(),
      Notification.find({ collegeId, recipientRole: 'college_admin' }).sort({ createdAt: -1 }).limit(8).lean(),
      Notification.countDocuments({ collegeId, recipientRole: 'college_admin', isRead: false }),
      Enrollment.find({ collegeId })
        .populate('userId', 'fullName username email studentId department batch')
        .populate('courseId', 'title')
        .sort({ createdAt: -1 })
        .limit(6)
        .lean(),
    ])

    if (!college) {
      return res.status(404).json({ message: 'The assigned college was not found.' })
    }

    let collegeStudentsList = []
    try {
      if (mongoose.connection.readyState !== 0 || CollegeStudent.find !== mongoose.Model.find) {
        collegeStudentsList = await CollegeStudent.find({ collegeId, role: 'student', studentType: 'college' })
          .select('fullName email rollNumber studentId status createdAt department batch')
          .sort({ createdAt: -1 })
          .lean()
      }
    } catch {
      collegeStudentsList = []
    }
    const studentLimit = await getCollegeStudentLimit(collegeId)

    // Attendance Calculations
    let totalAttendanceRecords = 0
    let presentAttendanceRecords = 0
    const studentAttendanceMap = new Map() // studentId -> { present: number, total: number }

    for (const session of attendanceSessions) {
      for (const record of session.records || []) {
        totalAttendanceRecords++
        const sid = String(record.studentId)
        if (!studentAttendanceMap.has(sid)) studentAttendanceMap.set(sid, { present: 0, total: 0 })
        const stat = studentAttendanceMap.get(sid)
        stat.total++
        if (record.status === 'present' || record.status === 'late') {
          presentAttendanceRecords++
          stat.present++
        }
      }
    }

    const averageAttendance = totalAttendanceRecords > 0
      ? Math.round((presentAttendanceRecords / totalAttendanceRecords) * 100)
      : 0

    // Academic Performance Calculations (from actual exams)
    let totalMarksEarned = 0
    let totalMarksPossible = 0
    const backloggedStudentIds = new Set()

    for (const exam of examinationsList) {
      for (const resItem of exam.results || []) {
        if (typeof resItem.marksObtained === 'number' && typeof resItem.maxMarks === 'number' && resItem.maxMarks > 0) {
          totalMarksEarned += resItem.marksObtained
          totalMarksPossible += resItem.maxMarks
        }
        if (resItem.backlog) {
          backloggedStudentIds.add(String(resItem.studentId))
        }
      }
    }

    const averageAcademicPerformance = totalMarksPossible > 0
      ? Math.round((totalMarksEarned / totalMarksPossible) * 100)
      : 0

    // Course completion rate
    const totalProgress = progressDocs.length
    const completedProgress = progressDocs.filter((p) => p.status === 'completed' || p.progressPercentage >= 100).length
    const courseCompletionRate = totalProgress > 0
      ? Math.round((completedProgress / totalProgress) * 100)
      : 0
    const overallProgress = totalProgress > 0
      ? Math.round(progressDocs.reduce((sum, p) => sum + (p.progressPercentage || 0), 0) / totalProgress)
      : 0

    // Students at risk: attendance < 75% OR has backlog OR academicStanding == 'at_risk'
    let lowAttendanceCount = 0
    for (const [, stat] of studentAttendanceMap.entries()) {
      if (stat.total >= 3 && (stat.present / stat.total) < 0.75) {
        lowAttendanceCount++
      }
    }
    const studentsAtRiskCount = Math.max(lowAttendanceCount, backloggedStudentIds.size)

    // Placement statistics
    let totalPlaced = 0
    let highestPackage = 0
    for (const drive of placementDrives) {
      for (const app of drive.applications || []) {
        if (app.status === 'placed') {
          totalPlaced++
          if (app.offeredPackage > highestPackage) highestPackage = app.offeredPackage
        }
      }
    }
    const placementPercentage = totalStudents > 0
      ? Math.round((totalPlaced / totalStudents) * 100)
      : 0

    // Interactive Analytics Charts data
    // 1. Weekly Attendance Trend (last 7 days)
    const attendanceTrend = []
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000)
      const dateStr = d.toISOString().slice(0, 10)
      const daySessions = attendanceSessions.filter((s) => s.date && new Date(s.date).toISOString().slice(0, 10) === dateStr)
      let dayTotal = 0
      let dayPresent = 0
      for (const s of daySessions) {
        for (const r of s.records || []) {
          dayTotal++
          if (r.status === 'present' || r.status === 'late') dayPresent++
        }
      }
      attendanceTrend.push({
        date: d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }),
        rate: dayTotal > 0 ? Math.round((dayPresent / dayTotal) * 100) : 0,
        sessionsCount: daySessions.length,
      })
    }

    // 2. Department-wise student breakdown & performance
    const departmentPerformance = departmentsList.map((dept) => {
      const deptExams = examinationsList.filter((e) => e.department === dept.name)
      let earned = 0
      let max = 0
      for (const e of deptExams) {
        for (const r of e.results || []) {
          if (r.marksObtained && r.maxMarks) {
            earned += r.marksObtained
            max += r.maxMarks
          }
        }
      }
      return {
        department: dept.name,
        code: dept.code,
        avgScore: max > 0 ? Math.round((earned / max) * 100) : 0,
        examsCount: deptExams.length,
      }
    })

    // 3. Course Progress Distribution
    const progressDistribution = {
      '0-25%': progressDocs.filter((p) => (p.progressPercentage || 0) <= 25).length,
      '26-50%': progressDocs.filter((p) => (p.progressPercentage || 0) > 25 && (p.progressPercentage || 0) <= 50).length,
      '51-75%': progressDocs.filter((p) => (p.progressPercentage || 0) > 50 && (p.progressPercentage || 0) <= 75).length,
      '76-100%': progressDocs.filter((p) => (p.progressPercentage || 0) > 75).length,
    }

    // Pending tasks
    const pendingTasks = []
    if (lowAttendanceCount > 0) {
      pendingTasks.push({
        id: 'task-low-att',
        type: 'warning',
        title: 'Low Attendance Warning',
        description: `${lowAttendanceCount} student(s) have attendance below 75% requirement.`,
        actionTab: 'attendance',
      })
    }
    const ongoingExams = examinationsList.filter((e) => e.status === 'ongoing' || (e.status === 'completed' && (!e.results || e.results.length === 0)))
    if (ongoingExams.length > 0) {
      pendingTasks.push({
        id: 'task-exams',
        type: 'info',
        title: 'Pending Exam Marks Entry',
        description: `${ongoingExams.length} examination(s) require results submission.`,
        actionTab: 'examinations',
      })
    }
    const upcomingDrives = placementDrives.filter((d) => d.status === 'upcoming' || d.status === 'active')
    if (upcomingDrives.length > 0) {
      pendingTasks.push({
        id: 'task-placements',
        type: 'success',
        title: 'Active Placement Drives',
        description: `${upcomingDrives.length} company drive(s) open for student applications.`,
        actionTab: 'placements',
      })
    }

    return res.json({
      studentLimit,
      totalStudents,
      remainingSlots: studentLimit === null ? null : Math.max(0, studentLimit - totalStudents),
      students: collegeStudentsList,
      college: {
        id: String(college._id),
        name: college.name,
        code: college.code,
        address: college.address,
        city: college.city,
        state: college.state,
        country: college.country,
        contactName: college.contactName,
        contactEmail: college.contactEmail,
        contactPhone: college.contactPhone,
        status: college.status,
      },
      stats: {
        totalStudents,
        activeStudents,
        totalDepartments: departmentsList.length,
        totalBatches: batchesList.length,
        totalFaculty,
        totalAssignedCourses: assignedCourseIds.length,
        totalPublishedCourses,
        averageAttendance,
        averageAcademicPerformance,
        courseCompletionRate,
        overallProgress,
        studentsAtRisk: studentsAtRiskCount,
        placement: {
          totalEligible: totalStudents,
          totalPlaced,
          placementPercentage,
          totalDrives: placementDrives.length,
          highestPackage,
        },
        unreadNotifications: unreadNotificationsCount,
      },
      analyticsCharts: {
        attendanceTrend,
        departmentPerformance,
        progressDistribution,
      },
      upcomingEvents,
      pendingTasks,
      recentEnrollments,
      recentNotifications,
      departments: departmentsList,
      batches: batchesList,
    })
  } catch (error) {
    return next(error)
  }
})

// -------------------------------------------------------------
// 2. ADVANCED STUDENT MANAGEMENT & 360° PROFILE
// -------------------------------------------------------------
router.get('/students', ...requireCollege, async (req, res, next) => {
  try {
    const collegeId = getCollegeId(req)
    if (!collegeId) return res.status(403).json({ message: 'College access required.' })

    const { search, department, batch, semester, status, academicStanding, placementStatus, page = 1, limit = 50 } = req.query
    const query = { role: 'student', studentType: 'college', collegeId }

    if (department && typeof department === 'string' && department.trim()) {
      query.department = department.trim()
    }
    if (batch && typeof batch === 'string' && batch.trim()) {
      query.batch = batch.trim()
    }
    if (semester && typeof semester === 'string' && semester.trim()) {
      query.semester = semester.trim()
    }
    if (academicStanding && typeof academicStanding === 'string' && academicStanding.trim()) {
      query.academicStanding = academicStanding.trim().toLowerCase()
    }
    if (placementStatus && typeof placementStatus === 'string' && placementStatus.trim()) {
      query.placementStatus = placementStatus.trim().toLowerCase()
    }
    if (status && typeof status === 'string' && status.trim()) {
      if (status === 'active') {
        query.isActive = true
        query.status = 'active'
      } else if (status === 'inactive') {
        query.$or = [{ isActive: false }, { status: 'inactive' }, { status: 'suspended' }]
      } else {
        query.status = status.trim().toLowerCase()
      }
    }
    if (search && typeof search === 'string' && search.trim()) {
      const escaped = search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const regex = new RegExp(escaped, 'i')
      query.$and = [
        ...(query.$and || []),
        {
          $or: [
            { fullName: regex },
            { email: regex },
            { username: regex },
            { studentId: regex },
          ],
        },
      ]
    }

    const pageNum = Math.max(1, parseInt(page, 10) || 1)
    const limitNum = Math.min(200, Math.max(1, parseInt(limit, 10) || 50))
    const skip = (pageNum - 1) * limitNum

    const [students, total] = await Promise.all([
      CollegeStudent.find(query)
        .select('fullName username email studentId department batch semester phone cgpa academicStanding placementStatus status isActive createdAt')
        .sort({ fullName: 1, createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .lean(),
      CollegeStudent.countDocuments(query),
    ])

    // Attach enrollment counts for each student
    const studentIds = students.map((s) => s._id)
    const enrollmentCounts = await Enrollment.aggregate([
      { $match: { userId: { $in: studentIds }, collegeId, status: { $ne: 'cancelled' } } },
      { $group: { _id: '$userId', count: { $sum: 1 } } },
    ])
    const countMap = new Map(enrollmentCounts.map((e) => [String(e._id), e.count]))

    const studentsWithEnrollments = students.map((s) => ({
      ...s,
      enrolledCoursesCount: countMap.get(String(s._id)) || 0,
    }))

    return res.json({
      students: studentsWithEnrollments,
      pagination: {
        total,
        page: pageNum,
        limit: limitNum,
        totalPages: Math.ceil(total / limitNum) || 1,
      },
    })
  } catch (error) {
    return next(error)
  }
})

// Comprehensive Student 360° Profile API
router.get('/students/:id/360', ...requireCollege, async (req, res, next) => {
  try {
    const collegeId = getCollegeId(req)
    if (!collegeId) return res.status(403).json({ message: 'College access required.' })
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: 'Invalid student ID.' })
    }

    const student = await CollegeStudent.findOne({ _id: req.params.id, collegeId }).lean()
    if (!student) {
      return res.status(404).json({ message: 'Student was not found in your college.' })
    }

    const [enrollments, progressRecords, attendanceSessions, examinations, placementDrives] = await Promise.all([
      Enrollment.find({ userId: student._id, collegeId, status: { $ne: 'cancelled' } })
        .populate('courseId', 'title description modules quizzes assignments')
        .lean(),
      Progress.find({ userId: student._id, collegeId })
        .populate('courseId', 'title')
        .lean(),
      Attendance.find({ collegeId, 'records.studentId': student._id })
        .sort({ date: -1 })
        .limit(50)
        .lean(),
      Examination.find({ collegeId, 'results.studentId': student._id })
        .sort({ startDate: -1 })
        .lean(),
      PlacementDrive.find({ collegeId, 'applications.studentId': student._id })
        .select('companyName jobTitle opportunityType packageLpa status applications')
        .lean(),
    ])

    // Compute student attendance stats
    let attendedCount = 0
    let totalSessions = attendanceSessions.length
    const attendanceHistory = []

    for (const s of attendanceSessions) {
      const rec = s.records.find((r) => String(r.studentId) === String(student._id))
      if (rec) {
        if (rec.status === 'present' || rec.status === 'late') attendedCount++
        attendanceHistory.push({
          date: s.date,
          subject: s.subject,
          batch: s.batch,
          status: rec.status,
          remarks: rec.remarks,
        })
      }
    }
    const attendancePercentage = totalSessions > 0 ? Math.round((attendedCount / totalSessions) * 100) : 0

    // Compute exam results
    const examResults = []
    let backlogsCount = 0
    for (const exam of examinations) {
      const r = exam.results.find((item) => String(item.studentId) === String(student._id))
      if (r) {
        if (r.backlog) backlogsCount++
        examResults.push({
          examTitle: exam.title,
          examType: exam.examType,
          subject: r.subject || exam.subject,
          marksObtained: r.marksObtained,
          maxMarks: r.maxMarks,
          percentage: r.maxMarks > 0 ? Math.round((r.marksObtained / r.maxMarks) * 100) : 0,
          grade: r.grade,
          isPass: r.isPass,
          backlog: r.backlog,
        })
      }
    }

    // Merge enrollments with progress
    const progressMap = new Map(progressRecords.map((p) => [String(p.courseId?._id || p.courseId), p]))
    const detailedCourses = enrollments.map((e) => {
      const course = e.courseId || {}
      const prog = progressMap.get(String(course._id))
      return {
        courseId: course._id,
        title: course.title,
        enrolledAt: e.createdAt,
        progressPercentage: prog?.progressPercentage || 0,
        status: prog?.status || 'not_started',
        completedLessonsCount: prog?.completedLessons?.length || 0,
        lastActivityAt: prog?.lastActivityAt,
      }
    })

    // Placement records
    const placementHistory = []
    for (const drive of placementDrives) {
      const app = drive.applications.find((a) => String(a.studentId) === String(student._id))
      if (app) {
        placementHistory.push({
          driveId: drive._id,
          companyName: drive.companyName,
          jobTitle: drive.jobTitle,
          opportunityType: drive.opportunityType,
          status: app.status,
          offeredPackage: app.offeredPackage,
          appliedAt: app.appliedAt,
        })
      }
    }

    return res.json({
      student: {
        id: String(student._id),
        fullName: student.fullName,
        studentId: student.studentId,
        email: student.email,
        username: student.username,
        department: student.department,
        batch: student.batch,
        semester: student.semester || 'Semester 1',
        phone: student.phone || '—',
        dateOfBirth: student.dateOfBirth,
        gender: student.gender || '—',
        bloodGroup: student.bloodGroup || '—',
        address: student.address || '—',
        guardianName: student.guardianName || '—',
        guardianPhone: student.guardianPhone || '—',
        cgpa: student.cgpa || 0,
        academicStanding: student.academicStanding || 'good',
        skills: student.skills || [],
        resumeUrl: student.resumeUrl || '',
        placementStatus: student.placementStatus || 'seeking',
        placedCompany: student.placedCompany || '',
        placementPackage: student.placementPackage || 0,
        status: student.status,
        isActive: student.isActive,
        createdAt: student.createdAt,
        achievements: student.achievements || [],
        documents: student.documents || [],
      },
      attendance: {
        totalSessions,
        attendedSessions: attendedCount,
        percentage: attendancePercentage,
        history: attendanceHistory,
      },
      examinations: {
        results: examResults,
        backlogsCount,
      },
      courses: detailedCourses,
      placements: placementHistory,
    })
  } catch (error) {
    return next(error)
  }
})

// Add Individual Student
router.post('/students', ...requireCollege, async (req, res, next) => {
  try {
    const collegeId = getCollegeId(req)
    if (!collegeId) return res.status(403).json({ message: 'College access required.' })

    const {
      fullName,
      studentId: customStudentId,
      email,
      username,
      password,
      department,
      batch,
      semester,
      phone,
      dateOfBirth,
      gender,
      bloodGroup,
      address,
      guardianName,
      guardianPhone,
      cgpa,
      skills,
    } = req.body ?? {}

    if (typeof fullName !== 'string' || !fullName.trim() || fullName.trim().length > 120) {
      return res.status(400).json({ message: 'Full name is required (max 120 characters).' })
    }
    if (typeof email !== 'string' || !emailPattern.test(email.trim()) || email.trim().length > 254) {
      return res.status(400).json({ message: 'A valid email address is required.' })
    }

    const normalizedEmail = email.trim().toLowerCase()
    // Auto-generate studentId if not provided
    const rawStudentId = (typeof customStudentId === 'string' && customStudentId.trim())
      ? customStudentId.trim()
      : `STU-${new Date().getFullYear()}-${randomBytes(3).toString('hex').toUpperCase()}`

    const normalizedUsername = (typeof username === 'string' && username.trim()
      ? username.trim().toLowerCase()
      : makeStudentUsername(rawStudentId, fullName)).toLowerCase()

    if (!usernamePattern.test(normalizedUsername)) {
      return res.status(400).json({ message: 'Username must be 3–30 letters, numbers, dots, underscores, or hyphens.' })
    }

    // Check uniqueness
    const [emailTaken, usernameTaken, existingStudentId] = await Promise.all([
      accountIdentifierExists('email', normalizedEmail),
      accountIdentifierExists('username', normalizedUsername),
      CollegeStudent.findOne({ collegeId, studentId: rawStudentId }).collation({ locale: 'en', strength: 2 }).lean(),
    ])

    if (emailTaken) return res.status(409).json({ message: 'An account with this email already exists.' })
    if (usernameTaken) return res.status(409).json({ message: 'This username is already taken. Try another.' })
    if (existingStudentId) return res.status(409).json({ message: 'A student with this Student ID already exists in your college.' })

    const plainPassword = (typeof password === 'string' && password.trim().length >= 8)
      ? password.trim()
      : `LMS@${randomBytes(4).toString('hex')}`
    const passwordHash = await bcrypt.hash(plainPassword, 12)

    const accountId = new mongoose.Types.ObjectId()
    const session = await mongoose.startSession()
    let student

    try {
      await session.withTransaction(async () => {
        await assertCollegeStudentCapacity(collegeId, session)
        await AccountIdentity.create(
          [{
            email: normalizedEmail,
            username: normalizedUsername,
            accountCollection: CollegeStudent.collection.name,
            accountId,
          }],
          { session },
        )
        ;[student] = await CollegeStudent.create(
          [{
            _id: accountId,
            fullName: fullName.trim(),
            studentId: rawStudentId,
            email: normalizedEmail,
            username: normalizedUsername,
            passwordHash,
            role: 'student',
            studentType: 'college',
            collegeId,
            department: typeof department === 'string' ? department.trim() : '',
            batch: typeof batch === 'string' ? batch.trim() : '',
            semester: typeof semester === 'string' ? semester.trim() : '',
            phone: typeof phone === 'string' ? phone.trim() : '',
            dateOfBirth: dateOfBirth ? new Date(dateOfBirth) : undefined,
            gender: typeof gender === 'string' ? gender.trim() : '',
            bloodGroup: typeof bloodGroup === 'string' ? bloodGroup.trim() : '',
            address: typeof address === 'string' ? address.trim() : '',
            guardianName: typeof guardianName === 'string' ? guardianName.trim() : '',
            guardianPhone: typeof guardianPhone === 'string' ? guardianPhone.trim() : '',
            cgpa: typeof cgpa === 'number' ? cgpa : 0,
            skills: Array.isArray(skills) ? skills : [],
            status: 'active',
            isActive: true,
            permissions: [],
          }],
          { session },
        )
      })
    } finally {
      await session.endSession()
    }

    await addCollegeNotification(
      collegeId,
      'Student Added',
      `${student.fullName} (${student.studentId}) was registered.`,
      'student',
    )

    return res.status(201).json({
      message: 'Student account created successfully.',
      student: {
        id: String(student._id),
        fullName: student.fullName,
        studentId: student.studentId,
        email: student.email,
        username: student.username,
        department: student.department,
        batch: student.batch,
        status: student.status,
        isActive: student.isActive,
      },
      credentials: {
        username: student.username,
        email: student.email,
        temporaryPassword: plainPassword,
      },
    })
  } catch (error) {
    if (error?.code === 11000) {
      return res.status(409).json({ message: 'Email, username, or Student ID is already registered.' })
    }
    if (error?.statusCode) {
      return res.status(error.statusCode).json({ message: error.message })
    }
    return next(error)
  }
})

// Bulk Upload Students (CSV)
async function handleBulkStudents(req, res, next) {
  try {
    const collegeId = getCollegeId(req)
    if (!collegeId) return res.status(403).json({ message: 'College access required.' })

    const { csvText, students: rawStudentsList } = req.body ?? {}
    let rows = []

    if (typeof csvText === 'string' && csvText.trim()) {
      try {
        rows = parseStudentCsv(csvText)
      } catch (err) {
        return res.status(400).json({ message: err.message || 'Invalid CSV format.' })
      }
    } else if (Array.isArray(rawStudentsList) && rawStudentsList.length > 0) {
      rows = rawStudentsList.map((item, index) => ({
        rowNumber: index + 1,
        fullName: item.fullName,
        studentId: item.studentId,
        email: item.email,
        department: item.department,
        batch: item.batch,
        phone: item.phone,
      }))
    } else {
      return res.status(400).json({ message: 'Provide a CSV string or a list of students to import.' })
    }

    if (rows.length > 500) {
      return res.status(400).json({ message: 'Import is limited to 500 students at a time.' })
    }

    const imported = []
    const failures = []
    const generatedCredentials = []

    for (const row of rows) {
      const { fullName, studentId, email, department, batch, phone } = row
      if (!fullName || !email || !emailPattern.test(email)) {
        failures.push({ row: row.rowNumber, studentId, email, reason: 'Missing or invalid required fields (fullName, email).' })
        continue
      }

      const normalizedEmail = email.trim().toLowerCase()
      const rawId = (typeof studentId === 'string' && studentId.trim())
        ? studentId.trim()
        : `STU-${new Date().getFullYear()}-${randomBytes(3).toString('hex').toUpperCase()}`
      const username = makeStudentUsername(rawId, fullName)

      const [existingEmail, existingUsername, existingId] = await Promise.all([
        accountIdentifierExists('email', normalizedEmail),
        accountIdentifierExists('username', username),
        CollegeStudent.findOne({ collegeId, studentId: rawId }).collation({ locale: 'en', strength: 2 }).lean(),
      ])

      if (existingEmail || existingUsername || existingId) {
        failures.push({
          row: row.rowNumber,
          studentId: rawId,
          email: normalizedEmail,
          reason: existingEmail ? 'Email already registered' : existingId ? 'Student ID already exists in college' : 'Username conflict',
        })
        continue
      }

      try {
        const tempPassword = `LMS@${randomBytes(4).toString('hex')}`
        const passwordHash = await bcrypt.hash(tempPassword, 12)
        const accountId = new mongoose.Types.ObjectId()
        const session = await mongoose.startSession()
        let createdStudent

        try {
          await session.withTransaction(async () => {
            await assertCollegeStudentCapacity(collegeId, session)
            await AccountIdentity.create(
              [{
                email: normalizedEmail,
                username,
                accountCollection: CollegeStudent.collection.name,
                accountId,
              }],
              { session },
            )
            ;[createdStudent] = await CollegeStudent.create(
              [{
                _id: accountId,
                fullName: fullName.trim(),
                studentId: rawId,
                email: normalizedEmail,
                username,
                passwordHash,
                role: 'student',
                studentType: 'college',
                collegeId,
                department: typeof department === 'string' ? department.trim() : '',
                batch: typeof batch === 'string' ? batch.trim() : '',
                phone: typeof phone === 'string' ? phone.trim() : '',
                status: 'active',
                isActive: true,
                permissions: [],
              }],
              { session },
            )
          })
        } finally {
          await session.endSession()
        }

        imported.push({
          id: String(createdStudent._id),
          fullName: createdStudent.fullName,
          studentId: createdStudent.studentId,
          email: createdStudent.email,
          username: createdStudent.username,
        })
        generatedCredentials.push({
          fullName: createdStudent.fullName,
          studentId: createdStudent.studentId,
          username: createdStudent.username,
          email: createdStudent.email,
          password: tempPassword,
        })
      } catch (err) {
        failures.push({
          row: row.rowNumber,
          studentId: rawId,
          email: normalizedEmail,
          reason: err.code === 'college_student_limit' ? err.message : (err.message || 'Database error during insertion.'),
        })
      }
    }

    if (imported.length > 0) {
      await addCollegeNotification(
        collegeId,
        'Bulk Students Imported',
        `${imported.length} student(s) imported successfully into the system.`,
        'student',
      )
    }

    return res.json({
      message: `Import completed: ${imported.length} student(s) imported, ${failures.length} failed.`,
      summary: {
        total: rows.length,
        imported: imported.length,
        failed: failures.length,
        importedCount: imported.length,
        failedCount: failures.length,
      },
      imported,
      failures,
      credentials: generatedCredentials,
    })
  } catch (error) {
    return next(error)
  }
}

router.post('/students/bulk', ...requireCollege, handleBulkStudents)
router.post('/students/import', ...requireCollege, handleBulkStudents)

// Update Student
router.put('/students/:id', ...requireCollege, async (req, res, next) => {
  try {
    const collegeId = getCollegeId(req)
    if (!collegeId) return res.status(403).json({ message: 'College access required.' })
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: 'Invalid student ID.' })
    }

    const {
      fullName,
      studentId,
      department,
      batch,
      semester,
      email,
      phone,
      cgpa,
      academicStanding,
      skills,
      placementStatus,
      placedCompany,
      placementPackage,
    } = req.body ?? {}

    const student = await CollegeStudent.findOne({ _id: req.params.id, collegeId })
    if (!student) {
      return res.status(404).json({ message: 'Student was not found in your college.' })
    }

    if (typeof fullName === 'string' && fullName.trim()) student.fullName = fullName.trim().slice(0, 120)
    if (typeof department === 'string') student.department = department.trim().slice(0, 120)
    if (typeof batch === 'string') student.batch = batch.trim().slice(0, 80)
    if (typeof semester === 'string') student.semester = semester.trim().slice(0, 50)
    if (typeof phone === 'string') student.phone = phone.trim().slice(0, 40)
    if (typeof cgpa === 'number') student.cgpa = Math.max(0, Math.min(10, cgpa))
    if (['good', 'probation', 'at_risk', 'excellent'].includes(academicStanding)) {
      student.academicStanding = academicStanding
    }
    if (Array.isArray(skills)) student.skills = skills.map((s) => String(s).trim()).filter(Boolean)
    if (['not_eligible', 'seeking', 'interviewing', 'placed', 'opted_out'].includes(placementStatus)) {
      student.placementStatus = placementStatus
    }
    if (typeof placedCompany === 'string') student.placedCompany = placedCompany.trim()
    if (typeof placementPackage === 'number') student.placementPackage = Math.max(0, placementPackage)

    if (typeof studentId === 'string' && studentId.trim() && studentId.trim() !== student.studentId) {
      const trimmedId = studentId.trim()
      const exists = await CollegeStudent.findOne({
        _id: { $ne: student._id },
        collegeId,
        studentId: trimmedId,
      }).collation({ locale: 'en', strength: 2 }).lean()
      if (exists) return res.status(409).json({ message: 'Student ID already in use in this college.' })
      student.studentId = trimmedId
    }

    if (typeof email === 'string' && email.trim() && email.trim().toLowerCase() !== student.email) {
      const normalizedEmail = email.trim().toLowerCase()
      if (!emailPattern.test(normalizedEmail)) {
        return res.status(400).json({ message: 'Enter a valid email address.' })
      }
      const taken = await accountIdentifierExists('email', normalizedEmail)
      if (taken) return res.status(409).json({ message: 'Email address already registered.' })

      student.email = normalizedEmail
      await AccountIdentity.updateOne({ accountId: student._id }, { $set: { email: normalizedEmail } })
    }

    await student.save()
    return res.json({ message: 'Student details updated successfully.', student })
  } catch (error) {
    return next(error)
  }
})

// Toggle Student Status
router.patch('/students/:id/status', ...requireCollege, async (req, res, next) => {
  try {
    const collegeId = getCollegeId(req)
    if (!collegeId) return res.status(403).json({ message: 'College access required.' })
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: 'Invalid student ID.' })
    }

    const { isActive, status } = req.body ?? {}
    const student = await CollegeStudent.findOne({ _id: req.params.id, collegeId })
    if (!student) {
      return res.status(404).json({ message: 'Student not found in your college.' })
    }

    if (typeof isActive === 'boolean') {
      student.isActive = isActive
      student.status = isActive ? 'active' : 'inactive'
    } else if (typeof status === 'string' && status.trim()) {
      const normStatus = status.trim().toLowerCase()
      if (['active', 'inactive', 'suspended', 'pending'].includes(normStatus)) {
        student.status = normStatus
        student.isActive = normStatus === 'active'
      }
    }

    await student.save()
    return res.json({
      message: `Student account ${student.isActive ? 'activated' : 'deactivated'} successfully.`,
      student: { id: String(student._id), status: student.status, isActive: student.isActive },
    })
  } catch (error) {
    return next(error)
  }
})

// Reset Student Password
router.post('/students/:id/reset-password', ...requireCollege, async (req, res, next) => {
  try {
    const collegeId = getCollegeId(req)
    if (!collegeId) return res.status(403).json({ message: 'College access required.' })
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: 'Invalid student ID.' })
    }

    const student = await CollegeStudent.findOne({ _id: req.params.id, collegeId })
    if (!student) {
      return res.status(404).json({ message: 'Student not found in your college.' })
    }

    const { password } = req.body ?? {}
    const newPassword = (typeof password === 'string' && password.trim().length >= 8)
      ? password.trim()
      : `LMS@${randomBytes(4).toString('hex')}`

    student.passwordHash = await bcrypt.hash(newPassword, 12)
    student.isActive = true
    student.status = 'active'
    await student.save()

    return res.json({
      message: 'Student password reset successfully. Provide these credentials to the student.',
      credentials: {
        username: student.username,
        email: student.email,
        password: newPassword,
      },
    })
  } catch (error) {
    return next(error)
  }
})

// Export Student Records as CSV
router.get('/students/export', ...requireCollege, async (req, res, next) => {
  try {
    const collegeId = getCollegeId(req)
    if (!collegeId) return res.status(403).json({ message: 'College access required.' })

    const students = await CollegeStudent.find({ collegeId, role: 'student', studentType: 'college' })
      .select('fullName studentId email username department batch semester phone cgpa academicStanding placementStatus status createdAt')
      .sort({ department: 1, fullName: 1 })
      .lean()

    const headers = ['Full Name', 'Student ID', 'Email', 'Username', 'Department', 'Batch', 'Semester', 'Phone', 'CGPA', 'Standing', 'Placement Status', 'Account Status', 'Created At']
    const rows = students.map((s) => [
      csvEscape(s.fullName),
      csvEscape(s.studentId),
      csvEscape(s.email),
      csvEscape(s.username),
      csvEscape(s.department),
      csvEscape(s.batch),
      csvEscape(s.semester || ''),
      csvEscape(s.phone || ''),
      csvEscape(s.cgpa || 0),
      csvEscape(s.academicStanding || 'good'),
      csvEscape(s.placementStatus || 'seeking'),
      csvEscape(s.status),
      csvEscape(s.createdAt ? new Date(s.createdAt).toISOString().slice(0, 10) : ''),
    ])

    const csvContent = [headers.join(','), ...rows.map((r) => r.join(','))].join('\n')
    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', 'attachment; filename="students-export.csv"')
    return res.send(csvContent)
  } catch (error) {
    return next(error)
  }
})

// -------------------------------------------------------------
// 3. ACADEMIC MANAGEMENT (Departments, Batches, Semesters, Calendar)
// -------------------------------------------------------------

// Departments
router.get('/departments', ...requireCollege, async (req, res, next) => {
  try {
    const collegeId = getCollegeId(req)
    if (!collegeId) return res.status(403).json({ message: 'College access required.' })

    const departments = await Department.find({ collegeId }).sort({ name: 1 }).lean()

    const [studentCounts, batchCounts, facultyCounts] = await Promise.all([
      CollegeStudent.aggregate([
        { $match: { collegeId, role: 'student' } },
        { $group: { _id: '$department', count: { $sum: 1 } } },
      ]),
      Batch.aggregate([
        { $match: { collegeId } },
        { $group: { _id: '$department', count: { $sum: 1 } } },
      ]),
      Faculty.aggregate([
        { $match: { collegeId } },
        { $group: { _id: '$department', count: { $sum: 1 } } },
      ]),
    ])

    const studentMap = new Map(studentCounts.map((s) => [s._id, s.count]))
    const batchMap = new Map(batchCounts.map((b) => [b._id, b.count]))
    const facultyMap = new Map(facultyCounts.map((f) => [f._id, f.count]))

    const enriched = departments.map((d) => ({
      ...d,
      studentCount: studentMap.get(d.name) || 0,
      batchCount: batchMap.get(d.name) || 0,
      facultyCount: facultyMap.get(d.name) || 0,
    }))

    return res.json({ departments: enriched })
  } catch (error) {
    return next(error)
  }
})

router.post('/departments', ...requireCollege, async (req, res, next) => {
  try {
    const collegeId = getCollegeId(req)
    if (!collegeId) return res.status(403).json({ message: 'College access required.' })

    const { name, code, description, headOfDepartment, intakeCapacity } = req.body ?? {}
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 120) {
      return res.status(400).json({ message: 'Department name is required (max 120 characters).' })
    }
    if (typeof code !== 'string' || !code.trim() || code.trim().length > 40) {
      return res.status(400).json({ message: 'Department code is required (max 40 characters).' })
    }

    const cleanCode = code.trim().toUpperCase()
    const cleanName = name.trim()

    const existing = await Department.findOne({
      collegeId,
      $or: [{ code: cleanCode }, { name: cleanName }],
    }).lean()
    if (existing) {
      return res.status(409).json({ message: 'A department with this name or code already exists in your college.' })
    }

    const department = await Department.create({
      name: cleanName,
      code: cleanCode,
      description: typeof description === 'string' ? description.trim() : '',
      headOfDepartment: typeof headOfDepartment === 'string' ? headOfDepartment.trim() : '',
      intakeCapacity: typeof intakeCapacity === 'number' ? Math.max(0, intakeCapacity) : 60,
      collegeId,
      status: 'active',
    })

    await addCollegeNotification(collegeId, 'Department Created', `Department "${cleanName}" (${cleanCode}) was added.`, 'academic')
    return res.status(201).json({ message: 'Department created successfully.', department })
  } catch (error) {
    return next(error)
  }
})

router.put('/departments/:id', ...requireCollege, async (req, res, next) => {
  try {
    const collegeId = getCollegeId(req)
    if (!collegeId) return res.status(403).json({ message: 'College access required.' })
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: 'Invalid department ID.' })
    }

    const { name, code, description, headOfDepartment, intakeCapacity, status } = req.body ?? {}
    const department = await Department.findOne({ _id: req.params.id, collegeId })
    if (!department) return res.status(404).json({ message: 'Department not found.' })

    if (typeof name === 'string' && name.trim()) department.name = name.trim().slice(0, 120)
    if (typeof code === 'string' && code.trim()) department.code = code.trim().toUpperCase().slice(0, 40)
    if (typeof description === 'string') department.description = description.trim().slice(0, 500)
    if (typeof headOfDepartment === 'string') department.headOfDepartment = headOfDepartment.trim().slice(0, 120)
    if (typeof intakeCapacity === 'number') department.intakeCapacity = Math.max(0, intakeCapacity)
    if (['active', 'inactive'].includes(status)) department.status = status

    await department.save()
    return res.json({ message: 'Department updated successfully.', department })
  } catch (error) {
    return next(error)
  }
})

router.delete('/departments/:id', ...requireCollege, async (req, res, next) => {
  try {
    const collegeId = getCollegeId(req)
    if (!collegeId) return res.status(403).json({ message: 'College access required.' })
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: 'Invalid department ID.' })
    }

    const department = await Department.findOne({ _id: req.params.id, collegeId })
    if (!department) return res.status(404).json({ message: 'Department not found.' })

    const [assignedBatches, assignedStudents] = await Promise.all([
      Batch.countDocuments({ collegeId, department: department.name }),
      CollegeStudent.countDocuments({ collegeId, department: department.name }),
    ])

    if (assignedBatches > 0 || assignedStudents > 0) {
      return res.status(409).json({
        message: `Cannot delete department "${department.name}". There are ${assignedStudents} student(s) and ${assignedBatches} batch(es) assigned to it. Reassign or remove them first.`,
      })
    }

    await Department.deleteOne({ _id: department._id })
    return res.json({ message: `Department "${department.name}" was safely deleted.` })
  } catch (error) {
    return next(error)
  }
})

// Batches
router.get('/batches', ...requireCollege, async (req, res, next) => {
  try {
    const collegeId = getCollegeId(req)
    if (!collegeId) return res.status(403).json({ message: 'College access required.' })

    const batches = await Batch.find({ collegeId }).sort({ createdAt: -1 }).lean()

    const studentCounts = await CollegeStudent.aggregate([
      { $match: { collegeId, role: 'student' } },
      { $group: { _id: '$batch', count: { $sum: 1 } } },
    ])
    const countMap = new Map(studentCounts.map((s) => [s._id, s.count]))

    const enriched = batches.map((b) => ({
      ...b,
      studentCount: countMap.get(b.name) || 0,
    }))

    return res.json({ batches: enriched })
  } catch (error) {
    return next(error)
  }
})

router.post('/batches', ...requireCollege, async (req, res, next) => {
  try {
    const collegeId = getCollegeId(req)
    if (!collegeId) return res.status(403).json({ message: 'College access required.' })

    const { name, academicYear, department, departmentId, semester, startDate, endDate } = req.body ?? {}
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 120) {
      return res.status(400).json({ message: 'Batch name is required (e.g. 2025-2029 CS-A).' })
    }

    const cleanName = name.trim()
    const existing = await Batch.findOne({ collegeId, name: cleanName }).lean()
    if (existing) return res.status(409).json({ message: 'A batch with this name already exists in your college.' })

    let resolvedDeptId = departmentId
    if (department && !resolvedDeptId) {
      const dept = await Department.findOne({ collegeId, name: department.trim() }).select('_id').lean()
      if (dept) resolvedDeptId = dept._id
    }

    const batch = await Batch.create({
      name: cleanName,
      academicYear: typeof academicYear === 'string' ? academicYear.trim() : '',
      department: typeof department === 'string' ? department.trim() : '',
      departmentId: resolvedDeptId,
      semester: typeof semester === 'string' ? semester.trim() : '',
      startDate: startDate ? new Date(startDate) : undefined,
      endDate: endDate ? new Date(endDate) : undefined,
      collegeId,
      status: 'active',
    })

    await addCollegeNotification(collegeId, 'Batch Created', `Batch "${cleanName}" was created.`, 'academic')
    return res.status(201).json({ message: 'Batch created successfully.', batch })
  } catch (error) {
    return next(error)
  }
})

router.put('/batches/:id', ...requireCollege, async (req, res, next) => {
  try {
    const collegeId = getCollegeId(req)
    if (!collegeId) return res.status(403).json({ message: 'College access required.' })
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid batch ID.' })

    const { name, academicYear, department, departmentId, semester, status, startDate, endDate } = req.body ?? {}
    const batch = await Batch.findOne({ _id: req.params.id, collegeId })
    if (!batch) return res.status(404).json({ message: 'Batch not found.' })

    if (typeof name === 'string' && name.trim()) batch.name = name.trim().slice(0, 120)
    if (typeof academicYear === 'string') batch.academicYear = academicYear.trim().slice(0, 50)
    if (typeof department === 'string') batch.department = department.trim().slice(0, 120)
    if (mongoose.isValidObjectId(departmentId)) batch.departmentId = departmentId
    if (typeof semester === 'string') batch.semester = semester.trim().slice(0, 50)
    if (['active', 'graduated', 'archived'].includes(status)) batch.status = status
    if (startDate) batch.startDate = new Date(startDate)
    if (endDate) batch.endDate = new Date(endDate)

    await batch.save()
    return res.json({ message: 'Batch updated successfully.', batch })
  } catch (error) {
    return next(error)
  }
})

router.delete('/batches/:id', ...requireCollege, async (req, res, next) => {
  try {
    const collegeId = getCollegeId(req)
    if (!collegeId) return res.status(403).json({ message: 'College access required.' })
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid batch ID.' })

    const batch = await Batch.findOne({ _id: req.params.id, collegeId })
    if (!batch) return res.status(404).json({ message: 'Batch not found.' })

    const assignedStudentsCount = await CollegeStudent.countDocuments({ collegeId, batch: batch.name })
    if (assignedStudentsCount > 0) {
      return res.status(409).json({
        message: `Cannot delete batch "${batch.name}". There are ${assignedStudentsCount} student(s) currently assigned to this batch.`,
      })
    }

    await Batch.deleteOne({ _id: batch._id })
    return res.json({ message: `Batch "${batch.name}" was safely deleted.` })
  } catch (error) {
    return next(error)
  }
})

// Semesters
router.get('/semesters', ...requireCollege, async (req, res, next) => {
  try {
    const collegeId = getCollegeId(req)
    if (!collegeId) return res.status(403).json({ message: 'College access required.' })

    const semesters = await Semester.find({ collegeId }).sort({ startDate: -1, name: 1 }).lean()
    return res.json({ semesters })
  } catch (error) {
    return next(error)
  }
})

router.post('/semesters', ...requireCollege, async (req, res, next) => {
  try {
    const collegeId = getCollegeId(req)
    if (!collegeId) return res.status(403).json({ message: 'College access required.' })

    const { name, academicYear, department, departmentId, startDate, endDate, isCurrent, subjects, status } = req.body ?? {}
    if (typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ message: 'Semester name is required (e.g. Semester 1).' })
    }

    if (isCurrent) {
      await Semester.updateMany({ collegeId, department }, { $set: { isCurrent: false } })
    }

    const semester = await Semester.create({
      name: name.trim(),
      academicYear: typeof academicYear === 'string' ? academicYear.trim() : '',
      department: typeof department === 'string' ? department.trim() : '',
      departmentId: mongoose.isValidObjectId(departmentId) ? departmentId : undefined,
      startDate: startDate ? new Date(startDate) : undefined,
      endDate: endDate ? new Date(endDate) : undefined,
      isCurrent: Boolean(isCurrent),
      subjects: Array.isArray(subjects) ? subjects : [],
      status: ['upcoming', 'active', 'completed'].includes(status) ? status : 'active',
      collegeId,
    })

    return res.status(201).json({ message: 'Semester created successfully.', semester })
  } catch (error) {
    return next(error)
  }
})

router.put('/semesters/:id', ...requireCollege, async (req, res, next) => {
  try {
    const collegeId = getCollegeId(req)
    if (!collegeId) return res.status(403).json({ message: 'College access required.' })
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid semester ID.' })

    const semester = await Semester.findOne({ _id: req.params.id, collegeId })
    if (!semester) return res.status(404).json({ message: 'Semester not found.' })

    const { name, academicYear, department, startDate, endDate, isCurrent, subjects, status } = req.body ?? {}
    if (typeof name === 'string' && name.trim()) semester.name = name.trim()
    if (typeof academicYear === 'string') semester.academicYear = academicYear.trim()
    if (typeof department === 'string') semester.department = department.trim()
    if (startDate) semester.startDate = new Date(startDate)
    if (endDate) semester.endDate = new Date(endDate)
    if (typeof isCurrent === 'boolean') {
      if (isCurrent) await Semester.updateMany({ collegeId, _id: { $ne: semester._id } }, { $set: { isCurrent: false } })
      semester.isCurrent = isCurrent
    }
    if (Array.isArray(subjects)) semester.subjects = subjects
    if (['upcoming', 'active', 'completed'].includes(status)) semester.status = status

    await semester.save()
    return res.json({ message: 'Semester updated successfully.', semester })
  } catch (error) {
    return next(error)
  }
})

router.delete('/semesters/:id', ...requireCollege, async (req, res, next) => {
  try {
    const collegeId = getCollegeId(req)
    if (!collegeId) return res.status(403).json({ message: 'College access required.' })
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid semester ID.' })

    const semester = await Semester.findOne({ _id: req.params.id, collegeId })
    if (!semester) return res.status(404).json({ message: 'Semester not found.' })

    await Semester.deleteOne({ _id: semester._id })
    return res.json({ message: 'Semester deleted successfully.' })
  } catch (error) {
    return next(error)
  }
})

// Academic Calendar & Events
router.get('/events', ...requireCollege, async (req, res, next) => {
  try {
    const collegeId = getCollegeId(req)
    if (!collegeId) return res.status(403).json({ message: 'College access required.' })

    const { eventType, department } = req.query
    const query = { collegeId }
    if (eventType) query.eventType = eventType
    if (department) query.$or = [{ department }, { targetAudience: 'all' }]

    const events = await AcademicEvent.find(query).sort({ startDate: 1 }).lean()
    return res.json({ events })
  } catch (error) {
    return next(error)
  }
})

router.post('/events', ...requireCollege, async (req, res, next) => {
  try {
    const collegeId = getCollegeId(req)
    if (!collegeId) return res.status(403).json({ message: 'College access required.' })

    const { title, description, eventType, startDate, endDate, targetAudience, department, batch, isHoliday, venue } = req.body ?? {}
    if (typeof title !== 'string' || !title.trim()) {
      return res.status(400).json({ message: 'Event title is required.' })
    }
    if (!startDate || !endDate) {
      return res.status(400).json({ message: 'Start and end dates are required.' })
    }

    const event = await AcademicEvent.create({
      title: title.trim(),
      description: typeof description === 'string' ? description.trim() : '',
      eventType: eventType || 'activity',
      startDate: new Date(startDate),
      endDate: new Date(endDate),
      targetAudience: targetAudience || 'all',
      department: typeof department === 'string' ? department.trim() : '',
      batch: typeof batch === 'string' ? batch.trim() : '',
      isHoliday: Boolean(isHoliday),
      venue: typeof venue === 'string' ? venue.trim() : '',
      collegeId,
    })

    await addCollegeNotification(collegeId, 'Event Added', `New academic event "${event.title}" scheduled.`, 'academic')
    return res.status(201).json({ message: 'Academic event created successfully.', event })
  } catch (error) {
    return next(error)
  }
})

router.put('/events/:id', ...requireCollege, async (req, res, next) => {
  try {
    const collegeId = getCollegeId(req)
    if (!collegeId) return res.status(403).json({ message: 'College access required.' })
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid event ID.' })

    const event = await AcademicEvent.findOne({ _id: req.params.id, collegeId })
    if (!event) return res.status(404).json({ message: 'Event not found.' })

    const { title, description, eventType, startDate, endDate, targetAudience, department, isHoliday, venue } = req.body ?? {}
    if (typeof title === 'string' && title.trim()) event.title = title.trim()
    if (typeof description === 'string') event.description = description.trim()
    if (eventType) event.eventType = eventType
    if (startDate) event.startDate = new Date(startDate)
    if (endDate) event.endDate = new Date(endDate)
    if (targetAudience) event.targetAudience = targetAudience
    if (typeof department === 'string') event.department = department.trim()
    if (typeof isHoliday === 'boolean') event.isHoliday = isHoliday
    if (typeof venue === 'string') event.venue = venue.trim()

    await event.save()
    return res.json({ message: 'Event updated successfully.', event })
  } catch (error) {
    return next(error)
  }
})

router.delete('/events/:id', ...requireCollege, async (req, res, next) => {
  try {
    const collegeId = getCollegeId(req)
    if (!collegeId) return res.status(403).json({ message: 'College access required.' })
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid event ID.' })

    const event = await AcademicEvent.findOne({ _id: req.params.id, collegeId })
    if (!event) return res.status(404).json({ message: 'Event not found.' })

    await AcademicEvent.deleteOne({ _id: event._id })
    return res.json({ message: 'Event removed.' })
  } catch (error) {
    return next(error)
  }
})

// -------------------------------------------------------------
// 4. FACULTY MANAGEMENT (College Records, No 4th Auth Role)
// -------------------------------------------------------------
router.get('/faculty', ...requireCollege, async (req, res, next) => {
  try {
    const collegeId = getCollegeId(req)
    if (!collegeId) return res.status(403).json({ message: 'College access required.' })

    const { search, department, status } = req.query
    const query = { collegeId }
    if (department) query.department = department
    if (status) query.status = status
    if (search) {
      const reg = new RegExp(search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
      query.$or = [{ fullName: reg }, { email: reg }, { facultyId: reg }, { designation: reg }]
    }

    const facultyList = await Faculty.find(query).sort({ fullName: 1 }).lean()
    return res.json({ faculty: facultyList })
  } catch (error) {
    return next(error)
  }
})

router.post('/faculty', ...requireCollege, async (req, res, next) => {
  try {
    const collegeId = getCollegeId(req)
    if (!collegeId) return res.status(403).json({ message: 'College access required.' })

    const {
      fullName,
      email,
      phone,
      department,
      departmentId,
      designation,
      qualification,
      specialization,
      workloadHours,
      facultyId: customFacultyId,
    } = req.body ?? {}

    if (typeof fullName !== 'string' || !fullName.trim()) {
      return res.status(400).json({ message: 'Faculty full name is required.' })
    }
    if (typeof email !== 'string' || !emailPattern.test(email.trim())) {
      return res.status(400).json({ message: 'A valid email address is required.' })
    }

    const normEmail = email.trim().toLowerCase()
    const autoId = (typeof customFacultyId === 'string' && customFacultyId.trim())
      ? customFacultyId.trim()
      : `FAC-${new Date().getFullYear()}-${randomBytes(2).toString('hex').toUpperCase()}`

    const existing = await Faculty.findOne({ collegeId, $or: [{ email: normEmail }, { facultyId: autoId }] }).lean()
    if (existing) {
      return res.status(409).json({ message: 'A faculty member with this email or Faculty ID already exists in your college.' })
    }

    const faculty = await Faculty.create({
      facultyId: autoId,
      fullName: fullName.trim(),
      email: normEmail,
      phone: typeof phone === 'string' ? phone.trim() : '',
      department: typeof department === 'string' ? department.trim() : '',
      departmentId: mongoose.isValidObjectId(departmentId) ? departmentId : undefined,
      designation: typeof designation === 'string' ? designation.trim() : 'Assistant Professor',
      qualification: typeof qualification === 'string' ? qualification.trim() : '',
      specialization: typeof specialization === 'string' ? specialization.trim() : '',
      workloadHours: typeof workloadHours === 'number' ? workloadHours : 16,
      collegeId,
      status: 'active',
    })

    await addCollegeNotification(collegeId, 'Faculty Added', `Faculty member ${faculty.fullName} (${faculty.facultyId}) was registered.`, 'academic')
    return res.status(201).json({ message: 'Faculty profile added successfully.', faculty })
  } catch (error) {
    return next(error)
  }
})

router.put('/faculty/:id', ...requireCollege, async (req, res, next) => {
  try {
    const collegeId = getCollegeId(req)
    if (!collegeId) return res.status(403).json({ message: 'College access required.' })
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid faculty ID.' })

    const faculty = await Faculty.findOne({ _id: req.params.id, collegeId })
    if (!faculty) return res.status(404).json({ message: 'Faculty profile not found.' })

    const { fullName, phone, department, designation, qualification, specialization, workloadHours, status } = req.body ?? {}
    if (typeof fullName === 'string' && fullName.trim()) faculty.fullName = fullName.trim()
    if (typeof phone === 'string') faculty.phone = phone.trim()
    if (typeof department === 'string') faculty.department = department.trim()
    if (typeof designation === 'string') faculty.designation = designation.trim()
    if (typeof qualification === 'string') faculty.qualification = qualification.trim()
    if (typeof specialization === 'string') faculty.specialization = specialization.trim()
    if (typeof workloadHours === 'number') faculty.workloadHours = Math.max(0, workloadHours)
    if (['active', 'on_leave', 'inactive'].includes(status)) faculty.status = status

    await faculty.save()
    return res.json({ message: 'Faculty details updated successfully.', faculty })
  } catch (error) {
    return next(error)
  }
})

router.delete('/faculty/:id', ...requireCollege, async (req, res, next) => {
  try {
    const collegeId = getCollegeId(req)
    if (!collegeId) return res.status(403).json({ message: 'College access required.' })
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid faculty ID.' })

    const faculty = await Faculty.findOne({ _id: req.params.id, collegeId })
    if (!faculty) return res.status(404).json({ message: 'Faculty profile not found.' })

    await Faculty.deleteOne({ _id: faculty._id })
    return res.json({ message: `Faculty profile for ${faculty.fullName} was removed.` })
  } catch (error) {
    return next(error)
  }
})

// Assign Course/Batch to Faculty
router.post('/faculty/:id/assign-course', ...requireCollege, async (req, res, next) => {
  try {
    const collegeId = getCollegeId(req)
    if (!collegeId) return res.status(403).json({ message: 'College access required.' })
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid faculty ID.' })

    const faculty = await Faculty.findOne({ _id: req.params.id, collegeId })
    if (!faculty) return res.status(404).json({ message: 'Faculty not found.' })

    const { courseId, batch, semester } = req.body ?? {}
    if (!mongoose.isValidObjectId(courseId)) return res.status(400).json({ message: 'Select a valid course.' })

    const course = await Course.findById(courseId).select('title').lean()
    if (!course) return res.status(404).json({ message: 'Course not found.' })

    faculty.assignedCourses.push({
      courseId: course._id,
      courseTitle: course.title,
      batch: typeof batch === 'string' ? batch.trim() : 'All Batches',
      semester: typeof semester === 'string' ? semester.trim() : '',
    })
    await faculty.save()

    return res.json({ message: `Course "${course.title}" assigned to ${faculty.fullName}.`, faculty })
  } catch (error) {
    return next(error)
  }
})

// -------------------------------------------------------------
// 5. ATTENDANCE MANAGEMENT
// -------------------------------------------------------------
router.get('/attendance', ...requireCollege, async (req, res, next) => {
  try {
    const collegeId = getCollegeId(req)
    if (!collegeId) return res.status(403).json({ message: 'College access required.' })

    const { department, batch, subject, date } = req.query
    const query = { collegeId }
    if (department) query.department = department
    if (batch) query.batch = batch
    if (subject) query.subject = subject
    if (date) {
      const d = new Date(date)
      if (!Number.isNaN(d.getTime())) {
        const startOfDay = new Date(d.getFullYear(), d.getMonth(), d.getDate())
        const endOfDay = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999)
        query.date = { $gte: startOfDay, $lte: endOfDay }
      }
    }

    const sessions = await Attendance.find(query).sort({ date: -1 }).limit(100).lean()
    return res.json({ sessions })
  } catch (error) {
    return next(error)
  }
})

router.post('/attendance', ...requireCollege, async (req, res, next) => {
  try {
    const collegeId = getCollegeId(req)
    if (!collegeId) return res.status(403).json({ message: 'College access required.' })

    const { department, batch, subject, date, semester, takenBy, records } = req.body ?? {}
    if (!department || !batch || !subject) {
      return res.status(400).json({ message: 'Department, batch, and subject are required.' })
    }
    if (!Array.isArray(records) || records.length === 0) {
      return res.status(400).json({ message: 'Attendance records array is required.' })
    }

    const attendanceDate = date ? new Date(date) : new Date()

    const session = await Attendance.create({
      collegeId,
      date: attendanceDate,
      department: department.trim(),
      batch: batch.trim(),
      subject: subject.trim(),
      semester: typeof semester === 'string' ? semester.trim() : '',
      takenBy: typeof takenBy === 'string' ? takenBy.trim() : 'College Faculty',
      records: records.map((r) => ({
        studentId: r.studentId,
        studentRollNo: r.studentRollNo || '',
        studentName: r.studentName || '',
        status: ['present', 'absent', 'late', 'excused'].includes(r.status) ? r.status : 'present',
        remarks: r.remarks || '',
      })),
      correctionHistory: [],
    })

    return res.status(201).json({ message: 'Attendance recorded successfully.', session })
  } catch (error) {
    return next(error)
  }
})

// Attendance correction with audit trail
router.put('/attendance/:id', ...requireCollege, async (req, res, next) => {
  try {
    const collegeId = getCollegeId(req)
    if (!collegeId) return res.status(403).json({ message: 'College access required.' })
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid attendance ID.' })

    const session = await Attendance.findOne({ _id: req.params.id, collegeId })
    if (!session) return res.status(404).json({ message: 'Attendance session not found.' })

    const { studentId, newStatus, reason } = req.body ?? {}
    if (!mongoose.isValidObjectId(studentId) || !['present', 'absent', 'late', 'excused'].includes(newStatus)) {
      return res.status(400).json({ message: 'Provide studentId and valid new status.' })
    }

    const record = session.records.find((r) => String(r.studentId) === String(studentId))
    if (!record) return res.status(404).json({ message: 'Student record not found in this session.' })

    const previousStatus = record.status
    record.status = newStatus

    session.correctionHistory.push({
      correctedAt: new Date(),
      correctedBy: req.auth.user?.fullName || 'College Admin',
      studentId,
      studentName: record.studentName,
      previousStatus,
      newStatus,
      reason: typeof reason === 'string' ? reason.trim() : 'Administrative adjustment',
    })

    await session.save()
    return res.json({ message: 'Attendance corrected with audit trail updated.', session })
  } catch (error) {
    return next(error)
  }
})

// Attendance Statistics & Low Attendance Warning Alert
router.get('/attendance/stats', ...requireCollege, async (req, res, next) => {
  try {
    const collegeId = getCollegeId(req)
    if (!collegeId) return res.status(403).json({ message: 'College access required.' })

    const threshold = parseFloat(req.query.threshold) || 75.0
    const sessions = await Attendance.find({ collegeId }).select('records department batch subject').lean()

    const studentMap = new Map()
    const subjectMap = new Map()
    const batchMap = new Map()

    for (const session of sessions) {
      const bKey = session.batch || 'General'
      const sKey = session.subject || 'General'

      if (!batchMap.has(bKey)) batchMap.set(bKey, { present: 0, total: 0 })
      if (!subjectMap.has(sKey)) subjectMap.set(sKey, { present: 0, total: 0 })

      for (const rec of session.records || []) {
        const sid = String(rec.studentId)
        if (!studentMap.has(sid)) {
          studentMap.set(sid, {
            studentId: sid,
            studentName: rec.studentName,
            studentRollNo: rec.studentRollNo,
            department: session.department,
            batch: session.batch,
            present: 0,
            total: 0,
          })
        }
        const sStat = studentMap.get(sid)
        sStat.total++
        batchMap.get(bKey).total++
        subjectMap.get(sKey).total++

        if (rec.status === 'present' || rec.status === 'late') {
          sStat.present++
          batchMap.get(bKey).present++
          subjectMap.get(sKey).present++
        }
      }
    }

    const lowAttendanceStudents = []
    let totalPresentSum = 0
    let totalRecordsSum = 0

    for (const [, s] of studentMap.entries()) {
      totalPresentSum += s.present
      totalRecordsSum += s.total
      const rate = s.total > 0 ? Math.round((s.present / s.total) * 100) : 0
      if (s.total >= 1 && rate < threshold) {
        lowAttendanceStudents.push({ ...s, rate })
      }
    }

    const overallPercentage = totalRecordsSum > 0 ? Math.round((totalPresentSum / totalRecordsSum) * 100) : 0

    const batchStats = Array.from(batchMap.entries()).map(([batch, data]) => ({
      batch,
      percentage: data.total > 0 ? Math.round((data.present / data.total) * 100) : 0,
      totalSessions: data.total,
    }))

    const subjectStats = Array.from(subjectMap.entries()).map(([subject, data]) => ({
      subject,
      percentage: data.total > 0 ? Math.round((data.present / data.total) * 100) : 0,
      totalSessions: data.total,
    }))

    return res.json({
      overallPercentage,
      totalSessionsRecorded: sessions.length,
      threshold,
      lowAttendanceCount: lowAttendanceStudents.length,
      lowAttendanceStudents: lowAttendanceStudents.sort((a, b) => a.rate - b.rate),
      batchStats,
      subjectStats,
    })
  } catch (error) {
    return next(error)
  }
})

// Export Attendance Records as CSV
router.get('/attendance/export', ...requireCollege, async (req, res, next) => {
  try {
    const collegeId = getCollegeId(req)
    if (!collegeId) return res.status(403).json({ message: 'College access required.' })

    const sessions = await Attendance.find({ collegeId }).sort({ date: -1 }).lean()
    const rows = []
    for (const s of sessions) {
      const dateStr = s.date ? new Date(s.date).toISOString().slice(0, 10) : ''
      for (const r of s.records || []) {
        rows.push([
          csvEscape(dateStr),
          csvEscape(s.department),
          csvEscape(s.batch),
          csvEscape(s.subject),
          csvEscape(r.studentRollNo || ''),
          csvEscape(r.studentName || ''),
          csvEscape(r.status),
          csvEscape(r.remarks || ''),
          csvEscape(s.takenBy || ''),
        ])
      }
    }

    const headers = ['Date', 'Department', 'Batch', 'Subject', 'Student ID', 'Student Name', 'Status', 'Remarks', 'Taken By']
    const csvContent = [headers.join(','), ...rows.map((r) => r.join(','))].join('\n')
    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', 'attachment; filename="attendance-records.csv"')
    return res.send(csvContent)
  } catch (error) {
    return next(error)
  }
})

// -------------------------------------------------------------
// 6. EXAMINATION AND RESULT MANAGEMENT
// -------------------------------------------------------------
router.get('/examinations', ...requireCollege, async (req, res, next) => {
  try {
    const collegeId = getCollegeId(req)
    if (!collegeId) return res.status(403).json({ message: 'College access required.' })

    const { department, semester, status } = req.query
    const query = { collegeId }
    if (department) query.department = department
    if (semester) query.semester = semester
    if (status) query.status = status

    const exams = await Examination.find(query).sort({ startDate: -1 }).lean()
    const enriched = exams.map((e) => {
      const resList = e.results || []
      const passCount = resList.filter((r) => r.isPass).length
      return {
        ...e,
        resultsCount: resList.length,
        passPercentage: resList.length > 0 ? Math.round((passCount / resList.length) * 100) : 0,
      }
    })

    return res.json({ examinations: enriched })
  } catch (error) {
    return next(error)
  }
})

router.post('/examinations', ...requireCollege, async (req, res, next) => {
  try {
    const collegeId = getCollegeId(req)
    if (!collegeId) return res.status(403).json({ message: 'College access required.' })

    const { title, examType, semester, department, batch, subject, startDate, endDate, maxMarks, passingMarks, status } = req.body ?? {}
    if (typeof title !== 'string' || !title.trim()) {
      return res.status(400).json({ message: 'Examination title is required.' })
    }
    if (!startDate || !endDate) {
      return res.status(400).json({ message: 'Start and end dates are required.' })
    }

    const exam = await Examination.create({
      collegeId,
      title: title.trim(),
      examType: examType || 'internal',
      semester: typeof semester === 'string' ? semester.trim() : '',
      department: typeof department === 'string' ? department.trim() : '',
      batch: typeof batch === 'string' ? batch.trim() : '',
      subject: typeof subject === 'string' ? subject.trim() : '',
      startDate: new Date(startDate),
      endDate: new Date(endDate),
      maxMarks: typeof maxMarks === 'number' ? Math.max(1, maxMarks) : 100,
      passingMarks: typeof passingMarks === 'number' ? Math.max(0, passingMarks) : 40,
      status: status || 'scheduled',
      results: [],
    })

    await addCollegeNotification(collegeId, 'Examination Scheduled', `Examination "${exam.title}" scheduled.`, 'exam')
    return res.status(201).json({ message: 'Examination created successfully.', examination: exam })
  } catch (error) {
    return next(error)
  }
})

router.put('/examinations/:id', ...requireCollege, async (req, res, next) => {
  try {
    const collegeId = getCollegeId(req)
    if (!collegeId) return res.status(403).json({ message: 'College access required.' })
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid examination ID.' })

    const exam = await Examination.findOne({ _id: req.params.id, collegeId })
    if (!exam) return res.status(404).json({ message: 'Examination not found.' })

    const { title, examType, semester, department, batch, subject, startDate, endDate, maxMarks, passingMarks, status } = req.body ?? {}
    if (typeof title === 'string' && title.trim()) exam.title = title.trim()
    if (examType) exam.examType = examType
    if (typeof semester === 'string') exam.semester = semester.trim()
    if (typeof department === 'string') exam.department = department.trim()
    if (typeof batch === 'string') exam.batch = batch.trim()
    if (typeof subject === 'string') exam.subject = subject.trim()
    if (startDate) exam.startDate = new Date(startDate)
    if (endDate) exam.endDate = new Date(endDate)
    if (typeof maxMarks === 'number') exam.maxMarks = Math.max(1, maxMarks)
    if (typeof passingMarks === 'number') exam.passingMarks = Math.max(0, passingMarks)
    if (['scheduled', 'ongoing', 'completed', 'published'].includes(status)) exam.status = status

    await exam.save()
    return res.json({ message: 'Examination updated successfully.', examination: exam })
  } catch (error) {
    return next(error)
  }
})

router.delete('/examinations/:id', ...requireCollege, async (req, res, next) => {
  try {
    const collegeId = getCollegeId(req)
    if (!collegeId) return res.status(403).json({ message: 'College access required.' })
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid examination ID.' })

    const exam = await Examination.findOne({ _id: req.params.id, collegeId })
    if (!exam) return res.status(404).json({ message: 'Examination not found.' })

    await Examination.deleteOne({ _id: exam._id })
    return res.json({ message: 'Examination deleted.' })
  } catch (error) {
    return next(error)
  }
})

// Bulk marks entry with automatic grade calculation
router.post('/examinations/:id/results', ...requireCollege, async (req, res, next) => {
  try {
    const collegeId = getCollegeId(req)
    if (!collegeId) return res.status(403).json({ message: 'College access required.' })
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid examination ID.' })

    const exam = await Examination.findOne({ _id: req.params.id, collegeId })
    if (!exam) return res.status(404).json({ message: 'Examination not found.' })

    const { results } = req.body ?? {}
    if (!Array.isArray(results) || results.length === 0) {
      return res.status(400).json({ message: 'Results array is required.' })
    }

    const max = exam.maxMarks || 100
    const pass = exam.passingMarks || 40

    const processedResults = results.map((item) => {
      const marks = typeof item.marksObtained === 'number' ? Math.max(0, item.marksObtained) : 0
      const percentage = (marks / max) * 100
      const isPass = marks >= pass
      const grade = calculateGrade(percentage)
      return {
        studentId: item.studentId,
        studentRollNo: item.studentRollNo || '',
        studentName: item.studentName || '',
        subject: item.subject || exam.subject,
        marksObtained: marks,
        maxMarks: max,
        grade,
        isPass,
        backlog: !isPass,
        remarks: item.remarks || '',
        updatedAt: new Date(),
      }
    })

    exam.results = processedResults
    exam.status = 'completed'
    await exam.save()

    await addCollegeNotification(collegeId, 'Exam Marks Recorded', `Marks recorded for examination "${exam.title}".`, 'exam')
    return res.json({ message: `Successfully recorded results for ${processedResults.length} student(s).`, examination: exam })
  } catch (error) {
    return next(error)
  }
})

// Downloadable Student Report Card
router.get('/results/report-card/:studentId', ...requireCollege, async (req, res, next) => {
  try {
    const collegeId = getCollegeId(req)
    if (!collegeId) return res.status(403).json({ message: 'College access required.' })
    if (!mongoose.isValidObjectId(req.params.studentId)) return res.status(400).json({ message: 'Invalid student ID.' })

    const [student, college, exams] = await Promise.all([
      CollegeStudent.findOne({ _id: req.params.studentId, collegeId }).lean(),
      College.findById(collegeId).select('name code city state').lean(),
      Examination.find({ collegeId, 'results.studentId': req.params.studentId }).lean(),
    ])

    if (!student) return res.status(404).json({ message: 'Student not found.' })

    const subjectScores = []
    let totalMarks = 0
    let totalMax = 0
    let backlogsCount = 0

    for (const exam of exams) {
      const r = exam.results.find((item) => String(item.studentId) === String(student._id))
      if (r) {
        totalMarks += r.marksObtained
        totalMax += r.maxMarks
        if (r.backlog) backlogsCount++
        subjectScores.push({
          examTitle: exam.title,
          examType: exam.examType,
          subject: r.subject || exam.subject,
          marksObtained: r.marksObtained,
          maxMarks: r.maxMarks,
          percentage: r.maxMarks > 0 ? Math.round((r.marksObtained / r.maxMarks) * 100) : 0,
          grade: r.grade,
          isPass: r.isPass,
          backlog: r.backlog,
        })
      }
    }

    const overallPercentage = totalMax > 0 ? Math.round((totalMarks / totalMax) * 100) : 0
    const overallGrade = calculateGrade(overallPercentage)

    return res.json({
      college,
      student: {
        fullName: student.fullName,
        studentId: student.studentId,
        department: student.department,
        batch: student.batch,
        semester: student.semester || 'Semester 1',
        email: student.email,
      },
      reportCard: {
        generatedAt: new Date(),
        totalExamsTaken: subjectScores.length,
        totalMarksObtained: totalMarks,
        totalMaxMarks: totalMax,
        overallPercentage,
        overallGrade,
        backlogsCount,
        results: subjectScores,
      },
    })
  } catch (error) {
    return next(error)
  }
})

// -------------------------------------------------------------
// 7. PLACEMENT AND INTERNSHIP MANAGEMENT
// -------------------------------------------------------------
router.get('/placements', ...requireCollege, async (req, res, next) => {
  try {
    const collegeId = getCollegeId(req)
    if (!collegeId) return res.status(403).json({ message: 'College access required.' })

    const { opportunityType, status } = req.query
    const query = { collegeId }
    if (opportunityType) query.opportunityType = opportunityType
    if (status) query.status = status

    const drives = await PlacementDrive.find(query).sort({ deadline: 1 }).lean()
    const enriched = drives.map((d) => ({
      ...d,
      totalApplicants: d.applications?.length || 0,
      placedCount: d.applications?.filter((a) => a.status === 'placed')?.length || 0,
    }))

    return res.json({ placementDrives: enriched })
  } catch (error) {
    return next(error)
  }
})

router.post('/placements', ...requireCollege, async (req, res, next) => {
  try {
    const collegeId = getCollegeId(req)
    if (!collegeId) return res.status(403).json({ message: 'College access required.' })

    const {
      companyName,
      companyWebsite,
      jobTitle,
      opportunityType,
      packageLpa,
      stipendMonthly,
      location,
      eligibleDepartments,
      minCgpa,
      maxBacklogs,
      deadline,
      driveDate,
      rounds,
    } = req.body ?? {}

    if (typeof companyName !== 'string' || !companyName.trim()) {
      return res.status(400).json({ message: 'Company name is required.' })
    }
    if (typeof jobTitle !== 'string' || !jobTitle.trim()) {
      return res.status(400).json({ message: 'Job title is required.' })
    }
    if (!deadline) {
      return res.status(400).json({ message: 'Application deadline is required.' })
    }

    const drive = await PlacementDrive.create({
      collegeId,
      companyName: companyName.trim(),
      companyWebsite: typeof companyWebsite === 'string' ? companyWebsite.trim() : '',
      jobTitle: jobTitle.trim(),
      opportunityType: opportunityType || 'full_time',
      packageLpa: typeof packageLpa === 'number' ? Math.max(0, packageLpa) : 0,
      stipendMonthly: typeof stipendMonthly === 'number' ? Math.max(0, stipendMonthly) : 0,
      location: typeof location === 'string' ? location.trim() : 'Multiple',
      eligibleDepartments: Array.isArray(eligibleDepartments) ? eligibleDepartments : [],
      minCgpa: typeof minCgpa === 'number' ? minCgpa : 6.0,
      maxBacklogs: typeof maxBacklogs === 'number' ? maxBacklogs : 0,
      deadline: new Date(deadline),
      driveDate: driveDate ? new Date(driveDate) : undefined,
      rounds: Array.isArray(rounds) && rounds.length > 0 ? rounds : ['Online Assessment', 'Technical Interview', 'HR Interview'],
      status: 'active',
      applications: [],
    })

    await addCollegeNotification(collegeId, 'Placement Drive Announced', `${drive.companyName} (${drive.jobTitle}) drive is now active.`, 'placement')
    return res.status(201).json({ message: 'Placement opportunity created.', placementDrive: drive })
  } catch (error) {
    return next(error)
  }
})

router.put('/placements/:id', ...requireCollege, async (req, res, next) => {
  try {
    const collegeId = getCollegeId(req)
    if (!collegeId) return res.status(403).json({ message: 'College access required.' })
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid drive ID.' })

    const drive = await PlacementDrive.findOne({ _id: req.params.id, collegeId })
    if (!drive) return res.status(404).json({ message: 'Placement drive not found.' })

    const { companyName, jobTitle, opportunityType, packageLpa, stipendMonthly, location, minCgpa, deadline, driveDate, status } = req.body ?? {}
    if (typeof companyName === 'string' && companyName.trim()) drive.companyName = companyName.trim()
    if (typeof jobTitle === 'string' && jobTitle.trim()) drive.jobTitle = jobTitle.trim()
    if (opportunityType) drive.opportunityType = opportunityType
    if (typeof packageLpa === 'number') drive.packageLpa = Math.max(0, packageLpa)
    if (typeof stipendMonthly === 'number') drive.stipendMonthly = Math.max(0, stipendMonthly)
    if (typeof location === 'string') drive.location = location.trim()
    if (typeof minCgpa === 'number') drive.minCgpa = minCgpa
    if (deadline) drive.deadline = new Date(deadline)
    if (driveDate) drive.driveDate = new Date(driveDate)
    if (status) drive.status = status

    await drive.save()
    return res.json({ message: 'Placement drive updated.', placementDrive: drive })
  } catch (error) {
    return next(error)
  }
})

router.delete('/placements/:id', ...requireCollege, async (req, res, next) => {
  try {
    const collegeId = getCollegeId(req)
    if (!collegeId) return res.status(403).json({ message: 'College access required.' })
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid drive ID.' })

    const drive = await PlacementDrive.findOne({ _id: req.params.id, collegeId })
    if (!drive) return res.status(404).json({ message: 'Placement drive not found.' })

    await PlacementDrive.deleteOne({ _id: drive._id })
    return res.json({ message: 'Placement drive removed.' })
  } catch (error) {
    return next(error)
  }
})

// Apply student for placement drive
router.post('/placements/:id/apply', ...requireCollege, async (req, res, next) => {
  try {
    const collegeId = getCollegeId(req)
    if (!collegeId) return res.status(403).json({ message: 'College access required.' })
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid drive ID.' })

    const drive = await PlacementDrive.findOne({ _id: req.params.id, collegeId })
    if (!drive) return res.status(404).json({ message: 'Placement drive not found.' })

    const { studentId, notes } = req.body ?? {}
    if (!mongoose.isValidObjectId(studentId)) return res.status(400).json({ message: 'Valid student ID is required.' })

    const student = await CollegeStudent.findOne({ _id: studentId, collegeId }).lean()
    if (!student) return res.status(404).json({ message: 'Student not found in your college.' })

    const existingApp = drive.applications.find((a) => String(a.studentId) === String(student._id))
    if (existingApp) return res.status(409).json({ message: 'This student has already applied for this placement drive.' })

    drive.applications.push({
      studentId: student._id,
      studentName: student.fullName,
      studentEmail: student.email,
      studentRollNo: student.studentId,
      department: student.department,
      batch: student.batch,
      cgpa: student.cgpa || 0,
      resumeUrl: student.resumeUrl || '',
      status: 'applied',
      appliedAt: new Date(),
      notes: typeof notes === 'string' ? notes.trim() : '',
    })

    await drive.save()
    return res.status(201).json({ message: `Student ${student.fullName} registered for ${drive.companyName}.`, placementDrive: drive })
  } catch (error) {
    return next(error)
  }
})

// Update student application status in a placement drive
router.patch('/placements/:id/applications/:appId', ...requireCollege, async (req, res, next) => {
  try {
    const collegeId = getCollegeId(req)
    if (!collegeId) return res.status(403).json({ message: 'College access required.' })
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid drive ID.' })

    const drive = await PlacementDrive.findOne({ _id: req.params.id, collegeId })
    if (!drive) return res.status(404).json({ message: 'Placement drive not found.' })

    const app = drive.applications.id(req.params.appId)
    if (!app) return res.status(404).json({ message: 'Application record not found.' })

    const { status, offeredPackage, notes } = req.body ?? {}
    if (['applied', 'shortlisted', 'interviewing', 'placed', 'rejected'].includes(status)) {
      app.status = status
    }
    if (typeof offeredPackage === 'number') app.offeredPackage = offeredPackage
    if (typeof notes === 'string') app.notes = notes.trim()

    await drive.save()

    // If marked placed, sync student placement status
    if (status === 'placed') {
      await CollegeStudent.updateOne(
        { _id: app.studentId, collegeId },
        {
          $set: {
            placementStatus: 'placed',
            placedCompany: drive.companyName,
            placementPackage: app.offeredPackage || drive.packageLpa || 0,
          },
        },
      )
    }

    return res.json({ message: 'Application status updated.', application: app })
  } catch (error) {
    return next(error)
  }
})

// Placement Statistics
router.get('/placements/stats', ...requireCollege, async (req, res, next) => {
  try {
    const collegeId = getCollegeId(req)
    if (!collegeId) return res.status(403).json({ message: 'College access required.' })

    const [totalStudents, drives] = await Promise.all([
      CollegeStudent.countDocuments({ collegeId, role: 'student', studentType: 'college' }),
      PlacementDrive.find({ collegeId }).lean(),
    ])

    const departmentPlacementMap = new Map()
    const companyHiringStats = []
    let totalPlaced = 0
    let totalInternships = 0
    let highestPackage = 0

    for (const drive of drives) {
      let drivePlaced = 0
      for (const app of drive.applications || []) {
        if (app.status === 'placed') {
          totalPlaced++
          drivePlaced++
          const dept = app.department || 'General'
          departmentPlacementMap.set(dept, (departmentPlacementMap.get(dept) || 0) + 1)
          if ((app.offeredPackage || drive.packageLpa) > highestPackage) {
            highestPackage = app.offeredPackage || drive.packageLpa
          }
        }
      }
      if (drive.opportunityType === 'internship') totalInternships++
      companyHiringStats.push({
        companyName: drive.companyName,
        jobTitle: drive.jobTitle,
        placedCount: drivePlaced,
        packageLpa: drive.packageLpa,
      })
    }

    const placementPercentage = totalStudents > 0 ? Math.round((totalPlaced / totalStudents) * 100) : 0

    return res.json({
      totalEligible: totalStudents,
      totalPlaced,
      placementPercentage,
      totalDrives: drives.length,
      totalInternshipDrives: totalInternships,
      highestPackage,
      departmentStats: Array.from(departmentPlacementMap.entries()).map(([department, count]) => ({
        department,
        placedCount: count,
      })),
      companyHiringStats: companyHiringStats.sort((a, b) => b.placedCount - a.placedCount).slice(0, 10),
    })
  } catch (error) {
    return next(error)
  }
})

// -------------------------------------------------------------
// 8. ADVANCED LEARNING ANALYTICS & AI-ASSISTED INSIGHTS
// -------------------------------------------------------------
router.get('/analytics', ...requireCollege, async (req, res, next) => {
  try {
    const collegeId = getCollegeId(req)
    if (!collegeId) return res.status(403).json({ message: 'College access required.' })

    const [
      students,
      enrollments,
      progressDocs,
      departments,
      batches,
      courses,
      attendanceSessions,
      examinations,
    ] = await Promise.all([
      CollegeStudent.find({ collegeId, role: 'student' }).select('fullName studentId department batch cgpa academicStanding').lean(),
      Enrollment.find({ collegeId, status: { $ne: 'cancelled' } }).select('courseId userId').lean(),
      Progress.find({ collegeId }).select('progressPercentage status userId courseId completedLessons quizSubmissions assignmentSubmissions lastActivityAt').lean(),
      Department.find({ collegeId }).select('name code').lean(),
      Batch.find({ collegeId }).select('name academicYear department').lean(),
      Course.find({ status: 'published' }).select('title').lean(),
      Attendance.find({ collegeId }).select('records department batch subject').lean(),
      Examination.find({ collegeId }).select('title examType department subject results maxMarks passingMarks').lean(),
    ])

    // Department-wise breakdown
    const deptStats = departments.map((dept) => {
      const deptStudents = students.filter((s) => s.department === dept.name)
      const deptStudentIds = new Set(deptStudents.map((s) => String(s._id)))
      const deptProgress = progressDocs.filter((p) => deptStudentIds.has(String(p.userId)))
      const avgProg = deptProgress.length > 0
        ? Math.round(deptProgress.reduce((sum, p) => sum + (p.progressPercentage || 0), 0) / deptProgress.length)
        : 0
      const completed = deptProgress.filter((p) => p.status === 'completed' || p.progressPercentage >= 100).length
      return {
        department: dept.name,
        code: dept.code,
        studentCount: deptStudents.length,
        avgProgress: avgProg,
        completedCount: completed,
      }
    })

    // Batch-wise breakdown
    const batchStats = batches.map((batch) => {
      const batchStudents = students.filter((s) => s.batch === batch.name)
      const batchStudentIds = new Set(batchStudents.map((s) => String(s._id)))
      const batchProgress = progressDocs.filter((p) => batchStudentIds.has(String(p.userId)))
      const avgProg = batchProgress.length > 0
        ? Math.round(batchProgress.reduce((sum, p) => sum + (p.progressPercentage || 0), 0) / batchProgress.length)
        : 0
      return {
        batch: batch.name,
        department: batch.department,
        studentCount: batchStudents.length,
        avgProgress: avgProg,
      }
    })

    // At-risk students identification
    const studentAttendanceMap = new Map()
    for (const session of attendanceSessions) {
      for (const r of session.records || []) {
        const sid = String(r.studentId)
        if (!studentAttendanceMap.has(sid)) studentAttendanceMap.set(sid, { present: 0, total: 0 })
        const stat = studentAttendanceMap.get(sid)
        stat.total++
        if (r.status === 'present' || r.status === 'late') stat.present++
      }
    }

    const backloggedStudentIds = new Set()
    for (const exam of examinations) {
      for (const r of exam.results || []) {
        if (r.backlog) backloggedStudentIds.add(String(r.studentId))
      }
    }

    const atRiskStudents = students.filter((s) => {
      const sid = String(s._id)
      const att = studentAttendanceMap.get(sid)
      const lowAttendance = att && att.total >= 2 && (att.present / att.total) < 0.75
      const hasBacklog = backloggedStudentIds.has(sid)
      const standingRisk = s.academicStanding === 'at_risk' || s.academicStanding === 'probation'
      return lowAttendance || hasBacklog || standingRisk
    }).map((s) => {
      const sid = String(s._id)
      const att = studentAttendanceMap.get(sid)
      return {
        id: sid,
        fullName: s.fullName,
        studentId: s.studentId,
        department: s.department,
        batch: s.batch,
        attendanceRate: att && att.total > 0 ? Math.round((att.present / att.total) * 100) : 100,
        hasBacklog: backloggedStudentIds.has(sid),
        standing: s.academicStanding || 'good',
      }
    })

    // Weak subject identification
    const subjectScoreMap = new Map()
    for (const exam of examinations) {
      const subj = exam.subject || 'General'
      if (!subjectScoreMap.has(subj)) subjectScoreMap.set(subj, { earned: 0, max: 0, failCount: 0 })
      const item = subjectScoreMap.get(subj)
      for (const r of exam.results || []) {
        if (r.marksObtained && r.maxMarks) {
          item.earned += r.marksObtained
          item.max += r.maxMarks
          if (!r.isPass) item.failCount++
        }
      }
    }

    const weakSubjects = Array.from(subjectScoreMap.entries())
      .map(([subject, stat]) => ({
        subject,
        avgScore: stat.max > 0 ? Math.round((stat.earned / stat.max) * 100) : 0,
        failCount: stat.failCount,
      }))
      .sort((a, b) => a.avgScore - b.avgScore)
      .slice(0, 5)

    return res.json({
      overview: {
        totalStudents: students.length,
        totalEnrollments: enrollments.length,
        totalCoursesAvailable: courses.length,
        completedEnrollments: progressDocs.filter((p) => p.status === 'completed' || p.progressPercentage >= 100).length,
        atRiskCount: atRiskStudents.length,
      },
      deptStats,
      batchStats,
      atRiskStudents: atRiskStudents.slice(0, 20),
      weakSubjects,
    })
  } catch (error) {
    return next(error)
  }
})

// AI-Assisted Academic Insights API
router.get('/analytics/ai-insights', ...requireCollege, async (req, res, next) => {
  try {
    const collegeId = getCollegeId(req)
    if (!collegeId) return res.status(403).json({ message: 'College access required.' })

    const [students, progressDocs, attendanceSessions, examinations, batches] = await Promise.all([
      CollegeStudent.find({ collegeId, role: 'student' }).select('fullName studentId department batch cgpa').lean(),
      Progress.find({ collegeId }).select('progressPercentage status userId courseId').lean(),
      Attendance.find({ collegeId }).select('records department batch subject').lean(),
      Examination.find({ collegeId }).select('title department subject results').lean(),
      Batch.find({ collegeId, status: 'active' }).select('name department').lean(),
    ])

    // Attendance rate per student
    const studentAttendanceMap = new Map()
    for (const s of attendanceSessions) {
      for (const r of s.records || []) {
        const sid = String(r.studentId)
        if (!studentAttendanceMap.has(sid)) studentAttendanceMap.set(sid, { present: 0, total: 0 })
        const stat = studentAttendanceMap.get(sid)
        stat.total++
        if (r.status === 'present' || r.status === 'late') stat.present++
      }
    }

    // 1. Declining / Low attendance students
    const lowAttendanceList = []
    for (const s of students) {
      const att = studentAttendanceMap.get(String(s._id))
      if (att && att.total >= 3) {
        const rate = Math.round((att.present / att.total) * 100)
        if (rate < 75) {
          lowAttendanceList.push({
            name: s.fullName,
            rollNo: s.studentId,
            department: s.department,
            rate: `${rate}%`,
          })
        }
      }
    }

    // 2. Batches requiring intervention
    const batchNeedsAttention = []
    for (const b of batches) {
      const bStudents = students.filter((s) => s.batch === b.name)
      const bStudentIds = new Set(bStudents.map((s) => String(s._id)))
      const bProgress = progressDocs.filter((p) => bStudentIds.has(String(p.userId)))
      const avgProg = bProgress.length > 0
        ? Math.round(bProgress.reduce((sum, p) => sum + (p.progressPercentage || 0), 0) / bProgress.length)
        : 0
      if (avgProg < 40 && bStudents.length > 0) {
        batchNeedsAttention.push({
          batch: b.name,
          department: b.department,
          avgProgress: `${avgProg}%`,
          studentsCount: bStudents.length,
          recommendation: 'Schedule remedial LMS sessions and assignment checkpoints.',
        })
      }
    }

    // 3. Weekly Academic Summary
    const totalProgSum = progressDocs.reduce((sum, p) => sum + (p.progressPercentage || 0), 0)
    const overallAvgProg = progressDocs.length > 0 ? Math.round(totalProgSum / progressDocs.length) : 0

    return res.json({
      isAIAssisted: true,
      disclaimer: 'AI-assisted insights are analytical summaries generated from your actual database records to support decision-making.',
      generatedAt: new Date(),
      summary: {
        totalStudentsEvaluated: students.length,
        institutionalProgressAverage: `${overallAvgProg}%`,
        attentionRequiredCount: lowAttendanceList.length + batchNeedsAttention.length,
      },
      insights: {
        lowAttendanceAlerts: {
          count: lowAttendanceList.length,
          items: lowAttendanceList.slice(0, 10),
          actionRecommendation: 'Issue formal notification letters to parents and mentor these students.',
        },
        batchesRequiringAttention: {
          count: batchNeedsAttention.length,
          items: batchNeedsAttention,
        },
        curriculumRecommendations: [
          'Introduce short, 15-minute modular checkpoints in lower completion courses.',
          'Align internal examination schedules with LMS milestone deadlines.',
        ],
      },
    })
  } catch (error) {
    return next(error)
  }
})

// -------------------------------------------------------------
// 9. AI COLLEGE ASSISTANT (Natural Language Query Interface)
// -------------------------------------------------------------
router.post('/ai-assistant', ...requireCollege, async (req, res, next) => {
  try {
    const collegeId = getCollegeId(req)
    if (!collegeId) return res.status(403).json({ message: 'College access required.' })

    const { prompt } = req.body ?? {}
    if (typeof prompt !== 'string' || !prompt.trim()) {
      return res.status(400).json({ message: 'Enter a question for the AI Assistant.' })
    }

    const cleanPrompt = prompt.trim().toLowerCase()

    // Query actual data strictly for this college
    const [students, progressDocs, attendanceSessions, examinations, departments, batches, placementDrives] = await Promise.all([
      CollegeStudent.find({ collegeId, role: 'student' }).select('fullName studentId department batch cgpa academicStanding').lean(),
      Progress.find({ collegeId }).select('progressPercentage status userId courseId').lean(),
      Attendance.find({ collegeId }).select('records department batch subject date').lean(),
      Examination.find({ collegeId }).select('title department subject results maxMarks passingMarks').lean(),
      Department.find({ collegeId }).select('name code').lean(),
      Batch.find({ collegeId }).select('name department').lean(),
      PlacementDrive.find({ collegeId }).select('companyName packageLpa applications status').lean(),
    ])

    // Calculate facts
    // Attendance
    const studentAttendance = new Map()
    for (const session of attendanceSessions) {
      for (const r of session.records || []) {
        const sid = String(r.studentId)
        if (!studentAttendance.has(sid)) studentAttendance.set(sid, { present: 0, total: 0 })
        const item = studentAttendance.get(sid)
        item.total++
        if (r.status === 'present' || r.status === 'late') item.present++
      }
    }

    const lowAttStudents = []
    for (const s of students) {
      const att = studentAttendance.get(String(s._id))
      if (att && att.total > 0) {
        const rate = Math.round((att.present / att.total) * 100)
        if (rate < 75) {
          lowAttStudents.push({ name: s.fullName, id: s.studentId, department: s.department, rate: `${rate}%` })
        }
      }
    }

    // Batch completion
    const batchProgressList = batches.map((b) => {
      const bStudents = students.filter((s) => s.batch === b.name)
      const bStudentIds = new Set(bStudents.map((s) => String(s._id)))
      const bProg = progressDocs.filter((p) => bStudentIds.has(String(p.userId)))
      const avg = bProg.length > 0 ? Math.round(bProg.reduce((sum, p) => sum + (p.progressPercentage || 0), 0) / bProg.length) : 0
      return { batch: b.name, department: b.department, completion: avg, studentCount: bStudents.length }
    }).sort((a, b) => b.completion - a.completion)

    // Placements
    let placedTotal = 0
    for (const d of placementDrives) {
      for (const a of d.applications || []) {
        if (a.status === 'placed') placedTotal++
      }
    }

    let answer = ''
    const relevantData = {}

    if (cleanPrompt.includes('attendance') && (cleanPrompt.includes('75') || cleanPrompt.includes('low') || cleanPrompt.includes('below'))) {
      if (lowAttStudents.length === 0) {
        answer = `Great news! Currently, no students in your college have attendance below the 75% threshold based on ${attendanceSessions.length} recorded session(s).`
      } else {
        const listStr = lowAttStudents.slice(0, 5).map((s) => `• ${s.name} (${s.id}, ${s.department}): ${s.rate}`).join('\n')
        answer = `Found ${lowAttStudents.length} student(s) with attendance below 75%:\n\n${listStr}${lowAttStudents.length > 5 ? `\n...and ${lowAttStudents.length - 5} more.` : ''}\n\nRecommended Action: Issue an alert to their mentors via the Attendance Management module.`
      }
      relevantData.lowAttendanceStudents = lowAttStudents
    } else if (cleanPrompt.includes('batch') && (cleanPrompt.includes('completion') || cleanPrompt.includes('highest') || cleanPrompt.includes('best'))) {
      if (batchProgressList.length === 0) {
        answer = 'No active batches currently have enrolled courses or recorded progress.'
      } else {
        const top = batchProgressList[0]
        answer = `The batch with the highest course completion is "${top.batch}" in the ${top.department} department, with an average completion rate of ${top.completion}% across ${top.studentCount} student(s).`
      }
      relevantData.batchLeaderboard = batchProgressList
    } else if (cleanPrompt.includes('department') || cleanPrompt.includes('department-wise')) {
      const deptDetails = departments.map((d) => {
        const count = students.filter((s) => s.department === d.name).length
        return `• ${d.name} (${d.code}): ${count} student(s)`
      }).join('\n')
      answer = `Here are the department statistics for your college:\n\n${deptDetails}\n\nTotal Registered Students: ${students.length}`
      relevantData.departmentBreakdown = departments
    } else if (cleanPrompt.includes('summary') || cleanPrompt.includes('weekly') || cleanPrompt.includes('overview')) {
      const overallAvg = progressDocs.length > 0
        ? Math.round(progressDocs.reduce((sum, p) => sum + (p.progressPercentage || 0), 0) / progressDocs.length)
        : 0
      answer = `Weekly Academic Summary for Your College:\n\n• Total Students: ${students.length} (${students.filter((s) => s.isActive).length} active)\n• Total Departments: ${departments.length}\n• Total Batches: ${batches.length}\n• Overall Course Progress: ${overallAvg}%\n• Students with Low Attendance (< 75%): ${lowAttStudents.length}\n• Placement Success: ${placedTotal} student(s) placed across ${placementDrives.length} drives.`
      relevantData.summaryMetrics = { totalStudents: students.length, overallAvg, lowAttCount: lowAttStudents.length, placedTotal }
    } else if (cleanPrompt.includes('placement') || cleanPrompt.includes('placed') || cleanPrompt.includes('hiring')) {
      answer = `Placement Overview:\n\n• Total Placed Students: ${placedTotal}\n• Placement Drives Conducted: ${placementDrives.length}\n• Placement Rate: ${students.length > 0 ? Math.round((placedTotal / students.length) * 100) : 0}%\n• Active Opportunities: ${placementDrives.filter((d) => d.status === 'active').length}`
      relevantData.placement = { placedTotal, drivesCount: placementDrives.length }
    } else {
      answer = `I analyzed your college's current records:\n\n• Students Registered: ${students.length}\n• Departments: ${departments.length}\n• Batches: ${batches.length}\n• Recorded Attendance Sessions: ${attendanceSessions.length}\n• Scheduled Examinations: ${examinations.length}\n\nYou can ask me specific questions like: "Which students have attendance below 75%?", "Which batch has the highest course completion?", or "Generate a weekly academic summary".`
    }

    return res.json({
      query: prompt,
      answer,
      relevantData,
      isRealData: true,
      collegeId: String(collegeId),
      generatedAt: new Date(),
    })
  } catch (error) {
    return next(error)
  }
})

// -------------------------------------------------------------
// 10. REPORTS AND DOCUMENT MANAGEMENT
// -------------------------------------------------------------
router.get('/documents', ...requireCollege, async (req, res, next) => {
  try {
    const collegeId = getCollegeId(req)
    if (!collegeId) return res.status(403).json({ message: 'College access required.' })

    const { category, department } = req.query
    const query = { collegeId }
    if (category) query.category = category
    if (department) query.department = department

    const documents = await CollegeDocument.find(query).sort({ createdAt: -1 }).lean()
    return res.json({ documents })
  } catch (error) {
    return next(error)
  }
})

router.post('/documents', ...requireCollege, async (req, res, next) => {
  try {
    const collegeId = getCollegeId(req)
    if (!collegeId) return res.status(403).json({ message: 'College access required.' })

    const { title, category, fileName, fileUrl, fileSize, fileType, department, description } = req.body ?? {}
    if (typeof title !== 'string' || !title.trim()) {
      return res.status(400).json({ message: 'Document title is required.' })
    }
    if (typeof fileName !== 'string' || !fileName.trim()) {
      return res.status(400).json({ message: 'File name is required.' })
    }

    const doc = await CollegeDocument.create({
      collegeId,
      title: title.trim(),
      category: category || 'general',
      fileName: fileName.trim(),
      fileUrl: typeof fileUrl === 'string' ? fileUrl.trim() : '',
      fileSize: typeof fileSize === 'number' ? fileSize : 0,
      fileType: typeof fileType === 'string' ? fileType.trim() : 'application/pdf',
      department: typeof department === 'string' ? department.trim() : '',
      description: typeof description === 'string' ? description.trim() : '',
      uploadedBy: req.auth.user?.fullName || 'College Admin',
    })

    return res.status(201).json({ message: 'Document uploaded and registered successfully.', document: doc })
  } catch (error) {
    return next(error)
  }
})

router.delete('/documents/:id', ...requireCollege, async (req, res, next) => {
  try {
    const collegeId = getCollegeId(req)
    if (!collegeId) return res.status(403).json({ message: 'College access required.' })
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid document ID.' })

    const doc = await CollegeDocument.findOne({ _id: req.params.id, collegeId })
    if (!doc) return res.status(404).json({ message: 'Document not found.' })

    await CollegeDocument.deleteOne({ _id: doc._id })
    return res.json({ message: 'Document removed successfully.' })
  } catch (error) {
    return next(error)
  }
})

// Dynamic Comprehensive Report Exporter (CSV format)
router.get('/reports/export', ...requireCollege, async (req, res, next) => {
  try {
    const collegeId = getCollegeId(req)
    if (!collegeId) return res.status(403).json({ message: 'College access required.' })

    const { reportType } = req.query // 'students' | 'attendance' | 'examinations' | 'placements' | 'departments'

    if (reportType === 'attendance') {
      const sessions = await Attendance.find({ collegeId }).sort({ date: -1 }).lean()
      const rows = []
      for (const s of sessions) {
        for (const r of s.records || []) {
          rows.push([
            csvEscape(s.date ? new Date(s.date).toISOString().slice(0, 10) : ''),
            csvEscape(s.department),
            csvEscape(s.batch),
            csvEscape(s.subject),
            csvEscape(r.studentRollNo || ''),
            csvEscape(r.studentName || ''),
            csvEscape(r.status),
          ])
        }
      }
      const headers = ['Date', 'Department', 'Batch', 'Subject', 'Roll No', 'Student Name', 'Status']
      res.setHeader('Content-Type', 'text/csv; charset=utf-8')
      res.setHeader('Content-Disposition', 'attachment; filename="attendance-report.csv"')
      return res.send([headers.join(','), ...rows.map((r) => r.join(','))].join('\n'))
    }

    if (reportType === 'examinations') {
      const exams = await Examination.find({ collegeId }).sort({ startDate: -1 }).lean()
      const rows = []
      for (const e of exams) {
        for (const r of e.results || []) {
          rows.push([
            csvEscape(e.title),
            csvEscape(e.examType),
            csvEscape(e.department),
            csvEscape(r.subject || e.subject),
            csvEscape(r.studentRollNo || ''),
            csvEscape(r.studentName || ''),
            csvEscape(r.marksObtained),
            csvEscape(r.maxMarks),
            csvEscape(r.grade),
            csvEscape(r.isPass ? 'Passed' : 'Backlog'),
          ])
        }
      }
      const headers = ['Exam Title', 'Type', 'Department', 'Subject', 'Roll No', 'Student Name', 'Marks Obtained', 'Max Marks', 'Grade', 'Result']
      res.setHeader('Content-Type', 'text/csv; charset=utf-8')
      res.setHeader('Content-Disposition', 'attachment; filename="examinations-report.csv"')
      return res.send([headers.join(','), ...rows.map((r) => r.join(','))].join('\n'))
    }

    if (reportType === 'placements') {
      const drives = await PlacementDrive.find({ collegeId }).sort({ deadline: -1 }).lean()
      const rows = []
      for (const d of drives) {
        for (const a of d.applications || []) {
          rows.push([
            csvEscape(d.companyName),
            csvEscape(d.jobTitle),
            csvEscape(d.opportunityType),
            csvEscape(a.studentRollNo || ''),
            csvEscape(a.studentName || ''),
            csvEscape(a.department || ''),
            csvEscape(a.status),
            csvEscape(a.offeredPackage || d.packageLpa),
          ])
        }
      }
      const headers = ['Company', 'Job Title', 'Opportunity Type', 'Roll No', 'Student Name', 'Department', 'Status', 'Package (LPA)']
      res.setHeader('Content-Type', 'text/csv; charset=utf-8')
      res.setHeader('Content-Disposition', 'attachment; filename="placements-report.csv"')
      return res.send([headers.join(','), ...rows.map((r) => r.join(','))].join('\n'))
    }

    // Default: Students report
    const students = await CollegeStudent.find({ collegeId, role: 'student', studentType: 'college' })
      .select('fullName studentId email department batch semester phone cgpa academicStanding placementStatus status')
      .sort({ department: 1, fullName: 1 })
      .lean()

    const rows = students.map((s) => [
      csvEscape(s.fullName),
      csvEscape(s.studentId),
      csvEscape(s.email),
      csvEscape(s.department),
      csvEscape(s.batch),
      csvEscape(s.semester || ''),
      csvEscape(s.cgpa || 0),
      csvEscape(s.academicStanding || 'good'),
      csvEscape(s.placementStatus || 'seeking'),
      csvEscape(s.status),
    ])
    const headers = ['Full Name', 'Student ID', 'Email', 'Department', 'Batch', 'Semester', 'CGPA', 'Standing', 'Placement Status', 'Account Status']
    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', 'attachment; filename="students-report.csv"')
    return res.send([headers.join(','), ...rows.map((r) => r.join(','))].join('\n'))
  } catch (error) {
    return next(error)
  }
})

// -------------------------------------------------------------
// 11. COURSE MANAGEMENT & ASSIGNMENTS (Preserved & Enhanced)
// -------------------------------------------------------------
router.get('/courses', ...requireCollege, async (req, res, next) => {
  try {
    const collegeId = getCollegeId(req)
    if (!collegeId) return res.status(403).json({ message: 'College access required.' })

    const publishedCourses = await Course.find({ status: 'published' })
      .select('title description modules assignments quizzes createdAt')
      .sort({ title: 1 })
      .lean()

    const enrollments = await Enrollment.find({ collegeId, status: { $ne: 'cancelled' } }).select('courseId userId').lean()
    const progressList = await Progress.find({ collegeId }).select('courseId progressPercentage status').lean()

    const enrollmentMap = new Map()
    for (const e of enrollments) {
      const cid = String(e.courseId)
      enrollmentMap.set(cid, (enrollmentMap.get(cid) || 0) + 1)
    }

    const progressMap = new Map()
    for (const p of progressList) {
      const cid = String(p.courseId)
      if (!progressMap.has(cid)) progressMap.set(cid, { total: 0, completed: 0, sum: 0 })
      const stat = progressMap.get(cid)
      stat.total++
      stat.sum += p.progressPercentage || 0
      if (p.status === 'completed' || p.progressPercentage >= 100) stat.completed++
    }

    const enriched = publishedCourses.map((c) => {
      const cid = String(c._id)
      const prog = progressMap.get(cid)
      return {
        id: cid,
        _id: cid,
        title: c.title,
        description: c.description,
        modulesCount: c.modules?.length || 0,
        quizzesCount: c.quizzes?.length || 0,
        assignmentsCount: c.assignments?.length || 0,
        enrolledStudentsCount: enrollmentMap.get(cid) || 0,
        completedCount: prog?.completed || 0,
        averageProgress: prog && prog.total > 0 ? Math.round(prog.sum / prog.total) : 0,
        createdAt: c.createdAt,
      }
    })

    return res.json({ courses: enriched })
  } catch (error) {
    return next(error)
  }
})

router.post('/courses/assign', ...requireCollege, async (req, res, next) => {
  try {
    const collegeId = getCollegeId(req)
    if (!collegeId) return res.status(403).json({ message: 'College access required.' })

    const { courseId, targetType, studentId, department, batch } = req.body ?? {}
    if (!mongoose.isValidObjectId(courseId)) {
      return res.status(400).json({ message: 'Select a valid course to assign.' })
    }

    const course = await Course.findOne({ _id: courseId, status: 'published' }).select('title').lean()
    if (!course) return res.status(404).json({ message: 'The published course was not found.' })

    let studentIdsToEnroll = []

    if (targetType === 'student') {
      if (!mongoose.isValidObjectId(studentId)) {
        return res.status(400).json({ message: 'Select a valid student.' })
      }
      const student = await CollegeStudent.findOne({ _id: studentId, collegeId }).select('_id fullName').lean()
      if (!student) return res.status(404).json({ message: 'Student was not found in your college.' })
      studentIdsToEnroll = [student._id]
    } else if (targetType === 'department') {
      if (!department || typeof department !== 'string') {
        return res.status(400).json({ message: 'Select a department to assign.' })
      }
      const students = await CollegeStudent.find({
        collegeId,
        role: 'student',
        $or: [{ department: department.trim() }, { department: new RegExp(`^${department.trim()}$`, 'i') }],
      }).select('_id').lean()
      studentIdsToEnroll = students.map((s) => s._id)
    } else if (targetType === 'batch') {
      if (!batch || typeof batch !== 'string') {
        return res.status(400).json({ message: 'Select a batch to assign.' })
      }
      const students = await CollegeStudent.find({
        collegeId,
        role: 'student',
        $or: [{ batch: batch.trim() }, { batch: new RegExp(`^${batch.trim()}$`, 'i') }],
      }).select('_id').lean()
      studentIdsToEnroll = students.map((s) => s._id)
    } else {
      return res.status(400).json({ message: 'Specify a valid assignment target (student, department, or batch).' })
    }

    if (!studentIdsToEnroll.length) {
      return res.status(400).json({ message: 'No students found matching the selected target.' })
    }

    // Filter out already enrolled
    const existingEnrollments = await Enrollment.find({
      collegeId,
      courseId: course._id,
      userId: { $in: studentIdsToEnroll },
      status: { $ne: 'cancelled' },
    }).select('userId').lean()
    const alreadyEnrolledSet = new Set(existingEnrollments.map((e) => String(e.userId)))

    const toEnroll = studentIdsToEnroll.filter((id) => !alreadyEnrolledSet.has(String(id)))

    if (!toEnroll.length) {
      return res.status(409).json({ message: 'All selected students are already enrolled in this course.' })
    }

    const enrollmentDocs = toEnroll.map((userId) => ({
      userId,
      courseId: course._id,
      collegeId,
      assignedBy: req.auth.id,
      status: 'active',
    }))
    await Enrollment.insertMany(enrollmentDocs)

    const progressOps = toEnroll.map((userId) => ({
      updateOne: {
        filter: { userId, courseId: course._id },
        update: {
          $setOnInsert: {
            userId,
            courseId: course._id,
            collegeId,
            progressPercentage: 0,
            status: 'in_progress',
            completedLessons: [],
            quizSubmissions: [],
          },
        },
        upsert: true,
      },
    }))
    await Progress.bulkWrite(progressOps)

    await addCollegeNotification(
      collegeId,
      'Course Assigned',
      `Course "${course.title}" was assigned to ${toEnroll.length} student(s).`,
      'course',
    )

    return res.status(201).json({
      message: `Course "${course.title}" successfully assigned to ${toEnroll.length} student(s).`,
      enrolledCount: toEnroll.length,
      skippedCount: alreadyEnrolledSet.size,
    })
  } catch (error) {
    return next(error)
  }
})

router.delete('/enrollments/:id', ...requireCollege, async (req, res, next) => {
  try {
    const collegeId = getCollegeId(req)
    if (!collegeId) return res.status(403).json({ message: 'College access required.' })
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid enrollment ID.' })

    const enrollment = await Enrollment.findOne({ _id: req.params.id, collegeId })
    if (!enrollment) return res.status(404).json({ message: 'Enrollment record not found.' })

    enrollment.status = 'cancelled'
    await enrollment.save()

    return res.json({ message: 'Course assignment cancelled.' })
  } catch (error) {
    return next(error)
  }
})

// Progress list
router.get('/progress', ...requireCollege, async (req, res, next) => {
  try {
    const collegeId = getCollegeId(req)
    if (!collegeId) return res.status(403).json({ message: 'College access required.' })

    const progress = await Progress.find({ collegeId })
      .populate('userId', 'fullName username email studentId department batch')
      .populate('courseId', 'title')
      .sort({ lastActivityAt: -1 })
      .limit(100)
      .lean()

    return res.json({ progress })
  } catch (error) {
    return next(error)
  }
})

// -------------------------------------------------------------
// 12. NOTIFICATIONS & COMMUNICATION
// -------------------------------------------------------------
router.get('/notifications', ...requireCollege, async (req, res, next) => {
  try {
    const collegeId = getCollegeId(req)
    if (!collegeId) return res.status(403).json({ message: 'College access required.' })

    const [notifications, unreadCount] = await Promise.all([
      Notification.find({ collegeId, recipientRole: 'college_admin' })
        .sort({ createdAt: -1 })
        .limit(100)
        .lean(),
      Notification.countDocuments({ collegeId, recipientRole: 'college_admin', isRead: false }),
    ])

    return res.json({ notifications, unreadCount })
  } catch (error) {
    return next(error)
  }
})

router.post('/notifications/broadcast', ...requireCollege, async (req, res, next) => {
  try {
    const collegeId = getCollegeId(req)
    if (!collegeId) return res.status(403).json({ message: 'College access required.' })

    const { title, message, type } = req.body ?? {}
    if (typeof title !== 'string' || !title.trim()) return res.status(400).json({ message: 'Notification title is required.' })
    if (typeof message !== 'string' || !message.trim()) return res.status(400).json({ message: 'Notification message is required.' })

    const notif = await Notification.create({
      collegeId,
      recipientRole: 'college_admin',
      title: title.trim(),
      message: message.trim(),
      type: type || 'announcement',
    })

    return res.status(201).json({ message: 'Announcement broadcasted.', notification: notif })
  } catch (error) {
    return next(error)
  }
})

router.patch('/notifications/:id/read', ...requireCollege, async (req, res, next) => {
  try {
    const collegeId = getCollegeId(req)
    if (!collegeId) return res.status(403).json({ message: 'College access required.' })
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid notification ID.' })

    const notification = await Notification.findOneAndUpdate(
      { _id: req.params.id, collegeId },
      { $set: { isRead: true, readAt: new Date() } },
      { new: true },
    )
    if (!notification) return res.status(404).json({ message: 'Notification not found.' })

    return res.json({ message: 'Notification marked as read.', notification })
  } catch (error) {
    return next(error)
  }
})

router.post('/notifications/read-all', ...requireCollege, async (req, res, next) => {
  try {
    const collegeId = getCollegeId(req)
    if (!collegeId) return res.status(403).json({ message: 'College access required.' })

    await Notification.updateMany(
      { collegeId, recipientRole: 'college_admin', isRead: false },
      { $set: { isRead: true, readAt: new Date() } },
    )

    return res.json({ message: 'All notifications marked as read.' })
  } catch (error) {
    return next(error)
  }
})

// -------------------------------------------------------------
// 13. ACHIEVEMENTS & LEADERBOARD
// -------------------------------------------------------------
router.get('/leaderboard', ...requireCollege, async (req, res, next) => {
  try {
    const collegeId = getCollegeId(req)
    if (!collegeId) return res.status(403).json({ message: 'College access required.' })

    const [students, progressList] = await Promise.all([
      CollegeStudent.find({ collegeId, role: 'student', status: 'active' })
        .select('fullName studentId department batch cgpa achievements')
        .lean(),
      Progress.find({ collegeId }).select('userId progressPercentage status').lean(),
    ])

    const progressMap = new Map()
    for (const p of progressList) {
      const sid = String(p.userId)
      if (!progressMap.has(sid)) progressMap.set(sid, { sum: 0, count: 0, completed: 0 })
      const item = progressMap.get(sid)
      item.count++
      item.sum += p.progressPercentage || 0
      if (p.status === 'completed' || p.progressPercentage >= 100) item.completed++
    }

    const ranked = students.map((s) => {
      const prog = progressMap.get(String(s._id))
      const avgProg = prog && prog.count > 0 ? Math.round(prog.sum / prog.count) : 0
      const score = Math.round((s.cgpa || 0) * 10 + avgProg * 0.5 + (s.achievements?.length || 0) * 5)
      return {
        id: String(s._id),
        fullName: s.fullName,
        studentId: s.studentId,
        department: s.department,
        batch: s.batch,
        cgpa: s.cgpa || 0,
        averageProgress: avgProg,
        completedCourses: prog?.completed || 0,
        achievementsCount: s.achievements?.length || 0,
        points: score,
      }
    }).sort((a, b) => b.points - a.points).slice(0, 20)

    return res.json({ leaderboard: ranked })
  } catch (error) {
    return next(error)
  }
})

// -------------------------------------------------------------
// 14. COLLEGE PROFILE AND SETTINGS
// -------------------------------------------------------------
router.get('/profile', ...requireCollege, async (req, res, next) => {
  try {
    const collegeId = getCollegeId(req)
    if (!collegeId) return res.status(403).json({ message: 'College access required.' })

    const [college, adminUser] = await Promise.all([
      College.findById(collegeId).lean(),
      CollegeAdmin.findById(req.auth.id).select('fullName email username role status createdAt').lean(),
    ])

    if (!college) return res.status(404).json({ message: 'College record not found.' })

    return res.json({
      studentLimit,
      totalStudents,
      remainingSlots: studentLimit === null ? null : Math.max(0, studentLimit - totalStudents),
      students: collegeStudentsList,
      college: {
        id: String(college._id),
        name: college.name,
        code: college.code,
        address: college.address,
        city: college.city,
        state: college.state,
        country: college.country,
        contactName: college.contactName,
        contactEmail: college.contactEmail,
        contactPhone: college.contactPhone,
        status: college.status,
      },
      account: adminUser,
    })
  } catch (error) {
    return next(error)
  }
})

router.put('/profile', ...requireCollege, async (req, res, next) => {
  try {
    const collegeId = getCollegeId(req)
    if (!collegeId) return res.status(403).json({ message: 'College access required.' })

    const college = await College.findById(collegeId)
    if (!college) return res.status(404).json({ message: 'College record not found.' })

    const { address, city, state, country, contactName, contactEmail, contactPhone } = req.body ?? {}
    if (typeof address === 'string') college.address = address.trim().slice(0, 500)
    if (typeof city === 'string') college.city = city.trim().slice(0, 120)
    if (typeof state === 'string') college.state = state.trim().slice(0, 120)
    if (typeof country === 'string') college.country = country.trim().slice(0, 120)
    if (typeof contactName === 'string') college.contactName = contactName.trim().slice(0, 120)
    if (typeof contactPhone === 'string') college.contactPhone = contactPhone.trim().slice(0, 40)
    if (typeof contactEmail === 'string' && contactEmail.trim()) {
      const email = contactEmail.trim().toLowerCase()
      if (!emailPattern.test(email)) return res.status(400).json({ message: 'Enter a valid contact email.' })
      college.contactEmail = email.slice(0, 254)
    }

    await college.save()
    return res.json({ message: 'College profile updated successfully.', college })
  } catch (error) {
    return next(error)
  }
})

router.put('/password', ...requireCollege, async (req, res, next) => {
  try {
    const { currentPassword, newPassword, confirmPassword } = req.body ?? {}
    if (typeof currentPassword !== 'string' || !currentPassword) {
      return res.status(400).json({ message: 'Enter your current password.' })
    }
    if (typeof newPassword !== 'string' || newPassword.length < 8) {
      return res.status(400).json({ message: 'New password must be at least 8 characters.' })
    }
    if (newPassword !== confirmPassword) {
      return res.status(400).json({ message: 'New passwords do not match.' })
    }

    const adminAccount = await CollegeAdmin.findById(req.auth.id).select('+passwordHash')
    if (!adminAccount) return res.status(404).json({ message: 'Account not found.' })

    const validCurrent = adminAccount.passwordHash
      ? await bcrypt.compare(currentPassword, adminAccount.passwordHash)
      : false
    if (!validCurrent) {
      return res.status(401).json({ message: 'Current password is incorrect.' })
    }

    adminAccount.passwordHash = await bcrypt.hash(newPassword, 12)
    await adminAccount.save()

    return res.json({ message: 'Password updated successfully.' })
  } catch (error) {
    return next(error)
  }
})

export default router
