import assert from 'node:assert/strict'
import express from 'express'
import jwt from 'jsonwebtoken'
import mongoose from 'mongoose'
import { config } from '../config/env.js'
import { connectToDatabase } from '../config/db.js'
import collegeRouter from '../routes/college.js'
import authRouter from '../routes/auth.js'
import adminRouter from '../routes/admin.js'
import learningRouter from '../routes/learning.js'
import College from '../models/College.js'
import Course from '../models/Course.js'
import Department from '../models/Department.js'
import Batch from '../models/Batch.js'
import Enrollment from '../models/Enrollment.js'
import Notification from '../models/Notification.js'
import Progress from '../models/Progress.js'
import Semester from '../models/Semester.js'
import Faculty from '../models/Faculty.js'
import Attendance from '../models/Attendance.js'
import AcademicEvent from '../models/AcademicEvent.js'
import Examination from '../models/Examination.js'
import PlacementDrive from '../models/PlacementDrive.js'
import CollegeDocument from '../models/CollegeDocument.js'
import AccountIdentity from '../models/AccountIdentity.js'
import { Admin, CollegeAdmin, CollegeStudent, Student } from '../models/account-models.js'

async function expectJson(res, expectedStatus, label) {
  const text = await res.text()
  assert.equal(res.status, expectedStatus, `${label} failed (status ${res.status}): ${text}`)
  return text ? JSON.parse(text) : {}
}

