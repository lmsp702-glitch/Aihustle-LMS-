import React, { useEffect, useMemo, useState } from 'react'
import { isInvalidSessionResponse } from './auth-session.js'
import './AdminEnrollmentManagement.css'

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:5000/api'

async function adminRequest(path, onLogout, options = {}) {
  const savedAuth = sessionStorage.getItem('lms.auth')
  const auth = savedAuth ? JSON.parse(savedAuth) : null
  if (auth?.user?.role !== 'main_admin' || typeof auth.token !== 'string') {
    onLogout()
    throw new Error('Your administrator session has ended.')
  }
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${auth.token}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  })
  const text = await response.text()
  let result
  try {
    result = text ? JSON.parse(text) : {}
  } catch {
    throw new Error('The server returned an invalid response.')
  }
  if (isInvalidSessionResponse(response, result)) onLogout()
  return { response, result }
}

function getInitials(name) {
  if (!name || typeof name !== 'string') return 'S'
  const parts = name.trim().split(/\s+/)
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

function formatDate(dateValue) {
  if (!dateValue) return 'N/A'
  const date = new Date(dateValue)
  if (isNaN(date.getTime())) return 'N/A'
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

function formatDateTime(dateValue) {
  if (!dateValue) return 'N/A'
  const date = new Date(dateValue)
  if (isNaN(date.getTime())) return 'N/A'
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function getRelativeTime(dateValue) {
  if (!dateValue) return ''
  const date = new Date(dateValue)
  if (isNaN(date.getTime())) return ''
  const diffDays = Math.floor((new Date() - date) / (1000 * 60 * 60 * 24))
  if (diffDays <= 0) return 'Today'
  if (diffDays === 1) return 'Yesterday'
  if (diffDays < 30) return `${diffDays} days ago`
  if (diffDays < 365) return `${Math.floor(diffDays / 30)} mo ago`
  return `${Math.floor(diffDays / 365)} yr ago`
}

// Minimal inline SVG icon set for high-performance rendering
function Icon({ name, size = 16, className = '' }) {
  const icons = {
    users: (
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm13 10v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
    ),
    book: (
      <>
        <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1-2.5-2.5Z" />
        <path d="M6 6h10M6 10h10" />
      </>
    ),
    checkCircle: (
      <>
        <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
        <polyline points="22 4 12 14.01 9 11.01" />
      </>
    ),
    chart: (
      <>
        <line x1="18" y1="20" x2="18" y2="10" />
        <line x1="12" y1="20" x2="12" y2="4" />
        <line x1="6" y1="20" x2="6" y2="14" />
      </>
    ),
    search: (
      <>
        <circle cx="11" cy="11" r="8" />
        <line x1="21" y1="21" x2="16.65" y2="16.65" />
      </>
    ),
    download: (
      <>
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
        <polyline points="7 10 12 15 17 10" />
        <line x1="12" y1="15" x2="12" y2="3" />
      </>
    ),
    refresh: (
      <>
        <polyline points="23 4 23 10 17 10" />
        <polyline points="1 20 1 14 7 14" />
        <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
      </>
    ),
    chevronDown: <polyline points="6 9 12 15 18 9" />,
    close: (
      <>
        <line x1="18" y1="6" x2="6" y2="18" />
        <line x1="6" y1="6" x2="18" y2="18" />
      </>
    ),
    eye: (
      <>
        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
        <circle cx="12" cy="12" r="3" />
      </>
    ),
    college: (
      <>
        <path d="M3 21h18M5 21V7l7-4 7 4v14M9 10h2v4H9zM13 10h2v4h-2z" />
      </>
    ),
    filter: (
      <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
    ),
  }

  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {icons[name] || null}
    </svg>
  )
}

export function EnrollmentManagement({ onLogout }) {
  const [enrollments, setEnrollments] = useState([])
  const [colleges, setColleges] = useState([])
  const [isLoading, setIsLoading] = useState(true)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [error, setError] = useState('')

  // Search & Filter state
  const [searchQuery, setSearchQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [typeFilter, setTypeFilter] = useState('all')
  const [collegeFilter, setCollegeFilter] = useState('all')
  const [sortBy, setSortBy] = useState('newest')

  // Pagination state
  const [currentPage, setCurrentPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)

  // Details drawer
  const [selectedEnrollment, setSelectedEnrollment] = useState(null)

  async function loadData(isManualRefresh = false) {
    if (isManualRefresh) setIsRefreshing(true)
    else setIsLoading(true)
    setError('')

    try {
      const [enrollmentRes, collegeRes] = await Promise.allSettled([
        adminRequest('/admin/enrollments', onLogout),
        adminRequest('/admin/colleges', onLogout),
      ])

      if (enrollmentRes.status === 'fulfilled') {
        const { response, result } = enrollmentRes.value
        if (!response.ok) throw new Error(result.message || 'Unable to load enrollments.')
        setEnrollments(result.enrollments || [])
      } else {
        throw new Error(enrollmentRes.reason?.message || 'Unable to load enrollments.')
      }

      if (collegeRes.status === 'fulfilled') {
        const { response, result } = collegeRes.value
        if (response.ok && Array.isArray(result.colleges)) {
          setColleges(result.colleges)
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load enrollment records.')
    } finally {
      setIsLoading(false)
      setIsRefreshing(false)
    }
  }

  useEffect(() => {
    loadData()
  }, [])

  // Close drawer on ESC key
  useEffect(() => {
    function handleKeyDown(e) {
      if (e.key === 'Escape') setSelectedEnrollment(null)
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  // Dynamic college options
  const collegeOptions = useMemo(() => {
    const map = new Map()
    for (const c of colleges) {
      if (c._id && c.name) map.set(String(c._id), c.name)
    }
    for (const e of enrollments) {
      if (e.collegeId && typeof e.collegeId === 'object' && e.collegeId.name) {
        map.set(String(e.collegeId._id || e.collegeId.name), e.collegeId.name)
      }
    }
    return [...map.entries()].map(([id, name]) => ({ id, name }))
  }, [colleges, enrollments])

  // Analytics Metrics
  const analytics = useMemo(() => {
    const total = enrollments.length
    let active = 0
    let completed = 0
    let totalProgressSum = 0

    for (const entry of enrollments) {
      const totalLessons = entry.progress?.totalLessons ?? (entry.courseId?.modules?.reduce((sum, m) => sum + (m.lessons?.length || m.contentItems?.filter(i => i.type === 'video-lesson')?.length || 0), 0) || 0)
      const completedCount = entry.progress?.completedCount ?? (entry.completedLessonIds?.length || 0)
      const isComplete = (totalLessons > 0 && completedCount >= totalLessons) || entry.status === 'completed'

      if (isComplete) {
        completed++
      } else if (entry.status === 'active') {
        active++
      }

      const pct = entry.progress?.percentage ?? (totalLessons > 0 ? Math.round((completedCount / totalLessons) * 100) : 0)
      totalProgressSum += pct
    }

    const avgCompletion = total > 0 ? Math.round(totalProgressSum / total) : 0

    return {
      total,
      active,
      completed,
      avgCompletion,
    }
  }, [enrollments])

  // Filtered & Sorted Enrollments
  const filteredEnrollments = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()

    return enrollments
      .filter((entry) => {
        // Search query
        if (q) {
          const studentName = (entry.userId?.fullName || entry.userId?.name || '').toLowerCase()
          const studentEmail = (entry.userId?.email || '').toLowerCase()
          const studentUsername = (entry.userId?.username || '').toLowerCase()
          const courseTitle = (entry.courseId?.title || '').toLowerCase()
          const courseCategory = (entry.courseId?.category || '').toLowerCase()
          const collegeName = (entry.collegeId?.name || '').toLowerCase()

          const matchesSearch =
            studentName.includes(q) ||
            studentEmail.includes(q) ||
            studentUsername.includes(q) ||
            courseTitle.includes(q) ||
            courseCategory.includes(q) ||
            collegeName.includes(q)

          if (!matchesSearch) return false
        }

        // Status filter
        if (statusFilter !== 'all') {
          const totalLessons = entry.progress?.totalLessons ?? 0
          const completedCount = entry.progress?.completedCount ?? (entry.completedLessonIds?.length || 0)
          const isComplete = (totalLessons > 0 && completedCount >= totalLessons) || entry.status === 'completed'

          if (statusFilter === 'completed' && !isComplete) return false
          if (statusFilter === 'active' && (isComplete || entry.status !== 'active')) return false
          if (statusFilter === 'cancelled' && entry.status !== 'cancelled' && entry.status !== 'suspended') return false
        }

        // Student Type filter
        if (typeFilter !== 'all') {
          const isCollege = entry.userId?.studentType === 'college' || Boolean(entry.collegeId)
          if (typeFilter === 'college' && !isCollege) return false
          if (typeFilter === 'independent' && isCollege) return false
        }

        // College filter
        if (collegeFilter !== 'all') {
          const entryCollegeId = String(entry.collegeId?._id || entry.collegeId || entry.userId?.collegeId || '')
          const entryCollegeName = String(entry.collegeId?.name || '')
          if (entryCollegeId !== collegeFilter && entryCollegeName !== collegeFilter) return false
        }

        return true
      })
      .sort((a, b) => {
        if (sortBy === 'newest') return new Date(b.createdAt || 0) - new Date(a.createdAt || 0)
        if (sortBy === 'oldest') return new Date(a.createdAt || 0) - new Date(b.createdAt || 0)
        if (sortBy === 'progress-high') return (b.progress?.percentage || 0) - (a.progress?.percentage || 0)
        if (sortBy === 'progress-low') return (a.progress?.percentage || 0) - (b.progress?.percentage || 0)
        if (sortBy === 'student-name') {
          const nameA = (a.userId?.fullName || a.userId?.username || '').toLowerCase()
          const nameB = (b.userId?.fullName || b.userId?.username || '').toLowerCase()
          return nameA.localeCompare(nameB)
        }
        if (sortBy === 'course-title') {
          const titleA = (a.courseId?.title || '').toLowerCase()
          const titleB = (b.courseId?.title || '').toLowerCase()
          return titleA.localeCompare(titleB)
        }
        return 0
      })
  }, [enrollments, searchQuery, statusFilter, typeFilter, collegeFilter, sortBy])

  // Reset page when filters change
  useEffect(() => {
    setCurrentPage(1)
  }, [searchQuery, statusFilter, typeFilter, collegeFilter, sortBy, pageSize])

  // Paginated records
  const totalPages = Math.max(1, Math.ceil(filteredEnrollments.length / pageSize))
  const paginatedEnrollments = useMemo(() => {
    const startIndex = (currentPage - 1) * pageSize
    return filteredEnrollments.slice(startIndex, startIndex + pageSize)
  }, [filteredEnrollments, currentPage, pageSize])

  const hasActiveFilters =
    Boolean(searchQuery.trim()) ||
    statusFilter !== 'all' ||
    typeFilter !== 'all' ||
    collegeFilter !== 'all' ||
    sortBy !== 'newest'

  function clearFilters() {
    setSearchQuery('')
    setStatusFilter('all')
    setTypeFilter('all')
    setCollegeFilter('all')
    setSortBy('newest')
  }

  // Real CSV Export
  function handleExportCsv() {
    const exportRecords = filteredEnrollments.length > 0 ? filteredEnrollments : enrollments
    if (!exportRecords.length) return

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
      'Videos Completed',
      'Quizzes Passed',
      'Assessments Completed',
      'Overall Progress (%)',
      'Status',
      'Completion Date',
      'Last Activity',
    ]

    const rows = exportRecords.map((entry) => {
      const student = entry.userId || {}
      const course = entry.courseId || {}
      const college = entry.collegeId || {}
      const progress = entry.progress || {}
      const isCollege = student.studentType === 'college' || Boolean(entry.collegeId)

      return [
        entry._id || '',
        student.fullName || student.name || 'Unknown',
        student.email || '',
        student.username || '',
        isCollege ? 'College Student' : 'Independent Student',
        college.name || (isCollege ? 'Assigned College' : 'N/A'),
        course.title || 'Untitled Course',
        course.category || 'General',
        entry.createdAt ? new Date(entry.createdAt).toISOString().split('T')[0] : '',
        `${progress.videoStats?.completed ?? (entry.completedLessonIds?.length || 0)} / ${progress.videoStats?.total ?? progress.totalLessons ?? 0}`,
        `${progress.quizStats?.passed ?? 0} / ${progress.quizStats?.total ?? 0}`,
        `${progress.assessmentStats?.completed ?? 0} / ${progress.assessmentStats?.total ?? 0}`,
        `${progress.percentage ?? 0}%`,
        entry.status || 'active',
        entry.completedAt ? new Date(entry.completedAt).toISOString().split('T')[0] : 'N/A',
        entry.lastActivityAt ? new Date(entry.lastActivityAt).toISOString().split('T')[0] : 'N/A',
      ]
    })

    const csvContent = [
      headers.map((h) => `"${h.replace(/"/g, '""')}"`).join(','),
      ...rows.map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(',')),
    ].join('\r\n')

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.setAttribute('href', url)
    link.setAttribute('download', `aihustle-enrollments-${new Date().toISOString().split('T')[0]}.csv`)
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)
  }

  return (
    <section className="admin-enrollment-management" aria-label="Enrollment Management">
      {/* 1. Page Header */}
      <div className="admin-enrollment-header">
        <div className="admin-enrollment-header__copy">
          <span className="admin-enrollment-header__badge">Course Management</span>
          <h1>Enrollment Management</h1>
          <p>
            Monitor student enrollments, course participation and learning progress across aiHustle.
          </p>
        </div>
        <div className="admin-enrollment-header__actions">
          <button
            type="button"
            className="admin-enrollment-btn admin-enrollment-btn--secondary"
            onClick={() => loadData(true)}
            disabled={isLoading || isRefreshing}
            title="Refresh enrollment records"
          >
            <Icon name="refresh" size={14} className={isRefreshing ? 'spin' : ''} />
            <span>{isRefreshing ? 'Refreshing…' : 'Refresh'}</span>
          </button>
          <button
            type="button"
            className="admin-enrollment-btn admin-enrollment-btn--primary"
            onClick={handleExportCsv}
            disabled={isLoading || enrollments.length === 0}
            title="Export filtered enrollment data to CSV"
          >
            <Icon name="download" size={14} />
            <span>Export CSV</span>
          </button>
        </div>
      </div>

      {/* Error Banner */}
      {error && (
        <div className="admin-inline-error" role="alert">
          <span>{error}</span>
          <button type="button" className="admin-text-button" onClick={() => loadData()}>
            Retry
          </button>
        </div>
      )}

      {/* 2. Enrollment Analytics Cards */}
      <div className="admin-enrollment-analytics">
        {/* Card 1: Total Enrollments */}
        <div className="admin-analytics-card">
          <div className="admin-analytics-card__top">
            <span className="admin-analytics-card__label">Total Enrollments</span>
            <div className="admin-analytics-card__icon-wrap admin-analytics-card__icon-wrap--gold">
              <Icon name="users" size={18} />
            </div>
          </div>
          <div className="admin-analytics-card__metric">
            {isLoading ? <span className="admin-skeleton" style={{ display: 'inline-block', width: '60px', height: '28px' }} /> : analytics.total}
          </div>
          <p className="admin-analytics-card__sub">
            All-time course registrations
          </p>
        </div>

        {/* Card 2: Active Enrollments */}
        <div className="admin-analytics-card">
          <div className="admin-analytics-card__top">
            <span className="admin-analytics-card__label">Active Enrollments</span>
            <div className="admin-analytics-card__icon-wrap admin-analytics-card__icon-wrap--teal">
              <Icon name="book" size={18} />
            </div>
          </div>
          <div className="admin-analytics-card__metric">
            {isLoading ? <span className="admin-skeleton" style={{ display: 'inline-block', width: '60px', height: '28px' }} /> : analytics.active}
          </div>
          <p className="admin-analytics-card__sub">
            <strong>{analytics.total ? Math.round((analytics.active / analytics.total) * 100) : 0}%</strong> of enrolled learners
          </p>
        </div>

        {/* Card 3: Completed Enrollments */}
        <div className="admin-analytics-card">
          <div className="admin-analytics-card__top">
            <span className="admin-analytics-card__label">Completed Courses</span>
            <div className="admin-analytics-card__icon-wrap admin-analytics-card__icon-wrap--emerald">
              <Icon name="checkCircle" size={18} />
            </div>
          </div>
          <div className="admin-analytics-card__metric">
            {isLoading ? <span className="admin-skeleton" style={{ display: 'inline-block', width: '60px', height: '28px' }} /> : analytics.completed}
          </div>
          <p className="admin-analytics-card__sub">
            <strong>{analytics.total ? Math.round((analytics.completed / analytics.total) * 100) : 0}%</strong> completion rate
          </p>
        </div>

        {/* Card 4: Average Completion Rate */}
        <div className="admin-analytics-card">
          <div className="admin-analytics-card__top">
            <span className="admin-analytics-card__label">Avg Completion</span>
            <div className="admin-analytics-card__icon-wrap admin-analytics-card__icon-wrap--blue">
              <Icon name="chart" size={18} />
            </div>
          </div>
          <div className="admin-analytics-card__metric">
            {isLoading ? <span className="admin-skeleton" style={{ display: 'inline-block', width: '60px', height: '28px' }} /> : `${analytics.avgCompletion}%`}
          </div>
          <div className="admin-analytics-card__progress">
            <div
              className="admin-analytics-card__progress-bar"
              style={{ width: `${Math.min(100, analytics.avgCompletion)}%` }}
            />
          </div>
        </div>
      </div>

      {/* 3. Search and Filtering Toolbar */}
      <div className="admin-enrollment-toolbar">
        <div className="admin-enrollment-toolbar__row">
          {/* Search Input */}
          <div className="admin-enrollment-search">
            <Icon name="search" size={15} className="admin-enrollment-search__icon" />
            <input
              type="text"
              placeholder="Search by student name, username, email, course…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              aria-label="Search enrollments"
            />
          </div>

          <div className="admin-enrollment-filter-group">
            {/* Status Filter */}
            <div className="admin-enrollment-select-wrap">
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                aria-label="Filter by enrollment status"
              >
                <option value="all">All Statuses</option>
                <option value="active">Active</option>
                <option value="completed">Completed</option>
                <option value="cancelled">Cancelled</option>
              </select>
              <Icon name="chevronDown" size={13} className="admin-enrollment-select-wrap__chevron" />
            </div>

            {/* Student Type Filter */}
            <div className="admin-enrollment-select-wrap">
              <select
                value={typeFilter}
                onChange={(e) => setTypeFilter(e.target.value)}
                aria-label="Filter by student type"
              >
                <option value="all">All Student Types</option>
                <option value="independent">Independent</option>
                <option value="college">College Student</option>
              </select>
              <Icon name="chevronDown" size={13} className="admin-enrollment-select-wrap__chevron" />
            </div>

            {/* College Filter */}
            {collegeOptions.length > 0 && (
              <div className="admin-enrollment-select-wrap">
                <select
                  value={collegeFilter}
                  onChange={(e) => setCollegeFilter(e.target.value)}
                  aria-label="Filter by college"
                >
                  <option value="all">All Colleges</option>
                  {collegeOptions.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
                <Icon name="chevronDown" size={13} className="admin-enrollment-select-wrap__chevron" />
              </div>
            )}

            {/* Sort Filter */}
            <div className="admin-enrollment-select-wrap">
              <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value)}
                aria-label="Sort enrollments"
              >
                <option value="newest">Newest First</option>
                <option value="oldest">Oldest First</option>
                <option value="progress-high">Highest Progress</option>
                <option value="progress-low">Lowest Progress</option>
                <option value="student-name">Student Name (A-Z)</option>
                <option value="course-title">Course Title (A-Z)</option>
              </select>
              <Icon name="chevronDown" size={13} className="admin-enrollment-select-wrap__chevron" />
            </div>

            {/* Clear All Filters Button */}
            {hasActiveFilters && (
              <button
                type="button"
                className="admin-enrollment-clear-btn"
                onClick={clearFilters}
                title="Reset all filters"
              >
                <Icon name="close" size={12} />
                <span>Clear filters</span>
              </button>
            )}
          </div>
        </div>

        {/* Toolbar Count & Summary */}
        <div className="admin-enrollment-toolbar__meta">
          <span className="admin-enrollment-toolbar__count">
            Showing <strong>{filteredEnrollments.length}</strong> of <strong>{enrollments.length}</strong> total enrollments
          </span>
          {hasActiveFilters && (
            <span>Filtered results active</span>
          )}
        </div>
      </div>

      {/* 4. Modern Enrollment Table */}
      <div className="admin-enrollment-table-card">
        <div className="admin-enrollment-table-wrapper">
          <table className="admin-enrollment-table">
            <thead>
              <tr>
                <th scope="col">Student</th>
                <th scope="col">Course</th>
                <th scope="col">Student Type / College</th>
                <th scope="col">Enrollment Date</th>
                <th scope="col">Learning Progress</th>
                <th scope="col">Status</th>
                <th scope="col" style={{ textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                // Skeletons
                Array.from({ length: 4 }).map((_, idx) => (
                  <tr key={`skeleton-${idx}`}>
                    <td>
                      <div className="admin-enrollment-student">
                        <div className="admin-skeleton" style={{ width: '36px', height: '36px', borderRadius: '50%' }} />
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                          <div className="admin-skeleton" style={{ width: '120px', height: '14px' }} />
                          <div className="admin-skeleton" style={{ width: '90px', height: '11px' }} />
                        </div>
                      </div>
                    </td>
                    <td>
                      <div className="admin-skeleton" style={{ width: '150px', height: '16px' }} />
                    </td>
                    <td>
                      <div className="admin-skeleton" style={{ width: '90px', height: '14px' }} />
                    </td>
                    <td>
                      <div className="admin-skeleton" style={{ width: '80px', height: '14px' }} />
                    </td>
                    <td>
                      <div className="admin-skeleton" style={{ width: '110px', height: '14px' }} />
                    </td>
                    <td>
                      <div className="admin-skeleton" style={{ width: '60px', height: '20px', borderRadius: '999px' }} />
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <div className="admin-skeleton" style={{ width: '70px', height: '28px', display: 'inline-block' }} />
                    </td>
                  </tr>
                ))
              ) : paginatedEnrollments.length === 0 ? (
                <tr>
                  <td colSpan="7">
                    <div className="admin-enrollment-empty">
                      <div className="admin-enrollment-empty__icon">
                        <Icon name="search" size={24} />
                      </div>
                      <h3>{hasActiveFilters ? 'No matching enrollments found' : 'No enrollment records yet'}</h3>
                      <p>
                        {hasActiveFilters
                          ? 'Try adjusting your search terms or filters to find what you are looking for.'
                          : 'Student enrollments will appear here once learners enroll in courses.'}
                      </p>
                      {hasActiveFilters && (
                        <button
                          type="button"
                          className="admin-enrollment-btn admin-enrollment-btn--secondary"
                          onClick={clearFilters}
                        >
                          Reset all filters
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ) : (
                paginatedEnrollments.map((entry) => {
                  const student = entry.userId || {}
                  const course = entry.courseId || {}
                  const college = entry.collegeId || {}
                  const isCollege = student.studentType === 'college' || Boolean(entry.collegeId)
                  const studentName = student.fullName || student.name || 'Unknown Student'
                  const initials = getInitials(studentName)

                  const videoStats = entry.progress?.videoStats || {
                    completed: entry.progress?.completedCount ?? (entry.completedLessonIds?.length || 0),
                    total: entry.progress?.totalLessons ?? (course.modules?.reduce((sum, m) => sum + (m.lessons?.length || m.contentItems?.filter(i => i.type === 'video-lesson')?.length || 0), 0) || 0)
                  }
                  const quizStats = entry.progress?.quizStats || { passed: 0, total: 0 }
                  const assessmentStats = entry.progress?.assessmentStats || { completed: 0, total: 0 }
                  const totalActivities = entry.progress?.totalRequiredActivities ?? videoStats.total
                  const completedActivities = entry.progress?.completedActivities ?? videoStats.completed
                  const percentage = entry.progress?.percentage ?? (totalActivities > 0 ? Math.round((completedActivities / totalActivities) * 100) : 0)
                  const isComplete = Boolean(entry.progress?.isCompleted || entry.status === 'completed')
                  const displayStatus = isComplete ? 'completed' : (entry.status || 'active')

                  return (
                    <tr key={entry._id}>
                      {/* 1. Student */}
                      <td>
                        <div className="admin-enrollment-student">
                          <div className="admin-enrollment-avatar" aria-hidden="true">
                            {initials}
                          </div>
                          <div className="admin-enrollment-student__info">
                            <span className="admin-enrollment-student__name" title={studentName}>
                              {studentName}
                            </span>
                            <span className="admin-enrollment-student__email" title={student.email}>
                              {student.email || 'No email'}
                            </span>
                            {student.username && (
                              <span className="admin-enrollment-student__username">
                                @{student.username}
                              </span>
                            )}
                          </div>
                        </div>
                      </td>

                      {/* 2. Course */}
                      <td>
                        <div className="admin-enrollment-course">
                          {course.thumbnailUrl ? (
                            <img
                              className="admin-enrollment-course__thumb"
                              src={course.thumbnailUrl}
                              alt=""
                              loading="lazy"
                            />
                          ) : (
                            <div className="admin-enrollment-course__thumb admin-enrollment-course__thumb--placeholder">
                              <Icon name="book" size={16} />
                            </div>
                          )}
                          <div>
                            <div className="admin-enrollment-course__title" title={course.title}>
                              {course.title || 'Untitled Course'}
                            </div>
                            <span className="admin-enrollment-course__category">
                              {course.category || 'General'}
                            </span>
                          </div>
                        </div>
                      </td>

                      {/* 3. Student Type / College */}
                      <td>
                        <div className="admin-enrollment-type-cell">
                          <span
                            className={`admin-type-pill ${
                              isCollege ? 'admin-type-pill--college' : 'admin-type-pill--independent'
                            }`}
                          >
                            {isCollege ? 'College Student' : 'Independent'}
                          </span>
                          {isCollege && (
                            <span className="admin-college-name" title={college.name}>
                              <Icon name="college" size={12} />
                              {college.name || 'Assigned College'}
                            </span>
                          )}
                        </div>
                      </td>

                      {/* 4. Enrollment Date */}
                      <td>
                        <div className="admin-enrollment-date">
                          {formatDate(entry.createdAt)}
                          <span className="admin-enrollment-date__sub">
                            {getRelativeTime(entry.createdAt)}
                          </span>
                        </div>
                      </td>

                      {/* 5. Learning Progress */}
                      <td>
                        <div className="admin-enrollment-progress">
                          <div className="admin-enrollment-progress__labels">
                            <span className="admin-enrollment-progress__count">
                              {completedActivities} of {totalActivities} activities
                            </span>
                            <span className="admin-enrollment-progress__pct">
                              {percentage}%
                            </span>
                          </div>
                          <div className="admin-enrollment-progress__track" role="progressbar" aria-valuenow={percentage} aria-valuemin="0" aria-valuemax="100">
                            <div
                              className={`admin-enrollment-progress__fill ${
                                isComplete ? 'admin-enrollment-progress__fill--complete' : ''
                              }`}
                              style={{ width: `${Math.min(100, percentage)}%` }}
                            />
                          </div>
                          <div className="admin-enrollment-progress__breakdown">
                            <span
                              className={`admin-enrollment-breakdown-pill ${videoStats.total > 0 && videoStats.completed >= videoStats.total ? 'admin-enrollment-breakdown-pill--complete' : ''}`}
                              title={`Video Lessons: ${videoStats.completed} completed of ${videoStats.total}`}
                            >
                              🎥 {videoStats.completed}/{videoStats.total}
                            </span>
                            {quizStats.total > 0 && (
                              <span
                                className={`admin-enrollment-breakdown-pill ${quizStats.passed >= quizStats.total ? 'admin-enrollment-breakdown-pill--complete' : ''}`}
                                title={`Quizzes: ${quizStats.passed} passed of ${quizStats.total}`}
                              >
                                📝 {quizStats.passed}/{quizStats.total}
                              </span>
                            )}
                            {assessmentStats.total > 0 && (
                              <span
                                className={`admin-enrollment-breakdown-pill ${assessmentStats.completed >= assessmentStats.total ? 'admin-enrollment-breakdown-pill--complete' : ''}`}
                                title={`Assessments: ${assessmentStats.completed} completed of ${assessmentStats.total}`}
                              >
                                🎯 {assessmentStats.completed}/{assessmentStats.total}
                              </span>
                            )}
                          </div>
                        </div>
                      </td>

                      {/* 6. Status */}
                      <td>
                        <span
                          className={`admin-enrollment-status-badge admin-enrollment-status-badge--${displayStatus}`}
                        >
                          <span className="admin-enrollment-status-badge__dot" />
                          {displayStatus}
                        </span>
                        {entry.completedAt && (
                          <span className="admin-enrollment-completed-date" title={`Completed on ${formatDateTime(entry.completedAt)}`}>
                            Completed: {formatDate(entry.completedAt)}
                          </span>
                        )}
                      </td>

                      {/* 7. Actions */}
                      <td style={{ textAlign: 'right' }}>
                        <button
                          type="button"
                          className="admin-enrollment-action-btn"
                          onClick={() => setSelectedEnrollment(entry)}
                          title="View complete enrollment details"
                        >
                          <Icon name="eye" size={13} />
                          <span>View Details</span>
                        </button>
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>

        {/* 5. Pagination Footer */}
        {!isLoading && filteredEnrollments.length > 0 && (
          <div className="admin-enrollment-pagination">
            <div className="admin-enrollment-pagination__size">
              <span>Show</span>
              <select
                value={pageSize}
                onChange={(e) => setPageSize(Number(e.target.value))}
                aria-label="Items per page"
              >
                <option value="10">10</option>
                <option value="25">25</option>
                <option value="50">50</option>
                <option value="100">100</option>
              </select>
              <span>per page</span>
              <span>·</span>
              <span>
                Showing <strong>{(currentPage - 1) * pageSize + 1}</strong>–
                <strong>{Math.min(currentPage * pageSize, filteredEnrollments.length)}</strong> of{' '}
                <strong>{filteredEnrollments.length}</strong>
              </span>
            </div>

            <div className="admin-enrollment-pagination__controls">
              <button
                type="button"
                className="admin-enrollment-page-btn"
                onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                disabled={currentPage <= 1}
                aria-label="Previous page"
              >
                ‹
              </button>
              {Array.from({ length: totalPages }).map((_, i) => {
                const pageNum = i + 1
                if (
                  pageNum === 1 ||
                  pageNum === totalPages ||
                  (pageNum >= currentPage - 1 && pageNum <= currentPage + 1)
                ) {
                  return (
                    <button
                      key={pageNum}
                      type="button"
                      className={`admin-enrollment-page-btn ${
                        pageNum === currentPage ? 'is-active' : ''
                      }`}
                      onClick={() => setCurrentPage(pageNum)}
                    >
                      {pageNum}
                    </button>
                  )
                }
                if (pageNum === currentPage - 2 || pageNum === currentPage + 2) {
                  return <span key={pageNum} style={{ padding: '0 4px', color: 'var(--admin-muted)' }}>…</span>
                }
                return null
              })}
              <button
                type="button"
                className="admin-enrollment-page-btn"
                onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                disabled={currentPage >= totalPages}
                aria-label="Next page"
              >
                ›
              </button>
            </div>
          </div>
        )}
      </div>

      {/* 6. Details Drawer (Slide-Over Panel) */}
      {selectedEnrollment && (
        <div
          className="admin-drawer-backdrop"
          onClick={() => setSelectedEnrollment(null)}
          role="dialog"
          aria-modal="true"
          aria-labelledby="drawer-title"
        >
          <div
            className="admin-drawer"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="admin-drawer__header">
              <div className="admin-drawer__header-left">
                <h2 id="drawer-title" className="admin-drawer__title">
                  Enrollment Details
                </h2>
                <span className="admin-drawer__id">
                  ID: {selectedEnrollment._id}
                </span>
              </div>
              <button
                type="button"
                className="admin-drawer__close"
                onClick={() => setSelectedEnrollment(null)}
                aria-label="Close details"
              >
                <Icon name="close" size={16} />
              </button>
            </div>

            <div className="admin-drawer__content">
              {/* Student Card */}
              <div className="admin-drawer-card">
                <h3 className="admin-drawer-card__heading">Student Information</h3>
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '14px' }}>
                  <div className="admin-enrollment-avatar" style={{ width: '42px', height: '42px', fontSize: '15px' }}>
                    {getInitials(selectedEnrollment.userId?.fullName || selectedEnrollment.userId?.name)}
                  </div>
                  <div>
                    <strong style={{ display: 'block', fontSize: '15px', color: 'var(--admin-ink)' }}>
                      {selectedEnrollment.userId?.fullName || selectedEnrollment.userId?.name || 'Unknown Student'}
                    </strong>
                    <span style={{ fontSize: '12px', color: 'var(--admin-muted)' }}>
                      {selectedEnrollment.userId?.email || 'No email on record'}
                    </span>
                  </div>
                </div>
                <dl className="admin-drawer-grid">
                  <div className="admin-drawer-prop">
                    <dt>Username</dt>
                    <dd>{selectedEnrollment.userId?.username ? `@${selectedEnrollment.userId.username}` : 'N/A'}</dd>
                  </div>
                  <div className="admin-drawer-prop">
                    <dt>Account Type</dt>
                    <dd>
                      {selectedEnrollment.userId?.studentType === 'college' || selectedEnrollment.collegeId
                        ? 'College Student'
                        : 'Independent Student'}
                    </dd>
                  </div>
                  {selectedEnrollment.collegeId && (
                    <div className="admin-drawer-prop" style={{ gridColumn: 'span 2' }}>
                      <dt>Associated College</dt>
                      <dd>{selectedEnrollment.collegeId.name || 'Assigned College'}</dd>
                    </div>
                  )}
                </dl>
              </div>

              {/* Course Card */}
              <div className="admin-drawer-card">
                <h3 className="admin-drawer-card__heading">Course Information</h3>
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '12px' }}>
                  {selectedEnrollment.courseId?.thumbnailUrl ? (
                    <img
                      src={selectedEnrollment.courseId.thumbnailUrl}
                      alt=""
                      style={{ width: '56px', height: '40px', borderRadius: '6px', objectFit: 'cover' }}
                    />
                  ) : (
                    <div className="admin-enrollment-course__thumb admin-enrollment-course__thumb--placeholder" style={{ width: '56px', height: '40px' }}>
                      <Icon name="book" size={20} />
                    </div>
                  )}
                  <div>
                    <strong style={{ display: 'block', fontSize: '14px', color: 'var(--admin-ink)' }}>
                      {selectedEnrollment.courseId?.title || 'Untitled Course'}
                    </strong>
                    <span className="admin-enrollment-course__category">
                      {selectedEnrollment.courseId?.category || 'General'}
                    </span>
                  </div>
                </div>
              </div>

              {/* Enrollment Info Card */}
              <div className="admin-drawer-card">
                <h3 className="admin-drawer-card__heading">Enrollment Status & Dates</h3>
                <dl className="admin-drawer-grid">
                  <div className="admin-drawer-prop">
                    <dt>Enrollment Status</dt>
                    <dd>
                      <span className={`admin-enrollment-status-badge admin-enrollment-status-badge--${selectedEnrollment.status || 'active'}`}>
                        <span className="admin-enrollment-status-badge__dot" />
                        {selectedEnrollment.status || 'active'}
                      </span>
                    </dd>
                  </div>
                  <div className="admin-drawer-prop">
                    <dt>Date Enrolled</dt>
                    <dd>{formatDateTime(selectedEnrollment.createdAt)}</dd>
                  </div>
                  <div className="admin-drawer-prop">
                    <dt>Completion Date</dt>
                    <dd>
                      {selectedEnrollment.completedAt ? (
                        <span style={{ color: '#2e7d32', fontWeight: 600 }}>
                          {formatDateTime(selectedEnrollment.completedAt)}
                        </span>
                      ) : (
                        <span style={{ color: 'var(--admin-muted)' }}>Not completed yet</span>
                      )}
                    </dd>
                  </div>
                  <div className="admin-drawer-prop">
                    <dt>Last Activity</dt>
                    <dd>{formatDateTime(selectedEnrollment.lastActivityAt || selectedEnrollment.updatedAt)}</dd>
                  </div>
                </dl>
              </div>

              {/* Progress & Activity Breakdown */}
              <div className="admin-drawer-card">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                  <h3 className="admin-drawer-card__heading" style={{ margin: 0 }}>Learning Progress</h3>
                  <strong style={{ fontSize: '16px', color: 'var(--admin-ink)' }}>
                    {selectedEnrollment.progress?.percentage ?? 0}%
                  </strong>
                </div>
                <div className="admin-enrollment-progress__track" style={{ height: '8px', marginBottom: '14px' }}>
                  <div
                    className={`admin-enrollment-progress__fill ${
                      (selectedEnrollment.progress?.isCompleted || selectedEnrollment.status === 'completed') ? 'admin-enrollment-progress__fill--complete' : ''
                    }`}
                    style={{ width: `${Math.min(100, selectedEnrollment.progress?.percentage ?? 0)}%` }}
                  />
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '8px', marginBottom: '16px' }}>
                  <div style={{ padding: '8px 10px', background: 'var(--admin-cream)', borderRadius: '6px', textAlign: 'center' }}>
                    <div style={{ fontSize: '10px', textTransform: 'uppercase', color: 'var(--admin-muted)', fontWeight: 600 }}>
                      🎥 Videos
                    </div>
                    <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--admin-ink)', marginTop: '2px' }}>
                      {selectedEnrollment.progress?.videoStats?.completed ?? (selectedEnrollment.progress?.completedCount || 0)} / {selectedEnrollment.progress?.videoStats?.total ?? (selectedEnrollment.progress?.totalLessons || 0)}
                    </div>
                  </div>
                  <div style={{ padding: '8px 10px', background: 'var(--admin-cream)', borderRadius: '6px', textAlign: 'center' }}>
                    <div style={{ fontSize: '10px', textTransform: 'uppercase', color: 'var(--admin-muted)', fontWeight: 600 }}>
                      📝 Quizzes
                    </div>
                    <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--admin-ink)', marginTop: '2px' }}>
                      {selectedEnrollment.progress?.quizStats?.passed ?? 0} / {selectedEnrollment.progress?.quizStats?.total ?? 0}
                    </div>
                  </div>
                  <div style={{ padding: '8px 10px', background: 'var(--admin-cream)', borderRadius: '6px', textAlign: 'center' }}>
                    <div style={{ fontSize: '10px', textTransform: 'uppercase', color: 'var(--admin-muted)', fontWeight: 600 }}>
                      🎯 Assessments
                    </div>
                    <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--admin-ink)', marginTop: '2px' }}>
                      {selectedEnrollment.progress?.assessmentStats?.completed ?? 0} / {selectedEnrollment.progress?.assessmentStats?.total ?? 0}
                    </div>
                  </div>
                </div>

                {selectedEnrollment.progress?.sequence && selectedEnrollment.progress.sequence.length > 0 ? (
                  <div>
                    <span style={{ fontSize: '11px', fontWeight: '700', textTransform: 'uppercase', color: 'var(--admin-muted)' }}>
                      Sequenced Curriculum Activities ({selectedEnrollment.progress.sequence.filter(a => a.isCompleted).length}/{selectedEnrollment.progress.sequence.length})
                    </span>
                    <div className="admin-drawer-lesson-list">
                      {selectedEnrollment.progress.sequence.map((act) => (
                        <div
                          key={act.id}
                          className={`admin-drawer-lesson-item ${act.isCompleted ? 'is-completed' : act.isFailed ? 'is-failed' : ''}`}
                        >
                          <div style={{ display: 'flex', alignItems: 'center', minWidth: 0 }}>
                            <span className={`admin-drawer-activity-badge admin-drawer-activity-badge--${act.type === 'video-lesson' ? 'video' : act.type}`}>
                              {(act.type === 'video' || act.type === 'video-lesson') ? '🎥 Video' : act.type === 'quiz' ? '📝 Quiz' : '🎯 Assessment'}
                            </span>
                            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={act.title}>
                              #{act.sequenceNumber}. {act.title}
                            </span>
                          </div>
                          <span
                            className={`admin-drawer-lesson-item__status ${
                              act.isCompleted
                                ? 'admin-drawer-lesson-item__status--completed'
                                : act.isFailed
                                ? 'admin-drawer-lesson-item__status--failed'
                                : 'admin-drawer-lesson-item__status--pending'
                            }`}
                          >
                            {act.isCompleted ? '✓ Completed' : act.isFailed ? '✗ Failed' : 'Pending'}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : selectedEnrollment.progress?.allLessons && selectedEnrollment.progress.allLessons.length > 0 ? (
                  <div>
                    <span style={{ fontSize: '11px', fontWeight: '700', textTransform: 'uppercase', color: 'var(--admin-muted)' }}>
                      Lesson Breakdown
                    </span>
                    <div className="admin-drawer-lesson-list">
                      {selectedEnrollment.progress.allLessons.map((les) => (
                        <div
                          key={les.id}
                          className={`admin-drawer-lesson-item ${les.isCompleted ? 'is-completed' : ''}`}
                        >
                          <span>{les.title}</span>
                          <span
                            className={`admin-drawer-lesson-item__status ${
                              les.isCompleted
                                ? 'admin-drawer-lesson-item__status--completed'
                                : 'admin-drawer-lesson-item__status--pending'
                            }`}
                          >
                            {les.isCompleted ? '✓ Completed' : 'Pending'}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            </div>

            <div className="admin-drawer__footer">
              <button
                type="button"
                className="admin-enrollment-btn admin-enrollment-btn--secondary"
                onClick={() => setSelectedEnrollment(null)}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}

