import React, { useEffect, useState, useMemo } from 'react'
import { isInvalidSessionResponse } from './auth-session.js'
import ThemeToggle from './ThemeToggle.jsx'
import './CollegeAdminDashboard.css'

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:5000/api'

async function collegeRequest(path, options = {}) {
  const savedAuth = sessionStorage.getItem('lms.auth')
  const auth = savedAuth ? JSON.parse(savedAuth) : null
  if (
    !auth ||
    (auth.user?.role !== 'college_admin' && auth.user?.role !== 'college') ||
    typeof auth.token !== 'string'
  ) {
    if (typeof window.__handleLmsLogout === 'function') {
      window.__handleLmsLogout()
    }
    throw new Error('Your college administrator session has ended. Please log in again.')
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${auth.token}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  })

  // Handle file downloads
  const contentType = response.headers.get('content-type')
  if (contentType && contentType.includes('text/csv')) {
    const blob = await response.blob()
    return blob
  }

  let result
  try {
    result = await response.json()
  } catch {
    throw new Error('The server returned an invalid response.')
  }

  if (isInvalidSessionResponse(response, result)) {
    if (typeof window.__handleLmsLogout === 'function') {
      window.__handleLmsLogout()
    }
  }

  if (!response.ok) {
    throw new Error(result.message || 'The request could not be completed.')
  }
  return result
}