async function runLiveVerification() {
  console.log('=== STARTING LIVE MONGO ATLAS END-TO-END VERIFICATION ===\n')

  await connectToDatabase()
  console.log('[Live] Connected to MongoDB Atlas.\n')

  // Setup test Express server
  const app = express()
  app.use(express.json())
  app.use('/api/college', collegeRouter)
  app.use('/api/auth', authRouter)
  app.use('/api/admin', adminRouter)
  app.use('/api', learningRouter)

  const server = app.listen(0)
  await new Promise((resolve) => server.once('listening', resolve))
  const port = server.address().port
  const baseUrl = `http://127.0.0.1:${port}/api`

  const cleanupTasks = []

  try {
    // 0. Verify Admin Login via Common Login Page
    console.log('[Live] 0. Testing Admin Common Login...')
    const adminLoginRes = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        identifier: 'admin@gmail.com',
        password: 'admin@123456',
      }),
    })
    const adminLoginData = await expectJson(adminLoginRes, 200, 'Admin login')
    assert.equal(adminLoginData.user.role, 'main_admin', 'Role should be detected as main_admin')
    const adminToken = adminLoginData.token
    console.log(`[Live] Admin successfully logged in via common login! Token acquired.\n`)

    const adminHeaders = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${adminToken}`,
    }

    // 1. Verify / ensure a published course exists
    let course = await Course.findOne({ status: 'published' })
    if (!course) {
      console.log('[Live] Creating seed published course...')
      course = await Course.create({
        title: 'Live Test Web Architecture',
        description: 'Comprehensive Web Architecture Course',
        status: 'published',
        createdBy: new mongoose.Types.ObjectId(),
        modules: [
          {
            title: 'Module 1: Foundations',
            lessons: [{ title: 'Lesson 1: Intro', durationMinutes: 30 }],
          },
        ],
      })
      cleanupTasks.push(async () => Course.deleteOne({ _id: course._id }))
    }
    console.log(`[Live] Using published course: "${course.title}" (${course._id})`)

    // 2. Admin creates a College Account
    const collegeCode1 = `TEST-${Date.now().toString().slice(-6)}`
    console.log(`\n[Live] 1. Creating College account (Code: ${collegeCode1})...`)
    const createCollegeRes = await fetch(`${baseUrl}/admin/colleges`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        name: 'E2E Apex University',
        code: collegeCode1,
        city: 'Boston',
        state: 'MA',
        contactName: 'Dean Winchester',
        contactEmail: `dean.${collegeCode1.toLowerCase()}@apex.edu`,
      }),
    })
    const college1Data = await expectJson(createCollegeRes, 201, 'Create college')
    const college1Id = college1Data.college.id
    cleanupTasks.push(async () => College.deleteOne({ _id: college1Id }))

    // Create sub-admin with direct credentials
    const subAdminEmail = `admin.${collegeCode1.toLowerCase()}@apex.edu`
    const subAdminUsername = `apex_dean_${Date.now().toString().slice(-4)}`
    const collegePassword = 'CollegeSecurePass2026!'

    const subAdminRes = await fetch(`${baseUrl}/admin/colleges/${college1Id}/sub-admins`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        fullName: 'Dean Winchester',
        email: subAdminEmail,
        username: subAdminUsername,
        password: collegePassword,
      }),
    })

    const subAdminData = await expectJson(subAdminRes, 201, 'Create sub-admin')
    console.log(`[Live] College sub-admin created successfully: ${subAdminEmail}`)
    cleanupTasks.push(async () => {
      await CollegeAdmin.deleteMany({ collegeId: college1Id })
      await AccountIdentity.deleteMany({ email: subAdminEmail })
    })

    // 3. College Login via Common Login Page (no role passed)
    console.log('\n[Live] 2. Verifying Common Login with Role Auto-Detection...')
    const loginRes = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        identifier: subAdminEmail,
        password: collegePassword,
      }),
    })
    const loginData = await expectJson(loginRes, 200, 'College login')
    assert.equal(loginData.user.role, 'college_admin', 'Role should be auto-detected as college_admin')
    assert.equal(loginData.user.collegeId, String(college1Id), 'College ID must match')
    const collegeToken = loginData.token
    console.log(`[Live] Auto-detection successful! Role: ${loginData.user.role}, Token acquired.`)

    const collegeHeaders = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${collegeToken}`,
    }

    // 4. College Dashboard Overview
    console.log('\n[Live] 3. Testing College Dashboard Overview endpoint...')
    const dashRes = await fetch(`${baseUrl}/college/dashboard`, { headers: collegeHeaders })
    const dashData = await expectJson(dashRes, 200, 'Dashboard overview')
    assert.equal(dashData.college.code, collegeCode1)
    console.log(`[Live] Dashboard overview verified. Students: ${dashData.stats.totalStudents}, Batches: ${dashData.stats.totalBatches}`)

    // 5. Department Management
    console.log('\n[Live] 4. Testing Department Management...')
    const deptRes = await fetch(`${baseUrl}/college/departments`, {
      method: 'POST',
      headers: collegeHeaders,
      body: JSON.stringify({
        name: 'Computer Science & Engineering',
        code: 'CSE',
        description: 'Department of CSE',
      }),
    })
    const deptData = await expectJson(deptRes, 201, 'Create department')
    const deptId = deptData.department._id
    console.log(`[Live] Department created: "${deptData.department.name}" (${deptId})`)
    cleanupTasks.push(async () => Department.deleteMany({ collegeId: college1Id }))

    // 6. Batch Management
    console.log('\n[Live] 5. Testing Batch Management...')
    const batchRes = await fetch(`${baseUrl}/college/batches`, {
      method: 'POST',
      headers: collegeHeaders,
      body: JSON.stringify({
        name: '2025-2029 CSE Alpha',
        academicYear: '2025-2029',
        department: 'Computer Science & Engineering',
        departmentId: deptId,
      }),
    })
    const batchData = await expectJson(batchRes, 201, 'Create batch')
    const batchId = batchData.batch._id
    console.log(`[Live] Batch created: "${batchData.batch.name}" (${batchId})`)
    cleanupTasks.push(async () => Batch.deleteMany({ collegeId: college1Id }))

    // 7. Student Creation with Login Credentials
    console.log('\n[Live] 6. Testing Student Creation & Provided Credentials...')
    const student1Email = `student1.${collegeCode1.toLowerCase()}@apex.edu`
    const student1Password = 'StudentPass2026!'
    const student1Id = `STU-${collegeCode1}-001`

    const createStudentRes = await fetch(`${baseUrl}/college/students`, {
      method: 'POST',
      headers: collegeHeaders,
      body: JSON.stringify({
        fullName: 'Aarav Patel',
        studentId: student1Id,
        email: student1Email,
        department: 'Computer Science & Engineering',
        batch: '2025-2029 CSE Alpha',
        password: student1Password,
      }),
    })
    const createStudentData = await expectJson(createStudentRes, 201, 'Create student')
    console.log(`[Live] Student created: ${createStudentData.student.fullName} (${createStudentData.student.email})`)
    cleanupTasks.push(async () => {
      await CollegeStudent.deleteMany({ collegeId: college1Id })
      await AccountIdentity.deleteMany({ email: { $regex: collegeCode1.toLowerCase() } })
    })

    // 8. Student Login via Common Login
    console.log('\n[Live] 7. Testing Student Login via Common Login...')
    const studentLoginRes = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        identifier: student1Email,
        password: student1Password,
      }),
    })
    const studentLoginData = await expectJson(studentLoginRes, 200, 'Student login')
    assert.equal(studentLoginData.user.role, 'student')
    console.log(`[Live] Student successfully logged in via common login! Role: ${studentLoginData.user.role}`)

    // 9. Bulk Upload Students
    console.log('\n[Live] 8. Testing Bulk Upload Students (CSV)...')
    const bulkCsv = `Full Name,Student ID,Email,Department,Batch
Priya Sharma,STU-${collegeCode1}-002,priya.${collegeCode1.toLowerCase()}@apex.edu,Computer Science & Engineering,2025-2029 CSE Alpha
Rohan Verma,STU-${collegeCode1}-003,rohan.${collegeCode1.toLowerCase()}@apex.edu,Computer Science & Engineering,2025-2029 CSE Alpha`

    const bulkRes = await fetch(`${baseUrl}/college/students/bulk`, {
      method: 'POST',
      headers: collegeHeaders,
      body: JSON.stringify({ csvText: bulkCsv }),
    })
    const bulkData = await expectJson(bulkRes, 200, 'Bulk student upload')
    assert.equal(bulkData.summary.importedCount, 2, 'Should import 2 students')
    console.log(`[Live] Bulk upload imported ${bulkData.summary.importedCount} students successfully.`)

    // 10. Course Assignment to Department
    console.log('\n[Live] 9. Testing Course Assignment to Department...')
    const assignRes = await fetch(`${baseUrl}/college/courses/assign`, {
      method: 'POST',
      headers: collegeHeaders,
      body: JSON.stringify({
        courseId: String(course._id),
        targetType: 'department',
        department: 'Computer Science & Engineering',
      }),
    })
    const assignData = await expectJson(assignRes, 201, 'Course assign')
    assert.equal(assignData.enrolledCount, 3, 'Should enroll all 3 students in the department')
    console.log(`[Live] Course successfully assigned to ${assignData.enrolledCount} students in department CSE.`)
    cleanupTasks.push(async () => {
      await Enrollment.deleteMany({ collegeId: college1Id })
      await Progress.deleteMany({ collegeId: college1Id })
    })

    // Verify Progress records created
    const progressCount = await Progress.countDocuments({ collegeId: college1Id, courseId: course._id })
    assert.equal(progressCount, 3, 'Progress records must exist for each student')
    console.log(`[Live] Verified ${progressCount} Progress tracking records initialized.`)

    // 11. Student Progress & Analytics
    console.log('\n[Live] 10. Testing Analytics & Progress APIs...')
    const analyticsRes = await fetch(`${baseUrl}/college/analytics`, { headers: collegeHeaders })
    const analyticsData = await expectJson(analyticsRes, 200, 'Analytics')
    assert.equal(analyticsData.overview.totalStudents, 3)
    assert.equal(analyticsData.overview.totalEnrollments, 3)
    console.log(`[Live] Analytics verified: totalStudents=${analyticsData.overview.totalStudents}, totalEnrollments=${analyticsData.overview.totalEnrollments}`)

    // 12. Safe Deletion Checks
    console.log('\n[Live] 11. Testing Safe Deletion Enforcement...')
    // Attempting to delete department with active students/batches must return 409 Conflict
    const delDeptRes = await fetch(`${baseUrl}/college/departments/${deptId}`, {
      method: 'DELETE',
      headers: collegeHeaders,
    })
    const delDeptData = await expectJson(delDeptRes, 409, 'Safe delete check')
    console.log(`[Live] Safe delete correctly prevented: "${delDeptData.message}"`)

    // 13. Data Isolation between Colleges
    console.log('\n[Live] 12. Testing College Data Isolation...')
    const collegeCode2 = `TEST-${(Date.now() + 1).toString().slice(-6)}`
    const college2 = await College.create({
      name: 'E2E Rival College',
      code: collegeCode2,
      status: 'active',
    })
    cleanupTasks.push(async () => College.deleteOne({ _id: college2._id }))

    // College 2 creates a secret student
    const studentInCollege2 = await CollegeStudent.create({
      fullName: 'Secret Agent',
      studentId: `RIV-${collegeCode2}-001`,
      email: `secret.${collegeCode2.toLowerCase()}@rival.edu`,
      username: `secret_${collegeCode2.toLowerCase()}`,
      passwordHash: 'dummyhash',
      role: 'student',
      studentType: 'college',
      collegeId: college2._id,
      status: 'active',
      isActive: true,
    })
    cleanupTasks.push(async () => CollegeStudent.deleteOne({ _id: studentInCollege2._id }))

    // College 1 attempts to update College 2's student
    const attackRes = await fetch(`${baseUrl}/college/students/${studentInCollege2._id}`, {
      method: 'PUT',
      headers: collegeHeaders,
      body: JSON.stringify({ fullName: 'Tampered Name' }),
    })
    assert.equal(attackRes.status, 404, 'College 1 must NOT be able to modify College 2 student')
    console.log('[Live] College Data Isolation verified: College 1 received 404 trying to access College 2 data.')

    // 14. Independent Student Registration & Public Login
    console.log('\n[Live] 13. Verifying Independent Student Public Registration...')
    const indStudentEmail = `independent.${collegeCode1.toLowerCase()}@gmail.com`
    const indStudentPass = 'IndStudentPass2026!'

    const regRes = await fetch(`${baseUrl}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fullName: 'Independent Student Public',
        email: indStudentEmail,
        username: `ind_${collegeCode1.toLowerCase()}`,
        password: indStudentPass,
        confirmPassword: indStudentPass,
        role: 'student',
        accountType: 'independent',
        hearAboutUs: 'Google / Search Engine',
      }),
    })
    const regData = await expectJson(regRes, 201, 'Independent registration')
    console.log(`[Live] Independent registration succeeded: ${regData.user.email}`)
    cleanupTasks.push(async () => {
      await Student.deleteMany({ email: indStudentEmail })
      await AccountIdentity.deleteMany({ email: indStudentEmail })
    })

    // Verify independent student stored in 'students' collection without collegeId
    const indDbDoc = await Student.findOne({ email: indStudentEmail })
    assert.ok(indDbDoc, 'Independent student must exist in "students" collection')
    assert.equal(indDbDoc.studentType, 'independent')
    assert.equal(indDbDoc.collegeId, undefined, 'Independent student must NOT have collegeId')
    assert.equal(indDbDoc.hearAboutUs, 'Google / Search Engine', 'hearAboutUs must be saved in DB')

    // Common login for pending independent student (should be blocked awaiting admin approval per GitHub updates)
    const pendingLoginRes = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        identifier: indStudentEmail,
        password: indStudentPass,
      }),
    })
    await expectJson(pendingLoginRes, 403, 'Pending independent student blocked from login')
    console.log(`[Live] Pending independent student correctly blocked awaiting approval (403).`)

    // Admin approves the independent student
    indDbDoc.status = 'active'
    indDbDoc.approvalStatus = 'approved'
    indDbDoc.approvedAt = new Date()
    await indDbDoc.save()
    console.log(`[Live] Independent student approved.`)

    // Common login for approved independent student
    const indLoginRes = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        identifier: indStudentEmail,
        password: indStudentPass,
      }),
    })
    const indLoginData = await expectJson(indLoginRes, 200, 'Independent login')
    assert.equal(indLoginData.user.role, 'student')
    console.log(`[Live] Independent student successfully logged in via common login!`)

    // 15. College Notifications
    console.log('\n[Live] 14. Testing Notifications flow...')
    const notifsRes = await fetch(`${baseUrl}/college/notifications`, { headers: collegeHeaders })
    const notifsData = await expectJson(notifsRes, 200, 'Get notifications')
    assert.ok(notifsData.notifications.length > 0, 'Notifications should exist from student creation and course assignment')
    console.log(`[Live] Notifications retrieved (${notifsData.notifications.length} notifications, ${notifsData.unreadCount} unread).`)

    const readAllRes = await fetch(`${baseUrl}/college/notifications/read-all`, {
      method: 'POST',
      headers: collegeHeaders,
    })
    await expectJson(readAllRes, 200, 'Mark notifications read')
    console.log('[Live] All notifications marked as read successfully.')

    // 16. Student 360° Profile API
    console.log('\n[Live] 15. Testing Student 360° Profile API...')
    const s360Res = await fetch(`${baseUrl}/college/students/${createStudentData.student.id}/360`, {
      headers: collegeHeaders,
    })
    const s360Data = await expectJson(s360Res, 200, 'Student 360 Profile')
    assert.equal(s360Data.student.fullName, 'Aarav Patel')
    assert.equal(s360Data.courses.length, 1, 'Should have 1 enrolled course')
    console.log(`[Live] Student 360° profile verified for ${s360Data.student.fullName}. Courses enrolled: ${s360Data.courses.length}`)

    // 17. Semester Management
    console.log('\n[Live] 16. Testing Semester Management...')
    const semRes = await fetch(`${baseUrl}/college/semesters`, {
      method: 'POST',
      headers: collegeHeaders,
      body: JSON.stringify({
        name: 'Fall 2026',
        academicYear: '2026-2027',
        department: 'Computer Science & Engineering',
        isCurrent: true,
        subjects: [{ code: 'CS201', name: 'Data Structures', credits: 4 }],
      }),
    })
    const semData = await expectJson(semRes, 201, 'Create semester')
    console.log(`[Live] Semester created: "${semData.semester.name}" (${semData.semester._id})`)
    cleanupTasks.push(async () => Semester.deleteMany({ collegeId: college1Id }))

    // 18. Faculty Management
    console.log('\n[Live] 17. Testing Faculty Management...')
    const facRes = await fetch(`${baseUrl}/college/faculty`, {
      method: 'POST',
      headers: collegeHeaders,
      body: JSON.stringify({
        fullName: 'Prof. Ada Lovelace',
        email: `ada.${collegeCode1.toLowerCase()}@apex.edu`,
        department: 'Computer Science & Engineering',
        designation: 'Associate Professor',
        qualification: 'M.Tech, Ph.D.',
      }),
    })
    const facData = await expectJson(facRes, 201, 'Create faculty')
    console.log(`[Live] Faculty created: ${facData.faculty.fullName} (${facData.faculty.facultyId})`)
    cleanupTasks.push(async () => Faculty.deleteMany({ collegeId: college1Id }))

    // 19. Attendance Management & Low Attendance Warning Alert
    console.log('\n[Live] 18. Testing Attendance Recording & Warning Calculation...')
    const attRes = await fetch(`${baseUrl}/college/attendance`, {
      method: 'POST',
      headers: collegeHeaders,
      body: JSON.stringify({
        department: 'Computer Science & Engineering',
        batch: '2025-2029 CSE Alpha',
        subject: 'Data Structures',
        records: [
          { studentId: createStudentData.student.id, studentName: 'Aarav Patel', status: 'present' },
          { studentId: bulkData.imported[0].id, studentName: 'Priya Sharma', status: 'absent' },
        ],
      }),
    })
    const attData = await expectJson(attRes, 201, 'Record attendance')
    console.log(`[Live] Attendance recorded for 2 students. Session ID: ${attData.session._id}`)
    cleanupTasks.push(async () => Attendance.deleteMany({ collegeId: college1Id }))

    const attStatsRes = await fetch(`${baseUrl}/college/attendance/stats?threshold=75`, { headers: collegeHeaders })
    const attStats = await expectJson(attStatsRes, 200, 'Attendance stats')
    console.log(`[Live] Attendance stats verified. Overall: ${attStats.overallPercentage}%, Low attendance students: ${attStats.lowAttendanceCount}`)

    // 20. Examination & Results with Auto-Grading
    console.log('\n[Live] 19. Testing Examination Creation & Results Entry...')
    const examRes = await fetch(`${baseUrl}/college/examinations`, {
      method: 'POST',
      headers: collegeHeaders,
      body: JSON.stringify({
        title: 'Mid-Term Algorithms',
        examType: 'mid_term',
        department: 'Computer Science & Engineering',
        batch: '2025-2029 CSE Alpha',
        subject: 'Data Structures',
        startDate: new Date(),
        endDate: new Date(Date.now() + 86400000),
        maxMarks: 100,
        passingMarks: 40,
      }),
    })
    const examData = await expectJson(examRes, 201, 'Create exam')
    const examId = examData.examination._id
    cleanupTasks.push(async () => Examination.deleteMany({ collegeId: college1Id }))

    // Enter marks
    const marksRes = await fetch(`${baseUrl}/college/examinations/${examId}/results`, {
      method: 'POST',
      headers: collegeHeaders,
      body: JSON.stringify({
        results: [
          { studentId: createStudentData.student.id, studentName: 'Aarav Patel', marksObtained: 88 },
          { studentId: bulkData.imported[0].id, studentName: 'Priya Sharma', marksObtained: 35 },
        ],
      }),
    })
    const marksData = await expectJson(marksRes, 200, 'Record marks')
    assert.equal(marksData.examination.results[0].grade, 'A', 'Marks 88 should yield grade A')
    assert.equal(marksData.examination.results[1].grade, 'F', 'Marks 35 should yield grade F')
    assert.equal(marksData.examination.results[1].backlog, true, 'Marks 35 should flag backlog')
    console.log(`[Live] Examination results entered with auto-grading (A for Aarav, F/Backlog for Priya).`)

    // Report card
    const cardRes = await fetch(`${baseUrl}/college/results/report-card/${createStudentData.student.id}`, { headers: collegeHeaders })
    const cardData = await expectJson(cardRes, 200, 'Report card')
    assert.equal(cardData.reportCard.overallGrade, 'A')
    console.log(`[Live] Report card verified for Aarav Patel (Grade: ${cardData.reportCard.overallGrade}).`)

    // 21. Placement Drive & Applications
    console.log('\n[Live] 20. Testing Placement Drive Management...')
    const placeRes = await fetch(`${baseUrl}/college/placements`, {
      method: 'POST',
      headers: collegeHeaders,
      body: JSON.stringify({
        companyName: 'CloudScale Global Inc.',
        jobTitle: 'Cloud Engineer',
        opportunityType: 'full_time',
        packageLpa: 14.5,
        deadline: new Date(Date.now() + 7 * 86400000),
      }),
    })
    const placeData = await expectJson(placeRes, 201, 'Create placement drive')
    const driveId = placeData.placementDrive._id
    cleanupTasks.push(async () => PlacementDrive.deleteMany({ collegeId: college1Id }))

    // Apply student
    const applyRes = await fetch(`${baseUrl}/college/placements/${driveId}/apply`, {
      method: 'POST',
      headers: collegeHeaders,
      body: JSON.stringify({ studentId: createStudentData.student.id }),
    })
    const applyData = await expectJson(applyRes, 201, 'Apply student')
    const appId = applyData.placementDrive.applications[0]._id

    // Update application to placed
    const placedRes = await fetch(`${baseUrl}/college/placements/${driveId}/applications/${appId}`, {
      method: 'PATCH',
      headers: collegeHeaders,
      body: JSON.stringify({ status: 'placed', offeredPackage: 15.0 }),
    })
    await expectJson(placedRes, 200, 'Mark placed')
    console.log(`[Live] Placement drive created, student applied and marked placed with 15.0 LPA.`)

    // 22. AI College Assistant Natural Language Query
    console.log('\n[Live] 21. Testing AI College Assistant Interface...')
    const aiRes = await fetch(`${baseUrl}/college/ai-assistant`, {
      method: 'POST',
      headers: collegeHeaders,
      body: JSON.stringify({ prompt: 'Which students have attendance below 75%?' }),
    })
    const aiData = await expectJson(aiRes, 200, 'AI Assistant Query')
    assert.equal(aiData.isRealData, true)
    console.log(`[Live] AI Assistant answered query based on real records:\n${aiData.answer}`)

    // 23. Document Upload & Reports Export
    console.log('\n[Live] 22. Testing Document Upload & Report Export...')
    const docRes = await fetch(`${baseUrl}/college/documents`, {
      method: 'POST',
      headers: collegeHeaders,
      body: JSON.stringify({
        title: 'NBA Accreditation Criteria 2026',
        category: 'naac_nba',
        fileName: 'nba-criteria-2026.pdf',
        fileSize: 2048576,
      }),
    })
    await expectJson(docRes, 201, 'Upload document')
    cleanupTasks.push(async () => CollegeDocument.deleteMany({ collegeId: college1Id }))

    const exportExamsRes = await fetch(`${baseUrl}/college/reports/export?reportType=examinations`, { headers: collegeHeaders })
    const exportCsv = await exportExamsRes.text()
    assert.match(exportCsv, /Exam Title,Type,Department/)
    console.log(`[Live] Document uploaded and examination report CSV exported successfully.`)

    // 24. Leaderboard
    console.log('\n[Live] 23. Testing Student Leaderboard...')
    const leadRes = await fetch(`${baseUrl}/college/leaderboard`, { headers: collegeHeaders })
    const leadData = await expectJson(leadRes, 200, 'Leaderboard')
    console.log(`[Live] Leaderboard verified with ${leadData.leaderboard.length} ranked student(s).`)

    console.log('\n======================================================')
    console.log('✅ ALL LIVE MONGO ATLAS END-TO-END CHECKS PASSED!')
    console.log('======================================================\n')
  } finally {
    console.log('[Live] Cleaning up test data from MongoDB Atlas...')
    for (const cleanup of cleanupTasks.reverse()) {
      try {
        await cleanup()
      } catch (err) {
        console.warn('[Live] Cleanup warning:', err.message)
      }
    }
    await new Promise((resolve) => server.close(resolve))
    await mongoose.disconnect()
    console.log('[Live] Disconnected cleanly. Cleanup completed.')
  }
}

runLiveVerification().catch((err) => {
  console.error('\n❌ LIVE VERIFICATION FAILED:', err)
  process.exit(1)
})