function formatDate(val) {
  if (!val) return '—'
  const d = new Date(val)
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

export default function CollegeAdminDashboard({ user, onLogout, isDark, onToggleTheme }) {
  useEffect(() => {
    window.__handleLmsLogout = onLogout
    return () => {
      window.__handleLmsLogout = null
    }
  }, [onLogout])

  // Navigation & Shell
  const [activeTab, setActiveTab] = useState('overview')
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [dateFilter, setDateFilter] = useState('month') // today, week, month, semester, custom
  const [customStart, setCustomStart] = useState('')
  const [customEnd, setCustomEnd] = useState('')
  const [globalSearch, setGlobalSearch] = useState('')

  // Loading & Alert States
  const [isLoading, setIsLoading] = useState(true)
  const [isActionLoading, setIsActionLoading] = useState(false)
  const [error, setError] = useState('')
  const [successMessage, setSuccessMessage] = useState('')

  // Core Data States
  const [dashboard, setDashboard] = useState(null)
  const [unreadCount, setUnreadCount] = useState(0)
  const [notifications, setNotifications] = useState([])
  const [studentsData, setStudentsData] = useState({ students: [], pagination: {} })
  const [departments, setDepartments] = useState([])
  const [batches, setBatches] = useState([])
  const [semesters, setSemesters] = useState([])
  const [facultyList, setFacultyList] = useState([])
  const [courses, setCourses] = useState([])
  const [attendanceSessions, setAttendanceSessions] = useState([])
  const [attendanceStats, setAttendanceStats] = useState(null)
  const [examinations, setExaminations] = useState([])
  const [placementDrives, setPlacementDrives] = useState([])
  const [placementStats, setPlacementStats] = useState(null)
  const [calendarEvents, setCalendarEvents] = useState([])
  const [analytics, setAnalytics] = useState(null)
  const [aiInsights, setAiInsights] = useState(null)
  const [leaderboard, setLeaderboard] = useState([])
  const [documents, setDocuments] = useState([])
  const [profileData, setProfileData] = useState(null)

  // Filters
  const [studentSearch, setStudentSearch] = useState('')
  const [studentDeptFilter, setStudentDeptFilter] = useState('')
  const [studentBatchFilter, setStudentBatchFilter] = useState('')
  const [studentStatusFilter, setStudentStatusFilter] = useState('')
  const [facultyDeptFilter, setFacultyDeptFilter] = useState('')
  const [attDeptFilter, setAttDeptFilter] = useState('')
  const [attBatchFilter, setAttBatchFilter] = useState('')
  const [attSubjectFilter, setAttSubjectFilter] = useState('')
  const [examDeptFilter, setExamDeptFilter] = useState('')
  const [placementTypeFilter, setPlacementTypeFilter] = useState('')
  const [docCategoryFilter, setDocCategoryFilter] = useState('')

  // Modals
  const [showAddStudentModal, setShowAddStudentModal] = useState(false)
  const [showBulkUploadModal, setShowBulkUploadModal] = useState(false)
  const [showAddDeptModal, setShowAddDeptModal] = useState(false)
  const [showAddBatchModal, setShowAddBatchModal] = useState(false)
  const [showAddSemesterModal, setShowAddSemesterModal] = useState(false)
  const [showAddFacultyModal, setShowAddFacultyModal] = useState(false)
  const [showAssignCourseModal, setShowAssignCourseModal] = useState(false)
  const [showMarkAttendanceModal, setShowMarkAttendanceModal] = useState(false)
  const [showCorrectionModal, setShowCorrectionModal] = useState(null) // attendance session obj
  const [showCreateExamModal, setShowCreateExamModal] = useState(false)
  const [showEnterMarksModal, setShowEnterMarksModal] = useState(null) // exam obj
  const [showReportCardModal, setShowReportCardModal] = useState(null) // report card data
  const [showCreatePlacementModal, setShowCreatePlacementModal] = useState(false)
  const [showApplyPlacementModal, setShowApplyPlacementModal] = useState(null) // drive obj
  const [showAddEventModal, setShowAddEventModal] = useState(false)
  const [showUploadDocModal, setShowUploadDocModal] = useState(false)
  const [showBroadcastModal, setShowBroadcastModal] = useState(false)
  const [student360Modal, setStudent360Modal] = useState(null) // student 360 data
  const [student360Tab, setStudent360Tab] = useState('overview')
  const [credentialsModal, setCredentialsModal] = useState(null)
  const [editingStudent, setEditingStudent] = useState(null)
  const [editingDept, setEditingDept] = useState(null)
  const [editingBatch, setEditingBatch] = useState(null)
  const [editingSemester, setEditingSemester] = useState(null)
  const [editingFaculty, setEditingFaculty] = useState(null)

  // AI Assistant Chat State
  const [aiPrompt, setAiPrompt] = useState('')
  const [aiChatHistory, setAiChatHistory] = useState([
    {
      role: 'assistant',
      text: 'Hello! I am your AI College ERP & Academic Assistant. Ask me anything about student attendance, batch course progress, examination results, at-risk students, or department statistics.',
      timestamp: new Date(),
    },
  ])
  const [isAiLoading, setIsAiLoading] = useState(false)

  function showMessage(msg) {
    setSuccessMessage(msg)
    setTimeout(() => setSuccessMessage(''), 5000)
  }

  // Initial and Date Filter Loads
  async function loadDashboard() {
    setIsLoading(true)
    setError('')
    try {
      const query = new URLSearchParams()
      if (dateFilter) query.set('dateFilter', dateFilter)
      if (dateFilter === 'custom') {
        if (customStart) query.set('startDate', customStart)
        if (customEnd) query.set('endDate', customEnd)
      }
      const data = await collegeRequest(`/college/dashboard?${query}`)
      setDashboard(data)
      setDepartments(data.departments || [])
      setBatches(data.batches || [])
      setUnreadCount(data.stats?.unreadNotifications || 0)
    } catch (err) {
      if (/session has ended/i.test(err.message)) {
        onLogout()
        return
      }
      setError(err.message)
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    loadDashboard()
  }, [dateFilter, customStart, customEnd])

  // Tab-specific Data Loaders
  useEffect(() => {
    if (activeTab === 'students') loadStudents()
    if (activeTab === 'departments') loadDepartments()
    if (activeTab === 'batches') loadBatches()
    if (activeTab === 'semesters') loadSemesters()
    if (activeTab === 'faculty') loadFaculty()
    if (activeTab === 'courses') loadCourses()
    if (activeTab === 'calendar') loadEvents()
    if (activeTab === 'attendance') {
      loadAttendance()
      loadAttendanceStats()
    }
    if (activeTab === 'analytics') {
      loadAnalytics()
      loadAiInsights()
    }
    if (activeTab === 'examinations' || activeTab === 'results') loadExaminations()
    if (activeTab === 'placements' || activeTab === 'internships') {
      loadPlacements()
      loadPlacementStats()
    }
    if (activeTab === 'achievements') loadLeaderboard()
    if (activeTab === 'reports' || activeTab === 'documents') loadDocuments()
    if (activeTab === 'notifications') loadNotifications()
    if (activeTab === 'settings') loadProfile()
  }, [activeTab])

  // Data Loaders
  async function loadStudents() {
    try {
      const query = new URLSearchParams()
      if (studentSearch) query.set('search', studentSearch)
      if (studentDeptFilter) query.set('department', studentDeptFilter)
      if (studentBatchFilter) query.set('batch', studentBatchFilter)
      if (studentStatusFilter) query.set('status', studentStatusFilter)
      const data = await collegeRequest(`/college/students?${query}`)
      setStudentsData(data)
    } catch (err) {
      setError(err.message)
    }
  }

  async function loadDepartments() {
    try {
      const data = await collegeRequest('/college/departments')
      setDepartments(data.departments || [])
    } catch (err) {
      setError(err.message)
    }
  }

  async function loadBatches() {
    try {
      const data = await collegeRequest('/college/batches')
      setBatches(data.batches || [])
    } catch (err) {
      setError(err.message)
    }
  }

  async function loadSemesters() {
    try {
      const data = await collegeRequest('/college/semesters')
      setSemesters(data.semesters || [])
    } catch (err) {
      setError(err.message)
    }
  }

  async function loadFaculty() {
    try {
      const query = new URLSearchParams()
      if (facultyDeptFilter) query.set('department', facultyDeptFilter)
      const data = await collegeRequest(`/college/faculty?${query}`)
      setFacultyList(data.faculty || [])
    } catch (err) {
      setError(err.message)
    }
  }

  async function loadCourses() {
    try {
      const data = await collegeRequest('/college/courses')
      setCourses(data.courses || [])
    } catch (err) {
      setError(err.message)
    }
  }

  async function loadEvents() {
    try {
      const data = await collegeRequest('/college/events')
      setCalendarEvents(data.events || [])
    } catch (err) {
      setError(err.message)
    }
  }

  async function loadAttendance() {
    try {
      const query = new URLSearchParams()
      if (attDeptFilter) query.set('department', attDeptFilter)
      if (attBatchFilter) query.set('batch', attBatchFilter)
      if (attSubjectFilter) query.set('subject', attSubjectFilter)
      const data = await collegeRequest(`/college/attendance?${query}`)
      setAttendanceSessions(data.sessions || [])
    } catch (err) {
      setError(err.message)
    }
  }

  async function loadAttendanceStats() {
    try {
      const data = await collegeRequest('/college/attendance/stats?threshold=75')
      setAttendanceStats(data)
    } catch (err) {
      setError(err.message)
    }
  }

  async function loadExaminations() {
    try {
      const query = new URLSearchParams()
      if (examDeptFilter) query.set('department', examDeptFilter)
      const data = await collegeRequest(`/college/examinations?${query}`)
      setExaminations(data.examinations || [])
    } catch (err) {
      setError(err.message)
    }
  }

  async function loadPlacements() {
    try {
      const query = new URLSearchParams()
      if (activeTab === 'internships') query.set('opportunityType', 'internship')
      else if (placementTypeFilter) query.set('opportunityType', placementTypeFilter)
      const data = await collegeRequest(`/college/placements?${query}`)
      setPlacementDrives(data.placementDrives || [])
    } catch (err) {
      setError(err.message)
    }
  }

  async function loadPlacementStats() {
    try {
      const data = await collegeRequest('/college/placements/stats')
      setPlacementStats(data)
    } catch (err) {
      setError(err.message)
    }
  }

  async function loadAnalytics() {
    try {
      const data = await collegeRequest('/college/analytics')
      setAnalytics(data)
    } catch (err) {
      setError(err.message)
    }
  }

  async function loadAiInsights() {
    try {
      const data = await collegeRequest('/college/analytics/ai-insights')
      setAiInsights(data)
    } catch (err) {
      setError(err.message)
    }
  }

  async function loadLeaderboard() {
    try {
      const data = await collegeRequest('/college/leaderboard')
      setLeaderboard(data.leaderboard || [])
    } catch (err) {
      setError(err.message)
    }
  }

  async function loadDocuments() {
    try {
      const query = new URLSearchParams()
      if (docCategoryFilter) query.set('category', docCategoryFilter)
      const data = await collegeRequest(`/college/documents?${query}`)
      setDocuments(data.documents || [])
    } catch (err) {
      setError(err.message)
    }
  }

  async function loadNotifications() {
    try {
      const data = await collegeRequest('/college/notifications')
      setNotifications(data.notifications || [])
      setUnreadCount(data.unreadCount || 0)
    } catch (err) {
      setError(err.message)
    }
  }

  async function loadProfile() {
    try {
      const data = await collegeRequest('/college/profile')
      setProfileData(data)
    } catch (err) {
      setError(err.message)
    }
  }

  // -------------------------------------------------------------
  // Student Actions
  // -------------------------------------------------------------
  async function handleAddStudent(e) {
    e.preventDefault()
    setIsActionLoading(true)
    setError('')
    try {
      const formData = new FormData(e.currentTarget)
      const payload = Object.fromEntries(formData.entries())
      const result = await collegeRequest('/college/students', {
        method: 'POST',
        body: JSON.stringify(payload),
      })
      setShowAddStudentModal(false)
      showMessage(result.message)
      if (result.credentials) {
        setCredentialsModal({
          title: 'Student Created Successfully',
          username: result.credentials.username,
          email: result.credentials.email,
          password: result.credentials.temporaryPassword,
          note: 'Provide these credentials to the student so they can log in via the common login page.',
        })
      }
      loadStudents()
      loadDashboard()
    } catch (err) {
      setError(err.message)
    } finally {
      setIsActionLoading(false)
    }
  }

  async function handleBulkUpload(e) {
    e.preventDefault()
    setIsActionLoading(true)
    setError('')
    try {
      const formData = new FormData(e.currentTarget)
      const csvText = formData.get('csvText')
      const result = await collegeRequest('/college/students/bulk', {
        method: 'POST',
        body: JSON.stringify({ csvText }),
      })
      setShowBulkUploadModal(false)
      showMessage(result.message)
      if (result.credentials?.length > 0) {
        setCredentialsModal({
          title: `Bulk Import Completed (${result.summary.importedCount} Imported)`,
          bulkList: result.credentials,
          note: 'The generated login credentials for imported students are listed below.',
        })
      }
      loadStudents()
      loadDashboard()
    } catch (err) {
      setError(err.message)
    } finally {
      setIsActionLoading(false)
    }
  }

  async function handleEditStudent(e) {
    e.preventDefault()
    if (!editingStudent) return
    setIsActionLoading(true)
    setError('')
    try {
      const formData = new FormData(e.currentTarget)
      const payload = Object.fromEntries(formData.entries())
      if (payload.cgpa) payload.cgpa = parseFloat(payload.cgpa)
      const result = await collegeRequest(`/college/students/${editingStudent._id}`, {
        method: 'PUT',
        body: JSON.stringify(payload),
      })
      setEditingStudent(null)
      showMessage(result.message)
      loadStudents()
    } catch (err) {
      setError(err.message)
    } finally {
      setIsActionLoading(false)
    }
  }

  async function handleToggleStudentStatus(student) {
    const nextActive = !student.isActive
    try {
      const result = await collegeRequest(`/college/students/${student._id}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ isActive: nextActive }),
      })
      showMessage(result.message)
      loadStudents()
    } catch (err) {
      setError(err.message)
    }
  }

  async function handleResetPassword(student) {
    try {
      const result = await collegeRequest(`/college/students/${student._id}/reset-password`, {
        method: 'POST',
        body: JSON.stringify({}),
      })
      setCredentialsModal({
        title: `Credentials Reset for ${student.fullName || student.username}`,
        username: result.credentials.username,
        email: result.credentials.email,
        password: result.credentials.password,
        note: 'Provide these credentials to the student to log in.',
      })
    } catch (err) {
      setError(err.message)
    }
  }

  async function openStudent360(studentId) {
    try {
      const data = await collegeRequest(`/college/students/${studentId}/360`)
      setStudent360Modal(data)
      setStudent360Tab('overview')
    } catch (err) {
      setError(err.message)
    }
  }

  async function handleExportStudents() {
    try {
      const blob = await collegeRequest('/college/students/export')
      const url = window.URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `students-export-${new Date().toISOString().slice(0, 10)}.csv`
      a.click()
      window.URL.revokeObjectURL(url)
    } catch (err) {
      setError(err.message)
    }
  }

  // -------------------------------------------------------------
  // Department & Batch Handlers
  // -------------------------------------------------------------
  async function handleAddDept(e) {
    e.preventDefault()
    setIsActionLoading(true)
    setError('')
    try {
      const formData = new FormData(e.currentTarget)
      const payload = Object.fromEntries(formData.entries())
      if (payload.intakeCapacity) payload.intakeCapacity = parseInt(payload.intakeCapacity, 10)
      const result = await collegeRequest('/college/departments', {
        method: 'POST',
        body: JSON.stringify(payload),
      })
      setShowAddDeptModal(false)
      showMessage(result.message)
      loadDepartments()
      loadDashboard()
    } catch (err) {
      setError(err.message)
    } finally {
      setIsActionLoading(false)
    }
  }

  async function handleEditDept(e) {
    e.preventDefault()
    if (!editingDept) return
    setIsActionLoading(true)
    setError('')
    try {
      const formData = new FormData(e.currentTarget)
      const payload = Object.fromEntries(formData.entries())
      if (payload.intakeCapacity) payload.intakeCapacity = parseInt(payload.intakeCapacity, 10)
      const result = await collegeRequest(`/college/departments/${editingDept._id}`, {
        method: 'PUT',
        body: JSON.stringify(payload),
      })
      setEditingDept(null)
      showMessage(result.message)
      loadDepartments()
      loadDashboard()
    } catch (err) {
      setError(err.message)
    } finally {
      setIsActionLoading(false)
    }
  }

  async function handleDeleteDept(dept) {
    if (!window.confirm(`Are you sure you want to delete the department "${dept.name}"? This action cannot be undone.`)) return
    try {
      const result = await collegeRequest(`/college/departments/${dept._id}`, { method: 'DELETE' })
      showMessage(result.message)
      loadDepartments()
      loadDashboard()
    } catch (err) {
      setError(err.message)
    }
  }

  async function handleAddBatch(e) {
    e.preventDefault()
    setIsActionLoading(true)
    setError('')
    try {
      const formData = new FormData(e.currentTarget)
      const payload = Object.fromEntries(formData.entries())
      const result = await collegeRequest('/college/batches', {
        method: 'POST',
        body: JSON.stringify(payload),
      })
      setShowAddBatchModal(false)
      showMessage(result.message)
      loadBatches()
      loadDashboard()
    } catch (err) {
      setError(err.message)
    } finally {
      setIsActionLoading(false)
    }
  }

  async function handleDeleteBatch(batch) {
    if (!window.confirm(`Are you sure you want to delete batch "${batch.name}"?`)) return
    try {
      const result = await collegeRequest(`/college/batches/${batch._id}`, { method: 'DELETE' })
      showMessage(result.message)
      loadBatches()
      loadDashboard()
    } catch (err) {
      setError(err.message)
    }
  }

  // -------------------------------------------------------------
  // Semester Handlers
  // -------------------------------------------------------------
  async function handleAddSemester(e) {
    e.preventDefault()
    setIsActionLoading(true)
    try {
      const formData = new FormData(e.currentTarget)
      const payload = Object.fromEntries(formData.entries())
      payload.isCurrent = formData.get('isCurrent') === 'on'
      const result = await collegeRequest('/college/semesters', {
        method: 'POST',
        body: JSON.stringify(payload),
      })
      setShowAddSemesterModal(false)
      showMessage(result.message)
      loadSemesters()
    } catch (err) {
      setError(err.message)
    } finally {
      setIsActionLoading(false)
    }
  }

  async function handleDeleteSemester(semId) {
    if (!window.confirm('Delete this semester?')) return
    try {
      await collegeRequest(`/college/semesters/${semId}`, { method: 'DELETE' })
      loadSemesters()
    } catch (err) {
      setError(err.message)
    }
  }

  // -------------------------------------------------------------
  // Faculty Handlers
  // -------------------------------------------------------------
  async function handleAddFaculty(e) {
    e.preventDefault()
    setIsActionLoading(true)
    try {
      const formData = new FormData(e.currentTarget)
      const payload = Object.fromEntries(formData.entries())
      if (payload.workloadHours) payload.workloadHours = parseInt(payload.workloadHours, 10)
      const result = await collegeRequest('/college/faculty', {
        method: 'POST',
        body: JSON.stringify(payload),
      })
      setShowAddFacultyModal(false)
      showMessage(result.message)
      loadFaculty()
      loadDashboard()
    } catch (err) {
      setError(err.message)
    } finally {
      setIsActionLoading(false)
    }
  }

  async function handleDeleteFaculty(facultyId) {
    if (!window.confirm('Remove this faculty record?')) return
    try {
      const result = await collegeRequest(`/college/faculty/${facultyId}`, { method: 'DELETE' })
      showMessage(result.message)
      loadFaculty()
      loadDashboard()
    } catch (err) {
      setError(err.message)
    }
  }

  // -------------------------------------------------------------
  // Attendance Handlers
  // -------------------------------------------------------------
  async function handleMarkAttendance(e) {
    e.preventDefault()
    setIsActionLoading(true)
    try {
      const formData = new FormData(e.currentTarget)
      const department = formData.get('department')
      const batch = formData.get('batch')
      const subject = formData.get('subject')
      const date = formData.get('date')

      // Mark all filtered students as present unless checked absent
      const matchingStudents = studentsData.students.filter(
        (s) => (!department || s.department === department) && (!batch || s.batch === batch),
      )
      if (matchingStudents.length === 0) {
        throw new Error('No students found for this department and batch. Add students first.')
      }

      const records = matchingStudents.map((s) => ({
        studentId: s._id,
        studentName: s.fullName,
        studentRollNo: s.studentId,
        status: formData.get(`status_${s._id}`) || 'present',
        remarks: formData.get(`remarks_${s._id}`) || '',
      }))

      const result = await collegeRequest('/college/attendance', {
        method: 'POST',
        body: JSON.stringify({ department, batch, subject, date, records }),
      })
      setShowMarkAttendanceModal(false)
      showMessage(result.message)
      loadAttendance()
      loadAttendanceStats()
      loadDashboard()
    } catch (err) {
      setError(err.message)
    } finally {
      setIsActionLoading(false)
    }
  }

  async function handleAttendanceCorrection(e) {
    e.preventDefault()
    if (!showCorrectionModal) return
    setIsActionLoading(true)
    try {
      const formData = new FormData(e.currentTarget)
      const studentId = formData.get('studentId')
      const newStatus = formData.get('newStatus')
      const reason = formData.get('reason')

      const result = await collegeRequest(`/college/attendance/${showCorrectionModal._id}`, {
        method: 'PUT',
        body: JSON.stringify({ studentId, newStatus, reason }),
      })
      setShowCorrectionModal(null)
      showMessage(result.message)
      loadAttendance()
      loadAttendanceStats()
    } catch (err) {
      setError(err.message)
    } finally {
      setIsActionLoading(false)
    }
  }

  async function handleExportAttendance() {
    try {
      const blob = await collegeRequest('/college/attendance/export')
      const url = window.URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `attendance-records-${new Date().toISOString().slice(0, 10)}.csv`
      a.click()
      window.URL.revokeObjectURL(url)
    } catch (err) {
      setError(err.message)
    }
  }

  // -------------------------------------------------------------
  // Examination & Results Handlers
  // -------------------------------------------------------------
  async function handleCreateExam(e) {
    e.preventDefault()
    setIsActionLoading(true)
    try {
      const formData = new FormData(e.currentTarget)
      const payload = Object.fromEntries(formData.entries())
      if (payload.maxMarks) payload.maxMarks = parseInt(payload.maxMarks, 10)
      if (payload.passingMarks) payload.passingMarks = parseInt(payload.passingMarks, 10)
      const result = await collegeRequest('/college/examinations', {
        method: 'POST',
        body: JSON.stringify(payload),
      })
      setShowCreateExamModal(false)
      showMessage(result.message)
      loadExaminations()
      loadDashboard()
    } catch (err) {
      setError(err.message)
    } finally {
      setIsActionLoading(false)
    }
  }

  async function handleSaveMarks(e) {
    e.preventDefault()
    if (!showEnterMarksModal) return
    setIsActionLoading(true)
    try {
      const formData = new FormData(e.currentTarget)
      const matchingStudents = studentsData.students.filter(
        (s) => (!showEnterMarksModal.department || s.department === showEnterMarksModal.department) &&
               (!showEnterMarksModal.batch || s.batch === showEnterMarksModal.batch),
      )
      const results = matchingStudents.map((s) => {
        const marks = parseFloat(formData.get(`marks_${s._id}`) || 0)
        return {
          studentId: s._id,
          studentName: s.fullName,
          studentRollNo: s.studentId,
          marksObtained: marks,
        }
      })

      const res = await collegeRequest(`/college/examinations/${showEnterMarksModal._id}/results`, {
        method: 'POST',
        body: JSON.stringify({ results }),
      })
      setShowEnterMarksModal(null)
      showMessage(res.message)
      loadExaminations()
      loadDashboard()
    } catch (err) {
      setError(err.message)
    } finally {
      setIsActionLoading(false)
    }
  }

  async function openReportCard(studentId) {
    try {
      const data = await collegeRequest(`/college/results/report-card/${studentId}`)
      setShowReportCardModal(data)
    } catch (err) {
      setError(err.message)
    }
  }

  // -------------------------------------------------------------
  // Placement Handlers
  // -------------------------------------------------------------
  async function handleCreatePlacement(e) {
    e.preventDefault()
    setIsActionLoading(true)
    try {
      const formData = new FormData(e.currentTarget)
      const payload = Object.fromEntries(formData.entries())
      if (payload.packageLpa) payload.packageLpa = parseFloat(payload.packageLpa)
      if (payload.stipendMonthly) payload.stipendMonthly = parseFloat(payload.stipendMonthly)
      if (payload.minCgpa) payload.minCgpa = parseFloat(payload.minCgpa)
      const result = await collegeRequest('/college/placements', {
        method: 'POST',
        body: JSON.stringify(payload),
      })
      setShowCreatePlacementModal(false)
      showMessage(result.message)
      loadPlacements()
      loadPlacementStats()
      loadDashboard()
    } catch (err) {
      setError(err.message)
    } finally {
      setIsActionLoading(false)
    }
  }

  async function handleApplyPlacement(e) {
    e.preventDefault()
    if (!showApplyPlacementModal) return
    setIsActionLoading(true)
    try {
      const formData = new FormData(e.currentTarget)
      const studentId = formData.get('studentId')
      const notes = formData.get('notes')
      const result = await collegeRequest(`/college/placements/${showApplyPlacementModal._id}/apply`, {
        method: 'POST',
        body: JSON.stringify({ studentId, notes }),
      })
      setShowApplyPlacementModal(null)
      showMessage(result.message)
      loadPlacements()
      loadPlacementStats()
    } catch (err) {
      setError(err.message)
    } finally {
      setIsActionLoading(false)
    }
  }

  async function handleUpdatePlacementApp(driveId, appId, status, offeredPackage) {
    try {
      await collegeRequest(`/college/placements/${driveId}/applications/${appId}`, {
        method: 'PATCH',
        body: JSON.stringify({ status, offeredPackage }),
      })
      showMessage('Candidate status updated successfully.')
      loadPlacements()
      loadPlacementStats()
      loadDashboard()
    } catch (err) {
      setError(err.message)
    }
  }

  // -------------------------------------------------------------
  // AI Assistant Chat Handler
  // -------------------------------------------------------------
  async function handleSendAiPrompt(promptText) {
    const textToSend = promptText || aiPrompt
    if (!textToSend || !textToSend.trim()) return

    const userMessage = { role: 'user', text: textToSend, timestamp: new Date() }
    setAiChatHistory((prev) => [...prev, userMessage])
    setAiPrompt('')
    setIsAiLoading(true)

    try {
      const result = await collegeRequest('/college/ai-assistant', {
        method: 'POST',
        body: JSON.stringify({ prompt: textToSend }),
      })
      const botMessage = {
        role: 'assistant',
        text: result.answer,
        data: result.relevantData,
        timestamp: new Date(),
      }
      setAiChatHistory((prev) => [...prev, botMessage])
    } catch (err) {
      setAiChatHistory((prev) => [
        ...prev,
        {
          role: 'assistant',
          text: `⚠️ Query could not be processed: ${err.message}`,
          timestamp: new Date(),
        },
      ])
    } finally {
      setIsAiLoading(false)
    }
  }

  // -------------------------------------------------------------
  // Reports & Document Handlers
  // -------------------------------------------------------------
  async function handleUploadDoc(e) {
    e.preventDefault()
    setIsActionLoading(true)
    try {
      const formData = new FormData(e.currentTarget)
      const payload = Object.fromEntries(formData.entries())
      payload.fileSize = 1048576 // 1MB simulated
      const result = await collegeRequest('/college/documents', {
        method: 'POST',
        body: JSON.stringify(payload),
      })
      setShowUploadDocModal(false)
      showMessage(result.message)
      loadDocuments()
    } catch (err) {
      setError(err.message)
    } finally {
      setIsActionLoading(false)
    }
  }

  async function handleExportReport(reportType) {
    try {
      const blob = await collegeRequest(`/college/reports/export?reportType=${reportType}`)
      const url = window.URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${reportType}-report-${new Date().toISOString().slice(0, 10)}.csv`
      a.click()
      window.URL.revokeObjectURL(url)
    } catch (err) {
      setError(err.message)
    }
  }

  // -------------------------------------------------------------
  // Course Assign Handler
  // -------------------------------------------------------------
  async function handleAssignCourse(e) {
    e.preventDefault()
    setIsActionLoading(true)
    try {
      const formData = new FormData(e.currentTarget)
      const payload = Object.fromEntries(formData.entries())
      const result = await collegeRequest('/college/courses/assign', {
        method: 'POST',
        body: JSON.stringify(payload),
      })
      setShowAssignCourseModal(false)
      showMessage(result.message)
      loadCourses()
      loadDashboard()
    } catch (err) {
      setError(err.message)
    } finally {
      setIsActionLoading(false)
    }
  }

  // -------------------------------------------------------------
  // Notifications Handlers
  // -------------------------------------------------------------
  async function handleMarkAllNotificationsRead() {
    try {
      await collegeRequest('/college/notifications/read-all', { method: 'POST' })
      setUnreadCount(0)
      loadNotifications()
      showMessage('All notifications marked as read.')
    } catch (err) {
      setError(err.message)
    }
  }

  async function handleBroadcastAnnouncement(e) {
    e.preventDefault()
    setIsActionLoading(true)
    try {
      const formData = new FormData(e.currentTarget)
      const payload = Object.fromEntries(formData.entries())
      await collegeRequest('/college/notifications/broadcast', {
        method: 'POST',
        body: JSON.stringify(payload),
      })
      setShowBroadcastModal(false)
      showMessage('Announcement broadcasted successfully.')
      loadNotifications()
    } catch (err) {
      setError(err.message)
    } finally {
      setIsActionLoading(false)
    }
  }

  // -------------------------------------------------------------
  // Profile & Password Handlers
  // -------------------------------------------------------------
  async function handleUpdateProfile(e) {
    e.preventDefault()
    setIsActionLoading(true)
    try {
      const formData = new FormData(e.currentTarget)
      const payload = Object.fromEntries(formData.entries())
      const result = await collegeRequest('/college/profile', {
        method: 'PUT',
        body: JSON.stringify(payload),
      })
      showMessage(result.message)
      loadProfile()
      loadDashboard()
    } catch (err) {
      setError(err.message)
    } finally {
      setIsActionLoading(false)
    }
  }

  async function handleChangePassword(e) {
    e.preventDefault()
    setIsActionLoading(true)
    try {
      const formData = new FormData(e.currentTarget)
      const payload = Object.fromEntries(formData.entries())
      const result = await collegeRequest('/college/password', {
        method: 'PUT',
        body: JSON.stringify(payload),
      })
      e.target.reset()
      showMessage(result.message)
    } catch (err) {
      setError(err.message)
    } finally {
      setIsActionLoading(false)
    }
  }

  const collegeName = dashboard?.college?.name || user?.fullName || 'College Workspace'

  return (
    <div className="college-dashboard">
      {/* Sidebar Navigation */}
      <aside className={`cd-sidebar ${sidebarOpen ? 'is-open' : ''}`}>
        <div className="cd-sidebar__brand">
          <img src="/logo.png" alt="LMS Logo" onError={(e) => { e.currentTarget.style.display = 'none' }} />
          <div className="cd-sidebar__brand-text">
            <span className="cd-sidebar__college-badge">College ERP</span>
          </div>
        </div>

        <nav className="cd-nav">
          {/* Group 1: OVERVIEW */}
          <div className="cd-nav__group">
            <div className="cd-nav__group-header">Overview</div>
            <button
              type="button"
              className={`cd-nav__item ${activeTab === 'overview' ? 'is-active' : ''}`}
              onClick={() => { setActiveTab('overview'); setSidebarOpen(false) }}
            >
              <span className="cd-nav__icon">◫</span>
              <span>Dashboard</span>
            </button>
            <button
              type="button"
              className={`cd-nav__item ${activeTab === 'notifications' ? 'is-active' : ''}`}
              onClick={() => { setActiveTab('notifications'); setSidebarOpen(false) }}
            >
              <span className="cd-nav__icon">🔔</span>
              <span>Notifications</span>
              {unreadCount > 0 && <span className="cd-nav__badge">{unreadCount}</span>}
            </button>
            <button
              type="button"
              className={`cd-nav__item ${activeTab === 'ai-assistant' ? 'is-active' : ''}`}
              onClick={() => { setActiveTab('ai-assistant'); setSidebarOpen(false) }}
            >
              <span className="cd-nav__icon">✨</span>
              <span>AI Assistant</span>
            </button>
          </div>

          {/* Group 2: ACADEMIC MANAGEMENT */}
          <div className="cd-nav__group">
            <div className="cd-nav__group-header">Academic Management</div>
            <button
              type="button"
              className={`cd-nav__item ${activeTab === 'students' ? 'is-active' : ''}`}
              onClick={() => { setActiveTab('students'); setSidebarOpen(false) }}
            >
              <span className="cd-nav__icon">🎓</span>
              <span>Students</span>
              {Boolean(dashboard?.stats?.totalStudents) && (
                <span className="cd-nav__badge">{dashboard.stats.totalStudents}</span>
              )}
            </button>
            <button
              type="button"
              className={`cd-nav__item ${activeTab === 'departments' ? 'is-active' : ''}`}
              onClick={() => { setActiveTab('departments'); setSidebarOpen(false) }}
            >
              <span className="cd-nav__icon">🏛</span>
              <span>Departments</span>
            </button>
            <button
              type="button"
              className={`cd-nav__item ${activeTab === 'batches' ? 'is-active' : ''}`}
              onClick={() => { setActiveTab('batches'); setSidebarOpen(false) }}
            >
              <span className="cd-nav__icon">👥</span>
              <span>Batches</span>
            </button>
            <button
              type="button"
              className={`cd-nav__item ${activeTab === 'semesters' ? 'is-active' : ''}`}
              onClick={() => { setActiveTab('semesters'); setSidebarOpen(false) }}
            >
              <span className="cd-nav__icon">📚</span>
              <span>Semesters</span>
            </button>
            <button
              type="button"
              className={`cd-nav__item ${activeTab === 'courses' ? 'is-active' : ''}`}
              onClick={() => { setActiveTab('courses'); setSidebarOpen(false) }}
            >
              <span className="cd-nav__icon">📖</span>
              <span>Courses</span>
            </button>
            <button
              type="button"
              className={`cd-nav__item ${activeTab === 'faculty' ? 'is-active' : ''}`}
              onClick={() => { setActiveTab('faculty'); setSidebarOpen(false) }}
            >
              <span className="cd-nav__icon">👨‍🏫</span>
              <span>Faculty</span>
            </button>
            <button
              type="button"
              className={`cd-nav__item ${activeTab === 'calendar' ? 'is-active' : ''}`}
              onClick={() => { setActiveTab('calendar'); setSidebarOpen(false) }}
            >
              <span className="cd-nav__icon">📅</span>
              <span>Academic Calendar</span>
            </button>
          </div>

          {/* Group 3: STUDENT PERFORMANCE */}
          <div className="cd-nav__group">
            <div className="cd-nav__group-header">Student Performance</div>
            <button
              type="button"
              className={`cd-nav__item ${activeTab === 'attendance' ? 'is-active' : ''}`}
              onClick={() => { setActiveTab('attendance'); setSidebarOpen(false) }}
            >
              <span className="cd-nav__icon">📋</span>
              <span>Attendance</span>
            </button>
            <button
              type="button"
              className={`cd-nav__item ${activeTab === 'analytics' ? 'is-active' : ''}`}
              onClick={() => { setActiveTab('analytics'); setSidebarOpen(false) }}
            >
              <span className="cd-nav__icon">📊</span>
              <span>Learning Analytics</span>
            </button>
            <button
              type="button"
              className={`cd-nav__item ${activeTab === 'examinations' ? 'is-active' : ''}`}
              onClick={() => { setActiveTab('examinations'); setSidebarOpen(false) }}
            >
              <span className="cd-nav__icon">📝</span>
              <span>Examinations</span>
            </button>
            <button
              type="button"
              className={`cd-nav__item ${activeTab === 'results' ? 'is-active' : ''}`}
              onClick={() => { setActiveTab('results'); setSidebarOpen(false) }}
            >
              <span className="cd-nav__icon">🏅</span>
              <span>Results & Report Cards</span>
            </button>
          </div>

          {/* Group 4: CAREER DEVELOPMENT */}
          <div className="cd-nav__group">
            <div className="cd-nav__group-header">Career Development</div>
            <button
              type="button"
              className={`cd-nav__item ${activeTab === 'placements' ? 'is-active' : ''}`}
              onClick={() => { setActiveTab('placements'); setSidebarOpen(false) }}
            >
              <span className="cd-nav__icon">💼</span>
              <span>Placements</span>
            </button>
            <button
              type="button"
              className={`cd-nav__item ${activeTab === 'internships' ? 'is-active' : ''}`}
              onClick={() => { setActiveTab('internships'); setSidebarOpen(false) }}
            >
              <span className="cd-nav__icon">🏢</span>
              <span>Internships</span>
            </button>
            <button
              type="button"
              className={`cd-nav__item ${activeTab === 'achievements' ? 'is-active' : ''}`}
              onClick={() => { setActiveTab('achievements'); setSidebarOpen(false) }}
            >
              <span className="cd-nav__icon">🏆</span>
              <span>Achievements & Leaderboard</span>
            </button>
          </div>

          {/* Group 5: ADMINISTRATION */}
          <div className="cd-nav__group">
            <div className="cd-nav__group-header">Administration</div>
            <button
              type="button"
              className={`cd-nav__item ${activeTab === 'reports' ? 'is-active' : ''}`}
              onClick={() => { setActiveTab('reports'); setSidebarOpen(false) }}
            >
              <span className="cd-nav__icon">📑</span>
              <span>Reports & Exports</span>
            </button>
            <button
              type="button"
              className={`cd-nav__item ${activeTab === 'documents' ? 'is-active' : ''}`}
              onClick={() => { setActiveTab('documents'); setSidebarOpen(false) }}
            >
              <span className="cd-nav__icon">📁</span>
              <span>Documents</span>
            </button>
            <button
              type="button"
              className={`cd-nav__item ${activeTab === 'settings' ? 'is-active' : ''}`}
              onClick={() => { setActiveTab('settings'); setSidebarOpen(false) }}
            >
              <span className="cd-nav__icon">⚙</span>
              <span>College Settings</span>
            </button>
          </div>
        </nav>

        {/* User Footer */}
        <div className="cd-sidebar__footer">
          <div className="cd-user-chip">
            <div className="cd-user-chip__avatar">
              {(user?.fullName || user?.username || 'C')[0].toUpperCase()}
            </div>
            <div className="cd-user-chip__info">
              <span className="cd-user-chip__name">{user?.fullName || user?.username || 'College Admin'}</span>
              <span className="cd-user-chip__role">{dashboard?.college?.code || 'College Admin'}</span>
            </div>
          </div>
          <button type="button" className="cd-logout-button" onClick={() => onLogout?.()}>
            <span>Log out</span>
          </button>
        </div>
      </aside>

      {/* Main Panel */}
      <div className="cd-main">
        {/* Top Header */}
        <header className="cd-topbar">
          <div className="cd-topbar__left">
            <button
              type="button"
              className="cd-menu-toggle"
              onClick={() => setSidebarOpen(!sidebarOpen)}
              aria-label="Toggle Navigation"
            >
              ☰
            </button>
            <div>
              <h1 className="cd-topbar__title">{collegeName}</h1>
              <span className="cd-topbar__subtitle">College ERP & LMS Management Portal</span>
            </div>
          </div>

          <div className="cd-topbar__right">
            {/* Global Date Filter */}
            <div className="cd-date-filter-group">
              <span className="cd-date-filter-label">Period:</span>
              <select
                className="cd-date-filter-select"
                value={dateFilter}
                onChange={(e) => setDateFilter(e.target.value)}
              >
                <option value="today">Today</option>
                <option value="week">This Week</option>
                <option value="month">This Month</option>
                <option value="semester">This Semester</option>
                <option value="custom">Custom Range</option>
              </select>
              {dateFilter === 'custom' && (
                <div className="cd-custom-date-inputs">
                  <input
                    type="date"
                    value={customStart}
                    onChange={(e) => setCustomStart(e.target.value)}
                    className="cd-date-input"
                  />
                  <span>to</span>
                  <input
                    type="date"
                    value={customEnd}
                    onChange={(e) => setCustomEnd(e.target.value)}
                    className="cd-date-input"
                  />
                </div>
              )}
            </div>

            <button
              type="button"
              className="cd-btn cd-btn--secondary cd-btn--sm"
              onClick={() => setActiveTab('notifications')}
            >
              🔔 {unreadCount > 0 && <span className="cd-badge-pill">{unreadCount}</span>}
            </button>
            {onToggleTheme && (
              <ThemeToggle isDark={isDark} onToggle={onToggleTheme} className="cd-theme-toggle" />
            )}
            <button type="button" className="cd-btn cd-btn--secondary cd-btn--sm" onClick={() => onLogout?.()}>
              Sign out
            </button>
          </div>
        </header>

        {/* Content Body */}
        <main className="cd-content">
          {error && (
            <div className="cd-alert cd-alert--error" role="alert">
              <span>{error}</span>
              <button type="button" onClick={() => setError('')} className="cd-alert-close">✕</button>
            </div>
          )}

          {successMessage && (
            <div className="cd-alert cd-alert--success" role="status">
              <span>{successMessage}</span>
              <button type="button" onClick={() => setSuccessMessage('')} className="cd-alert-close">✕</button>
            </div>
          )}

          {/* ============================================================== */}
          {/* TAB 1: OVERVIEW                                                */}
          {/* ============================================================== */}
          {activeTab === 'overview' && (
            isLoading && !dashboard ? (
              <div className="cd-loading-screen">
                <div className="cd-spinner" />
                <h3>Loading Institutional Workspace...</h3>
                <p>Retrieving departments, batches, and academic analytics.</p>
              </div>
            ) : !dashboard ? (
              <div className="cd-loading-screen">
                <h3>Unable to load dashboard data</h3>
                <p>{error || 'Could not retrieve college records.'}</p>
                <button type="button" className="cd-btn cd-btn--primary" onClick={loadDashboard}>
                  Retry Loading
                </button>
              </div>
            ) : (
            <div className="cd-view cd-overview">
              <div className="cd-view__header">
                <div>
                  <h2 className="cd-view__title">Institutional Overview</h2>
                  <p className="cd-view__subtitle">Real-time academic, attendance, course, and placement analytics.</p>
                </div>
                <div className="cd-view__actions">
                  <button type="button" className="cd-btn cd-btn--primary" onClick={() => setActiveTab('ai-assistant')}>
                    ✨ Ask AI Assistant
                  </button>
                  <button type="button" className="cd-btn cd-btn--secondary" onClick={() => handleExportReport('students')}>
                    📥 Export All Data
                  </button>
                </div>
              </div>

              {/* Enterprise KPI Metric Cards */}
              <div className="cd-kpi-grid">
                <div className="cd-kpi-card">
                  <div className="cd-kpi-card__header">
                    <span className="cd-kpi-card__label">Total Students</span>
                    <span className="cd-kpi-card__icon">🎓</span>
                  </div>
                  <div className="cd-kpi-card__value">{dashboard?.stats?.totalStudents || 0}</div>
                  <div className="cd-kpi-card__footer">
                    <span className="cd-pill cd-pill--success">{dashboard?.stats?.activeStudents || 0} Active</span>
                  </div>
                </div>

                <div className="cd-kpi-card">
                  <div className="cd-kpi-card__header">
                    <span className="cd-kpi-card__label">Average Attendance</span>
                    <span className="cd-kpi-card__icon">📋</span>
                  </div>
                  <div className="cd-kpi-card__value">{dashboard?.stats?.averageAttendance || 0}%</div>
                  <div className="cd-kpi-card__footer">
                    <span className={`cd-pill ${(dashboard?.stats?.averageAttendance || 0) >= 75 ? 'cd-pill--success' : 'cd-pill--danger'}`}>
                      {(dashboard?.stats?.averageAttendance || 0) >= 75 ? 'Healthy Attendance' : 'Below 75% Threshold'}
                    </span>
                  </div>
                </div>

                <div className="cd-kpi-card">
                  <div className="cd-kpi-card__header">
                    <span className="cd-kpi-card__label">Academic Performance</span>
                    <span className="cd-kpi-card__icon">📈</span>
                  </div>
                  <div className="cd-kpi-card__value">{dashboard?.stats?.averageAcademicPerformance || 0}%</div>
                  <div className="cd-kpi-card__footer">
                    <span>Average Examination Score</span>
                  </div>
                </div>

                <div className="cd-kpi-card">
                  <div className="cd-kpi-card__header">
                    <span className="cd-kpi-card__label">Course Completion Rate</span>
                    <span className="cd-kpi-card__icon">📖</span>
                  </div>
                  <div className="cd-kpi-card__value">{dashboard?.stats?.courseCompletionRate || 0}%</div>
                  <div className="cd-kpi-card__footer">
                    <span>{dashboard?.stats?.totalAssignedCourses || 0} Assigned LMS Courses</span>
                  </div>
                </div>

                <div className="cd-kpi-card cd-kpi-card--highlight">
                  <div className="cd-kpi-card__header">
                    <span className="cd-kpi-card__label">Students At Risk</span>
                    <span className="cd-kpi-card__icon">⚠️</span>
                  </div>
                  <div className="cd-kpi-card__value cd-kpi-card__value--danger">
                    {dashboard?.stats?.studentsAtRisk || 0}
                  </div>
                  <div className="cd-kpi-card__footer">
                    <span>Low attendance (&lt;75%) or backlogs</span>
                  </div>
                </div>

                <div className="cd-kpi-card">
                  <div className="cd-kpi-card__header">
                    <span className="cd-kpi-card__label">Placement Rate</span>
                    <span className="cd-kpi-card__icon">💼</span>
                  </div>
                  <div className="cd-kpi-card__value">{dashboard?.stats?.placement?.placementPercentage || 0}%</div>
                  <div className="cd-kpi-card__footer">
                    <span>{dashboard?.stats?.placement?.totalPlaced || 0} Placed · Highest {dashboard?.stats?.placement?.highestPackage || 0} LPA</span>
                  </div>
                </div>

                <div className="cd-kpi-card">
                  <div className="cd-kpi-card__header">
                    <span className="cd-kpi-card__label">Departments & Batches</span>
                    <span className="cd-kpi-card__icon">🏛</span>
                  </div>
                  <div className="cd-kpi-card__value">
                    {dashboard?.stats?.totalDepartments || 0} <span className="cd-kpi-sub">/ {dashboard?.stats?.totalBatches || 0}</span>
                  </div>
                  <div className="cd-kpi-card__footer">
                    <span>{dashboard?.stats?.totalFaculty || 0} Faculty Members</span>
                  </div>
                </div>
              </div>

              {/* Pending Tasks & Action Alerts */}
              {dashboard?.pendingTasks?.length > 0 && (
                <div className="cd-tasks-banner">
                  <h3 className="cd-tasks-banner__title">⚠️ Action Required</h3>
                  <div className="cd-tasks-list">
                    {(dashboard?.pendingTasks || []).map((task) => (
                      <div key={task.id} className="cd-task-item">
                        <div>
                          <strong>{task.title}:</strong> <span>{task.description}</span>
                        </div>
                        <button
                          type="button"
                          className="cd-btn cd-btn--secondary cd-btn--sm"
                          onClick={() => setActiveTab(task.actionTab)}
                        >
                          Resolve →
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Analytics Charts & Upcoming Events Grid */}
              <div className="cd-charts-grid">
                {/* Chart 1: Attendance Trend Bar Visualization */}
                <div className="cd-card cd-chart-card">
                  <h3 className="cd-card__title">Weekly Attendance Trends</h3>
                  <p className="cd-card__subtitle">Daily percentage over recorded academic sessions</p>
                  <div className="cd-bar-chart">
                    {(dashboard?.analyticsCharts?.attendanceTrend || []).map((day, idx) => (
                      <div key={idx} className="cd-bar-col">
                        <div className="cd-bar-track">
                          <div
                            className="cd-bar-fill"
                            style={{ height: `${day.rate}%`, background: day.rate >= 75 ? 'var(--cd-olive)' : 'var(--cd-danger)' }}
                            title={`${day.date}: ${day.rate}% (${day.sessionsCount} sessions)`}
                          />
                        </div>
                        <span className="cd-bar-val">{day.rate}%</span>
                        <span className="cd-bar-label">{day.date.split(',')[0]}</span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Chart 2: Course Progress Distribution */}
                <div className="cd-card cd-chart-card">
                  <h3 className="cd-card__title">Course Completion Milestones</h3>
                  <p className="cd-card__subtitle">Student distribution across progress brackets</p>
                  <div className="cd-progress-distribution">
                    {Object.entries(dashboard?.analyticsCharts?.progressDistribution || {}).map(([bracket, count]) => (
                      <div key={bracket} className="cd-dist-row">
                        <span className="cd-dist-label">{bracket}</span>
                        <div className="cd-dist-bar-track">
                          <div
                            className="cd-dist-bar-fill"
                            style={{
                              width: `${(dashboard?.stats?.totalStudents || 0) > 0 ? (count / dashboard.stats.totalStudents) * 100 : 0}%`,
                            }}
                          />
                        </div>
                        <span className="cd-dist-count">{count} student(s)</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {/* Bottom Split: Upcoming Events & Recent Activities */}
              <div className="cd-grid-two">
                <div className="cd-card">
                  <div className="cd-card__header-flex">
                    <h3 className="cd-card__title">Upcoming Academic Events</h3>
                    <button type="button" className="cd-btn cd-btn--text" onClick={() => setActiveTab('calendar')}>View Calendar →</button>
                  </div>
                  {(!dashboard?.upcomingEvents || dashboard.upcomingEvents.length === 0) ? (
                    <div className="cd-empty-compact">No upcoming events scheduled.</div>
                  ) : (
                    <div className="cd-events-timeline">
                      {(dashboard?.upcomingEvents || []).map((evt) => (
                        <div key={evt._id} className="cd-event-pill">
                          <div className="cd-event-pill__date">
                            <span>{new Date(evt.startDate).toLocaleDateString(undefined, { month: 'short' })}</span>
                            <strong>{new Date(evt.startDate).getDate()}</strong>
                          </div>
                          <div className="cd-event-pill__content">
                            <h4>{evt.title}</h4>
                            <p>{evt.description || `${(evt.eventType || '').toUpperCase()} · ${evt.department || 'All Departments'}`}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="cd-card">
                  <div className="cd-card__header-flex">
                    <h3 className="cd-card__title">Recent Course Enrollments</h3>
                    <button type="button" className="cd-btn cd-btn--text" onClick={() => setActiveTab('courses')}>Manage Courses →</button>
                  </div>
                  {(!dashboard?.recentEnrollments || dashboard.recentEnrollments.length === 0) ? (
                    <div className="cd-empty-compact">No recent enrollments recorded.</div>
                  ) : (
                    <div className="cd-enrollments-mini-list">
                      {(dashboard?.recentEnrollments || []).map((enr) => (
                        <div key={enr._id} className="cd-enroll-mini-row">
                          <div className="cd-enroll-mini-avatar">
                            {(enr.userId?.fullName || 'S')[0].toUpperCase()}
                          </div>
                          <div className="cd-enroll-mini-details">
                            <strong>{enr.userId?.fullName || 'Student'}</strong>
                            <span>{enr.courseId?.title || 'Course'} · {enr.userId?.department || 'Department'}</span>
                          </div>
                          <span className="cd-pill cd-pill--success">Enrolled</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
            )
          )}

          {/* ============================================================== */}
          {/* TAB 2: ADVANCED STUDENT MANAGEMENT & 360° PROFILE             */}
          {/* ============================================================== */}
          {activeTab === 'students' && (
            <div className="cd-view">
              <div className="cd-view__header">
                <div>
                  <h2 className="cd-view__title">Student Directory & 360° Profiles</h2>
                  <p className="cd-view__subtitle">Manage credentials, academic standings, department assignments, and records.</p>
                </div>
                <div className="cd-view__actions">
                  <button type="button" className="cd-btn cd-btn--primary" onClick={() => setShowAddStudentModal(true)}>
                    + Add Student
                  </button>
                  <button type="button" className="cd-btn cd-btn--secondary" onClick={() => setShowBulkUploadModal(true)}>
                    📥 Bulk Import CSV
                  </button>
                  <button type="button" className="cd-btn cd-btn--secondary" onClick={handleExportStudents}>
                    Export Records
                  </button>
                </div>
              </div>

              {/* Filter Bar */}
              <div className="cd-filter-bar">
                <input
                  type="text"
                  placeholder="Search by name, email, roll no, or username..."
                  className="cd-input cd-filter-search"
                  value={studentSearch}
                  onChange={(e) => setStudentSearch(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && loadStudents()}
                />
                <select
                  className="cd-select"
                  value={studentDeptFilter}
                  onChange={(e) => setStudentDeptFilter(e.target.value)}
                >
                  <option value="">All Departments</option>
                  {departments.map((d) => (
                    <option key={d._id} value={d.name}>{d.name}</option>
                  ))}
                </select>
                <select
                  className="cd-select"
                  value={studentBatchFilter}
                  onChange={(e) => setStudentBatchFilter(e.target.value)}
                >
                  <option value="">All Batches</option>
                  {batches.map((b) => (
                    <option key={b._id} value={b.name}>{b.name}</option>
                  ))}
                </select>
                <select
                  className="cd-select"
                  value={studentStatusFilter}
                  onChange={(e) => setStudentStatusFilter(e.target.value)}
                >
                  <option value="">All Statuses</option>
                  <option value="active">Active</option>
                  <option value="inactive">Inactive</option>
                </select>
                <button type="button" className="cd-btn cd-btn--secondary" onClick={loadStudents}>
                  Filter
                </button>
              </div>

              {/* Students Data Table */}
              <div className="cd-table-container">
                <table className="cd-table">
                  <thead>
                    <tr>
                      <th>Student</th>
                      <th>Roll No / ID</th>
                      <th>Department & Batch</th>
                      <th>Semester</th>
                      <th>CGPA</th>
                      <th>Standing</th>
                      <th>Status</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {studentsData.students?.length === 0 ? (
                      <tr>
                        <td colSpan="8" className="cd-empty-td">
                          No student records found matching your filters.
                        </td>
                      </tr>
                    ) : (
                      studentsData.students?.map((s) => (
                        <tr key={s._id}>
                          <td>
                            <div className="cd-user-cell">
                              <div className="cd-user-avatar">{(s.fullName || 'S')[0].toUpperCase()}</div>
                              <div>
                                <div className="cd-user-name">{s.fullName}</div>
                                <div className="cd-user-sub">{s.email}</div>
                              </div>
                            </div>
                          </td>
                          <td><code>{s.studentId || '—'}</code></td>
                          <td>
                            <div>{s.department || 'Unassigned'}</div>
                            <small className="cd-text-muted">{s.batch || 'No Batch'}</small>
                          </td>
                          <td>{s.semester || 'Sem 1'}</td>
                          <td><strong>{s.cgpa || 0}</strong></td>
                          <td>
                            <span className={`cd-pill cd-pill--${s.academicStanding === 'at_risk' ? 'danger' : s.academicStanding === 'excellent' ? 'success' : 'neutral'}`}>
                              {s.academicStanding || 'good'}
                            </span>
                          </td>
                          <td>
                            <span className={`cd-pill cd-pill--${s.isActive ? 'success' : 'danger'}`}>
                              {s.isActive ? 'Active' : 'Inactive'}
                            </span>
                          </td>
                          <td>
                            <div className="cd-actions-cell">
                              <button
                                type="button"
                                className="cd-btn cd-btn--sm cd-btn--primary"
                                onClick={() => openStudent360(s._id)}
                                title="Open 360° Profile"
                              >
                                360° Profile
                              </button>
                              <button
                                type="button"
                                className="cd-btn cd-btn--sm cd-btn--secondary"
                                onClick={() => setEditingStudent(s)}
                                title="Edit details"
                              >
                                Edit
                              </button>
                              <button
                                type="button"
                                className="cd-btn cd-btn--sm cd-btn--secondary"
                                onClick={() => handleToggleStudentStatus(s)}
                              >
                                {s.isActive ? 'Deactivate' : 'Activate'}
                              </button>
                              <button
                                type="button"
                                className="cd-btn cd-btn--sm cd-btn--secondary"
                                onClick={() => handleResetPassword(s)}
                                title="Generate new password"
                              >
                                Reset Pass
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ============================================================== */}
          {/* TAB 3: DEPARTMENTS                                             */}
          {/* ============================================================== */}
          {activeTab === 'departments' && (
            <div className="cd-view">
              <div className="cd-view__header">
                <div>
                  <h2 className="cd-view__title">Department Management</h2>
                  <p className="cd-view__subtitle">Organize college academic departments, assign HODs, and monitor intake capacities.</p>
                </div>
                <button type="button" className="cd-btn cd-btn--primary" onClick={() => setShowAddDeptModal(true)}>
                  + Add Department
                </button>
              </div>

              <div className="cd-card-grid">
                {departments.map((dept) => (
                  <div key={dept._id} className="cd-dept-card">
                    <div className="cd-dept-card__header">
                      <h3>{dept.name}</h3>
                      <span className="cd-code-badge">{dept.code}</span>
                    </div>
                    <p className="cd-dept-card__desc">{dept.description || 'No description provided.'}</p>
                    <div className="cd-dept-card__meta">
                      <div><strong>HOD:</strong> {dept.headOfDepartment || 'Unassigned'}</div>
                      <div><strong>Intake Capacity:</strong> {dept.intakeCapacity || 60} students</div>
                      <div><strong>Current Students:</strong> {dept.studentCount || 0}</div>
                      <div><strong>Batches:</strong> {dept.batchCount || 0} · <strong>Faculty:</strong> {dept.facultyCount || 0}</div>
                    </div>
                    <div className="cd-dept-card__actions">
                      <button type="button" className="cd-btn cd-btn--sm cd-btn--secondary" onClick={() => setEditingDept(dept)}>Edit</button>
                      <button type="button" className="cd-btn cd-btn--sm cd-btn--danger" onClick={() => handleDeleteDept(dept)}>Delete</button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ============================================================== */}
          {/* TAB 4: BATCHES                                                 */}
          {/* ============================================================== */}
          {activeTab === 'batches' && (
            <div className="cd-view">
              <div className="cd-view__header">
                <div>
                  <h2 className="cd-view__title">Batch Management</h2>
                  <p className="cd-view__subtitle">Track academic cohorts, department allocations, and current semesters.</p>
                </div>
                <button type="button" className="cd-btn cd-btn--primary" onClick={() => setShowAddBatchModal(true)}>
                  + Create Batch
                </button>
              </div>

              <div className="cd-table-container">
                <table className="cd-table">
                  <thead>
                    <tr>
                      <th>Batch Name</th>
                      <th>Academic Year</th>
                      <th>Department</th>
                      <th>Semester</th>
                      <th>Students</th>
                      <th>Status</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {batches.map((b) => (
                      <tr key={b._id}>
                        <td><strong>{b.name}</strong></td>
                        <td>{b.academicYear || '—'}</td>
                        <td>{b.department || '—'}</td>
                        <td>{b.semester || 'Sem 1'}</td>
                        <td><span className="cd-pill cd-pill--neutral">{b.studentCount || 0} Students</span></td>
                        <td><span className="cd-pill cd-pill--success">{b.status}</span></td>
                        <td>
                          <button type="button" className="cd-btn cd-btn--sm cd-btn--danger" onClick={() => handleDeleteBatch(b)}>
                            Delete
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ============================================================== */}
          {/* TAB 5: SEMESTERS                                               */}
          {/* ============================================================== */}
          {activeTab === 'semesters' && (
            <div className="cd-view">
              <div className="cd-view__header">
                <div>
                  <h2 className="cd-view__title">Semester Management</h2>
                  <p className="cd-view__subtitle">Define academic terms, curriculum subjects, and active semester cycles.</p>
                </div>
                <button type="button" className="cd-btn cd-btn--primary" onClick={() => setShowAddSemesterModal(true)}>
                  + Add Semester
                </button>
              </div>

              <div className="cd-card-grid">
                {semesters.map((sem) => (
                  <div key={sem._id} className="cd-sem-card">
                    <div className="cd-sem-card__header">
                      <h3>{sem.name}</h3>
                      {sem.isCurrent && <span className="cd-pill cd-pill--success">Current Term</span>}
                    </div>
                    <div className="cd-sem-card__meta">
                      <div><strong>Academic Year:</strong> {sem.academicYear || '2026-2027'}</div>
                      <div><strong>Department:</strong> {sem.department || 'General'}</div>
                      <div><strong>Dates:</strong> {formatDate(sem.startDate)} – {formatDate(sem.endDate)}</div>
                      <div><strong>Subjects:</strong> {sem.subjects?.length || 0} registered</div>
                    </div>
                    <div className="cd-sem-card__actions">
                      <button type="button" className="cd-btn cd-btn--sm cd-btn--danger" onClick={() => handleDeleteSemester(sem._id)}>
                        Remove
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ============================================================== */}
          {/* TAB 6: COURSES & ASSIGNMENTS                                   */}
          {/* ============================================================== */}
          {activeTab === 'courses' && (
            <div className="cd-view">
              <div className="cd-view__header">
                <div>
                  <h2 className="cd-view__title">Course Catalog & Allocation</h2>
                  <p className="cd-view__subtitle">Assign LMS courses to departments, batches, or individual students.</p>
                </div>
                <button type="button" className="cd-btn cd-btn--primary" onClick={() => setShowAssignCourseModal(true)}>
                  + Assign Course
                </button>
              </div>

              <div className="cd-card-grid">
                {courses.map((course) => (
                  <div key={course._id} className="cd-course-card">
                    <h3>{course.title}</h3>
                    <p className="cd-course-desc">{course.description || 'Comprehensive curriculum modules.'}</p>
                    <div className="cd-course-meta">
                      <div><strong>Enrolled Students:</strong> {course.enrolledStudentsCount || 0}</div>
                      <div><strong>Completed:</strong> {course.completedCount || 0}</div>
                      <div><strong>Avg Progress:</strong> {course.averageProgress || 0}%</div>
                    </div>
                    <div className="cd-course-progress-bar">
                      <div className="cd-course-progress-fill" style={{ width: `${course.averageProgress || 0}%` }} />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ============================================================== */}
          {/* TAB 7: FACULTY MANAGEMENT                                      */}
          {/* ============================================================== */}
          {activeTab === 'faculty' && (
            <div className="cd-view">
              <div className="cd-view__header">
                <div>
                  <h2 className="cd-view__title">Faculty Management</h2>
                  <p className="cd-view__subtitle">Manage college faculty profiles, designations, and workload hours.</p>
                </div>
                <button type="button" className="cd-btn cd-btn--primary" onClick={() => setShowAddFacultyModal(true)}>
                  + Add Faculty Profile
                </button>
              </div>

              <div className="cd-table-container">
                <table className="cd-table">
                  <thead>
                    <tr>
                      <th>Faculty Member</th>
                      <th>Faculty ID</th>
                      <th>Department</th>
                      <th>Designation</th>
                      <th>Workload</th>
                      <th>Status</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {facultyList.length === 0 ? (
                      <tr><td colSpan="7" className="cd-empty-td">No faculty members registered yet.</td></tr>
                    ) : (
                      facultyList.map((f) => (
                        <tr key={f._id}>
                          <td>
                            <strong>{f.fullName}</strong>
                            <div className="cd-user-sub">{f.email} · {f.phone || 'No phone'}</div>
                          </td>
                          <td><code>{f.facultyId}</code></td>
                          <td>{f.department}</td>
                          <td>{f.designation}</td>
                          <td>{f.workloadHours || 16} hrs/week</td>
                          <td><span className="cd-pill cd-pill--success">{f.status}</span></td>
                          <td>
                            <button type="button" className="cd-btn cd-btn--sm cd-btn--danger" onClick={() => handleDeleteFaculty(f._id)}>
                              Remove
                            </button>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ============================================================== */}
          {/* TAB 8: ACADEMIC CALENDAR                                       */}
          {/* ============================================================== */}
          {activeTab === 'calendar' && (
            <div className="cd-view">
              <div className="cd-view__header">
                <div>
                  <h2 className="cd-view__title">Academic Calendar & Events</h2>
                  <p className="cd-view__subtitle">Track institutional exams, holidays, workshops, and assignment deadlines.</p>
                </div>
                <button type="button" className="cd-btn cd-btn--primary" onClick={() => setShowAddEventModal(true)}>
                  + Add Event
                </button>
              </div>

              <div className="cd-calendar-grid">
                {calendarEvents.map((evt) => (
                  <div key={evt._id} className={`cd-cal-card ${evt.isHoliday ? 'is-holiday' : ''}`}>
                    <div className="cd-cal-card__badge">{evt.eventType?.toUpperCase()}</div>
                    <h3>{evt.title}</h3>
                    <p>{evt.description}</p>
                    <div className="cd-cal-card__meta">
                      <div>📅 {formatDate(evt.startDate)} – {formatDate(evt.endDate)}</div>
                      {evt.venue && <div>📍 {evt.venue}</div>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ============================================================== */}
          {/* TAB 9: ATTENDANCE MANAGEMENT                                   */}
          {/* ============================================================== */}
          {activeTab === 'attendance' && (
            <div className="cd-view">
              <div className="cd-view__header">
                <div>
                  <h2 className="cd-view__title">Attendance Management</h2>
                  <p className="cd-view__subtitle">Daily roll call, subject attendance, percentage tracking, and low-attendance warnings.</p>
                </div>
                <div className="cd-view__actions">
                  <button type="button" className="cd-btn cd-btn--primary" onClick={() => setShowMarkAttendanceModal(true)}>
                    + Take Daily Attendance
                  </button>
                  <button type="button" className="cd-btn cd-btn--secondary" onClick={handleExportAttendance}>
                    📥 Export Attendance CSV
                  </button>
                </div>
              </div>

              {/* Attendance Statistics Banner */}
              <div className="cd-kpi-grid">
                <div className="cd-kpi-card">
                  <span className="cd-kpi-card__label">Average Attendance</span>
                  <div className="cd-kpi-card__value">{attendanceStats?.overallPercentage || 0}%</div>
                </div>
                <div className="cd-kpi-card">
                  <span className="cd-kpi-card__label">Total Recorded Sessions</span>
                  <div className="cd-kpi-card__value">{attendanceStats?.totalSessionsRecorded || 0}</div>
                </div>
                <div className="cd-kpi-card cd-kpi-card--highlight">
                  <span className="cd-kpi-card__label">Low Attendance Warning (&lt;75%)</span>
                  <div className="cd-kpi-card__value cd-kpi-card__value--danger">
                    {attendanceStats?.lowAttendanceCount || 0} Student(s)
                  </div>
                </div>
              </div>

              {/* Low Attendance Warning List */}
              {attendanceStats?.lowAttendanceStudents?.length > 0 && (
                <div className="cd-card cd-card--warning">
                  <h3 className="cd-card__title">⚠️ Students Below 75% Attendance Requirement</h3>
                  <div className="cd-table-container">
                    <table className="cd-table">
                      <thead>
                        <tr>
                          <th>Student Name</th>
                          <th>Roll No</th>
                          <th>Department</th>
                          <th>Batch</th>
                          <th>Attendance %</th>
                          <th>Action</th>
                        </tr>
                      </thead>
                      <tbody>
                        {attendanceStats.lowAttendanceStudents.slice(0, 10).map((s) => (
                          <tr key={s.studentId}>
                            <td><strong>{s.studentName}</strong></td>
                            <td><code>{s.studentRollNo}</code></td>
                            <td>{s.department}</td>
                            <td>{s.batch}</td>
                            <td><span className="cd-pill cd-pill--danger">{s.rate}%</span></td>
                            <td>
                              <button type="button" className="cd-btn cd-btn--sm cd-btn--secondary" onClick={() => openStudent360(s.studentId)}>
                                View 360°
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* Past Attendance Sessions */}
              <h3 className="cd-section-title">Recorded Sessions</h3>
              <div className="cd-table-container">
                <table className="cd-table">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Department</th>
                      <th>Batch</th>
                      <th>Subject</th>
                      <th>Taken By</th>
                      <th>Present Count</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {attendanceSessions.map((s) => {
                      const present = s.records?.filter((r) => r.status === 'present' || r.status === 'late')?.length || 0
                      const total = s.records?.length || 0
                      return (
                        <tr key={s._id}>
                          <td><strong>{formatDate(s.date)}</strong></td>
                          <td>{s.department}</td>
                          <td>{s.batch}</td>
                          <td>{s.subject}</td>
                          <td>{s.takenBy}</td>
                          <td>{present} / {total} ({total > 0 ? Math.round((present / total) * 100) : 0}%)</td>
                          <td>
                            <button type="button" className="cd-btn cd-btn--sm cd-btn--secondary" onClick={() => setShowCorrectionModal(s)}>
                              Audit / Correct
                            </button>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ============================================================== */}
          {/* TAB 10: LEARNING ANALYTICS & AI INSIGHTS                       */}
          {/* ============================================================== */}
          {activeTab === 'analytics' && (
            <div className="cd-view">
              <div className="cd-view__header">
                <div>
                  <h2 className="cd-view__title">Learning Analytics & Academic Insights</h2>
                  <p className="cd-view__subtitle">At-risk identification, department comparisons, and curriculum recommendations.</p>
                </div>
              </div>

              {/* AI Assisted Academic Insights Panel */}
              {aiInsights && (
                <div className="cd-ai-insights-panel">
                  <div className="cd-ai-insights-panel__header">
                    <h3>✨ AI-Assisted Academic Insights</h3>
                    <span className="cd-ai-badge">Verified Backend Analysis</span>
                  </div>
                  <p className="cd-ai-disclaimer">{aiInsights.disclaimer}</p>
                  <div className="cd-ai-insights-grid">
                    <div className="cd-ai-box">
                      <h4>Attendance Alerts ({aiInsights.insights?.lowAttendanceAlerts?.count || 0})</h4>
                      <p>{aiInsights.insights?.lowAttendanceAlerts?.actionRecommendation}</p>
                    </div>
                    <div className="cd-ai-box">
                      <h4>Curriculum Recommendations</h4>
                      <ul>
                        {aiInsights.insights?.curriculumRecommendations?.map((rec, i) => (
                          <li key={i}>{rec}</li>
                        ))}
                      </ul>
                    </div>
                  </div>
                </div>
              )}

              {/* Department Comparison Table */}
              <div className="cd-card">
                <h3 className="cd-card__title">Department Learning Performance</h3>
                <div className="cd-table-container">
                  <table className="cd-table">
                    <thead>
                      <tr>
                        <th>Department</th>
                        <th>Code</th>
                        <th>Student Count</th>
                        <th>Average LMS Progress</th>
                        <th>Completed Enrollments</th>
                      </tr>
                    </thead>
                    <tbody>
                      {analytics?.deptStats?.map((d) => (
                        <tr key={d.code}>
                          <td><strong>{d.department}</strong></td>
                          <td><code>{d.code}</code></td>
                          <td>{d.studentCount}</td>
                          <td>
                            <div className="cd-table-bar">
                              <div className="cd-table-bar-fill" style={{ width: `${d.avgProgress}%` }} />
                              <span>{d.avgProgress}%</span>
                            </div>
                          </td>
                          <td>{d.completedCount}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {/* ============================================================== */}
          {/* TAB 11: EXAMINATIONS                                           */}
          {/* ============================================================== */}
          {activeTab === 'examinations' && (
            <div className="cd-view">
              <div className="cd-view__header">
                <div>
                  <h2 className="cd-view__title">Examination Management</h2>
                  <p className="cd-view__subtitle">Schedule internal assessments, midterm, and final examinations.</p>
                </div>
                <button type="button" className="cd-btn cd-btn--primary" onClick={() => setShowCreateExamModal(true)}>
                  + Schedule Examination
                </button>
              </div>

              <div className="cd-table-container">
                <table className="cd-table">
                  <thead>
                    <tr>
                      <th>Exam Title</th>
                      <th>Type</th>
                      <th>Department & Subject</th>
                      <th>Dates</th>
                      <th>Passing Marks</th>
                      <th>Results Entered</th>
                      <th>Pass %</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {examinations.map((exam) => (
                      <tr key={exam._id}>
                        <td><strong>{exam.title}</strong></td>
                        <td><span className="cd-pill cd-pill--neutral">{exam.examType}</span></td>
                        <td>{exam.department} · {exam.subject || 'General'}</td>
                        <td>{formatDate(exam.startDate)}</td>
                        <td>{exam.passingMarks} / {exam.maxMarks}</td>
                        <td>{exam.resultsCount || 0}</td>
                        <td>{exam.passPercentage || 0}%</td>
                        <td>
                          <button type="button" className="cd-btn cd-btn--sm cd-btn--primary" onClick={() => setShowEnterMarksModal(exam)}>
                            Enter Marks
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ============================================================== */}
          {/* TAB 12: RESULTS & REPORT CARDS                                 */}
          {/* ============================================================== */}
          {activeTab === 'results' && (
            <div className="cd-view">
              <div className="cd-view__header">
                <div>
                  <h2 className="cd-view__title">Examination Results & Report Cards</h2>
                  <p className="cd-view__subtitle">View student grades, backlogs, and generate downloadable report cards.</p>
                </div>
                <button type="button" className="cd-btn cd-btn--secondary" onClick={() => handleExportReport('examinations')}>
                  📥 Export Results CSV
                </button>
              </div>

              <div className="cd-table-container">
                <table className="cd-table">
                  <thead>
                    <tr>
                      <th>Student Name</th>
                      <th>Roll No</th>
                      <th>Department</th>
                      <th>CGPA</th>
                      <th>Standing</th>
                      <th>Report Card</th>
                    </tr>
                  </thead>
                  <tbody>
                    {studentsData.students?.map((s) => (
                      <tr key={s._id}>
                        <td><strong>{s.fullName}</strong></td>
                        <td><code>{s.studentId}</code></td>
                        <td>{s.department}</td>
                        <td><strong>{s.cgpa || 0}</strong></td>
                        <td><span className="cd-pill cd-pill--neutral">{s.academicStanding || 'good'}</span></td>
                        <td>
                          <button type="button" className="cd-btn cd-btn--sm cd-btn--primary" onClick={() => openReportCard(s._id)}>
                            View Report Card
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ============================================================== */}
          {/* TAB 13: PLACEMENTS & INTERNSHIPS                               */}
          {/* ============================================================== */}
          {(activeTab === 'placements' || activeTab === 'internships') && (
            <div className="cd-view">
              <div className="cd-view__header">
                <div>
                  <h2 className="cd-view__title">
                    {activeTab === 'internships' ? 'Internship Opportunities' : 'Campus Placements & Drives'}
                  </h2>
                  <p className="cd-view__subtitle">Track visiting companies, eligibility criteria, applications, and placement packages.</p>
                </div>
                <button type="button" className="cd-btn cd-btn--primary" onClick={() => setShowCreatePlacementModal(true)}>
                  + Announce Drive
                </button>
              </div>

              {/* Placement KPIs */}
              <div className="cd-kpi-grid">
                <div className="cd-kpi-card">
                  <span className="cd-kpi-card__label">Placed Students</span>
                  <div className="cd-kpi-card__value">{placementStats?.totalPlaced || 0}</div>
                  <span className="cd-pill cd-pill--success">{placementStats?.placementPercentage || 0}% Success</span>
                </div>
                <div className="cd-kpi-card">
                  <span className="cd-kpi-card__label">Highest Package</span>
                  <div className="cd-kpi-card__value">{placementStats?.highestPackage || 0} LPA</div>
                </div>
                <div className="cd-kpi-card">
                  <span className="cd-kpi-card__label">Active Drives</span>
                  <div className="cd-kpi-card__value">{placementDrives.length}</div>
                </div>
              </div>

              {/* Drives List */}
              <div className="cd-card-grid">
                {placementDrives.map((d) => (
                  <div key={d._id} className="cd-placement-card">
                    <div className="cd-placement-card__header">
                      <h3>{d.companyName}</h3>
                      <span className="cd-pill cd-pill--primary">{d.opportunityType}</span>
                    </div>
                    <h4>{d.jobTitle}</h4>
                    <div className="cd-placement-card__meta">
                      <div>💰 <strong>Package:</strong> {d.packageLpa || 0} LPA {d.stipendMonthly ? `· ₹${d.stipendMonthly}/mo` : ''}</div>
                      <div>🎯 <strong>Min CGPA:</strong> {d.minCgpa || 6.0} · <strong>Max Backlogs:</strong> {d.maxBacklogs || 0}</div>
                      <div>⏳ <strong>Deadline:</strong> {formatDate(d.deadline)}</div>
                      <div>👥 <strong>Applicants:</strong> {d.totalApplicants || 0} ({d.placedCount || 0} Placed)</div>
                    </div>
                    <div className="cd-placement-card__actions">
                      <button type="button" className="cd-btn cd-btn--sm cd-btn--primary" onClick={() => setShowApplyPlacementModal(d)}>
                        Register Student
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ============================================================== */}
          {/* TAB 14: ACHIEVEMENTS & LEADERBOARD                             */}
          {/* ============================================================== */}
          {activeTab === 'achievements' && (
            <div className="cd-view">
              <div className="cd-view__header">
                <div>
                  <h2 className="cd-view__title">Student Leaderboard & Achievements</h2>
                  <p className="cd-view__subtitle">Institutional ranking by academic performance, courses completed, and merit badges.</p>
                </div>
              </div>

              <div className="cd-table-container">
                <table className="cd-table">
                  <thead>
                    <tr>
                      <th>Rank</th>
                      <th>Student</th>
                      <th>Department & Batch</th>
                      <th>CGPA</th>
                      <th>Completed Courses</th>
                      <th>Achievements</th>
                      <th>Merit Points</th>
                    </tr>
                  </thead>
                  <tbody>
                    {leaderboard.map((item, idx) => (
                      <tr key={item.id}>
                        <td>
                          <span className={`cd-rank-badge ${idx === 0 ? 'rank-1' : idx === 1 ? 'rank-2' : idx === 2 ? 'rank-3' : ''}`}>
                            #{idx + 1}
                          </span>
                        </td>
                        <td><strong>{item.fullName}</strong></td>
                        <td>{item.department} ({item.batch})</td>
                        <td><strong>{item.cgpa}</strong></td>
                        <td>{item.completedCourses}</td>
                        <td>{item.achievementsCount}</td>
                        <td><span className="cd-pill cd-pill--success">{item.points} pts</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ============================================================== */}
          {/* TAB 15: AI COLLEGE ASSISTANT                                   */}
          {/* ============================================================== */}
          {activeTab === 'ai-assistant' && (
            <div className="cd-view cd-ai-view">
              <div className="cd-view__header">
                <div>
                  <h2 className="cd-view__title">AI College ERP Assistant</h2>
                  <p className="cd-view__subtitle">Ask natural language questions about your college's students, batches, attendance, and performance.</p>
                </div>
              </div>

              {/* Prompt Suggestion Chips */}
              <div className="cd-prompt-chips">
                <button
                  type="button"
                  className="cd-chip"
                  onClick={() => handleSendAiPrompt('Which students have attendance below 75%?')}
                >
                  Which students have attendance below 75%?
                </button>
                <button
                  type="button"
                  className="cd-chip"
                  onClick={() => handleSendAiPrompt('Which batch has the highest course completion?')}
                >
                  Which batch has the highest course completion?
                </button>
                <button
                  type="button"
                  className="cd-chip"
                  onClick={() => handleSendAiPrompt('Generate a weekly academic summary for our college')}
                >
                  Generate weekly academic summary
                </button>
                <button
                  type="button"
                  className="cd-chip"
                  onClick={() => handleSendAiPrompt('Show department-wise student statistics')}
                >
                  Department-wise student statistics
                </button>
                <button
                  type="button"
                  className="cd-chip"
                  onClick={() => handleSendAiPrompt('Show our campus placement statistics')}
                >
                  Campus placement statistics
                </button>
              </div>

              {/* Chat Thread */}
              <div className="cd-chat-thread">
                {aiChatHistory.map((msg, i) => (
                  <div key={i} className={`cd-chat-msg cd-chat-msg--${msg.role}`}>
                    <div className="cd-chat-avatar">{msg.role === 'assistant' ? '✨' : '👤'}</div>
                    <div className="cd-chat-bubble">
                      <div className="cd-chat-text" style={{ whiteSpace: 'pre-wrap' }}>{msg.text}</div>
                      <span className="cd-chat-time">{new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                    </div>
                  </div>
                ))}
                {isAiLoading && (
                  <div className="cd-chat-msg cd-chat-msg--assistant">
                    <div className="cd-chat-avatar">✨</div>
                    <div className="cd-chat-bubble">
                      <div className="cd-typing-indicator"><span>.</span><span>.</span><span>.</span></div>
                    </div>
                  </div>
                )}
              </div>

              {/* Query Input Bar */}
              <div className="cd-chat-input-bar">
                <input
                  type="text"
                  placeholder="Ask a question about your students, attendance, or courses..."
                  className="cd-input cd-chat-input"
                  value={aiPrompt}
                  onChange={(e) => setAiPrompt(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleSendAiPrompt()}
                />
                <button
                  type="button"
                  className="cd-btn cd-btn--primary"
                  onClick={() => handleSendAiPrompt()}
                  disabled={isAiLoading || !aiPrompt.trim()}
                >
                  Ask
                </button>
              </div>
            </div>
          )}

          {/* ============================================================== */}
          {/* TAB 16: REPORTS & DOCUMENTS                                    */}
          {/* ============================================================== */}
          {(activeTab === 'reports' || activeTab === 'documents') && (
            <div className="cd-view">
              <div className="cd-view__header">
                <div>
                  <h2 className="cd-view__title">Institutional Reports & Document Repository</h2>
                  <p className="cd-view__subtitle">Export official CSV data and manage NAAC/NBA documentation.</p>
                </div>
                <button type="button" className="cd-btn cd-btn--primary" onClick={() => setShowUploadDocModal(true)}>
                  + Upload Document
                </button>
              </div>

              {/* Reports Export Cards */}
              <div className="cd-kpi-grid">
                <div className="cd-kpi-card">
                  <span className="cd-kpi-card__label">Students Directory Report</span>
                  <button type="button" className="cd-btn cd-btn--secondary cd-btn--sm" onClick={() => handleExportReport('students')}>
                    📥 Export CSV
                  </button>
                </div>
                <div className="cd-kpi-card">
                  <span className="cd-kpi-card__label">Attendance Log Report</span>
                  <button type="button" className="cd-btn cd-btn--secondary cd-btn--sm" onClick={() => handleExportReport('attendance')}>
                    📥 Export CSV
                  </button>
                </div>
                <div className="cd-kpi-card">
                  <span className="cd-kpi-card__label">Examinations Report</span>
                  <button type="button" className="cd-btn cd-btn--secondary cd-btn--sm" onClick={() => handleExportReport('examinations')}>
                    📥 Export CSV
                  </button>
                </div>
                <div className="cd-kpi-card">
                  <span className="cd-kpi-card__label">Placements Report</span>
                  <button type="button" className="cd-btn cd-btn--secondary cd-btn--sm" onClick={() => handleExportReport('placements')}>
                    📥 Export CSV
                  </button>
                </div>
              </div>

              {/* Documents Repository Table */}
              <h3 className="cd-section-title">Institutional Documents</h3>
              <div className="cd-table-container">
                <table className="cd-table">
                  <thead>
                    <tr>
                      <th>Document Title</th>
                      <th>Category</th>
                      <th>File Name</th>
                      <th>Uploaded By</th>
                      <th>Uploaded At</th>
                    </tr>
                  </thead>
                  <tbody>
                    {documents.map((doc) => (
                      <tr key={doc._id}>
                        <td><strong>{doc.title}</strong></td>
                        <td><span className="cd-pill cd-pill--neutral">{doc.category}</span></td>
                        <td><code>{doc.fileName}</code></td>
                        <td>{doc.uploadedBy}</td>
                        <td>{formatDate(doc.createdAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ============================================================== */}
          {/* TAB 17: NOTIFICATIONS & ANNOUNCEMENTS                          */}
          {/* ============================================================== */}
          {activeTab === 'notifications' && (
            <div className="cd-view">
              <div className="cd-view__header">
                <div>
                  <h2 className="cd-view__title">Notifications & Announcements</h2>
                  <p className="cd-view__subtitle">Broadcast messages and inspect platform alerts.</p>
                </div>
                <div className="cd-view__actions">
                  <button type="button" className="cd-btn cd-btn--primary" onClick={() => setShowBroadcastModal(true)}>
                    + Broadcast Announcement
                  </button>
                  <button type="button" className="cd-btn cd-btn--secondary" onClick={handleMarkAllNotificationsRead}>
                    Mark All as Read
                  </button>
                </div>
              </div>

              <div className="cd-notifications-list">
                {notifications.map((n) => (
                  <div key={n._id} className={`cd-notif-item ${n.isRead ? 'is-read' : 'is-unread'}`}>
                    <div className="cd-notif-dot" />
                    <div className="cd-notif-body">
                      <h4>{n.title}</h4>
                      <p>{n.message}</p>
                      <span className="cd-notif-time">{formatDate(n.createdAt)}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ============================================================== */}
          {/* TAB 18: SETTINGS & PROFILE                                     */}
          {/* ============================================================== */}
          {activeTab === 'settings' && (
            <div className="cd-view">
              <div className="cd-view__header">
                <div>
                  <h2 className="cd-view__title">College Profile & Security Settings</h2>
                  <p className="cd-view__subtitle">Manage institution metadata and administrative password.</p>
                </div>
              </div>

              <div className="cd-grid-two">
                <div className="cd-card">
                  <h3 className="cd-card__title">Institution Details</h3>
                  <form onSubmit={handleUpdateProfile} className="cd-form">
                    <div className="cd-form-row">
                      <label>College Code</label>
                      <input type="text" className="cd-input" value={profileData?.college?.code || ''} disabled />
                    </div>
                    <div className="cd-form-row">
                      <label>Contact Name</label>
                      <input type="text" name="contactName" className="cd-input" defaultValue={profileData?.college?.contactName || ''} />
                    </div>
                    <div className="cd-form-row">
                      <label>Contact Email</label>
                      <input type="email" name="contactEmail" className="cd-input" defaultValue={profileData?.college?.contactEmail || ''} />
                    </div>
                    <div className="cd-form-row">
                      <label>Contact Phone</label>
                      <input type="text" name="contactPhone" className="cd-input" defaultValue={profileData?.college?.contactPhone || ''} />
                    </div>
                    <div className="cd-form-row">
                      <label>City & State</label>
                      <div className="cd-form-split">
                        <input type="text" name="city" placeholder="City" className="cd-input" defaultValue={profileData?.college?.city || ''} />
                        <input type="text" name="state" placeholder="State" className="cd-input" defaultValue={profileData?.college?.state || ''} />
                      </div>
                    </div>
                    <button type="submit" className="cd-btn cd-btn--primary">Save Changes</button>
                  </form>
                </div>

                <div className="cd-card">
                  <h3 className="cd-card__title">Change Admin Password</h3>
                  <form onSubmit={handleChangePassword} className="cd-form">
                    <div className="cd-form-row">
                      <label>Current Password</label>
                      <input type="password" name="currentPassword" required className="cd-input" />
                    </div>
                    <div className="cd-form-row">
                      <label>New Password</label>
                      <input type="password" name="newPassword" required minLength="8" className="cd-input" />
                    </div>
                    <div className="cd-form-row">
                      <label>Confirm New Password</label>
                      <input type="password" name="confirmPassword" required minLength="8" className="cd-input" />
                    </div>
                    <button type="submit" className="cd-btn cd-btn--primary">Update Password</button>
                  </form>
                </div>
              </div>
            </div>
          )}
        </main>
      </div>

      {/* ============================================================== */}
      {/* MODALS                                                         */}
      {/* ============================================================== */}

      {/* 1. Student 360° Profile Modal */}
      {student360Modal && (
        <div className="cd-modal-backdrop" onClick={() => setStudent360Modal(null)}>
          <div className="cd-modal cd-modal--large" onClick={(e) => e.stopPropagation()}>
            <div className="cd-modal__header">
              <div>
                <h2>{student360Modal.student.fullName}</h2>
                <span className="cd-modal__sub">
                  Student ID: <code>{student360Modal.student.studentId}</code> · {student360Modal.student.department} ({student360Modal.student.batch})
                </span>
              </div>
              <button type="button" className="cd-modal-close" onClick={() => setStudent360Modal(null)}>✕</button>
            </div>

            {/* Sub-Tabs */}
            <div className="cd-sub-tabs">
              <button
                type="button"
                className={`cd-sub-tab ${student360Tab === 'overview' ? 'is-active' : ''}`}
                onClick={() => setStudent360Tab('overview')}
              >
                Overview & Personal
              </button>
              <button
                type="button"
                className={`cd-sub-tab ${student360Tab === 'attendance' ? 'is-active' : ''}`}
                onClick={() => setStudent360Tab('attendance')}
              >
                Attendance ({student360Modal.attendance.percentage}%)
              </button>
              <button
                type="button"
                className={`cd-sub-tab ${student360Tab === 'courses' ? 'is-active' : ''}`}
                onClick={() => setStudent360Tab('courses')}
              >
                Courses ({student360Modal.courses?.length || 0})
              </button>
              <button
                type="button"
                className={`cd-sub-tab ${student360Tab === 'exams' ? 'is-active' : ''}`}
                onClick={() => setStudent360Tab('exams')}
              >
                Exams & Grades ({student360Modal.examinations?.results?.length || 0})
              </button>
              <button
                type="button"
                className={`cd-sub-tab ${student360Tab === 'placements' ? 'is-active' : ''}`}
                onClick={() => setStudent360Tab('placements')}
              >
                Career & Placements
              </button>
            </div>

            <div className="cd-modal__body">
              {student360Tab === 'overview' && (
                <div className="cd-360-grid">
                  <div className="cd-360-info-card">
                    <h4>Personal Information</h4>
                    <p><strong>Email:</strong> {student360Modal.student.email}</p>
                    <p><strong>Phone:</strong> {student360Modal.student.phone}</p>
                    <p><strong>Gender:</strong> {student360Modal.student.gender}</p>
                    <p><strong>Blood Group:</strong> {student360Modal.student.bloodGroup}</p>
                    <p><strong>Guardian:</strong> {student360Modal.student.guardianName} ({student360Modal.student.guardianPhone})</p>
                    <p><strong>Address:</strong> {student360Modal.student.address}</p>
                  </div>
                  <div className="cd-360-info-card">
                    <h4>Academic Metrics</h4>
                    <p><strong>Semester:</strong> {student360Modal.student.semester}</p>
                    <p><strong>CGPA:</strong> {student360Modal.student.cgpa}</p>
                    <p><strong>Academic Standing:</strong> <span className="cd-pill cd-pill--neutral">{student360Modal.student.academicStanding}</span></p>
                    <p><strong>Backlogs:</strong> {student360Modal.examinations?.backlogsCount || 0}</p>
                    <p><strong>Placement Status:</strong> <span className="cd-pill cd-pill--success">{student360Modal.student.placementStatus}</span></p>
                  </div>
                </div>
              )}

              {student360Tab === 'attendance' && (
                <div>
                  <div className="cd-kpi-card" style={{ marginBottom: 16 }}>
                    <span className="cd-kpi-card__label">Attendance Rate</span>
                    <div className="cd-kpi-card__value">{student360Modal.attendance.percentage}%</div>
                    <span>{student360Modal.attendance.attendedSessions} out of {student360Modal.attendance.totalSessions} sessions attended</span>
                  </div>
                  <table className="cd-table">
                    <thead>
                      <tr><th>Date</th><th>Subject</th><th>Batch</th><th>Status</th></tr>
                    </thead>
                    <tbody>
                      {student360Modal.attendance.history?.map((h, i) => (
                        <tr key={i}>
                          <td>{formatDate(h.date)}</td>
                          <td>{h.subject}</td>
                          <td>{h.batch}</td>
                          <td><span className={`cd-pill cd-pill--${h.status === 'present' ? 'success' : 'danger'}`}>{h.status}</span></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {student360Tab === 'courses' && (
                <div className="cd-card-grid">
                  {student360Modal.courses?.map((c, i) => (
                    <div key={i} className="cd-course-card">
                      <h4>{c.title}</h4>
                      <p>Status: <span className="cd-pill cd-pill--neutral">{c.status}</span></p>
                      <div className="cd-table-bar" style={{ marginTop: 8 }}>
                        <div className="cd-table-bar-fill" style={{ width: `${c.progressPercentage}%` }} />
                        <span>{c.progressPercentage}%</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {student360Tab === 'exams' && (
                <table className="cd-table">
                  <thead>
                    <tr><th>Exam</th><th>Subject</th><th>Score</th><th>Grade</th><th>Result</th></tr>
                  </thead>
                  <tbody>
                    {student360Modal.examinations?.results?.map((r, i) => (
                      <tr key={i}>
                        <td>{r.examTitle}</td>
                        <td>{r.subject}</td>
                        <td>{r.marksObtained} / {r.maxMarks}</td>
                        <td><strong>{r.grade}</strong></td>
                        <td><span className={`cd-pill cd-pill--${r.isPass ? 'success' : 'danger'}`}>{r.isPass ? 'Passed' : 'Backlog'}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              {student360Tab === 'placements' && (
                <div>
                  <p><strong>Current Status:</strong> {student360Modal.student.placementStatus?.toUpperCase()}</p>
                  {student360Modal.student.placedCompany && (
                    <p><strong>Placed Company:</strong> {student360Modal.student.placedCompany} (Package: {student360Modal.student.placementPackage} LPA)</p>
                  )}
                  <h4 style={{ marginTop: 16 }}>Drive Applications</h4>
                  <table className="cd-table">
                    <thead>
                      <tr><th>Company</th><th>Role</th><th>Type</th><th>Status</th></tr>
                    </thead>
                    <tbody>
                      {student360Modal.placements?.map((p, i) => (
                        <tr key={i}>
                          <td>{p.companyName}</td>
                          <td>{p.jobTitle}</td>
                          <td>{p.opportunityType}</td>
                          <td><span className="cd-pill cd-pill--primary">{p.status}</span></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* 2. Add Student Modal */}
      {showAddStudentModal && (
        <div className="cd-modal-backdrop" onClick={() => setShowAddStudentModal(false)}>
          <div className="cd-modal" onClick={(e) => e.stopPropagation()}>
            <div className="cd-modal__header">
              <h2>Add Student</h2>
              <button type="button" className="cd-modal-close" onClick={() => setShowAddStudentModal(false)}>✕</button>
            </div>
            <form onSubmit={handleAddStudent} className="cd-form">
              <div className="cd-form-row">
                <label>Full Name *</label>
                <input type="text" name="fullName" required className="cd-input" />
              </div>
              <div className="cd-form-row">
                <label>Email Address *</label>
                <input type="email" name="email" required className="cd-input" />
              </div>
              <div className="cd-form-row">
                <label>Student ID / Roll No (leave blank to auto-generate)</label>
                <input type="text" name="studentId" placeholder="e.g. STU-2026-001" className="cd-input" />
              </div>
              <div className="cd-form-row">
                <label>Department</label>
                <select name="department" className="cd-select">
                  <option value="">Select Department</option>
                  {departments.map((d) => (
                    <option key={d._id} value={d.name}>{d.name}</option>
                  ))}
                </select>
              </div>
              <div className="cd-form-row">
                <label>Batch</label>
                <select name="batch" className="cd-select">
                  <option value="">Select Batch</option>
                  {batches.map((b) => (
                    <option key={b._id} value={b.name}>{b.name}</option>
                  ))}
                </select>
              </div>
              <div className="cd-form-row">
                <label>Password (leave blank for secure auto-generation)</label>
                <input type="text" name="password" placeholder="Min 8 characters" className="cd-input" />
              </div>
              <button type="submit" className="cd-btn cd-btn--primary" disabled={isActionLoading}>
                {isActionLoading ? 'Creating Student...' : 'Create Student'}
              </button>
            </form>
          </div>
        </div>
      )}

      {/* 3. Bulk Import CSV Modal */}
      {showBulkUploadModal && (
        <div className="cd-modal-backdrop" onClick={() => setShowBulkUploadModal(false)}>
          <div className="cd-modal" onClick={(e) => e.stopPropagation()}>
            <div className="cd-modal__header">
              <h2>Bulk Import Students via CSV</h2>
              <button type="button" className="cd-modal-close" onClick={() => setShowBulkUploadModal(false)}>✕</button>
            </div>
            <form onSubmit={handleBulkUpload} className="cd-form">
              <p className="cd-text-muted">
                Paste CSV data including headers: <code>Full Name,Student ID,Email,Department,Batch,Phone</code>
              </p>
              <textarea
                name="csvText"
                rows="8"
                required
                className="cd-input"
                placeholder="Full Name,Student ID,Email,Department,Batch&#10;Aarav Patel,STU-001,aarav@college.edu,Computer Science,2025-2029"
              />
              <button type="submit" className="cd-btn cd-btn--primary" disabled={isActionLoading}>
                {isActionLoading ? 'Importing...' : 'Start Import'}
              </button>
            </form>
          </div>
        </div>
      )}

      {/* 4. Credentials Modal */}
      {credentialsModal && (
        <div className="cd-modal-backdrop" onClick={() => setCredentialsModal(null)}>
          <div className="cd-modal" onClick={(e) => e.stopPropagation()}>
            <div className="cd-modal__header">
              <h2>{credentialsModal.title}</h2>
              <button type="button" className="cd-modal-close" onClick={() => setCredentialsModal(null)}>✕</button>
            </div>
            <div className="cd-modal__body">
              <p>{credentialsModal.note}</p>
              {credentialsModal.password && (
                <div className="cd-cred-box">
                  <p><strong>Username:</strong> <code>{credentialsModal.username}</code></p>
                  <p><strong>Email:</strong> <code>{credentialsModal.email}</code></p>
                  <p><strong>Password:</strong> <code>{credentialsModal.password}</code></p>
                </div>
              )}
              {credentialsModal.bulkList && (
                <div className="cd-table-container" style={{ maxHeight: 240, overflowY: 'auto' }}>
                  <table className="cd-table">
                    <thead><tr><th>Name</th><th>Email</th><th>Password</th></tr></thead>
                    <tbody>
                      {credentialsModal.bulkList.map((c, i) => (
                        <tr key={i}>
                          <td>{c.fullName}</td>
                          <td><code>{c.email}</code></td>
                          <td><code>{c.password}</code></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* 5. Add Department Modal */}
      {showAddDeptModal && (
        <div className="cd-modal-backdrop" onClick={() => setShowAddDeptModal(false)}>
          <div className="cd-modal" onClick={(e) => e.stopPropagation()}>
            <div className="cd-modal__header">
              <h2>Add Department</h2>
              <button type="button" className="cd-modal-close" onClick={() => setShowAddDeptModal(false)}>✕</button>
            </div>
            <form onSubmit={handleAddDept} className="cd-form">
              <div className="cd-form-row">
                <label>Department Name *</label>
                <input type="text" name="name" required placeholder="e.g. Mechanical Engineering" className="cd-input" />
              </div>
              <div className="cd-form-row">
                <label>Department Code *</label>
                <input type="text" name="code" required placeholder="e.g. ME" className="cd-input" />
              </div>
              <div className="cd-form-row">
                <label>Head of Department (HOD)</label>
                <input type="text" name="headOfDepartment" placeholder="e.g. Dr. Jane Smith" className="cd-input" />
              </div>
              <div className="cd-form-row">
                <label>Intake Capacity</label>
                <input type="number" name="intakeCapacity" defaultValue="60" className="cd-input" />
              </div>
              <div className="cd-form-row">
                <label>Description</label>
                <textarea name="description" className="cd-input" rows="3" />
              </div>
              <button type="submit" className="cd-btn cd-btn--primary" disabled={isActionLoading}>Create Department</button>
            </form>
          </div>
        </div>
      )}

      {/* 6. Create Batch Modal */}
      {showAddBatchModal && (
        <div className="cd-modal-backdrop" onClick={() => setShowAddBatchModal(false)}>
          <div className="cd-modal" onClick={(e) => e.stopPropagation()}>
            <div className="cd-modal__header">
              <h2>Create Batch</h2>
              <button type="button" className="cd-modal-close" onClick={() => setShowAddBatchModal(false)}>✕</button>
            </div>
            <form onSubmit={handleAddBatch} className="cd-form">
              <div className="cd-form-row">
                <label>Batch Name *</label>
                <input type="text" name="name" required placeholder="e.g. 2025-2029 CS-A" className="cd-input" />
              </div>
              <div className="cd-form-row">
                <label>Academic Year</label>
                <input type="text" name="academicYear" placeholder="e.g. 2025-2029" className="cd-input" />
              </div>
              <div className="cd-form-row">
                <label>Department</label>
                <select name="department" className="cd-select">
                  <option value="">Select Department</option>
                  {departments.map((d) => (
                    <option key={d._id} value={d.name}>{d.name}</option>
                  ))}
                </select>
              </div>
              <div className="cd-form-row">
                <label>Semester</label>
                <input type="text" name="semester" placeholder="e.g. Semester 1" className="cd-input" />
              </div>
              <button type="submit" className="cd-btn cd-btn--primary" disabled={isActionLoading}>Create Batch</button>
            </form>
          </div>
        </div>
      )}

      {/* 7. Take Daily Attendance Modal */}
      {showMarkAttendanceModal && (
        <div className="cd-modal-backdrop" onClick={() => setShowMarkAttendanceModal(false)}>
          <div className="cd-modal cd-modal--large" onClick={(e) => e.stopPropagation()}>
            <div className="cd-modal__header">
              <h2>Record Daily Attendance</h2>
              <button type="button" className="cd-modal-close" onClick={() => setShowMarkAttendanceModal(false)}>✕</button>
            </div>
            <form onSubmit={handleMarkAttendance} className="cd-form">
              <div className="cd-form-grid">
                <div className="cd-form-row">
                  <label>Department *</label>
                  <select name="department" required className="cd-select">
                    <option value="">Select Department</option>
                    {departments.map((d) => (
                      <option key={d._id} value={d.name}>{d.name}</option>
                    ))}
                  </select>
                </div>
                <div className="cd-form-row">
                  <label>Batch *</label>
                  <select name="batch" required className="cd-select">
                    <option value="">Select Batch</option>
                    {batches.map((b) => (
                      <option key={b._id} value={b.name}>{b.name}</option>
                    ))}
                  </select>
                </div>
                <div className="cd-form-row">
                  <label>Subject *</label>
                  <input type="text" name="subject" required placeholder="e.g. Data Structures" className="cd-input" />
                </div>
                <div className="cd-form-row">
                  <label>Date *</label>
                  <input type="date" name="date" defaultValue={new Date().toISOString().slice(0, 10)} required className="cd-input" />
                </div>
              </div>

              <div className="cd-students-roster-preview" style={{ maxHeight: 260, overflowY: 'auto' }}>
                <table className="cd-table">
                  <thead><tr><th>Student</th><th>Roll No</th><th>Status</th></tr></thead>
                  <tbody>
                    {studentsData.students.map((s) => (
                      <tr key={s._id}>
                        <td>{s.fullName}</td>
                        <td><code>{s.studentId}</code></td>
                        <td>
                          <select name={`status_${s._id}`} defaultValue="present" className="cd-select cd-select--sm">
                            <option value="present">Present</option>
                            <option value="absent">Absent</option>
                            <option value="late">Late</option>
                            <option value="excused">Excused</option>
                          </select>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <button type="submit" className="cd-btn cd-btn--primary" disabled={isActionLoading}>Save Attendance Session</button>
            </form>
          </div>
        </div>
      )}

      {/* 8. Attendance Correction Audit Modal */}
      {showCorrectionModal && (
        <div className="cd-modal-backdrop" onClick={() => setShowCorrectionModal(null)}>
          <div className="cd-modal" onClick={(e) => e.stopPropagation()}>
            <div className="cd-modal__header">
              <h2>Attendance Correction with Audit Trail</h2>
              <button type="button" className="cd-modal-close" onClick={() => setShowCorrectionModal(null)}>✕</button>
            </div>
            <form onSubmit={handleAttendanceCorrection} className="cd-form">
              <p>Session: <strong>{showCorrectionModal.subject}</strong> ({formatDate(showCorrectionModal.date)})</p>
              <div className="cd-form-row">
                <label>Select Student</label>
                <select name="studentId" required className="cd-select">
                  {showCorrectionModal.records?.map((r) => (
                    <option key={r.studentId} value={r.studentId}>{r.studentName} (Currently: {r.status})</option>
                  ))}
                </select>
              </div>
              <div className="cd-form-row">
                <label>New Attendance Status</label>
                <select name="newStatus" required className="cd-select">
                  <option value="present">Present</option>
                  <option value="absent">Absent</option>
                  <option value="late">Late</option>
                  <option value="excused">Excused</option>
                </select>
              </div>
              <div className="cd-form-row">
                <label>Correction Audit Reason *</label>
                <input type="text" name="reason" required placeholder="e.g. Student submitted medical leave certificate" className="cd-input" />
              </div>
              <button type="submit" className="cd-btn cd-btn--primary" disabled={isActionLoading}>Commit Correction</button>
            </form>
          </div>
        </div>
      )}

      {/* 9. Schedule Examination Modal */}
      {showCreateExamModal && (
        <div className="cd-modal-backdrop" onClick={() => setShowCreateExamModal(false)}>
          <div className="cd-modal" onClick={(e) => e.stopPropagation()}>
            <div className="cd-modal__header">
              <h2>Schedule Examination</h2>
              <button type="button" className="cd-modal-close" onClick={() => setShowCreateExamModal(false)}>✕</button>
            </div>
            <form onSubmit={handleCreateExam} className="cd-form">
              <div className="cd-form-row">
                <label>Exam Title *</label>
                <input type="text" name="title" required placeholder="e.g. Mid-Term Algorithms 2026" className="cd-input" />
              </div>
              <div className="cd-form-row">
                <label>Exam Type</label>
                <select name="examType" className="cd-select">
                  <option value="internal">Internal Assessment</option>
                  <option value="mid_term">Mid-Term</option>
                  <option value="final">Final Exam</option>
                  <option value="quiz">Quiz</option>
                  <option value="practical">Practical</option>
                </select>
              </div>
              <div className="cd-form-row">
                <label>Department & Subject</label>
                <div className="cd-form-split">
                  <select name="department" className="cd-select">
                    <option value="">Select Department</option>
                    {departments.map((d) => (
                      <option key={d._id} value={d.name}>{d.name}</option>
                    ))}
                  </select>
                  <input type="text" name="subject" placeholder="Subject Name" className="cd-input" />
                </div>
              </div>
              <div className="cd-form-row">
                <label>Dates *</label>
                <div className="cd-form-split">
                  <input type="date" name="startDate" required className="cd-input" />
                  <input type="date" name="endDate" required className="cd-input" />
                </div>
              </div>
              <div className="cd-form-row">
                <label>Max Marks & Passing Marks</label>
                <div className="cd-form-split">
                  <input type="number" name="maxMarks" defaultValue="100" className="cd-input" />
                  <input type="number" name="passingMarks" defaultValue="40" className="cd-input" />
                </div>
              </div>
              <button type="submit" className="cd-btn cd-btn--primary" disabled={isActionLoading}>Schedule Exam</button>
            </form>
          </div>
        </div>
      )}

      {/* 10. Enter Exam Marks Modal with Auto-Grading Preview */}
      {showEnterMarksModal && (
        <div className="cd-modal-backdrop" onClick={() => setShowEnterMarksModal(null)}>
          <div className="cd-modal cd-modal--large" onClick={(e) => e.stopPropagation()}>
            <div className="cd-modal__header">
              <h2>Enter Marks: {showEnterMarksModal.title}</h2>
              <button type="button" className="cd-modal-close" onClick={() => setShowEnterMarksModal(null)}>✕</button>
            </div>
            <form onSubmit={handleSaveMarks} className="cd-form">
              <p>Max Marks: <strong>{showEnterMarksModal.maxMarks}</strong> · Passing Marks: <strong>{showEnterMarksModal.passingMarks}</strong></p>
              <div className="cd-table-container" style={{ maxHeight: 300, overflowY: 'auto' }}>
                <table className="cd-table">
                  <thead><tr><th>Student</th><th>Roll No</th><th>Marks Obtained</th></tr></thead>
                  <tbody>
                    {studentsData.students.map((s) => (
                      <tr key={s._id}>
                        <td>{s.fullName}</td>
                        <td><code>{s.studentId}</code></td>
                        <td>
                          <input
                            type="number"
                            name={`marks_${s._id}`}
                            max={showEnterMarksModal.maxMarks}
                            min="0"
                            placeholder="0"
                            className="cd-input cd-input--sm"
                            style={{ width: 100 }}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <button type="submit" className="cd-btn cd-btn--primary" disabled={isActionLoading}>Calculate Grades & Save Results</button>
            </form>
          </div>
        </div>
      )}

      {/* 11. Report Card Modal */}
      {showReportCardModal && (
        <div className="cd-modal-backdrop" onClick={() => setShowReportCardModal(null)}>
          <div className="cd-modal cd-modal--large cd-report-card" onClick={(e) => e.stopPropagation()}>
            <div className="cd-modal__header">
              <div>
                <h2>Academic Report Card</h2>
                <span>{showReportCardModal.college?.name}</span>
              </div>
              <button type="button" className="cd-modal-close" onClick={() => setShowReportCardModal(null)}>✕</button>
            </div>
            <div className="cd-report-card-body">
              <div className="cd-report-student-meta">
                <div><strong>Student Name:</strong> {showReportCardModal.student?.fullName}</div>
                <div><strong>Roll No:</strong> {showReportCardModal.student?.studentId}</div>
                <div><strong>Department:</strong> {showReportCardModal.student?.department}</div>
                <div><strong>Semester:</strong> {showReportCardModal.student?.semester}</div>
              </div>

              <table className="cd-table" style={{ margin: '16px 0' }}>
                <thead>
                  <tr><th>Subject / Exam</th><th>Type</th><th>Score</th><th>Grade</th><th>Status</th></tr>
                </thead>
                <tbody>
                  {showReportCardModal.reportCard?.results?.map((r, i) => (
                    <tr key={i}>
                      <td><strong>{r.subject}</strong></td>
                      <td>{r.examType}</td>
                      <td>{r.marksObtained} / {r.maxMarks} ({r.percentage}%)</td>
                      <td><strong>{r.grade}</strong></td>
                      <td><span className={`cd-pill cd-pill--${r.isPass ? 'success' : 'danger'}`}>{r.isPass ? 'Pass' : 'Backlog'}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <div className="cd-report-summary">
                <div>Total Score: <strong>{showReportCardModal.reportCard?.totalMarksObtained} / {showReportCardModal.reportCard?.totalMaxMarks}</strong></div>
                <div>Overall Percentage: <strong>{showReportCardModal.reportCard?.overallPercentage}%</strong></div>
                <div>Overall Grade: <span className="cd-pill cd-pill--success">{showReportCardModal.reportCard?.overallGrade}</span></div>
                <div>Backlogs: <strong>{showReportCardModal.reportCard?.backlogsCount}</strong></div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 12. Create Placement Drive Modal */}
      {showCreatePlacementModal && (
        <div className="cd-modal-backdrop" onClick={() => setShowCreatePlacementModal(false)}>
          <div className="cd-modal" onClick={(e) => e.stopPropagation()}>
            <div className="cd-modal__header">
              <h2>Announce Placement / Internship Drive</h2>
              <button type="button" className="cd-modal-close" onClick={() => setShowCreatePlacementModal(false)}>✕</button>
            </div>
            <form onSubmit={handleCreatePlacement} className="cd-form">
              <div className="cd-form-row">
                <label>Company Name *</label>
                <input type="text" name="companyName" required placeholder="e.g. Google, Microsoft, Infosys" className="cd-input" />
              </div>
              <div className="cd-form-row">
                <label>Job Title *</label>
                <input type="text" name="jobTitle" required placeholder="e.g. Associate Software Engineer" className="cd-input" />
              </div>
              <div className="cd-form-row">
                <label>Opportunity Type</label>
                <select name="opportunityType" className="cd-select">
                  <option value="full_time">Full-Time Placement</option>
                  <option value="internship">Internship</option>
                  <option value="ppo">Pre-Placement Offer (PPO)</option>
                </select>
              </div>
              <div className="cd-form-row">
                <label>Package (LPA) / Monthly Stipend (₹)</label>
                <div className="cd-form-split">
                  <input type="number" step="0.1" name="packageLpa" placeholder="Package in LPA (e.g. 12.5)" className="cd-input" />
                  <input type="number" name="stipendMonthly" placeholder="Monthly Stipend (₹)" className="cd-input" />
                </div>
              </div>
              <div className="cd-form-row">
                <label>Eligibility (Min CGPA & Max Backlogs)</label>
                <div className="cd-form-split">
                  <input type="number" step="0.1" name="minCgpa" defaultValue="6.0" placeholder="Min CGPA" className="cd-input" />
                  <input type="number" name="maxBacklogs" defaultValue="0" placeholder="Max Backlogs" className="cd-input" />
                </div>
              </div>
              <div className="cd-form-row">
                <label>Application Deadline *</label>
                <input type="date" name="deadline" required className="cd-input" />
              </div>
              <button type="submit" className="cd-btn cd-btn--primary" disabled={isActionLoading}>Announce Drive</button>
            </form>
          </div>
        </div>
      )}

      {/* 13. Register Student for Placement Modal */}
      {showApplyPlacementModal && (
        <div className="cd-modal-backdrop" onClick={() => setShowApplyPlacementModal(null)}>
          <div className="cd-modal" onClick={(e) => e.stopPropagation()}>
            <div className="cd-modal__header">
              <h2>Register Student: {showApplyPlacementModal.companyName}</h2>
              <button type="button" className="cd-modal-close" onClick={() => setShowApplyPlacementModal(null)}>✕</button>
            </div>
            <form onSubmit={handleApplyPlacement} className="cd-form">
              <p>Role: <strong>{showApplyPlacementModal.jobTitle}</strong> · Min CGPA: <strong>{showApplyPlacementModal.minCgpa}</strong></p>
              <div className="cd-form-row">
                <label>Select Student</label>
                <select name="studentId" required className="cd-select">
                  <option value="">Select Candidate</option>
                  {studentsData.students.map((s) => (
                    <option key={s._id} value={s._id}>{s.fullName} ({s.studentId}, CGPA: {s.cgpa || 0})</option>
                  ))}
                </select>
              </div>
              <div className="cd-form-row">
                <label>Notes / Recommendation</label>
                <input type="text" name="notes" placeholder="e.g. Recommended by CS HOD" className="cd-input" />
              </div>
              <button type="submit" className="cd-btn cd-btn--primary" disabled={isActionLoading}>Register Candidate</button>
            </form>
          </div>
        </div>
      )}

      {/* 14. Assign Course Modal */}
      {showAssignCourseModal && (
        <div className="cd-modal-backdrop" onClick={() => setShowAssignCourseModal(false)}>
          <div className="cd-modal" onClick={(e) => e.stopPropagation()}>
            <div className="cd-modal__header">
              <h2>Assign Course</h2>
              <button type="button" className="cd-modal-close" onClick={() => setShowAssignCourseModal(false)}>✕</button>
            </div>
            <form onSubmit={handleAssignCourse} className="cd-form">
              <div className="cd-form-row">
                <label>Select Course *</label>
                <select name="courseId" required className="cd-select">
                  <option value="">Choose Course</option>
                  {courses.map((c) => (
                    <option key={c.id || c._id} value={c.id || c._id}>{c.title}</option>
                  ))}
                </select>
              </div>
              <div className="cd-form-row">
                <label>Assign To Target *</label>
                <select name="targetType" required className="cd-select">
                  <option value="department">Entire Department</option>
                  <option value="batch">Specific Batch</option>
                  <option value="student">Individual Student</option>
                </select>
              </div>
              <div className="cd-form-row">
                <label>Department</label>
                <select name="department" className="cd-select">
                  <option value="">Select Department</option>
                  {departments.map((d) => (
                    <option key={d._id} value={d.name}>{d.name}</option>
                  ))}
                </select>
              </div>
              <div className="cd-form-row">
                <label>Batch</label>
                <select name="batch" className="cd-select">
                  <option value="">Select Batch</option>
                  {batches.map((b) => (
                    <option key={b._id} value={b.name}>{b.name}</option>
                  ))}
                </select>
              </div>
              <button type="submit" className="cd-btn cd-btn--primary" disabled={isActionLoading}>Assign Course</button>
            </form>
          </div>
        </div>
      )}

      {/* 15. Broadcast Announcement Modal */}
      {showBroadcastModal && (
        <div className="cd-modal-backdrop" onClick={() => setShowBroadcastModal(false)}>
          <div className="cd-modal" onClick={(e) => e.stopPropagation()}>
            <div className="cd-modal__header">
              <h2>Broadcast College Announcement</h2>
              <button type="button" className="cd-modal-close" onClick={() => setShowBroadcastModal(false)}>✕</button>
            </div>
            <form onSubmit={handleBroadcastAnnouncement} className="cd-form">
              <div className="cd-form-row">
                <label>Title *</label>
                <input type="text" name="title" required placeholder="Announcement headline" className="cd-input" />
              </div>
              <div className="cd-form-row">
                <label>Message *</label>
                <textarea name="message" required rows="4" placeholder="Announcement content..." className="cd-input" />
              </div>
              <button type="submit" className="cd-btn cd-btn--primary" disabled={isActionLoading}>Broadcast</button>
            </form>
          </div>
        </div>
      )}

      {/* 16. Upload Document Modal */}
      {showUploadDocModal && (
        <div className="cd-modal-backdrop" onClick={() => setShowUploadDocModal(false)}>
          <div className="cd-modal" onClick={(e) => e.stopPropagation()}>
            <div className="cd-modal__header">
              <h2>Register / Upload Institutional Document</h2>
              <button type="button" className="cd-modal-close" onClick={() => setShowUploadDocModal(false)}>✕</button>
            </div>
            <form onSubmit={handleUploadDoc} className="cd-form">
              <div className="cd-form-row">
                <label>Document Title *</label>
                <input type="text" name="title" required placeholder="e.g. NAAC Criteria 2 Academic Report" className="cd-input" />
              </div>
              <div className="cd-form-row">
                <label>Category *</label>
                <select name="category" required className="cd-select">
                  <option value="naac_nba">NAAC / NBA Documentation</option>
                  <option value="syllabus">Syllabus & Curriculum</option>
                  <option value="policy">Institutional Policy</option>
                  <option value="academic_report">Academic Report</option>
                  <option value="general">General</option>
                </select>
              </div>
              <div className="cd-form-row">
                <label>File Name *</label>
                <input type="text" name="fileName" required placeholder="e.g. naac-criteria-2.pdf" className="cd-input" />
              </div>
              <div className="cd-form-row">
                <label>Description</label>
                <textarea name="description" rows="3" className="cd-input" />
              </div>
              <button type="submit" className="cd-btn cd-btn--primary" disabled={isActionLoading}>Register Document</button>
            </form>
          </div>
        </div>
      )}

      {/* 17. Add Faculty Modal */}
      {showAddFacultyModal && (
        <div className="cd-modal-backdrop" onClick={() => setShowAddFacultyModal(false)}>
          <div className="cd-modal" onClick={(e) => e.stopPropagation()}>
            <div className="cd-modal__header">
              <h2>Add Faculty Profile</h2>
              <button type="button" className="cd-modal-close" onClick={() => setShowAddFacultyModal(false)}>✕</button>
            </div>
            <form onSubmit={handleAddFaculty} className="cd-form">
              <div className="cd-form-row">
                <label>Full Name *</label>
                <input type="text" name="fullName" required placeholder="e.g. Dr. John von Neumann" className="cd-input" />
              </div>
              <div className="cd-form-row">
                <label>Email *</label>
                <input type="email" name="email" required placeholder="faculty@college.edu" className="cd-input" />
              </div>
              <div className="cd-form-row">
                <label>Department</label>
                <select name="department" className="cd-select">
                  <option value="">Select Department</option>
                  {departments.map((d) => (
                    <option key={d._id} value={d.name}>{d.name}</option>
                  ))}
                </select>
              </div>
              <div className="cd-form-row">
                <label>Designation</label>
                <input type="text" name="designation" defaultValue="Assistant Professor" className="cd-input" />
              </div>
              <div className="cd-form-row">
                <label>Qualifications</label>
                <input type="text" name="qualification" placeholder="e.g. Ph.D., M.Tech" className="cd-input" />
              </div>
              <button type="submit" className="cd-btn cd-btn--primary" disabled={isActionLoading}>Save Faculty Profile</button>
            </form>
          </div>
        </div>
      )}

      {/* 18. Add Event Modal */}
      {showAddEventModal && (
        <div className="cd-modal-backdrop" onClick={() => setShowAddEventModal(false)}>
          <div className="cd-modal" onClick={(e) => e.stopPropagation()}>
            <div className="cd-modal__header">
              <h2>Add Calendar Event</h2>
              <button type="button" className="cd-modal-close" onClick={() => setShowAddEventModal(false)}>✕</button>
            </div>
            <form onSubmit={async (e) => {
              e.preventDefault()
              const fd = new FormData(e.currentTarget)
              const payload = Object.fromEntries(fd.entries())
              payload.isHoliday = fd.get('isHoliday') === 'on'
              await collegeRequest('/college/events', { method: 'POST', body: JSON.stringify(payload) })
              setShowAddEventModal(false)
              loadEvents()
            }} className="cd-form">
              <div className="cd-form-row">
                <label>Title *</label>
                <input type="text" name="title" required className="cd-input" />
              </div>
              <div className="cd-form-row">
                <label>Type</label>
                <select name="eventType" className="cd-select">
                  <option value="exam">Examination</option>
                  <option value="holiday">Holiday</option>
                  <option value="activity">College Activity</option>
                  <option value="workshop">Workshop</option>
                  <option value="announcement">Announcement</option>
                </select>
              </div>
              <div className="cd-form-row">
                <label>Dates *</label>
                <div className="cd-form-split">
                  <input type="date" name="startDate" required className="cd-input" />
                  <input type="date" name="endDate" required className="cd-input" />
                </div>
              </div>
              <div className="cd-form-row">
                <label><input type="checkbox" name="isHoliday" /> Official College Holiday</label>
              </div>
              <button type="submit" className="cd-btn cd-btn--primary">Save Event</button>
            </form>
          </div>
        </div>
      )}

      {/* 19. Add Semester Modal */}
      {showAddSemesterModal && (
        <div className="cd-modal-backdrop" onClick={() => setShowAddSemesterModal(false)}>
          <div className="cd-modal" onClick={(e) => e.stopPropagation()}>
            <div className="cd-modal__header">
              <h2>Add Academic Semester</h2>
              <button type="button" className="cd-modal-close" onClick={() => setShowAddSemesterModal(false)}>✕</button>
            </div>
            <form onSubmit={handleAddSemester} className="cd-form">
              <div className="cd-form-row">
                <label>Semester Name *</label>
                <input type="text" name="name" required placeholder="e.g. Semester 1, Fall 2026" className="cd-input" />
              </div>
              <div className="cd-form-row">
                <label>Academic Year</label>
                <input type="text" name="academicYear" placeholder="e.g. 2026-2027" className="cd-input" />
              </div>
              <div className="cd-form-row">
                <label>Department</label>
                <select name="department" className="cd-select">
                  <option value="">All Departments / General</option>
                  {departments.map((d) => (
                    <option key={d._id} value={d.name}>{d.name}</option>
                  ))}
                </select>
              </div>
              <div className="cd-form-row">
                <label><input type="checkbox" name="isCurrent" /> Mark as Current Active Term</label>
              </div>
              <button type="submit" className="cd-btn cd-btn--primary" disabled={isActionLoading}>Create Semester</button>
            </form>
          </div>
        </div>
      )}

      {/* 20. Edit Student Modal */}
      {editingStudent && (
        <div className="cd-modal-backdrop" onClick={() => setEditingStudent(null)}>
          <div className="cd-modal" onClick={(e) => e.stopPropagation()}>
            <div className="cd-modal__header">
              <h2>Edit Student: {editingStudent.fullName}</h2>
              <button type="button" className="cd-modal-close" onClick={() => setEditingStudent(null)}>✕</button>
            </div>
            <form onSubmit={handleEditStudent} className="cd-form">
              <div className="cd-form-row">
                <label>Full Name</label>
                <input type="text" name="fullName" defaultValue={editingStudent.fullName} required className="cd-input" />
              </div>
              <div className="cd-form-row">
                <label>Student ID / Roll No</label>
                <input type="text" name="studentId" defaultValue={editingStudent.studentId} required className="cd-input" />
              </div>
              <div className="cd-form-row">
                <label>Department</label>
                <select name="department" defaultValue={editingStudent.department} className="cd-select">
                  <option value="">Select Department</option>
                  {departments.map((d) => (
                    <option key={d._id} value={d.name}>{d.name}</option>
                  ))}
                </select>
              </div>
              <div className="cd-form-row">
                <label>Batch</label>
                <select name="batch" defaultValue={editingStudent.batch} className="cd-select">
                  <option value="">Select Batch</option>
                  {batches.map((b) => (
                    <option key={b._id} value={b.name}>{b.name}</option>
                  ))}
                </select>
              </div>
              <div className="cd-form-row">
                <label>CGPA</label>
                <input type="number" step="0.01" name="cgpa" defaultValue={editingStudent.cgpa || 0} className="cd-input" />
              </div>
              <div className="cd-form-row">
                <label>Academic Standing</label>
                <select name="academicStanding" defaultValue={editingStudent.academicStanding || 'good'} className="cd-select">
                  <option value="good">Good Standing</option>
                  <option value="excellent">Excellent</option>
                  <option value="probation">Probation</option>
                  <option value="at_risk">At Risk</option>
                </select>
              </div>
              <button type="submit" className="cd-btn cd-btn--primary" disabled={isActionLoading}>Update Student</button>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
