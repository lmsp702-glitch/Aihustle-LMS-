import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, Navigate, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom'
import { API_BASE_URL } from './api-base-url.js'
import {
  EmailSupportPage,
  HelpCenterHome,
  SubmitComplaintPage,
  SubmitSupportTicketPage,
  SupportFaqPage,
  SupportRequestsPage,
  SupportTicketDetailPage,
} from './SupportCenter.jsx'
import SettingsPage from './SettingsPage.jsx'
import ThemeToggle from './ThemeToggle.jsx'
import { fetchWithAuth, isInvalidSessionResponse } from './auth-session.js'
import NotificationFeed from './NotificationFeed.jsx'
import StudentNotificationBell from './StudentNotificationBell.jsx'
import StudentNotificationsPage from './StudentNotificationsPage.jsx'
import StudentQuizExperience from './StudentQuizPanel.jsx'
import { filterCoursesByCategory, getCourseCategoryNames, normalizeCourseCategory } from './course-categories.js'
import { findActiveTranscriptCueIndex, formatTranscriptTime } from './srt-transcript.js'
import { createAttentionCheckSchedule } from './video-attention-checks.js'
import './StudentDashboard.css'
import './StudentNotesSystem.css'
import StudentNotesSection from './StudentNotesSystem.jsx'
import StudentLearningResourcesPage from './StudentLearningResourcesPage.jsx'



const studentCertificateCache = new Map()
const studentCertificateRequests = new Map()
const studentCertificateCacheTtlMs = 30_000
const studentLearningPageCacheTtlMs = 30_000
const studentEnrollmentCache = new Map()
const studentEnrollmentRequests = new Map()
const studentCourseContentCache = new Map()
const studentCourseContentRequests = new Map()
const studentPageCertificateRequests = new Map()
const studentResultsCache = new Map()
const COURSE_NOTES_KEY = 'course-notes'
const COURSE_RESOURCES_KEY = 'course-resources'
const COURSE_CERTIFICATE_KEY = 'course-certificate'

function getStudentCertificateCacheKey() {
  try {
    const auth = JSON.parse(sessionStorage.getItem('lms.auth') || 'null')
    return typeof auth?.user?.id === 'string' ? auth.user.id : ''
  } catch {
    return ''
  }
}


const navigation = [
  { label: 'Dashboard', icon: 'grid', path: '/student/dashboard' },
  { label: 'My Courses', icon: 'book', path: '/student/courses' },
  { label: 'Quizzes & Assignments', icon: 'clipboardCheck', path: '/student/assignments' },
  { label: 'Grades & Results', icon: 'chart', path: '/student/results' },
  { label: 'Learning Resources', icon: 'folder', path: '/student/resources' },
  { label: 'Messages', icon: 'message', path: '/student/messages' },
  { label: 'Certificates', icon: 'award', path: '/student/certificates' },
  { label: 'My Referrals', icon: 'users', path: '/student/referrals' },
  { label: 'My Profile', icon: 'user', path: '/student/profile' },
  { label: 'Settings', icon: 'settings', path: '/student/settings' },
  { label: 'Help Center', icon: 'help', path: '/student/help' },
]

const secondaryPages = {
  '/student/announcements': { label: 'Notifications', icon: 'bell' },
  '/student/updates': { label: 'Updates', icon: 'bell' },
  '/student/purchases': { label: 'My Purchases', icon: 'bookOpen' },
  '/student/achievements': { label: 'My Achievements', icon: 'award' },
  '/student/learning-activity': { label: 'Learning Streak', icon: 'chartNoAxesCombined' },
  '/student/study-companion': { label: 'AI Study Companion', icon: 'spark' },
}

const stats = [
  { label: 'Enrolled courses', value: 'enrolledCourses', caption: 'courses in your learning plan', icon: 'book', tone: 'gold' },
  { label: 'Pending assignments', value: 'pendingAssignments', caption: 'assignments awaiting submission', icon: 'check', tone: 'peach' },
  { label: 'Completed courses', value: 'completedCourses', caption: 'courses with every lesson complete', icon: 'award', tone: 'mint' },
  { label: 'Learning streak', value: 'learningStreak', caption: 'consecutive active days', icon: 'spark', tone: 'blue' },
]

const emptyLearningSummary = {
  enrolledCourses: 0,
  pendingAssignments: 0,
  completedCourses: 0,
  learningStreak: 0,
  completedLessons: 0,
  inProgressLessons: 0,
  notStartedLessons: 0,
  totalLessons: 0,
  completionPercentage: 0,
}

const categories = [
  { label: 'Digital Marketing', icon: 'chart' },
  { label: 'Python', icon: 'code' },
  { label: 'Prompt Engineering', icon: 'spark' },
  { label: 'UI/UX Design', icon: 'pen' },
  { label: 'Full Stack Development', icon: 'laptop' },
  { label: 'Web Development', icon: 'laptop' },
]

const tools = [
  { title: 'Grades & Results', description: 'View your quiz and assignment scores.', icon: 'chart', id: 'student-grades', path: '/student/results' },
  { title: 'Learning Resources', description: 'Access course notes and learning materials.', icon: 'folder', id: 'student-resources', path: '/student/resources' },
  { title: 'Messages', description: 'Open course conversations and updates.', icon: 'message', id: 'student-messages', path: '/student/messages' },
  { title: 'Certificates', description: 'View and download your earned certificates.', icon: 'award', id: 'student-certificates', path: '/student/certificates' },
  { title: 'My Profile', description: 'Review your personal and academic details.', icon: 'user', id: 'student-profile', path: '/student/profile' },
  { title: 'Settings', description: 'Manage your account and preferences.', icon: 'settings', id: 'student-settings', path: '/student/settings' },
]



function Icon({ name, size = 19 }) {
  const paths = {
    layoutDashboard: <><rect x="3" y="3" width="7" height="9" rx="1" /><rect x="14" y="3" width="7" height="5" rx="1" /><rect x="14" y="12" width="7" height="9" rx="1" /><rect x="3" y="16" width="7" height="5" rx="1" /></>,
    bookOpen: <><path d="M12 7v14" /><path d="M3 18V5a1 1 0 0 1 1-1h4a4 4 0 0 1 4 4 4 4 0 0 1 4-4h4a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-4a4 4 0 0 0-4 2 4 4 0 0 0-4-2H4a1 1 0 0 1-1-1Z" /></>,
    file: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6M8 13h8m-8 4h8" /></>,
    play: <><circle cx="12" cy="12" r="9" /><path d="m10 8 6 4-6 4z" /></>,
    clipboardCheck: <><rect x="8" y="4" width="8" height="4" rx="1" /><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" /><path d="m9 14 2 2 4-4" /></>,
    chartNoAxesCombined: <><path d="M3 3v18h18" /><path d="m19 9-5 5-4-4-5 5" /></>,
    messageCircle: <><path d="M20 11.5a7.5 7.5 0 0 1-7.5 7.5 8 8 0 0 1-3.5-.8L4 20l1.5-4A7.5 7.5 0 1 1 20 11.5Z" /><path d="M8 11h.01M12 11h.01M16 11h.01" /></>,
    userRound: <><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></>,
    circleHelp: <><circle cx="12" cy="12" r="9" /><path d="M9.6 9a2.5 2.5 0 1 1 4.5 1.5c-.9 1.1-2.1 1.3-2.1 3m0 3h.01" /></>,
    grid: <><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></>,
    book: <><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v16H6.5A2.5 2.5 0 0 0 4 21.5z" /><path d="M4 5.5v16M8 7h8m-8 4h8" /></>,
    link: <><path d="M10 13a5 5 0 0 0 7.1 0l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1" /><path d="M14 11a5 5 0 0 0-7.1 0l-2 2A5 5 0 0 0 12 20l1.1-1.1" /></>,
    check: <><rect x="4" y="4" width="16" height="17" rx="2" /><path d="M8 3v3m8-3v3M4 9h16m-11 5 2 2 4-4" /></>,
    chart: <><path d="M4 19V5m0 14h17" /><path d="m7 15 4-4 3 2 5-6m-4 0h4v4" /></>,
    folder: <><path d="M3 6.5A2.5 2.5 0 0 1 5.5 4H10l2 2h6.5A2.5 2.5 0 0 1 21 8.5v9a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z" /><path d="M3 9h18" /></>,
    folderOpen: <><path d="M3 7V5.5A1.5 1.5 0 0 1 4.5 4H10l2 2h6.5A1.5 1.5 0 0 1 20 7.5V9" /><path d="M3 10h18l-2.1 8.4a2 2 0 0 1-1.9 1.6H5a2 2 0 0 1-2-2z" /></>,
    message: <><path d="M20 11.5a7.5 7.5 0 0 1-7.5 7.5 8 8 0 0 1-3.5-.8L4 20l1.5-4A7.5 7.5 0 1 1 20 11.5Z" /><path d="M8 11h.01M12 11h.01M16 11h.01" /></>,
    award: <><circle cx="12" cy="8" r="5" /><path d="m8.5 12-1 9 4.5-2.5 4.5 2.5-1-9" /></>,
    user: <><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></>,
    settings: <><circle cx="12" cy="12" r="3" /><path d="m19.4 15 .1.1 1.4 1.1-1.4 2.4-1.8-.6a8 8 0 0 1-1.7 1l-.3 1.9h-2.8l-.3-1.9a8 8 0 0 1-1.7-1l-1.8.6-1.4-2.4 1.4-1.1a7 7 0 0 1 0-2l-1.4-1.1 1.4-2.4 1.8.6a8 8 0 0 1 1.7-1l.3-1.9h2.8l.3 1.9a8 8 0 0 1 1.7 1l1.8-.6 1.4 2.4-1.4 1.1a7 7 0 0 1 0 2Z" transform="translate(-1 -1)" /></>,
    spark: <><path d="m12 2 1.7 6.3L20 10l-6.3 1.7L12 18l-1.7-6.3L4 10l6.3-1.7z" /><path d="m19 15 .8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z" /></>,
    search: <><circle cx="10.8" cy="10.8" r="6.8" /><path d="m16 16 4.5 4.5" /></>,
    eye: <><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="3" /></>,
    bell: <><path d="M18 9a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9m-8 12a2 2 0 0 0 4 0" /></>,
    help: <><circle cx="12" cy="12" r="9" /><path d="M9.6 9a2.5 2.5 0 1 1 4.5 1.5c-.9 1.1-2.1 1.3-2.1 3m0 3h.01" /></>,
    menu: <><path d="M4 6h16M4 12h16M4 18h16" /></>,
    logout: <><path d="M10 17l5-5-5-5m5 5H3" /><path d="M12 3h6a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-6" /></>,
    arrow: <><path d="M5 12h14m-6-6 6 6-6 6" /></>,
    clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
    circleX: <><circle cx="12" cy="12" r="9" /><path d="m9 9 6 6m0-6-6 6" /></>,
    lock: <><rect x="4" y="10" width="16" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></>,
    briefcase: <><rect x="3" y="7" width="18" height="14" rx="2" /><path d="M8 7V4h8v3m-13 5h18m-11 0v2h4v-2" /></>,
    code: <><path d="m8 7-5 5 5 5m8-10 5 5-5 5m-3-12-2 14" /></>,
    laptop: <><rect x="4" y="4" width="16" height="12" rx="1.5" /><path d="M2 20h20l-2-4H4z" /></>,
    rocket: <><path d="M12 15 9 12c.5-4 3.5-7 10-9-.5 6.5-3.5 9.5-7 10Z" /><path d="m9 12-4 1-2 4 5-1m4-1 1 4 4 2-1-5" /><circle cx="15" cy="8" r="1" /></>,
    health: <><path d="M12 22s8-4 8-11V5l-8-3-8 3v6c0 7 8 11 8 11Z" /><path d="M12 8v7m-3.5-3.5h7" /></>,
    globe: <><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18" /></>,
    users: <><circle cx="9" cy="8" r="3" /><path d="M3 20v-1a6 6 0 0 1 12 0v1Zm12-9a3 3 0 1 0-1-5.8M17 14a5 5 0 0 1 4 5v1h-3" /></>,
    pen: <><path d="m4 20 4.5-1 10-10a2.1 2.1 0 0 0-3-3l-10 10L4 20Z" /><path d="m14 7 3 3" /></>,
    flask: <><path d="M9 3h6m-5 0v7l-6 10a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1l-6-10V3m-8 12h12" /></>,
    calculator: <><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M8 7h8v3H8zm0 7h.01M12 14h.01M16 14h.01M8 17h.01M12 17h.01M16 17h.01" /></>,
    database: <><ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" /></>,
    xCircle: <><circle cx="12" cy="12" r="9" /><path d="m15 9-6 6m0-6 6 6" /></>,
    alertCircle: <><circle cx="12" cy="12" r="9" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" /></>,
    download: <><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></>,
    printer: <><polyline points="6 9 6 2 18 2 18 9" /><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" /><rect x="6" y="14" width="12" height="8" /></>,
    chevronDown: <polyline points="6 9 12 15 18 9" />,
    chevronUp: <polyline points="18 15 12 9 6 15" />,
    pin: <><line x1="12" y1="17" x2="12" y2="22" /><path d="M5 17h14v-2l-3-4V4h1V2H7v2h1v7l-3 4v2z" /></>,
    trash: <><polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></>,
    plus: <><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></>,
  }

  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {paths[name] || paths.grid}
    </svg>
  )
}


function LearningIllustration() {
  return (
    <svg className="student-welcome__illustration" viewBox="0 0 240 172" fill="none" aria-hidden="true">
      <circle cx="154" cy="83" r="67" fill="#F7EBC8" />
      <circle cx="154" cy="83" r="52" fill="#E4F0E7" />
      <path d="M104 120h99" stroke="#AFC6B8" strokeWidth="2" strokeLinecap="round" />
      <path d="M126 119V74c0-4 3-7 7-7h42c4 0 7 3 7 7v45" fill="#FFFDF7" stroke="#D8D6C9" strokeWidth="2" />
      <path d="M147 67v52m-21-38h21m7 0h28m-28 12h28m-28 12h19" stroke="#7FA99A" strokeWidth="2" strokeLinecap="round" />
      <path d="M108 121c11-15 24-19 39-12 12 6 19 5 28 1" stroke="#D6B35B" strokeWidth="3" strokeLinecap="round" />
      <circle cx="101" cy="51" r="8" fill="#E8C460" />
      <path d="m197 38 3 7 7 3-7 3-3 7-3-7-7-3 7-3z" fill="#6BA99A" />
      <path d="M57 121h44m-35-9v9m26-9v9" stroke="#C9C7BA" strokeWidth="2" strokeLinecap="round" />
      <path d="M65 107h28l-3-30a11 11 0 0 0-22 0z" fill="#EBD789" />
      <path d="M72 91h14m-12 8h10" stroke="#A78A43" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}

function EmptyState({ icon, title, description }) {
  return (
    <div className="student-empty">
      <span className="student-empty__icon"><Icon name={icon} size={22} /></span>
      <h3>{title}</h3>
      <p>{description}</p>
    </div>
  )
}





function EarnedCertificateSkeleton() {
  return (
    <article className="student-certificates__earned-item" aria-hidden="true">
      <span className="student-certificates__skeleton-shape student-certificates__earned-art-skeleton" />
      <span className="student-certificates__earned-copy student-certificates__earned-copy-skeleton">
        <i className="student-certificates__skeleton-shape is-wide" />
        <i className="student-certificates__skeleton-shape is-medium" />
        <i className="student-certificates__skeleton-shape is-short" />
      </span>
      <span className="student-certificates__earned-actions">
        <i className="student-certificates__skeleton-shape is-action" />
        <i className="student-certificates__skeleton-shape is-action" />
      </span>
    </article>
  )
}

function InProgressCertificateSkeleton() {
  return (
    <article className="student-certificates__progress-card" aria-hidden="true">
      <div className="student-certificates__course-progress">
        <span className="student-certificates__course-art">
          <i className="student-certificates__skeleton-shape is-course-art" />
        </span>
        <span className="student-certificates__course-progress-copy">
          <i className="student-certificates__skeleton-shape is-wide" />
          <i className="student-certificates__skeleton-shape is-progress-meter" />
        </span>
        <i className="student-certificates__skeleton-shape is-course-arrow" />
      </div>
      <div className="student-certificates__remaining">
        <i className="student-certificates__skeleton-shape is-medium" />
        <i className="student-certificates__skeleton-shape is-wide" />
      </div>
    </article>
  )
}





function StudentRoutePage({ title, children, to, showHeading = false, className = '' }) {
  const Element = to ? Link : 'section'
  return (
    <Element className={`student-panel student-route-page ${className}`.trim()} {...(to ? { to } : {})}>
      {showHeading && (
        <div className="student-section-heading">
          <div>
            <h2>{title}</h2>
          </div>
        </div>
      )}
      {children}
    </Element>
  )
}





function StudentCertificatesPage({ user, onLogout }) {
  const navigate = useNavigate()
  const initialCache = studentCertificateCache.get(getStudentCertificateCacheKey())
  const [courses, setCourses] = useState(initialCache?.certificates || null)
  const [isLoading, setIsLoading] = useState(!initialCache)
  const [error, setError] = useState('')
  const [earnedSearch, setEarnedSearch] = useState('')
  const [preview, setPreview] = useState(null)
  const [activeCertificate, setActiveCertificate] = useState('')
  const previewUrlRef = useRef('')

  async function studentRequest(path) {
    let auth
    try {
      auth = JSON.parse(sessionStorage.getItem('lms.auth') || 'null')
    } catch {
      onLogout()
      throw new Error('Your saved student session is invalid. Please sign in again.')
    }
    if (typeof auth?.token !== 'string') {
      onLogout()
      throw new Error('Your session has ended. Please sign in again.')
    }
    const response = await fetchWithAuth(`${API_BASE_URL}${path}`, {
      headers: { Authorization: `Bearer ${auth.token}` },
    }, API_BASE_URL, auth.token)
    const result = await response.json().catch(() => ({}))
    if (isInvalidSessionResponse(response, result)) {
      onLogout()
      throw new Error('Your session has ended. Please sign in again.')
    }
    if (!response.ok) throw new Error(result.message || 'The certificate request could not be completed.')
    return result
  }

  async function loadCertificates(forceRefresh = false) {
    const cacheKey = getStudentCertificateCacheKey()
    const cached = cacheKey ? studentCertificateCache.get(cacheKey) : null
    const hasCachedData = Array.isArray(cached?.certificates)
    if (hasCachedData) {
      setCourses(cached.certificates)
      setIsLoading(false)
    } else {
      setIsLoading(true)
    }
    setError('')

    if (
      !forceRefresh
      && hasCachedData
      && Date.now() - cached.savedAt < studentCertificateCacheTtlMs
    ) return

    let request = cacheKey ? studentCertificateRequests.get(cacheKey) : null
    try {
      if (!request) {
        request = studentRequest('/certificates').then((result) => {
          if (!Array.isArray(result.certificates)) {
            throw new Error('The server returned invalid certificate data.')
          }
          if (cacheKey) {
            studentCertificateCache.set(cacheKey, {
              certificates: result.certificates,
              savedAt: Date.now(),
            })
          }
          return result.certificates
        })
        if (cacheKey) studentCertificateRequests.set(cacheKey, request)
      }
      setCourses(await request)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Certificates could not be loaded.')
    } finally {
      if (!hasCachedData) setIsLoading(false)
      if (cacheKey && studentCertificateRequests.get(cacheKey) === request) {
        studentCertificateRequests.delete(cacheKey)
      }
    }
  }

  useEffect(() => {
    loadCertificates()
    return () => {
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current)
    }
  }, [])

  async function openCertificate(certificate, download) {
    setActiveCertificate(certificate.id)
    setError('')
    try {
      let auth
      try {
        auth = JSON.parse(sessionStorage.getItem('lms.auth') || 'null')
      } catch {
        onLogout()
        throw new Error('Your saved student session is invalid. Please sign in again.')
      }
      if (typeof auth?.token !== 'string') {
        onLogout()
        throw new Error('Your session has ended. Please sign in again.')
      }
      const response = await fetchWithAuth(
        `${API_BASE_URL}/certificates/${encodeURIComponent(certificate.id)}/pdf${download ? '?download=true' : ''}`,
        { headers: { Authorization: `Bearer ${auth.token}` } },
        API_BASE_URL,
        auth.token,
      )
      const result = response.ok ? null : await response.json().catch(() => ({}))
      if (isInvalidSessionResponse(response, result)) {
        onLogout()
        throw new Error('Your session has ended. Please sign in again.')
      }
      if (!response.ok) throw new Error(result?.message || 'The certificate PDF could not be opened.')

      const objectUrl = URL.createObjectURL(await response.blob())
      if (download) {
        const link = document.createElement('a')
        link.href = objectUrl
        link.download = `aiHustle-certificate-${certificate.certificateId}.pdf`
        document.body.append(link)
        link.click()
        link.remove()
        window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000)
      } else {
        if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current)
        previewUrlRef.current = objectUrl
        setPreview(certificate)
      }
    } catch (certificateError) {
      setError(certificateError instanceof Error ? certificateError.message : 'The certificate PDF could not be opened.')
    } finally {
      setActiveCertificate('')
    }
  }

  function closePreview() {
    setPreview(null)
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current)
      previewUrlRef.current = ''
    }
  }

  const hasCertificateData = Array.isArray(courses)
  const certificateCourses = hasCertificateData ? courses : []
  const earnedCourses = certificateCourses.filter((course) => course.certificate)
  const matchingEarnedCourses = earnedCourses.filter((course) => (
    String(course.courseName || '').toLowerCase().includes(earnedSearch.trim().toLowerCase())
  ))
  const inProgressCourses = certificateCourses.filter((course) => !course.certificate)
  function continueCourse(course, pendingRequirements) {
    const courseId = String(course.courseId || '')
    if (!courseId) return
    const firstIncomplete = pendingRequirements.find((requirement) => (
      ['video', 'quiz', 'assignment'].includes(requirement.type)
      && typeof requirement.id === 'string'
      && requirement.id
    ))
    const query = new URLSearchParams()
    if (firstIncomplete?.type === 'video') {
      query.set('lesson', firstIncomplete.id)
    } else if (firstIncomplete) {
      query.set('activity', firstIncomplete.id)
      query.set('activityType', firstIncomplete.type)
    }
    const search = query.toString()
    navigate(`/student/course/${encodeURIComponent(courseId)}/learn${search ? `?${search}` : ''}`)
  }

  function getRequirementStatus(requirement) {
    if (requirement.type === 'assignment') {
      return requirement.status === 'awaiting-review' ? 'Awaiting Admin review'
        : requirement.status === 'resubmit' ? 'Resubmit required' : 'Not submitted'
    }
    if (requirement.type === 'quiz') return 'Pass required'
    if (requirement.type === 'profile') return 'Update profile'
    if (requirement.type === 'course') return 'Admin setup required'
    return 'Not completed'
  }

  return (
    <StudentRoutePage title="Certificates" className="student-certificates-page">
      <header className="student-certificates__hero">
        <div className="student-certificates__hero-copy">
          <h1>Certificates</h1>
          <p>Your course completion certificates, all in one place.</p>
          <span aria-hidden="true" />
        </div>
        <div className="student-certificates__hero-art" aria-hidden="true">
          <div className="student-certificates__diploma"><span /><i /><b /></div>
          <div className="student-certificates__diploma-seal"><Icon name="award" size={28} /></div>
          <span className="student-certificates__leaf student-certificates__leaf--one" />
          <span className="student-certificates__leaf student-certificates__leaf--two" />
        </div>
      </header>
      <section className="student-certificates__summary" aria-label="Certificate summary">
        {[
          { label: 'Certificates Earned', count: earnedCourses.length, icon: 'award', tone: 'gold' },
          { label: 'In Progress', count: inProgressCourses.length, icon: 'bookOpen', tone: 'green' },
          { label: 'Total Courses', count: certificateCourses.length, icon: 'spark', tone: 'amber' },
        ].map((stat) => (
          <div className="student-certificates__summary-card" key={stat.label}>
            <span className={`student-certificates__summary-icon is-${stat.tone}`}><Icon name={stat.icon} size={25} /></span>
            <span>
              <strong>
                {hasCertificateData
                  ? stat.count
                  : isLoading
                    ? <i className="student-certificates__skeleton-shape is-summary-count" aria-hidden="true" />
                    : '—'}
              </strong>
              <small>{stat.label}</small>
            </span>
          </div>
        ))}
      </section>
      {error && <p className="student-certificates__error" role="alert">{error}</p>}
      {hasCertificateData && certificateCourses.length === 0
        ? <EmptyState icon="award" title="No enrolled courses yet" description="Certificate status will appear here after you enroll in a course." />
        : <div className="student-certificates__columns" aria-busy={!hasCertificateData && isLoading}>
            <section className="student-certificates__panel student-certificates__panel--earned" aria-labelledby="student-certificates-earned-title">
              <header className="student-certificates__panel-heading">
                <span className="student-certificates__panel-icon"><Icon name="award" size={34} /></span>
                <div><h2 id="student-certificates-earned-title">Earned Certificates</h2><p>Courses you have successfully completed.</p></div>
                {hasCertificateData
                  ? <span className="student-certificates__count">{earnedCourses.length} {earnedCourses.length === 1 ? 'Certificate' : 'Certificates'}</span>
                  : isLoading
                    ? <span className="student-certificates__count student-certificates__count-skeleton" aria-hidden="true"><i className="student-certificates__skeleton-shape" /></span>
                    : <span className="student-certificates__count">Unavailable</span>}
              </header>
              <div className="student-certificates__earned-list">
                <label className="student-certificates__earned-search">
                  <span aria-hidden="true"><Icon name="search" size={16} /></span>
                  <input
                    type="search"
                    aria-label="Search earned certificates by course name"
                    placeholder="Search by course name"
                    value={earnedSearch}
                    onChange={(event) => setEarnedSearch(event.target.value)}
                  />
                </label>
                {!hasCertificateData && isLoading
                  ? [0, 1].map((skeleton) => <EarnedCertificateSkeleton key={skeleton} />)
                  : !hasCertificateData
                    ? <p className="student-certificates__panel-empty">Certificate data could not be loaded.</p>
                    : matchingEarnedCourses.length ? matchingEarnedCourses.map((course) => (
                  <article className="student-certificates__earned-item" key={course.courseId}>
                    <div className="student-certificates__certificate-art" aria-hidden="true">
                      <small>aiHustle</small><strong>Certificate</strong><span>of Completion</span><Icon name="award" size={22} />
                    </div>
                    <div className="student-certificates__earned-copy">
                      <h3>{course.courseName}</h3>
                      <span className="student-certificates__completed"><Icon name="check" size={13} />Completed</span>
                      <p><Icon name="clock" size={14} />Completed on {new Date(course.certificate.completedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}</p>
                      <p><Icon name="clipboardCheck" size={14} />Certificate ID: {course.certificate.certificateId}</p>
                    </div>
                    <div className="student-certificates__earned-actions">
                      <button
                        type="button"
                        className="student-certificates__preview-button"
                        disabled={activeCertificate === course.certificate.id}
                        onClick={() => openCertificate(course.certificate, false)}
                      >
                        <Icon name="search" size={15} />Preview
                      </button>
                      <button
                        type="button"
                        className="student-certificates__download-button"
                        disabled={activeCertificate === course.certificate.id}
                        onClick={() => openCertificate(course.certificate, true)}
                      >
                        <Icon name="arrow" size={15} />Download PDF
                      </button>
                    </div>
                  </article>
                )) : earnedSearch.trim()
                  ? <p className="student-certificates__panel-empty">No certificates found</p>
                  : <p className="student-certificates__panel-empty">Completed courses will appear here once certificates are earned.</p>}
              </div>
            </section>
            <section className="student-certificates__panel student-certificates__panel--progress" aria-labelledby="student-certificates-progress-title">
              <header className="student-certificates__panel-heading">
                <span className="student-certificates__panel-icon"><Icon name="clock" size={34} /></span>
                <div><h2 id="student-certificates-progress-title">In Progress</h2><p>Complete the remaining activities to earn your certificate.</p></div>
                {hasCertificateData
                  ? <span className="student-certificates__count">{inProgressCourses.length} {inProgressCourses.length === 1 ? 'Course' : 'Courses'}</span>
                  : isLoading
                    ? <span className="student-certificates__count student-certificates__count-skeleton" aria-hidden="true"><i className="student-certificates__skeleton-shape" /></span>
                    : <span className="student-certificates__count">Unavailable</span>}
              </header>
              <div className="student-certificates__progress-list">
                {!hasCertificateData && isLoading
                  ? [0, 1].map((skeleton) => <InProgressCertificateSkeleton key={skeleton} />)
                  : !hasCertificateData
                    ? <p className="student-certificates__panel-empty">Certificate data could not be loaded.</p>
                    : inProgressCourses.length ? inProgressCourses.map((course) => {
                  const percentage = Math.max(0, Math.min(100, Number(course.progress?.percentage) || 0))
                  const pendingRequirements = course.pendingRequirements || []
                  const firstIncomplete = pendingRequirements.find((requirement) => (
                    ['video', 'quiz', 'assignment'].includes(requirement.type)
                    && typeof requirement.id === 'string'
                    && requirement.id
                  ))
                  return (
                    <article className="student-certificates__progress-card" key={course.courseId}>
                      <div className="student-certificates__course-progress">
                        <span className="student-certificates__course-art">
                          {course.thumbnailUrl
                            ? <img src={course.thumbnailUrl} alt="" loading="lazy" />
                            : <Icon name="bookOpen" size={28} />}
                        </span>
                        <div className="student-certificates__course-progress-copy">
                          <h3>{course.courseName}</h3>
                          <div className="student-certificates__progress-meter">
                            <span role="progressbar" aria-label={`${course.courseName} completion`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percentage}>
                              <i style={{ width: `${percentage}%` }} />
                            </span>
                            <strong>{percentage}%</strong>
                          </div>
                        </div>
                        <button
                          className="student-certificates__course-arrow"
                          type="button"
                          aria-label={firstIncomplete
                            ? `Continue ${course.courseName}: ${firstIncomplete.title}`
                            : `Open ${course.courseName}`}
                          onClick={() => continueCourse(course, pendingRequirements)}
                        >
                          <Icon name="arrow" size={17} />
                        </button>
                      </div>
                      <div className="student-certificates__remaining">
                        <strong>Remaining requirement:</strong>
                        {pendingRequirements.length ? (
                          <ul>
                            {pendingRequirements.slice(0, 2).map((requirement, index) => (
                              <li key={`${requirement.type}-${requirement.title}-${index}`}>
                                <span aria-hidden="true" />
                                <span>{requirement.title}</span>
                                <small>{getRequirementStatus(requirement)}</small>
                              </li>
                            ))}
                          </ul>
                        ) : <p>Course requirements are being checked.</p>}
                        {pendingRequirements.length > 2 && <small className="student-certificates__more-requirements">+{pendingRequirements.length - 2} more requirements</small>}
                        <span className="student-certificates__task-count">{pendingRequirements.length} {pendingRequirements.length === 1 ? 'task' : 'tasks'} required</span>
                      </div>
                    </article>
                  )
                }) : <p className="student-certificates__panel-empty">All enrolled courses have earned certificates.</p>}
              </div>
            </section>
          </div>}
      {preview && previewUrlRef.current && (
        <div className="student-certificate-preview" role="dialog" aria-modal="true" aria-label={`Certificate preview for ${preview.courseName}`}>
          <div className="student-certificate-preview__panel">
            <header><strong>{preview.courseName}</strong><button type="button" onClick={closePreview} aria-label="Close certificate preview">×</button></header>
            <iframe title={`Certificate for ${preview.courseName}`} src={`${previewUrlRef.current}#view=Fit`} />
          </div>
        </div>
      )}
    </StudentRoutePage>
  )
}


async function fetchMyEnrollments(onLogout, signal) {
  const savedAuth = sessionStorage.getItem('lms.auth')
  const auth = savedAuth ? JSON.parse(savedAuth) : null
  if (typeof auth?.token !== 'string') {
    onLogout()
    throw new Error('Your session has ended. Please sign in again.')
  }
  const response = await fetchWithAuth(`${API_BASE_URL}/enrollments/me`, {
    headers: { Authorization: `Bearer ${auth.token}` },
    signal,
  }, API_BASE_URL, auth.token)
  const result = await response.json()
  if (isInvalidSessionResponse(response, result)) {
    onLogout()
    throw new Error('Your session has ended. Please sign in again.')
  }
  if (!response.ok) throw new Error(result.message || 'Your learning data could not be loaded.')
  if (!Array.isArray(result.enrollments)) throw new Error('The server returned invalid enrollment data.')
  return result.enrollments
}

async function fetchStudentLearningSummary(onLogout, signal) {
  const savedAuth = sessionStorage.getItem('lms.auth')
  const auth = savedAuth ? JSON.parse(savedAuth) : null
  if (typeof auth?.token !== 'string') {
    onLogout()
    throw new Error('Your session has ended. Please sign in again.')
  }
  const response = await fetchWithAuth(`${API_BASE_URL}/learning/summary`, {
    headers: { Authorization: `Bearer ${auth.token}` },
    signal,
  }, API_BASE_URL, auth.token)
  const result = await response.json()
  if (isInvalidSessionResponse(response, result)) {
    onLogout()
    throw new Error('Your session has ended. Please sign in again.')
  }
  if (!response.ok) throw new Error(result.message || 'Learning statistics could not be loaded.')
  if (!result.summary || Object.keys(emptyLearningSummary).some((key) => !Number.isFinite(result.summary[key]))) {
    throw new Error('The server returned invalid learning statistics.')
  }
  return result.summary
}

async function fetchStudentCourseContent(courseId, onLogout, signal) {
  const savedAuth = sessionStorage.getItem('lms.auth')
  const auth = savedAuth ? JSON.parse(savedAuth) : null
  if (typeof auth?.token !== 'string') {
    onLogout()
    throw new Error('Your session has ended. Please sign in again.')
  }
  const response = await fetchWithAuth(`${API_BASE_URL}/courses/${encodeURIComponent(courseId)}/learning-content`, {
    headers: { Authorization: `Bearer ${auth.token}` },
    signal,
  }, API_BASE_URL, auth.token)
  const result = await response.json()
  if (isInvalidSessionResponse(response, result)) {
    onLogout()
    throw new Error('Your session has ended. Please sign in again.')
  }
  if (!response.ok) throw new Error(result.message || 'Your course content could not be loaded.')
  if (!result.enrollment?._id || !result.enrollment.courseId || !Array.isArray(result.assignmentSubmissions) || !Array.isArray(result.quizAttempts)) {
    throw new Error('The server returned invalid course content.')
  }
  return result
}

function getStudentPageCacheKey() {
  return getStudentCertificateCacheKey()
}

function getCachedStudentPageEnrollments() {
  const cacheKey = getStudentPageCacheKey()
  return cacheKey ? studentEnrollmentCache.get(cacheKey)?.enrollments || null : null
}

async function fetchStudentPageEnrollments(onLogout) {
  const cacheKey = getStudentPageCacheKey()
  if (!cacheKey) return fetchMyEnrollments(onLogout)
  const cached = studentEnrollmentCache.get(cacheKey)
  if (cached && Date.now() - cached.savedAt < studentLearningPageCacheTtlMs) return cached.enrollments

  let request = studentEnrollmentRequests.get(cacheKey)
  if (!request) {
    request = fetchMyEnrollments(onLogout).then((enrollments) => {
      studentEnrollmentCache.set(cacheKey, { enrollments, savedAt: Date.now() })
      return enrollments
    })
    studentEnrollmentRequests.set(cacheKey, request)
  }
  try {
    return await request
  } finally {
    if (studentEnrollmentRequests.get(cacheKey) === request) studentEnrollmentRequests.delete(cacheKey)
  }
}

function getStudentCourseContentCacheKey(courseId) {
  const studentId = getStudentPageCacheKey()
  return studentId ? `${studentId}:${courseId}` : ''
}

function getCachedStudentPageCourseContent(courseId) {
  const cacheKey = getStudentCourseContentCacheKey(courseId)
  return cacheKey ? studentCourseContentCache.get(cacheKey)?.content || null : null
}

async function fetchStudentPageCourseContent(courseId, onLogout) {
  const cacheKey = getStudentCourseContentCacheKey(courseId)
  if (!cacheKey) return fetchStudentCourseContent(courseId, onLogout)
  const cached = studentCourseContentCache.get(cacheKey)
  if (cached && Date.now() - cached.savedAt < studentLearningPageCacheTtlMs) return cached.content

  let request = studentCourseContentRequests.get(cacheKey)
  if (!request) {
    request = fetchStudentCourseContent(courseId, onLogout).then((content) => {
      studentCourseContentCache.set(cacheKey, { content, savedAt: Date.now() })
      return content
    })
    studentCourseContentRequests.set(cacheKey, request)
  }
  try {
    return await request
  } finally {
    if (studentCourseContentRequests.get(cacheKey) === request) studentCourseContentRequests.delete(cacheKey)
  }
}

async function fetchStudentPageCertificates(onLogout) {
  const cacheKey = getStudentPageCacheKey()
  if (!cacheKey) return fetchStudentCertificates(onLogout)
  const cached = studentCertificateCache.get(cacheKey)
  if (cached && Date.now() - cached.savedAt < studentCertificateCacheTtlMs) return cached.certificates

  let request = studentPageCertificateRequests.get(cacheKey)
  if (!request) {
    request = fetchStudentCertificates(onLogout).then((certificates) => {
      studentCertificateCache.set(cacheKey, { certificates, savedAt: Date.now() })
      return certificates
    })
    studentPageCertificateRequests.set(cacheKey, request)
  }
  try {
    return await request
  } finally {
    if (studentPageCertificateRequests.get(cacheKey) === request) studentPageCertificateRequests.delete(cacheKey)
  }
}

function invalidateStudentResultsCache() {
  const cacheKey = getStudentPageCacheKey()
  if (cacheKey) studentResultsCache.delete(cacheKey)
}

function invalidateStudentLearningPageCaches() {
  const cacheKey = getStudentPageCacheKey()
  if (!cacheKey) return
  studentEnrollmentCache.delete(cacheKey)
  studentResultsCache.delete(cacheKey)
  studentCertificateCache.delete(cacheKey)
  const coursePrefix = `${cacheKey}:`
  studentCourseContentCache.forEach((_, key) => {
    if (key.startsWith(coursePrefix)) studentCourseContentCache.delete(key)
  })
}

async function fetchStudentCourseCertificate(courseId, onLogout, signal) {
  const certificates = await fetchStudentCertificates(onLogout, signal)
  const certificate = certificates.find((entry) => String(entry.courseId) === String(courseId))
  if (!certificate) throw new Error('Certificate status for this course could not be found.')
  return certificate
}

async function fetchStudentCertificates(onLogout, signal) {
  const savedAuth = sessionStorage.getItem('lms.auth')
  const auth = savedAuth ? JSON.parse(savedAuth) : null
  if (typeof auth?.token !== 'string') {
    onLogout()
    throw new Error('Your session has ended. Please sign in again.')
  }
  const response = await fetchWithAuth(`${API_BASE_URL}/certificates`, {
    headers: { Authorization: `Bearer ${auth.token}` },
    signal,
  }, API_BASE_URL, auth.token)
  const result = await response.json()
  if (isInvalidSessionResponse(response, result)) {
    onLogout()
    throw new Error('Your session has ended. Please sign in again.')
  }
  if (!response.ok) throw new Error(result.message || 'Certificate status could not be loaded.')
  if (!Array.isArray(result.certificates)) throw new Error('The server returned invalid certificate data.')
  return result.certificates
}





async function fetchStudentActivities(onLogout, signal) {
  const savedAuth = sessionStorage.getItem('lms.auth')
  const auth = savedAuth ? JSON.parse(savedAuth) : null
  if (typeof auth?.token !== 'string') {
    onLogout()
    throw new Error('Your session has ended. Please sign in again.')
  }
  const response = await fetchWithAuth(`${API_BASE_URL}/learning/activities`, {
    headers: { Authorization: `Bearer ${auth.token}` },
    signal,
  }, API_BASE_URL, auth.token)
  const result = await response.json()
  if (isInvalidSessionResponse(response, result)) {
    onLogout()
    throw new Error('Your session has ended. Please sign in again.')
  }
  if (!response.ok) throw new Error(result.message || 'Quizzes and assignments could not be loaded.')
  return result
}

async function fetchCourseDetails(courseId, onLogout, signal) {
  const savedAuth = sessionStorage.getItem('lms.auth')
  const auth = savedAuth ? JSON.parse(savedAuth) : null
  if (typeof auth?.token !== 'string') {
    onLogout()
    throw new Error('Your session has ended. Please sign in again.')
  }
  const response = await fetchWithAuth(`${API_BASE_URL}/courses/${encodeURIComponent(courseId)}/details`, {
    headers: { Authorization: `Bearer ${auth.token}` },
    signal,
  }, API_BASE_URL, auth.token)
  const result = await response.json()
  if (isInvalidSessionResponse(response, result)) {
    onLogout()
    throw new Error('Your session has ended. Please sign in again.')
  }
  if (!response.ok) throw new Error(result.message || 'Course details could not be loaded.')
  return result
}

async function enrollInCourse(courseId, onLogout) {
  const savedAuth = sessionStorage.getItem('lms.auth')
  const auth = savedAuth ? JSON.parse(savedAuth) : null
  if (typeof auth?.token !== 'string') {
    onLogout()
    throw new Error('Your session has ended. Please sign in again.')
  }
  const response = await fetchWithAuth(`${API_BASE_URL}/courses/${encodeURIComponent(courseId)}/enroll`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${auth.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ courseId }),
  }, API_BASE_URL, auth.token)
  const result = await response.json()
  if (isInvalidSessionResponse(response, result)) {
    onLogout()
    throw new Error('Your session has ended. Please sign in again.')
  }
  if (!response.ok) throw new Error(result.message || 'You could not be enrolled in this course.')
  return result
}

async function unenrollFromCourse(courseId, onLogout) {
  const savedAuth = sessionStorage.getItem('lms.auth')
  const auth = savedAuth ? JSON.parse(savedAuth) : null
  if (typeof auth?.token !== 'string') {
    onLogout()
    throw new Error('Your session has ended. Please sign in again.')
  }
  const response = await fetchWithAuth(`${API_BASE_URL}/courses/${encodeURIComponent(courseId)}/unenroll`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${auth.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ courseId }),
  }, API_BASE_URL, auth.token)
  const result = await response.json()
  if (isInvalidSessionResponse(response, result)) {
    onLogout()
    throw new Error('Your session has ended. Please sign in again.')
  }
  if (!response.ok) throw new Error(result.message || 'Could not unenroll from this course.')
  return result
}


function getCourseQuizTitle(course, quizId) {
  const quizzes = [
    ...(course.quizzes || []),
    ...(course.modules || []).flatMap((module) => [
      ...(module.quiz ? [module.quiz] : []),
      ...(module.contentItems || [])
        .filter((item) => item.type === 'quiz')
        .map((item) => item.quiz || item),
    ]),
  ]
  return quizzes.find((quiz) => String(quiz._id || quiz.quiz?._id) === String(quizId))?.title || 'Quiz'
}

function getCourseAssignmentTitle(course, assignmentId) {
  const assignments = [
    ...(course.assignments || []),
    ...(course.modules || []).flatMap((module) => (module.contentItems || [])
      .filter((item) => item.type === 'assignment')
      .map((item) => item.assignment || item)),
  ]
  return assignments.find((assignment) => String(assignment._id) === String(assignmentId))?.title || 'Assignment'
}

function getCourseAssignments(course) {
  const moduleAssignments = (course.modules || []).flatMap((module) => (
    (module.contentItems || [])
      .filter((item) => item.type === 'assignment')
      .map((item) => ({ ...item, ...(item.assignment || {}), _id: item._id || item.assignment?._id }))
  ))
  const seenIds = new Set()
  return [...(course.assignments || []), ...moduleAssignments].filter((assignment) => {
    const id = String(assignment._id || '')
    if (!id || seenIds.has(id)) return false
    seenIds.add(id)
    return true
  }).map((assignment) => ({
    ...assignment,
    description: assignment.description || assignment.content || '',
  }))
}

function getLatestAssignmentSubmission(submissions, assignmentId) {
  return submissions
    .filter((submission) => String(submission.assignmentId) === String(assignmentId))
    .sort((left, right) => new Date(right.submittedAt || 0).getTime() - new Date(left.submittedAt || 0).getTime())[0] || null
}

function getAssignmentRecordStatus(submission) {
  if (!submission) return 'pending'
  if (submission.reviewStatus === 'approved') return 'graded'
  if (submission.reviewStatus === 'pending') return 'submitted'
  return 'pending'
}

function getLatestEnrollmentsByCourse(enrollments) {
  const latestEnrollmentByCourse = new Map()
  enrollments.forEach((enrollment) => {
    const courseId = String(enrollment.courseId?._id || enrollment.courseId || '')
    if (courseId && !latestEnrollmentByCourse.has(courseId)) {
      latestEnrollmentByCourse.set(courseId, enrollment)
    }
  })
  return latestEnrollmentByCourse
}

function createStudentAssignmentRows(courseResults) {
  return courseResults.flatMap(({ enrollment, submissions }) => {
    const course = enrollment.courseId
    return getCourseAssignments(course).map((assignment) => {
      const submission = getLatestAssignmentSubmission(submissions, assignment._id)
      return {
        key: `${enrollment._id}:${assignment._id}`,
        courseId: String(course._id),
        courseName: course.title || 'Course',
        enrollmentId: String(enrollment._id),
        assignment,
        submission,
        status: getAssignmentRecordStatus(submission),
      }
    })
  })
}

async function fetchStudentAssignmentRows(onLogout) {
  const enrollments = await fetchStudentPageEnrollments(onLogout)
  const latestEnrollments = getLatestEnrollmentsByCourse(enrollments)
  const courseResults = await Promise.all([...latestEnrollments.keys()].map(async (courseId) => {
    const result = await fetchStudentPageCourseContent(courseId, onLogout)
    return { enrollment: result.enrollment, submissions: result.assignmentSubmissions }
  }))
  return createStudentAssignmentRows(courseResults)
}

function getCachedStudentAssignmentRows() {
  const enrollments = getCachedStudentPageEnrollments()
  if (!enrollments) return null
  const latestEnrollments = getLatestEnrollmentsByCourse(enrollments)
  const courseResults = [...latestEnrollments.keys()].map((courseId) => {
    const content = getCachedStudentPageCourseContent(courseId)
    return content
      ? { enrollment: content.enrollment, submissions: content.assignmentSubmissions }
      : null
  })
  if (courseResults.some((result) => result === null)) return null
  return createStudentAssignmentRows(courseResults)
}

function getDashboardAssignmentStatus(entry) {
  const reviewStatus = entry.submission?.reviewStatus
  if (!entry.submission) return { label: 'Pending', tone: 'pending' }
  if (reviewStatus === 'approved') return { label: 'Approved', tone: 'approved' }
  if (reviewStatus === 'rejected') return { label: 'Rejected', tone: 'rejected' }
  if (reviewStatus === 'pending') return { label: 'Awaiting Review', tone: 'awaiting' }
  return { label: 'Submitted', tone: 'submitted' }
}

function StudentDashboardUpcomingAssignments({ onLogout }) {
  const cachedAssignments = getCachedStudentAssignmentRows()
  const [assignments, setAssignments] = useState(cachedAssignments || [])
  const [hasAssignmentData, setHasAssignmentData] = useState(cachedAssignments !== null)
  const [loading, setLoading] = useState(cachedAssignments === null)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)

  useEffect(() => {
    let active = true
    async function loadAssignments() {
      setLoading(true)
      setError('')
      try {
        const rows = await fetchStudentAssignmentRows(onLogout)
        if (active) {
          setAssignments(rows)
          setHasAssignmentData(true)
        }
      } catch (loadError) {
        if (active) {
          setError(loadError instanceof Error ? loadError.message : 'Assignments could not be loaded.')
        }
      } finally {
        if (active) setLoading(false)
      }
    }
    void loadAssignments()
    return () => { active = false }
  }, [onLogout, retry])

  const visibleAssignments = [...assignments]
    .sort((left, right) => {
      const priority = (entry) => {
        const status = getDashboardAssignmentStatus(entry).tone
        return status === 'approved' ? 2 : status === 'awaiting' || status === 'submitted' ? 1 : 0
      }
      const priorityDifference = priority(left) - priority(right)
      if (priorityDifference) return priorityDifference
      const leftDue = left.assignment.dueDate ? new Date(left.assignment.dueDate).getTime() : Number.POSITIVE_INFINITY
      const rightDue = right.assignment.dueDate ? new Date(right.assignment.dueDate).getTime() : Number.POSITIVE_INFINITY
      return leftDue - rightDue
    })
    .slice(0, 3)

  return (
    <div className="student-dashboard-assignment-list" aria-busy={loading}>
      {error && <p className="student-dashboard-data-error" role="alert">{error}</p>}
      {loading && !hasAssignmentData ? (
        [0, 1, 2].map((item) => (
          <div className="student-dashboard-assignment student-dashboard-assignment--skeleton" key={item} aria-hidden="true">
            <span className="student-page-skeleton student-dashboard-assignment__skeleton-icon" />
            <span className="student-dashboard-assignment__skeleton-copy">
              <i className="student-page-skeleton" />
              <i className="student-page-skeleton is-short" />
            </span>
            <span className="student-page-skeleton student-dashboard-assignment__skeleton-status" />
          </div>
        ))
      ) : !hasAssignmentData && error ? null : assignments.length === 0 ? (
        <EmptyState
          icon="check"
          title="No assignments yet"
          description="Assignments from your enrolled courses will appear here."
        />
      ) : visibleAssignments.map((entry) => {
        const status = getDashboardAssignmentStatus(entry)
        const dueDate = entry.assignment.dueDate ? new Date(entry.assignment.dueDate) : null
        const dueDateLabel = dueDate && Number.isFinite(dueDate.getTime())
          ? `Due: ${formatResultDate(dueDate)}`
          : 'No due date'
        return (
          <Link className="student-dashboard-assignment" key={entry.key} to="/student/assignments">
            <span className="student-dashboard-assignment__icon"><Icon name="file" size={18} /></span>
            <span className="student-dashboard-assignment__copy">
              <strong>{entry.assignment.title || 'Assignment'}</strong>
              <span>{entry.courseName}</span>
              <small>{dueDateLabel}</small>
            </span>
            <span className={`student-dashboard-assignment__status is-${status.tone}`}>{status.label}</span>
          </Link>
        )
      })}
      {hasAssignmentData && assignments.length > 3 && (
        <Link className="student-dashboard-assignment-list__more" to="/student/assignments">
          View all assignments <Icon name="arrow" size={15} />
        </Link>
      )}
      {!hasAssignmentData && error && (
        <button
          className="student-dashboard-data-retry"
          type="button"
          onClick={() => setRetry((current) => current + 1)}
        >
          Try again
        </button>
      )}
    </div>
  )
}

function StudentAssignmentsPage({ onLogout, onLearningDataChanged }) {
  const [initialAssignments] = useState(getCachedStudentAssignmentRows)
  const [assignments, setAssignments] = useState(initialAssignments || [])
  const [hasAssignmentData, setHasAssignmentData] = useState(initialAssignments !== null)
  const [isLoading, setIsLoading] = useState(initialAssignments === null)
  const [error, setError] = useState('')
  const [selectedStatus, setSelectedStatus] = useState('all')
  const [selectedCourseId, setSelectedCourseId] = useState('all')
  const [activeAssignmentKey, setActiveAssignmentKey] = useState('')
  const [refreshToken, setRefreshToken] = useState(0)
  const hasAssignmentDataRef = useRef(initialAssignments !== null)

  useEffect(() => {
    let active = true
    async function loadAssignments() {
      if (!hasAssignmentDataRef.current) setIsLoading(true)
      setError('')
      try {
        const rows = await fetchStudentAssignmentRows(onLogout)
        if (active) {
          setAssignments(rows)
          setHasAssignmentData(true)
          hasAssignmentDataRef.current = true
        }
      } catch (loadError) {
        if (active) setError(loadError instanceof Error ? loadError.message : 'Assignments could not be loaded.')
      } finally {
        if (active) {
          setIsLoading(false)
        }
      }
    }
    void loadAssignments()
    return () => { active = false }
  }, [onLogout, refreshToken])

  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === 'visible') setRefreshToken((current) => current + 1)
    }
    const intervalId = window.setInterval(refresh, 30000)
    window.addEventListener('focus', refresh)
    return () => {
      window.clearInterval(intervalId)
      window.removeEventListener('focus', refresh)
    }
  }, [])

  const activeAssignment = assignments.find(({ key }) => key === activeAssignmentKey) || null
  const courseAssignments = selectedCourseId === 'all'
    ? assignments
    : assignments.filter(({ courseId }) => courseId === selectedCourseId)
  const counts = {
    all: courseAssignments.length,
    pending: courseAssignments.filter(({ status }) => status === 'pending').length,
    submitted: courseAssignments.filter(({ status }) => status === 'submitted').length,
    graded: courseAssignments.filter(({ status }) => status === 'graded').length,
  }
  const visibleAssignments = courseAssignments.filter((entry) => (
    (selectedStatus === 'all' || entry.status === selectedStatus)
  )).sort((left, right) => {
    const leftDue = left.assignment.dueDate ? new Date(left.assignment.dueDate).getTime() : Number.POSITIVE_INFINITY
    const rightDue = right.assignment.dueDate ? new Date(right.assignment.dueDate).getTime() : Number.POSITIVE_INFINITY
    return leftDue - rightDue || String(left.assignment.title || '').localeCompare(String(right.assignment.title || ''))
  })
  const courses = [...new Map(assignments.map(({ courseId, courseName }) => [courseId, courseName])).entries()]
  function updateSubmission(entryKey, submission) {
    setAssignments((current) => current.map((entry) => (
      entry.key === entryKey
        ? { ...entry, submission, status: getAssignmentRecordStatus(submission) }
        : entry
    )))
    const entry = assignments.find(({ key }) => key === entryKey)
    if (entry) {
      studentCourseContentCache.delete(getStudentCourseContentCacheKey(entry.courseId))
      invalidateStudentResultsCache()
    }
  }

  const filters = [
    { key: 'all', label: hasAssignmentData ? `All Assignments (${counts.all})` : 'All Assignments' },
    { key: 'pending', label: hasAssignmentData ? `Pending (${counts.pending})` : 'Pending' },
    { key: 'submitted', label: hasAssignmentData ? `Awaiting Review (${counts.submitted})` : 'Awaiting Review' },
    { key: 'graded', label: hasAssignmentData ? `Graded (${counts.graded})` : 'Graded' },
  ]

  return (
    <StudentRoutePage eyebrow="STAY ON TRACK" title="Assignments" className="student-assignments-page">
      <div className="student-assignments">
        <header className="student-assignments__header">
          <div className="student-assignments__heading">
            <span className="student-assignments__eyebrow">Stay on Track</span>
            <h1>Your Assignments</h1>
            <p>View, submit, and track your course assignments.</p>
          </div>
          <svg className="student-assignments__illustration" viewBox="0 0 300 160" aria-hidden="true">
            <path d="M232 147c0 0 18-54-14-90 11-12 14-21 13-35l-26-2-27 17-14 36-15 12 14 31 69-2Z" fill="#AAD0B6" opacity="0.7"/>
            <path d="M220 58h-42c-5 0-9 4-9 9v55c0 5 4 9 9 9h67c5 0 9-4 9-9V81l-34-23Z" fill="#f4f5f0" stroke="#c9c7be" strokeWidth="2"/>
            <path d="M220 58v23h34" fill="none" stroke="#d5d0c8" strokeWidth="2"/>
            <path d="M178 84h52M178 96h52M178 108h41" stroke="#88A99A" strokeWidth="2" strokeLinecap="round"/>
            <path d="M250 99l15 15-20 20-17-17" fill="none" stroke="#38A76A" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M267 95l-8 8" stroke="#7DA297" strokeWidth="2" strokeLinecap="round"/>
            <path d="M144 52c0-6 5-11 11-11h43c6 0 11 5 11 11v57c0 6-5 11-11 11h-43c-6 0-11-5-11-11V52Z" fill="#f6f7f1" stroke="#d4d0c4" strokeWidth="2"/>
            <path d="M171 48l39 29-39 29-39-29 39-29Z" fill="#dfece4" opacity="0.9"/>
            <path d="M165 58h13M165 68h26" stroke="#7EA89C" strokeWidth="2" strokeLinecap="round"/>
            <path d="M124 118c14-15 28-19 44-11 9 5 18 6 29 3" fill="none" stroke="#d8b142" strokeWidth="4" strokeLinecap="round"/>
            <path d="M230 105l16-11 28 0c13 0 25 12 25 25v3H203l27-17Z" fill="#D3E8D3"/>
            <path d="M263 98l15 42h3l14-42h-12l-9 17-9-17h-2Z" fill="#f1d474"/>
            <path d="M100 121l-28-34 19 63h27l-18-29Z" fill="#e6d38d" opacity="0.85"/>
            <path d="M65 110l52 30" stroke="#7e7f74" strokeWidth="3" strokeLinecap="round" opacity="0.6"/>
            <path d="M72 61l-25 35" stroke="#f3d363" strokeWidth="5" strokeLinecap="round"/>
            <path d="M47 99l-17 8 27 9-10-17Z" fill="#f3d363"/>
            <path d="M46 91l31-24" stroke="#f0c94f" strokeWidth="4" strokeLinecap="round"/>
            <circle cx="44" cy="87" r="4" fill="#e6c257"/>
          </svg>
        </header>

        <div className="student-assignments__stats" aria-label="Assignment summary">
          {[
            { label: 'Total Assignments', value: counts.all, icon: 'check' },
            { label: 'Pending', value: counts.pending, icon: 'clock', tone: 'amber' },
            { label: 'Awaiting Review', value: counts.submitted, icon: 'check', tone: 'green' },
            { label: 'Graded', value: counts.graded, icon: 'award', tone: 'purple' },
          ].map((stat) => (
            <article className="student-assignments__stat" key={stat.label}>
              <span className={`student-assignments__stat-icon${stat.tone ? ` student-assignments__stat-icon--${stat.tone}` : ''}`}>
                <Icon name={stat.icon} size={20} />
              </span>
              <div>
                <span className="student-assignments__stat-label">{stat.label}</span>
                <strong>
                  {isLoading
                    ? <span className="student-page-skeleton student-assignments__stat-skeleton" aria-hidden="true" />
                    : hasAssignmentData ? stat.value : '—'}
                </strong>
              </div>
            </article>
          ))}
        </div>

        {error && <p className="student-assignments__error" role="alert">{error}</p>}

        <div className="student-assignments__toolbar">
          <div className="student-assignments__tabs" role="tablist" aria-label="Assignment filters">
            {filters.map((filter) => (
              <button
                type="button"
                role="tab"
                aria-selected={selectedStatus === filter.key}
                className={`student-assignments__tab${selectedStatus === filter.key ? ' is-active' : ''}`}
                key={filter.key}
                onClick={() => setSelectedStatus(filter.key)}
              >
                {filter.label}
              </button>
            ))}
          </div>
          <label className="student-assignments__filter">
            <select aria-label="Filter by course" value={selectedCourseId} onChange={(event) => setSelectedCourseId(event.target.value)}>
              <option value="all">All Courses</option>
              {courses.map(([courseId, courseName]) => <option value={courseId} key={courseId}>{courseName}</option>)}
            </select>
            <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 7.5 10 12.5 15 7.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg>
          </label>
        </div>

        <div className="student-assignments__list" aria-label="Assignments list" aria-busy={isLoading}>
          {isLoading ? (
            [0, 1, 2].map((item) => (
              <article className="student-assignment-item student-assignment-item--skeleton" key={item} aria-hidden="true">
                <div className="student-assignment-item__meta">
                  <span className="student-page-skeleton student-assignment-item__skeleton-icon" />
                  <div>
                    <span className="student-page-skeleton student-assignment-item__skeleton-title" />
                    <span className="student-page-skeleton student-assignment-item__skeleton-course" />
                  </div>
                </div>
                <span className="student-page-skeleton student-assignment-item__skeleton-due" />
                <span className="student-page-skeleton student-assignment-item__skeleton-status" />
                <span className="student-page-skeleton student-assignment-item__skeleton-score" />
                <span className="student-page-skeleton student-assignment-item__skeleton-action" />
              </article>
            ))
          ) : !hasAssignmentData ? null : visibleAssignments.length === 0 ? (
            <p className="student-assignments__empty">
              {assignments.length === 0
                ? 'Assignments from your enrolled courses will appear here.'
                : 'No assignments match these filters.'}
            </p>
          ) : visibleAssignments.map((entry) => {
            const { assignment, submission, status } = entry
            const rejected = submission?.reviewStatus === 'rejected'
            const hasMarks = submission?.marksObtained !== null
              && submission?.marksObtained !== undefined
              && Number.isFinite(Number(submission.marksObtained))
            const statusLabel = rejected ? 'Rejected' : status === 'graded' ? 'Approved' : status === 'submitted' ? 'Submitted' : 'Pending'
            const actionLabel = rejected ? 'Resubmit' : status === 'graded' ? 'View Details' : status === 'submitted' ? 'View Submission' : 'View & Submit'
            return (
              <article className="student-assignment-item" key={entry.key}>
                <div className="student-assignment-item__meta">
                  <span className="student-assignment-item__icon"><Icon name="book" size={16} /></span>
                  <div>
                    <h2>{assignment.title || 'Assignment'}</h2>
                    <p>{entry.courseName}</p>
                  </div>
                </div>
                <div className="student-assignment-item__due">
                  <Icon name="clock" size={14} />
                  <span>{assignment.dueDate ? `Due: ${formatResultDate(assignment.dueDate)}` : 'No due date'}</span>
                </div>
                <span className={`student-assignment-item__status is-${rejected ? 'rejected' : status === 'graded' ? 'graded' : status}`}>
                  {statusLabel}
                </span>
                {status === 'graded' && hasMarks ? (
                  <span className="student-assignment-item__score">
                    Score: {submission.marksObtained} / {assignment.points ?? assignment.maximumMarks ?? '—'}
                  </span>
                ) : <span className="student-assignment-item__score-placeholder" aria-hidden="true" />}
                <button
                  type="button"
                  className={`student-assignment-item__action${status === 'pending' ? ' student-assignment-item__action--primary' : ''}`}
                  onClick={() => setActiveAssignmentKey(entry.key)}
                >
                  {actionLabel} <span aria-hidden="true">›</span>
                </button>
              </article>
            )
          })}
        </div>
      </div>

      {activeAssignment && (
        <StudentAssignmentDetail
          entry={activeAssignment}
          onClose={() => setActiveAssignmentKey('')}
          onLogout={onLogout}
          onSubmitted={(submission) => updateSubmission(activeAssignment.key, submission)}
          onLearningDataChanged={onLearningDataChanged}
        />
      )}
    </StudentRoutePage>
  )
}

function getAttemptScore(attempt) {
  const score = attempt.scorePercentage
  if (score !== null && score !== undefined && Number.isFinite(Number(score))) return Number(score)
  const totalPoints = Number(attempt.totalPoints)
  const earnedPoints = attempt.earnedPoints === null || attempt.earnedPoints === undefined
    ? Number.NaN
    : Number(attempt.earnedPoints)
  return Number.isFinite(totalPoints) && totalPoints > 0 && Number.isFinite(earnedPoints)
    ? (earnedPoints / totalPoints) * 100
    : null
}

function formatResultDate(value) {
  const date = value ? new Date(value) : null
  return date && Number.isFinite(date.getTime())
    ? date.toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' })
    : '—'
}

function getCachedStudentResults() {
  const cacheKey = getStudentPageCacheKey()
  if (!cacheKey) return null
  const cachedResults = studentResultsCache.get(cacheKey)
  if (cachedResults) return { ...cachedResults, hasCertificatesData: true }

  const enrollments = getCachedStudentPageEnrollments()
  if (!enrollments) return null
  const courseResults = [...getLatestEnrollmentsByCourse(enrollments).keys()].map((courseId) => {
    const content = getCachedStudentPageCourseContent(courseId)
    return content
      ? {
        courseId,
        enrollment: content.enrollment,
        course: content.enrollment.courseId,
        quizAttempts: content.quizAttempts,
        assignmentSubmissions: content.assignmentSubmissions,
      }
      : null
  })
  if (courseResults.some((result) => result === null)) return null
  const certificateCache = studentCertificateCache.get(cacheKey)
  return {
    courseResults,
    certificates: certificateCache?.certificates || [],
    hasCertificatesData: Boolean(certificateCache),
  }
}

function StudentResultsTableSkeleton() {
  return (
    <div className="student-results__table-wrap student-results__skeleton-wrap" role="status" aria-label="Loading results" aria-busy="true">
      <table className="student-results__table" aria-hidden="true">
        <thead><tr>{[0, 1, 2, 3, 4, 5].map((cell) => <th key={cell}><span className="student-page-skeleton student-results__skeleton-heading" /></th>)}</tr></thead>
        <tbody>{[0, 1, 2].map((row) => (
          <tr key={row}>{[0, 1, 2, 3, 4, 5].map((cell) => (
            <td key={cell}><span className={`student-page-skeleton student-results__skeleton-cell is-cell-${cell}`} /></td>
          ))}</tr>
        ))}</tbody>
      </table>
    </div>
  )
}

function StudentResultsPage({ onLogout }) {
  const navigate = useNavigate()
  const [initialResults] = useState(getCachedStudentResults)
  const [courseResults, setCourseResults] = useState(initialResults?.courseResults || [])
  const [certificates, setCertificates] = useState(initialResults?.certificates || [])
  const [hasResultsData, setHasResultsData] = useState(initialResults !== null)
  const [hasCertificatesData, setHasCertificatesData] = useState(initialResults?.hasCertificatesData === true)
  const [activeTab, setActiveTab] = useState('courses')
  const [selectedCourseId, setSelectedCourseId] = useState('all')
  const [loading, setLoading] = useState(initialResults === null)
  const [certificatesLoading, setCertificatesLoading] = useState(initialResults?.hasCertificatesData !== true)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    async function loadResults() {
      setError('')
      try {
        const enrollments = await fetchStudentPageEnrollments(onLogout)
        const latestEnrollments = getLatestEnrollmentsByCourse(enrollments)
        const [loadedCourseResults, loadedCertificates] = await Promise.all([
          Promise.all([...latestEnrollments.keys()].map(async (courseId) => {
            const result = await fetchStudentPageCourseContent(courseId, onLogout)
            return {
              courseId,
              enrollment: result.enrollment,
              course: result.enrollment.courseId,
              quizAttempts: result.quizAttempts,
              assignmentSubmissions: result.assignmentSubmissions,
            }
          })),
          fetchStudentPageCertificates(onLogout),
        ])
        if (!active) return
        setCourseResults(loadedCourseResults)
        setCertificates(loadedCertificates)
        setHasResultsData(true)
        setHasCertificatesData(true)
        const cacheKey = getStudentPageCacheKey()
        if (cacheKey) {
          studentResultsCache.set(cacheKey, {
            courseResults: loadedCourseResults,
            certificates: loadedCertificates,
          })
        }
      } catch (loadError) {
        if (active) {
          setError(loadError instanceof Error ? loadError.message : 'Grades and results could not be loaded.')
        }
      } finally {
        if (active) {
          setLoading(false)
          setCertificatesLoading(false)
        }
      }
    }
    void loadResults()
    return () => { active = false }
  }, [onLogout])

  const courseRows = courseResults.map((result) => {
    const lessonEntries = getCourseLessons(result.course)
    const completedLessonIds = new Set((result.enrollment.completedLessonIds || []).map(String))
    const completedLessons = lessonEntries.filter(({ lesson }) => completedLessonIds.has(String(lesson._id))).length
    const progress = lessonEntries.length
      ? Math.round((completedLessons / lessonEntries.length) * 100)
      : result.enrollment.status === 'completed' ? 100 : 0
    const submittedQuizzes = result.quizAttempts.filter((attempt) => attempt.status === 'submitted')
    const scores = submittedQuizzes.map(getAttemptScore).filter((score) => score !== null)
    const averageScore = scores.length
      ? Math.round(scores.reduce((total, score) => total + score, 0) / scores.length)
      : null
    const lastAttempt = [
      ...submittedQuizzes.map((attempt) => attempt.submittedAt || attempt.createdAt),
      ...result.assignmentSubmissions.map((submission) => submission.submittedAt),
    ].filter(Boolean).sort((left, right) => new Date(right).getTime() - new Date(left).getTime())[0]
    return {
      ...result,
      completedLessons,
      lessonCount: lessonEntries.length,
      progress,
      status: progress >= 100 ? 'completed' : progress > 0 ? 'in-progress' : 'not-started',
      submittedQuizzes,
      averageScore,
      lastAttempt,
    }
  })
  const allQuizAttempts = courseRows.flatMap((course) => course.submittedQuizzes.map((attempt) => ({
    ...attempt,
    courseId: course.courseId,
    courseName: course.course.title || 'Course',
    quizTitle: getCourseQuizTitle(course.course, attempt.quizId),
    score: getAttemptScore(attempt),
  }))).sort((left, right) => new Date(right.submittedAt || right.createdAt).getTime()
    - new Date(left.submittedAt || left.createdAt).getTime())
  const allAssignments = courseRows.flatMap((course) => course.assignmentSubmissions.map((submission) => ({
    ...submission,
    courseId: course.courseId,
    courseName: course.course.title || 'Course',
    assignmentTitle: getCourseAssignmentTitle(course.course, submission.assignmentId),
  }))).sort((left, right) => new Date(right.submittedAt).getTime() - new Date(left.submittedAt).getTime())
  const scoredAttempts = allQuizAttempts.filter((attempt) => attempt.score !== null)
  const averageScore = scoredAttempts.length
    ? Math.round(scoredAttempts.reduce((total, attempt) => total + attempt.score, 0) / scoredAttempts.length)
    : null
  const lessonCount = courseRows.reduce((total, course) => total + course.lessonCount, 0)
  const completedLessons = courseRows.reduce((total, course) => total + course.completedLessons, 0)
  const overallProgress = lessonCount ? Math.round((completedLessons / lessonCount) * 100) : 0
  const completedCourseCount = courseRows.filter((course) => course.status === 'completed').length
  const inProgressCourseCount = courseRows.filter((course) => course.status === 'in-progress').length
  const notStartedCourseCount = courseRows.filter((course) => course.status === 'not-started').length
  const earnedCertificates = certificates.filter((entry) => entry.certificate)
  const visibleCourses = selectedCourseId === 'all'
    ? courseRows
    : courseRows.filter((course) => course.courseId === selectedCourseId)
  const recentAttempts = allQuizAttempts.slice(0, 3)

  function openCourse(courseId) {
    navigate(`/student/course/${encodeURIComponent(courseId)}/learn`)
  }

  return (
    <section className="student-results">
      <header className="student-results__hero">
        <div className="student-results__heading">
          <span className="student-results__hero-icon"><Icon name="award" size={27} /></span>
          <div>
            <h1>Grades &amp; Results</h1>
            <p>Track your performance and view your results</p>
          </div>
        </div>
        <label className="student-results__filter">
          <span className="sr-only">Filter results by course</span>
          <select value={selectedCourseId} onChange={(event) => setSelectedCourseId(event.target.value)}>
            <option value="all">All Courses</option>
            {courseRows.map((course) => <option key={course.courseId} value={course.courseId}>{course.course.title}</option>)}
          </select>
        </label>
      </header>

      <section className="student-results__summary" aria-label="Learning results summary">
        <button className="student-results__summary-card is-blue" type="button" onClick={() => navigate('/student/courses')}>
          <span className="student-results__summary-icon"><Icon name="bookOpen" size={25} /></span>
          <span><strong>{hasResultsData ? courseRows.length : loading ? <span className="student-page-skeleton student-results__summary-skeleton" /> : '—'}</strong><small>Enrolled Courses</small></span>
        </button>
        <article className="student-results__summary-card is-green">
          <span className="student-results__summary-icon"><Icon name="check" size={23} /></span>
          <span>
            <strong>{hasResultsData ? `${overallProgress}%` : loading ? <span className="student-page-skeleton student-results__summary-skeleton" /> : '—'}</strong>
            <small>Overall Progress</small>
            <i>{hasResultsData || loading
              ? <b className={!hasResultsData ? 'student-page-skeleton' : ''} style={{ width: hasResultsData ? `${overallProgress}%` : '100%' }} />
              : null}</i>
          </span>
        </article>
        <article className="student-results__summary-card is-purple">
          <span className="student-results__summary-icon"><Icon name="spark" size={23} /></span>
          <span><strong>{hasResultsData ? (averageScore === null ? '—' : `${averageScore}%`) : loading ? <span className="student-page-skeleton student-results__summary-skeleton" /> : '—'}</strong><small>Average Score</small></span>
        </article>
        <button className="student-results__summary-card is-orange" type="button" onClick={() => navigate('/student/certificates')}>
          <span className="student-results__summary-icon"><Icon name="award" size={25} /></span>
          <span><strong>{hasCertificatesData ? earnedCertificates.length : certificatesLoading ? <span className="student-page-skeleton student-results__summary-skeleton" /> : '—'}</strong><small>Certificates Earned</small></span>
        </button>
      </section>

      <section className="student-results__content">
        <nav className="student-results__tabs" aria-label="Results categories">
          {[
            ['courses', 'Course Results'],
            ['assignments', 'Assignments'],
            ['quizzes', 'Quizzes'],
            ['certificates', 'Certificates'],
          ].map(([tab, label]) => (
            <button
              key={tab}
              className={activeTab === tab ? 'is-active' : ''}
              type="button"
              aria-current={activeTab === tab ? 'page' : undefined}
              onClick={() => setActiveTab(tab)}
            >
              {label}
            </button>
          ))}
        </nav>
        {error && <p className="student-results__error" role="alert">{error}</p>}
        {loading && !hasResultsData ? <StudentResultsTableSkeleton /> : hasResultsData ? (
          <div className="student-results__table-wrap">
            {activeTab === 'courses' && (
              visibleCourses.length
                ? <table className="student-results__table">
                    <thead><tr><th>Course</th><th>Progress</th><th>Average Score</th><th>Status</th><th>Last Attempt</th><th><span className="sr-only">Course actions</span></th></tr></thead>
                    <tbody>{visibleCourses.map((course) => (
                      <tr key={course.courseId}>
                        <td>
                          <div className="student-results__course">
                            <span className="student-results__course-art">
                              {course.course.thumbnailUrl
                                ? <img src={course.course.thumbnailUrl} alt="" />
                                : <Icon name="bookOpen" size={21} />}
                            </span>
                            <button type="button" onClick={() => openCourse(course.courseId)}>{course.course.title || 'Course'}</button>
                          </div>
                        </td>
                        <td>
                          <div className="student-results__progress">
                            <span><small>{course.progress}%</small><small>{course.progress}%</small></span>
                            <i><b className={course.status === 'completed' ? 'is-completed' : ''} style={{ width: `${course.progress}%` }} /></i>
                          </div>
                        </td>
                        <td><strong className="student-results__score">{course.averageScore === null ? '—' : `${course.averageScore}%`}</strong></td>
                        <td><span className={`student-results__status is-${course.status}`}><Icon name={course.status === 'completed' ? 'check' : 'clock'} size={14} />{course.status === 'completed' ? 'Completed' : course.status === 'not-started' ? 'Not Started' : 'In Progress'}</span></td>
                        <td>{formatResultDate(course.lastAttempt)}</td>
                        <td><button className="student-results__details" type="button" onClick={() => openCourse(course.courseId)}>View Details <Icon name="arrow" size={15} /></button></td>
                      </tr>
                    ))}</tbody>
                  </table>
                : <p className="student-results__empty">No enrolled courses to show yet.</p>
            )}
            {activeTab === 'assignments' && (
              allAssignments.length
                ? <table className="student-results__table">
                    <thead><tr><th>Assignment</th><th>Course</th><th>Status</th><th>Submitted</th><th /></tr></thead>
                    <tbody>{allAssignments.map((assignment) => (
                      <tr key={assignment._id}>
                        <td>{assignment.assignmentTitle}</td>
                        <td>{assignment.courseName}</td>
                        <td><span className={`student-results__status is-${assignment.reviewStatus === 'approved' ? 'completed' : assignment.reviewStatus === 'rejected' ? 'not-started' : 'in-progress'}`}>{assignment.reviewStatus === 'approved' ? 'Approved' : assignment.reviewStatus === 'rejected' ? 'Changes Requested' : 'In Review'}</span></td>
                        <td>{formatResultDate(assignment.submittedAt)}</td>
                        <td><button className="student-results__details" type="button" onClick={() => openCourse(assignment.courseId)}>Open Course <Icon name="arrow" size={15} /></button></td>
                      </tr>
                    ))}</tbody>
                  </table>
                : <p className="student-results__empty">Assignment submissions will appear here when you submit work.</p>
            )}
            {activeTab === 'quizzes' && (
              allQuizAttempts.length
                ? <table className="student-results__table">
                    <thead><tr><th>Quiz</th><th>Course</th><th>Score</th><th>Status</th><th>Attempt Date</th><th /></tr></thead>
                    <tbody>{allQuizAttempts.map((attempt) => (
                      <tr key={attempt._id}>
                        <td>{attempt.quizTitle}</td>
                        <td>{attempt.courseName}</td>
                        <td>{attempt.score === null ? '—' : `${Math.round(attempt.score)}%`}</td>
                        <td><span className={`student-results__status is-${attempt.passed ? 'completed' : 'in-progress'}`}>{attempt.passed ? 'Passed' : 'Submitted'}</span></td>
                        <td>{formatResultDate(attempt.submittedAt || attempt.createdAt)}</td>
                        <td><button className="student-results__details" type="button" onClick={() => openCourse(attempt.courseId)}>Open Course <Icon name="arrow" size={15} /></button></td>
                      </tr>
                    ))}</tbody>
                  </table>
                : <p className="student-results__empty">Quiz attempts will appear here after you complete a quiz.</p>
            )}
            {activeTab === 'certificates' && (
              !hasCertificatesData
                ? certificatesLoading
                  ? <StudentResultsTableSkeleton />
                  : <p className="student-results__empty">Certificate data is unavailable.</p>
                : earnedCertificates.length
                ? <div className="student-results__certificates">
                    {earnedCertificates.map((entry) => (
                      <button key={entry.courseId} type="button" onClick={() => navigate('/student/certificates')}>
                        <span className="student-results__certificate-icon"><Icon name="award" size={21} /></span>
                        <span><strong>{entry.courseName}</strong><small>Certificate earned · {formatResultDate(entry.certificate.completedAt)}</small></span>
                        <Icon name="arrow" size={17} />
                      </button>
                    ))}
                  </div>
                : <p className="student-results__empty">Earned certificates will appear here.</p>
            )}
          </div>
        ) : null}
      </section>

      <div className="student-results__lower">
        <section className="student-results__panel" aria-labelledby="student-results-performance-title">
          <h2 id="student-results-performance-title"><Icon name="chart" size={17} />Performance Overview</h2>
          <div className="student-results__performance">
            <div
              className={`student-results__donut${hasResultsData ? '' : ' is-loading'}`}
              role="img"
              aria-label={hasResultsData ? `${overallProgress}% overall progress` : loading ? 'Overall progress loading' : 'Overall progress unavailable'}
              style={{ '--student-results-progress': `${overallProgress}%` }}
            >
              <span>
                <strong>{hasResultsData ? `${overallProgress}%` : loading ? <span className="student-page-skeleton student-results__summary-skeleton" /> : '—'}</strong>
                <small>Overall Progress</small>
              </span>
            </div>
            <ul>
              <li><i className="is-completed" />Completed<strong>{hasResultsData ? completedCourseCount : loading ? <span className="student-page-skeleton student-results__metric-skeleton" /> : '—'}</strong></li>
              <li><i className="is-progress" />In Progress<strong>{hasResultsData ? inProgressCourseCount : loading ? <span className="student-page-skeleton student-results__metric-skeleton" /> : '—'}</strong></li>
              <li><i className="is-not-started" />Not Started<strong>{hasResultsData ? notStartedCourseCount : loading ? <span className="student-page-skeleton student-results__metric-skeleton" /> : '—'}</strong></li>
            </ul>
          </div>
        </section>
        <section className="student-results__panel" aria-labelledby="student-results-recent-title">
          <h2 id="student-results-recent-title"><Icon name="spark" size={17} />Recent Results</h2>
          <button className="student-results__view-all" type="button" onClick={() => setActiveTab('quizzes')}>View All <Icon name="arrow" size={14} /></button>
          {loading && !hasResultsData
            ? <ul className="student-results__recent student-results__recent--skeleton" aria-hidden="true">
                {[0, 1, 2].map((item) => (
                  <li key={item}>
                    <span className="student-page-skeleton student-results__recent-skeleton-icon" />
                    <span className="student-results__recent-copy">
                      <span className="student-page-skeleton student-results__recent-skeleton-copy" />
                      <span className="student-page-skeleton student-results__recent-skeleton-copy is-short" />
                    </span>
                    <span className="student-page-skeleton student-results__recent-skeleton-score" />
                    <span className="student-page-skeleton student-results__recent-skeleton-date" />
                  </li>
                ))}
              </ul>
            : !hasResultsData
              ? <p className="student-results__empty">Results are unavailable.</p>
              : recentAttempts.length
            ? <ul className="student-results__recent">
                {recentAttempts.map((attempt) => (
                  <li key={attempt._id}>
                    <span className="student-results__recent-icon"><Icon name="check" size={13} /></span>
                    <span className="student-results__recent-copy"><strong>Quiz · {attempt.courseName}</strong><small>{attempt.quizTitle}</small></span>
                    <span className="student-results__recent-score">{attempt.score === null ? 'Submitted' : `Score: ${Math.round(attempt.score)}%`}</span>
                    <time>{formatResultDate(attempt.submittedAt || attempt.createdAt)}</time>
                  </li>
                ))}
              </ul>
            : <p className="student-results__empty">Your recent quiz results will appear here.</p>}
        </section>
      </div>
    </section>
  )
}

async function fetchPublishedCourses(onLogout, signal) {
  const savedAuth = sessionStorage.getItem('lms.auth')
  const auth = savedAuth ? JSON.parse(savedAuth) : null
  if (typeof auth?.token !== 'string') {
    onLogout()
    throw new Error('Your session has ended. Please sign in again.')
  }
  const response = await fetchWithAuth(`${API_BASE_URL}/courses`, {
    headers: { Authorization: `Bearer ${auth.token}` },
    signal,
  }, API_BASE_URL, auth.token)
  const result = await response.json()
  if (isInvalidSessionResponse(response, result)) {
    onLogout()
    throw new Error('Your session has ended. Please sign in again.')
  }
  if (!response.ok) throw new Error(result.message || 'Available courses could not be loaded.')
  if (!Array.isArray(result.courses)) throw new Error('The server returned invalid course data.')
  return result.courses
}



function getCourseCounts(course) {
  const lessonCount = (course.modules || []).reduce((count, module) => {
    const items = module.contentItems || []
    return count + (items.length
      ? items.filter((item) => item.type === 'video-lesson').length
      : (module.lessons || []).length)
  }, 0)
  return { modules: course.modules?.length || 0, lessons: lessonCount }
}

function formatCourseDuration(minutes) {
  const value = Number(minutes) || 0
  if (value < 60) return `${value} min`
  const hours = Math.floor(value / 60)
  const remainder = value % 60
  return remainder ? `${hours} hr ${remainder} min` : `${hours} hr`
}



function getCourseLessons(course) {
  return (course?.modules || []).flatMap((module, moduleIndex) => {
    const videoItems = (module.contentItems || []).filter((item) => item.type === 'video-lesson')
    const lessons = videoItems.length ? videoItems : module.lessons || []
    return lessons.map((lesson, lessonIndex) => ({
      module,
      lesson,
      moduleKey: String(module._id || `${module.title}-${moduleIndex}`),
      lessonKey: String(lesson._id || `${moduleIndex}-${lessonIndex}`),
    }))
  })
}



function buildClientCourseSequence(course) {
  const lessons = getCourseLessons(course)
  const existingQuizzes = [
    ...(course?.modules || []).flatMap((m) => [
      ...(m.contentItems || []).filter((i) => i.type === 'quiz').map((i) => i.quiz || i),
      ...(m.quiz?.questions?.length ? [m.quiz] : []),
    ]),
    ...(course?.quizzes || []),
  ].filter((q, idx, arr) => q?._id && arr.findIndex((x) => String(x._id) === String(q._id)) === idx)

  const existingAssessments = [
    ...(course?.modules || []).flatMap((m) => (m.contentItems || []).filter((i) => i.type === 'assignment')),
    ...(course?.assignments || []),
  ].filter((a, idx, arr) => a?._id && arr.findIndex((x) => String(x._id) === String(a._id)) === idx)

  const totalVideos = lessons.length
  const shouldSequence = totalVideos >= 4 || existingQuizzes.length > 0 || existingAssessments.length > 0

  const sequence = []
  let videoCount = 0
  let quizIndex = 0
  let assessmentIndex = 0

  for (const entry of lessons) {
    videoCount++
    sequence.push({
      sequenceIndex: sequence.length + 1,
      type: 'video-lesson',
      id: String(entry.lesson._id || entry.lessonKey),
      title: entry.lesson.title,
      durationSeconds: entry.lesson.durationSeconds,
      lessonEntry: entry,
      lesson: entry.lesson,
      _learningKey: String(entry.lesson._id || entry.lessonKey),
    })

    if (shouldSequence) {
      if (videoCount % 2 === 0) {
        quizIndex++
        const quizObj = existingQuizzes[quizIndex - 1] || {
          _id: `derived-quiz-${course?._id}-${quizIndex}`,
          title: `Quiz ${quizIndex}`,
          passingPercentage: 70,
          maxAttempts: 3,
        }
        sequence.push({
          sequenceIndex: sequence.length + 1,
          type: 'quiz',
          id: String(quizObj._id),
          title: quizObj.title || `Quiz ${quizIndex}`,
          quiz: quizObj,
          _learningKey: String(quizObj._id),
        })
      }

      if (videoCount % 4 === 0) {
        assessmentIndex++
        const assessmentObj = existingAssessments[assessmentIndex - 1] || {
          _id: `derived-assessment-${course?._id}-${assessmentIndex}`,
          title: `Assessment ${assessmentIndex}`,
          points: 100,
        }
        sequence.push({
          sequenceIndex: sequence.length + 1,
          type: 'assessment',
          id: String(assessmentObj._id),
          title: assessmentObj.title || `Assessment ${assessmentIndex}`,
          assignment: assessmentObj,
          _learningKey: String(assessmentObj._id),
        })
      }
    }
  }

  while (quizIndex < existingQuizzes.length) {
    const quizObj = existingQuizzes[quizIndex]
    quizIndex++
    sequence.push({
      sequenceIndex: sequence.length + 1,
      type: 'quiz',
      id: String(quizObj._id),
      title: quizObj.title || `Quiz ${quizIndex}`,
      quiz: quizObj,
      _learningKey: String(quizObj._id),
    })
  }

  while (assessmentIndex < existingAssessments.length) {
    const assessmentObj = existingAssessments[assessmentIndex]
    assessmentIndex++
    sequence.push({
      sequenceIndex: sequence.length + 1,
      type: 'assessment',
      id: String(assessmentObj._id),
      title: assessmentObj.title || `Assessment ${assessmentIndex}`,
      assignment: assessmentObj,
      _learningKey: String(assessmentObj._id),
    })
  }

  return sequence
}



function createEmptyAttentionSession(lessonId = '') {
  return {
    lessonId,
    sessionId: '',
    schedule: [],
    nextIndex: 0,
    pending: false,
    blocked: false,
    initialized: false,
    pendingDetails: null,
    lastVideoPositionSeconds: 0,
    durationSeconds: 0,
    videoUrl: '',
    questionsDuringVideo: 0,
    minIntervalSeconds: 0,
    maxIntervalSeconds: 0,
  }
}


function getCourseProgress(enrollment) {
  if (!enrollment?.courseId) {
    return {
      completedCount: 0,
      totalCount: 0,
      percentage: 0,
      isCompleted: false,
      videoStats: { completed: 0, total: 0 },
      quizStats: { passed: 0, total: 0 },
      assessmentStats: { completed: 0, total: 0 },
      nextActivity: null,
      status: 'active',
    }
  }

  if (enrollment.progress && typeof enrollment.progress.percentage === 'number') {
    const p = enrollment.progress
    return {
      completedCount: p.completedActivities ?? p.completedCount ?? 0,
      totalCount: p.totalRequiredActivities ?? p.totalLessons ?? 0,
      percentage: p.percentage ?? p.progressPercentage ?? 0,
      isCompleted: p.isCompleted === true || enrollment.status === 'completed',
      videoStats: p.videoStats || { completed: p.completedCount || 0, total: p.totalLessons || 0 },
      quizStats: p.quizStats || { passed: 0, total: 0 },
      assessmentStats: p.assessmentStats || { completed: 0, total: 0 },
      nextActivity: p.nextActivity || null,
      status: enrollment.status,
    }
  }

  const sequence = buildClientCourseSequence(enrollment.courseId)
  const completedLessonIds = new Set((enrollment.completedLessonIds || []).map(String))

  const videoItems = sequence.filter((item) => item.type === 'video-lesson')
  const completedVideos = videoItems.filter((item) => completedLessonIds.has(item.id)).length
  const totalVideos = videoItems.length

  const isCompleted = enrollment.status === 'completed'
  const percentage = totalVideos ? Math.round((completedVideos / totalVideos) * 100) : 0

  return {
    completedCount: completedVideos,
    totalCount: totalVideos,
    percentage,
    isCompleted,
    videoStats: { completed: completedVideos, total: totalVideos },
    quizStats: { passed: 0, total: 0 },
    assessmentStats: { completed: 0, total: 0 },
    nextActivity: sequence.find((s) => !completedLessonIds.has(s.id)) || null,
    status: enrollment.status,
  }
}



function getModuleLearningItems(module, moduleIndex) {
  const moduleKey = String(module._id || `${module.title}-${moduleIndex}`)
  const contentItems = module.contentItems?.length
    ? module.contentItems
      .map((item, index) => ({ item, index }))
      .sort((left, right) => (left.item.order ?? left.index) - (right.item.order ?? right.index))
      .map(({ item, index }) => ({
        ...item,
        _learningKey: String(item._id || `${moduleKey}-item-${index}`),
        _moduleKey: moduleKey,
      }))
    : (module.lessons || []).map((lesson, index) => ({
      ...lesson,
      type: 'video-lesson',
      _learningKey: String(lesson._id || `${moduleKey}-lesson-${index}`),
      _moduleKey: moduleKey,
    }))
  const items = [...contentItems]
  if (module.quiz?.questions?.length && !contentItems.some((item) => item.type === 'quiz')) {
    items.push({
      type: 'quiz',
      title: module.quiz.title || 'Module quiz',
      quiz: module.quiz,
      _learningKey: String(module.quiz._id || `${moduleKey}-quiz`),
      _moduleKey: moduleKey,
    })
  }
  return items
}

function getStudentContentLabel(type) {
  return {
    'video-lesson': 'Video',
    quiz: 'Quiz',
    assignment: 'Assignment',
    note: 'Notes / resources',
  }[type] || 'Course content'
}

function StudentAssignmentPanel({ courseId, enrollmentId, assignment, submissions, onSubmitted, onLearningDataChanged, onLogout, showHeader = true, canSubmit = true }) {
  const [file, setFile] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [isDragging, setIsDragging] = useState(false)
  const [filePreviewUrl, setFilePreviewUrl] = useState('')
  const fileInputRef = useRef(null)
  const assignmentSubmissions = submissions.filter((submission) => (
    String(submission.assignmentId) === String(assignment._id)
  ))
  const latestSubmission = assignmentSubmissions
    .slice()
    .sort((left, right) => new Date(right.submittedAt || 0).getTime() - new Date(left.submittedAt || 0).getTime())[0]

  useEffect(() => {
    if (!file) {
      setFilePreviewUrl('')
      return undefined
    }
    const previewUrl = URL.createObjectURL(file)
    setFilePreviewUrl(previewUrl)
    return () => URL.revokeObjectURL(previewUrl)
  }, [file])

  function chooseAssignmentFile(candidate) {
    if (!candidate) return
    const extension = candidate.name.slice(candidate.name.lastIndexOf('.')).toLowerCase()
    if (!['.pdf', '.docx', '.txt'].includes(extension)) {
      setError('Choose a PDF, DOCX, or TXT file.')
      return
    }
    if (!candidate.size || candidate.size > 10 * 1024 * 1024) {
      setError('Choose a file that is smaller than 10 MB.')
      return
    }
    setError('')
    setFile(candidate)
  }

  function formatFileSize(bytes) {
    return bytes >= 1024 * 1024
      ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
      : `${Math.max(1, Math.round(bytes / 1024))} KB`
  }

  function getSubmissionStatusLabel(submission) {
    if (submission.reviewStatus === 'approved') return 'Approved'
    if (submission.reviewStatus === 'rejected') return 'Rejected — resubmission required'
    return 'Awaiting Admin Review'
  }

  async function submitAssignment(event) {
    event.preventDefault()
    const form = event.currentTarget
    if (!file) {
      setError('Choose a PDF, DOCX, or TXT file to submit.')
      return
    }
    setSubmitting(true)
    setError('')
    try {
      const savedAuth = sessionStorage.getItem('lms.auth')
      const auth = savedAuth ? JSON.parse(savedAuth) : null
      if (typeof auth?.token !== 'string') {
        onLogout()
        return
      }
      const formData = new FormData()
      formData.append('file', file)
      const response = await fetch(`${API_BASE_URL}/courses/${encodeURIComponent(courseId)}/assignments/${encodeURIComponent(assignment._id)}/submissions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${auth.token}` },
        body: formData,
      })
      const result = await response.json()
      if (isInvalidSessionResponse(response, result)) {
        onLogout()
        return
      }
      if (!response.ok) throw new Error(result.message || 'Your assignment could not be submitted.')
      if (!result.submission?._id) throw new Error('The server did not confirm your assignment submission.')
      onSubmitted(result.submission)
      setFile(null)
      form.reset()
      onLearningDataChanged()
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Your assignment could not be submitted.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <section className={`student-course-activity${showHeader ? ' student-course-assignment-view' : ''}`}>
      {showHeader && (
        <header className="student-course-assignment-view__header">
          <span className="student-course-assignment-view__icon"><Icon name="clipboardCheck" size={20} /></span>
          <h2>{assignment.title}</h2>
          <span className="student-course-assignment-view__badge"><Icon name="clipboardCheck" size={13} />Assignment</span>
          {latestSubmission && (
            <span className={`student-course-assignment-view__status is-${latestSubmission.reviewStatus || 'pending'}`}>
              {getSubmissionStatusLabel(latestSubmission)}
            </span>
          )}
        </header>
      )}
      {assignment.description && <p className="student-course-activity__instructions">{assignment.description}</p>}
      {showHeader ? (
        <div className="student-course-activity__details student-course-assignment-view__details">
          <span>
            <Icon name="clock" size={19} />
            <span><small>Due Date</small><strong>{assignment.dueDate ? new Date(assignment.dueDate).toLocaleDateString() : 'No due date'}</strong></span>
          </span>
          <span>
            <Icon name="award" size={20} />
            <span><small>Total Points</small><strong>{Number(assignment.points) || 0} points</strong></span>
          </span>
        </div>
      ) : (
        <div className="student-course-activity__details">
          <span>Due {assignment.dueDate ? new Date(assignment.dueDate).toLocaleDateString() : 'No due date'}</span>
          <span>{Number(assignment.points) || 0} points</span>
        </div>
      )}
      {error && <p className="student-courses__message is-error" role="alert">{error}</p>}
      {canSubmit && (
        <form className={`student-assignment-submit${showHeader ? ' student-assignment-submit--card' : ''}`} onSubmit={submitAssignment}>
          {showHeader && (
            <div className="student-assignment-submit__heading">
              <span className="student-assignment-submit__upload-icon"><Icon name="file" size={20} /></span>
              <span><strong>Upload your work</strong><small>Upload a PDF, DOCX, or TXT file (max 10 MB)</small></span>
            </div>
          )}
          {showHeader ? (
            <label
              className={`student-assignment-submit__dropzone${isDragging ? ' is-dragging' : ''}${file ? ' has-file' : ''}`}
              onDragOver={(event) => {
                event.preventDefault()
                setIsDragging(true)
              }}
              onDragLeave={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget)) setIsDragging(false)
              }}
              onDrop={(event) => {
                event.preventDefault()
                setIsDragging(false)
                chooseAssignmentFile(event.dataTransfer.files?.[0])
              }}
            >
              <input
                ref={fileInputRef}
                className="student-assignment-submit__file-input"
                type="file"
                accept=".pdf,.docx,.txt,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain"
                onChange={(event) => chooseAssignmentFile(event.currentTarget.files?.[0])}
              />
              <Icon name="file" size={32} />
              <span>Drag and drop your file here</span>
              <small>or</small>
              <span className="student-assignment-submit__choose">Choose File</span>
            </label>
          ) : (
            <label>
              <span>Upload your work (PDF, DOCX, or TXT · max 10 MB)</span>
              <input
                type="file"
                accept=".pdf,.docx,.txt,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain"
                onChange={(event) => chooseAssignmentFile(event.currentTarget.files?.[0])}
              />
            </label>
          )}
          {showHeader && file && (
            <div className="student-assignment-submit__uploaded">
              <span className="student-assignment-submit__file-icon"><Icon name="file" size={17} /></span>
              <span className="student-assignment-submit__file-name"><strong>{file.name}</strong><small>{formatFileSize(file.size)}</small></span>
              <a href={filePreviewUrl || undefined} target="_blank" rel="noreferrer">View</a>
              <button
                type="button"
                onClick={() => {
                  setFile(null)
                  setError('')
                  if (fileInputRef.current) fileInputRef.current.value = ''
                }}
              >
                Remove
              </button>
            </div>
          )}
          <button
            className={`student-button${showHeader ? ' student-assignment-submit__submit' : ''}`}
            type="submit"
            disabled={submitting || !assignment._id || (showHeader && !file)}
          >
            {submitting ? 'Submitting…' : showHeader ? <>Submit assignment <Icon name="arrow" size={15} /></> : 'Submit assignment'}
          </button>
        </form>
      )}
      {showHeader && latestSubmission && (
        <div className="student-assignment-submit__review">
          <strong>{getSubmissionStatusLabel(latestSubmission)}</strong>
          {latestSubmission.reviewStatus === 'approved' && latestSubmission.marksObtained !== null && latestSubmission.marksObtained !== undefined && (
            <span>Score: {latestSubmission.marksObtained} / {assignment.points ?? assignment.maximumMarks ?? '—'}</span>
          )}
          {(latestSubmission.reviewComment || latestSubmission.feedback) && (
            <p>{latestSubmission.reviewComment || latestSubmission.feedback}</p>
          )}
        </div>
      )}
      {assignmentSubmissions.length > 0 && (
        <div className="student-assignment-submissions">
          <h3>Submissions</h3>
          {assignmentSubmissions.map((submission) => (
            <a className={showHeader ? 'student-assignment-submissions__file' : undefined} key={submission._id} href={`${API_BASE_URL}/assignment-submissions/${encodeURIComponent(submission._id)}/download`} onClick={async (event) => {
              event.preventDefault()
              try {
                const savedAuth = sessionStorage.getItem('lms.auth')
                const auth = savedAuth ? JSON.parse(savedAuth) : null
                if (typeof auth?.token !== 'string') {
                  onLogout()
                  return
                }
                const response = await fetch(event.currentTarget.href, { headers: { Authorization: `Bearer ${auth.token}` } })
                if (isInvalidSessionResponse(response, {})) {
                  onLogout()
                  return
                }
                if (!response.ok) throw new Error('The submitted file could not be downloaded.')
                const blob = await response.blob()
                const url = URL.createObjectURL(blob)
                const link = document.createElement('a')
                link.href = url
                link.download = submission.fileName
                link.click()
                URL.revokeObjectURL(url)
              } catch (downloadError) {
                setError(downloadError instanceof Error ? downloadError.message : 'The submitted file could not be downloaded.')
              }
            }}>
              {showHeader ? (
                <>
                  <span className="student-assignment-submit__file-icon"><Icon name="file" size={17} /></span>
                  <span className="student-assignment-submit__file-name"><strong>{submission.fileName}</strong><small>Submitted {new Date(submission.submittedAt).toLocaleString()}</small></span>
                  <span>View</span>
                </>
              ) : `${submission.fileName} · Submitted ${new Date(submission.submittedAt).toLocaleString()}`}
            </a>
          ))}
        </div>
      )}
    </section>
  )
}

function StudentAssignmentDetail({ entry, onClose, onLogout, onSubmitted, onLearningDataChanged }) {
  const { assignment, submission, status } = entry
  const isRejected = submission?.reviewStatus === 'rejected'
  const feedback = submission?.reviewComment || submission?.feedback
  const hasScore = submission?.marksObtained !== null
    && submission?.marksObtained !== undefined
    && Number.isFinite(Number(submission.marksObtained))
  const maximumMarks = assignment.points ?? assignment.maximumMarks

  return (
    <div className="student-assignment-dialog" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose()
    }}>
      <section className="student-assignment-dialog__panel" role="dialog" aria-modal="true" aria-labelledby="student-assignment-dialog-title">
        <header className="student-assignment-dialog__header">
          <div>
            <span className="student-assignments__eyebrow">{entry.courseName}</span>
            <h2 id="student-assignment-dialog-title">{assignment.title || 'Assignment'}</h2>
          </div>
          <button type="button" className="student-assignment-dialog__close" onClick={onClose} aria-label="Close assignment details">×</button>
        </header>
        {submission && (
          <div className={`student-assignment-dialog__review is-${isRejected ? 'rejected' : status}`}>
            <strong>{isRejected ? 'Rejected — resubmission required' : status === 'graded' ? 'Approved' : 'Awaiting Admin Review'}</strong>
            {hasScore && status === 'graded' && (
              <span>Score: {submission.marksObtained}{maximumMarks !== undefined ? ` / ${maximumMarks}` : ''}</span>
            )}
            {feedback && <p>{feedback}</p>}
          </div>
        )}
        <StudentAssignmentPanel
          courseId={entry.courseId}
          enrollmentId={entry.enrollmentId}
          assignment={assignment}
          submissions={submission ? [submission] : []}
          onSubmitted={onSubmitted}
          onLearningDataChanged={onLearningDataChanged}
          onLogout={onLogout}
          showHeader={false}
          canSubmit={status === 'pending'}
        />
      </section>
    </div>
  )
}

function StudentNotePanel({ item }) {
  return (
    <section className="student-course-activity">
      <header>
        <span className="student-eyebrow">{getStudentContentLabel('note')}</span>
        <h2>{item.title}</h2>
      </header>
      {item.description && <p className="student-course-activity__instructions">{item.description}</p>}
      {item.content && <div className="student-course-note__content">{item.content}</div>}
      {item.resources?.length > 0 ? (
        <ul className="student-course-note__resources">
          {item.resources.map((resource, index) => (
            <li key={resource._id || `${resource.url}-${index}`}>
              <a href={resource.url} target="_blank" rel="noreferrer" download={resource.resourceType === 'raw' || resource.format === 'pdf' ? resource.title : undefined}>
                {resource.title || `Resource ${index + 1}`}
              </a>
              {resource.format && <small>{resource.format.toUpperCase()}</small>}
            </li>
          ))}
        </ul>
      ) : <p>No downloadable resources were added to this note.</p>}
    </section>
  )
}

function EnrollmentCourseCard({ enrollment }) {
  const course = enrollment?.courseId && typeof enrollment.courseId === 'object'
    ? enrollment.courseId
    : {}
  const courseId = String(
    (enrollment?.courseId && typeof enrollment.courseId === 'object' ? enrollment.courseId._id : null) ||
    enrollment?.courseId ||
    enrollment?.course?._id ||
    ''
  )
  const counts = getCourseCounts(course)
  const progressData = getCourseProgress(enrollment)
  const {
    percentage,
    isCompleted,
    nextActivity,
  } = progressData

  const difficultyLabels = {
    beginner: 'Beginner',
    intermediate: 'Intermediate',
    advanced: 'Advanced',
    'all-levels': 'All levels',
  }

  const targetActivity = nextActivity || { id: '', type: 'video-lesson' }
  const coursePath = targetActivity?.id
    ? targetActivity.type === 'video-lesson'
      ? `/student/course/${encodeURIComponent(courseId)}/learn?lesson=${encodeURIComponent(targetActivity.id)}`
      : `/student/course/${encodeURIComponent(courseId)}/learn?activity=${encodeURIComponent(targetActivity.id)}&type=${targetActivity.type}`
    : `/student/course/${encodeURIComponent(courseId)}/learn`

  const nextLessonTitle = nextActivity?.title || ''

  return (
    <article className="student-enrolled-course">
      {course.thumbnailUrl ? (
        <img
          className="student-enrolled-course__thumbnail"
          src={course.thumbnailUrl}
          alt={`${course.title} course thumbnail`}
        />
      ) : (
        <div
          className="student-enrolled-course__thumbnail student-enrolled-course__thumbnail--empty"
          aria-label="No course thumbnail"
        >
          <Icon name="book" size={28} />
        </div>
      )}

      <div className="student-enrolled-course__body">
        <div className="student-enrolled-course__header">
          <div className="student-enrolled-course__meta-top">
            <span className="student-enrolled-course__category">
              {course.category || 'General'}
            </span>
            <span className="student-enrolled-course__meta-dot">·</span>
            <span className="student-enrolled-course__difficulty">
              {difficultyLabels[course.difficulty] || 'All levels'}
            </span>
          </div>
          <span className={`student-enrolled-course__status ${isCompleted ? 'is-completed' : 'is-progress'}`}>
            {isCompleted ? 'Completed' : 'In Progress'}
          </span>
        </div>

        <h3 className="student-enrolled-course__title" title={course.title}>
          {course.title}
        </h3>

        <div className="student-enrolled-course__curriculum-meta">
          <span>{counts.modules} {counts.modules === 1 ? 'module' : 'modules'}</span>
          <span className="student-enrolled-course__meta-dot">·</span>
          <span>{counts.lessons} {counts.lessons === 1 ? 'lesson' : 'lessons'}</span>
        </div>

        <div className="student-enrolled-course__progress">
          <div className="student-enrolled-course__progress-copy">
            <span>Overall Course Progress</span>
            <strong>{percentage}%</strong>
          </div>
          <div
            className="student-enrolled-course__progress-track"
            role="progressbar"
            aria-valuemin="0"
            aria-valuemax="100"
            aria-valuenow={percentage}
            aria-label={`${course.title} progress`}
          >
            <span
              className={isCompleted ? 'is-completed' : ''}
              style={{ width: `${Math.min(100, percentage)}%` }}
            />
          </div>

          {!isCompleted && nextLessonTitle && (
            <p className="student-enrolled-course__next-lesson">
              <span className="student-enrolled-course__next-label">Next lesson:</span>{' '}
              <span className="student-enrolled-course__next-title" title={nextLessonTitle}>
                {nextLessonTitle}
              </span>
            </p>
          )}
        </div>

        <Link
          className="student-enrolled-course__continue"
          to={`/student/course/${encodeURIComponent(courseId)}/details`}
        >
          <span>Course Details →</span>
        </Link>
      </div>
    </article>
  )
}

function EnrollmentCourseCards({
  enrollments,
  emptyTitle = 'No enrolled courses yet',
  emptyDescription = 'Courses assigned or enrolled for your account will appear here.',
}) {
  const availableEnrollments = enrollments.filter((entry) => entry.courseId && typeof entry.courseId === 'object')
  if (!availableEnrollments.length) {
    return enrollments.length
      ? <p className="student-courses__message is-error" role="alert">Your enrollment exists, but its course details are unavailable. Please contact your administrator.</p>
      : <EmptyState icon="book" title={emptyTitle} description={emptyDescription} />
  }
  return (
    <div className="student-enrolled-courses">
      {availableEnrollments.map((entry) => <EnrollmentCourseCard key={entry._id} enrollment={entry} />)}
    </div>
  )
}

function EnrollmentCourseSkeletons() {
  return (
    <div className="student-enrolled-courses student-enrolled-courses--skeleton" role="status" aria-label="Loading courses" aria-busy="true">
      {[0, 1].map((item) => (
        <article className="student-enrolled-course" key={item} aria-hidden="true">
          <span className="student-page-skeleton student-enrolled-course__skeleton-image" />
          <div className="student-enrolled-course__body student-enrolled-course__skeleton-body">
            <span className="student-page-skeleton student-enrolled-course__skeleton-title" />
            <span className="student-page-skeleton student-enrolled-course__skeleton-line" />
            <span className="student-page-skeleton student-enrolled-course__skeleton-line is-short" />
            <span className="student-page-skeleton student-enrolled-course__skeleton-progress" />
          </div>
        </article>
      ))}
    </div>
  )
}

function StudentDashboardCourses({ onLogout, selectedCategory, refreshKey }) {
  const [initialEnrollments] = useState(getCachedStudentPageEnrollments)
  const [enrollments, setEnrollments] = useState(initialEnrollments || [])
  const [loading, setLoading] = useState(initialEnrollments === null)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    fetchStudentPageEnrollments(onLogout)
      .then((loadedEnrollments) => { if (active) setEnrollments(loadedEnrollments) })
      .catch((loadError) => {
        if (active) setError(loadError instanceof Error ? loadError.message : 'Your courses could not be loaded.')
      })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [onLogout, refreshKey])

  const categoryEnrollments = selectedCategory
    ? enrollments.filter((entry) => (
      typeof entry.courseId === 'object'
      && entry.courseId
      && filterCoursesByCategory([entry.courseId], selectedCategory).length > 0
    ))
    : enrollments.slice(0, 3)

  return loading
    ? <EnrollmentCourseSkeletons />
    : error && initialEnrollments === null
      ? <p className="student-courses__message is-error" role="alert">{error}</p>
      : <>
        {error && <p className="student-courses__message is-error" role="alert">{error}</p>}
        <EnrollmentCourseCards
        enrollments={categoryEnrollments}
        emptyTitle={selectedCategory ? `No ${selectedCategory} courses yet` : 'No enrolled courses yet'}
        emptyDescription={selectedCategory
          ? `Enrolled courses in ${selectedCategory} will appear here.`
          : 'Courses assigned or enrolled for your account will appear here.'}
      />
      </>
}

function StudentAvailableCourseCard({ course, enrollment, onEnroll, enrolling, error }) {
  const counts = getCourseCounts(course)
  const difficultyLabels = {
    beginner: 'Beginner',
    intermediate: 'Intermediate',
    advanced: 'Advanced',
    'all-levels': 'All levels',
  }
  return (
    <article className="student-available-course">
      {course.thumbnailUrl
        ? <img className="student-available-course__thumbnail" src={course.thumbnailUrl} alt={`${course.title} course thumbnail`} />
        : <div className="student-available-course__thumbnail student-available-course__thumbnail--empty" aria-label="No course thumbnail"><Icon name="book" size={28} /></div>}
      <div className="student-available-course__body">
        <div className="student-available-course__heading">
          <div>
            <p className="student-available-course__category">
              {course.category || 'Other'} <span>·</span> {difficultyLabels[course.difficulty] || 'Beginner'}
            </p>
            <h3>
              <Link to={`/student/course/${encodeURIComponent(course._id)}/details`} className="student-available-course__title-link">
                {course.title}
              </Link>
            </h3>
          </div>
          <span className="student-available-course__status">{enrollment ? 'Enrolled' : 'Not Enrolled'}</span>
        </div>
        <p className="student-available-course__description">{course.description || course.detailedDescription || 'No course description added yet.'}</p>
        <div className="student-available-course__meta">
          <span>{counts.modules} modules</span>
          <span>{counts.lessons} lessons</span>
          <span>{formatCourseDuration(course.estimatedDurationMinutes)}</span>
        </div>
        {error && <p className="student-courses__message is-error" role="alert">{error}</p>}
        {enrollment
          ? <Link className="student-available-course__action" to={`/student/course/${encodeURIComponent(course._id)}/learn`}>
            Continue Learning <Icon name="arrow" size={15} />
          </Link>
          : <button className="student-available-course__action" type="button" onClick={() => onEnroll(course)} disabled={enrolling}>
            {enrolling ? 'Enrolling…' : 'Enroll Now'} <Icon name="arrow" size={15} />
          </button>}
      </div>
    </article>
  )
}

function StudentAvailableCourses({ user, onLogout, onLearningDataChanged, onCategoriesLoaded, selectedCategory }) {
  const [courses, setCourses] = useState([])
  const [enrollments, setEnrollments] = useState([])
  const [enrollingCourseId, setEnrollingCourseId] = useState('')
  const [enrollmentErrors, setEnrollmentErrors] = useState({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    const controller = new AbortController()
    Promise.all([
      fetchPublishedCourses(onLogout, controller.signal),
      fetchStudentPageEnrollments(onLogout),
    ])
      .then(([publishedCourses, currentEnrollments]) => {
        if (controller.signal.aborted) return
        setCourses(publishedCourses)
        setEnrollments(currentEnrollments)
        onCategoriesLoaded(getCourseCategoryNames(publishedCourses))
      })
      .catch((loadError) => {
        if (!controller.signal.aborted && loadError.name !== 'AbortError') {
          setError(loadError instanceof Error ? loadError.message : 'Available courses could not be loaded.')
        }
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [onCategoriesLoaded, onLogout, user?.id])

  const enrollmentsByCourseId = new Map()
  for (const entry of enrollments) {
    if (!entry.courseId || entry.status === 'cancelled') continue
    const enrolledCourseId = String(entry.courseId?._id || entry.courseId)
    if (!enrollmentsByCourseId.has(enrolledCourseId)) enrollmentsByCourseId.set(enrolledCourseId, entry)
  }

  const categoryCourses = filterCoursesByCategory(courses, selectedCategory)

  async function enrollInCourse(course) {
    const courseId = String(course._id)
    setEnrollingCourseId(courseId)
    setEnrollmentErrors((current) => ({ ...current, [courseId]: '' }))
    try {
      const savedAuth = sessionStorage.getItem('lms.auth')
      const auth = savedAuth ? JSON.parse(savedAuth) : null
      if (typeof auth?.token !== 'string') {
        onLogout()
        return
      }
      const response = await fetch(`${API_BASE_URL}/enrollments`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${auth.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ courseId }),
      })
      const result = await response.json()
      if (isInvalidSessionResponse(response, result)) {
        onLogout()
        return
      }
      if (!response.ok) throw new Error(result.message || 'You could not be enrolled in this course.')
      if (!result.enrollment?._id) throw new Error('The server did not confirm your enrollment.')
      setEnrollments((current) => [
        { ...result.enrollment, courseId: course },
        ...current.filter((entry) => String(entry.courseId?._id || entry.courseId) !== courseId),
      ])
      onLearningDataChanged()
    } catch (enrollError) {
      setEnrollmentErrors((current) => ({
        ...current,
        [courseId]: enrollError instanceof Error ? enrollError.message : 'You could not be enrolled in this course.',
      }))
    } finally {
      setEnrollingCourseId('')
    }
  }

  return (
    <section className="student-panel student-available-courses" aria-labelledby="student-available-courses-title">
      <div className="student-section-heading">
        <div><span className="student-eyebrow">KEEP LEARNING</span><h2 id="student-available-courses-title">All Courses</h2></div>
      </div>
      {error && <p className="student-courses__message is-error" role="alert">{error}</p>}
      {loading ? <p role="status">Loading courses…</p> : !error && (
        categoryCourses.length
          ? <div className="student-available-courses__grid">
            {categoryCourses.map((course) => (
              <StudentAvailableCourseCard
                key={course._id}
                course={course}
                enrollment={enrollmentsByCourseId.get(String(course._id))}
                onEnroll={enrollInCourse}
                enrolling={enrollingCourseId === String(course._id)}
                error={enrollmentErrors[String(course._id)]}
              />
            ))}
          </div>
          : selectedCategory
            ? <EmptyState
              icon="book"
              title={`No ${selectedCategory} courses found`}
              description={`Published courses in ${selectedCategory} will appear here.`}
            />
            : <EmptyState
            icon="book"
            title="No published courses yet"
            description="Published courses will appear here when the administrator adds them."
          />
      )}
    </section>
  )
}



function StudentCourseLearning({
  enrollment,
  onEnrollmentUpdated,
  onLearningDataChanged,
  onLogout,
  requestedLessonId,
  requestedActivityId,
  requestedActivityType,
  contentSearch,
}) {
  const location = useLocation()
  const navigate = useNavigate()
  const course = enrollment.courseId
  const lessons = getCourseLessons(course)
  const moduleItems = (course.modules || []).map((module, index) => ({
    module,
    moduleKey: String(module._id || `${module.title}-${index}`),
    items: getModuleLearningItems(module, index),
  }))
  const courseLevelItems = [
    ...(course.quizzes || []).map((quiz, index) => ({
      type: 'quiz',
      title: quiz.title || `Course quiz ${index + 1}`,
      quiz,
      _learningKey: String(quiz._id || `course-quiz-${index}`),
      _moduleKey: '',
    })),
    ...(course.assignments || []).map((assignment, index) => ({
      ...assignment,
      type: 'assignment',
      _learningKey: String(assignment._id || `course-assignment-${index}`),
      _moduleKey: '',
    })),
  ]
    const sequencedActivities = useMemo(() => {
    if (enrollment.progress?.sequence?.length) {
      return enrollment.progress.sequence.map((item, idx) => ({
        ...item,
        _learningKey: String(item.id || item.quizId || item.assignmentId || item.lessonId),
        _moduleKey: item.moduleId ? String(item.moduleId) : '',
        sequenceNumber: item.sequenceIndex || (idx + 1),
      }))
    }
    return buildClientCourseSequence(course).map((item, idx) => ({
      ...item,
      _learningKey: String(item.id),
      _moduleKey: '',
      sequenceNumber: item.sequenceIndex || (idx + 1),
    }))
  }, [course, enrollment.progress])

  const allContentItems = useMemo(() => {
    if (sequencedActivities.length > 0) {
      return sequencedActivities.map((item) => {
        if (item.type === 'video-lesson') {
          const entry = lessons.find((l) => String(l.lesson._id || l.lessonKey) === String(item.id || item.lessonId))
          return {
            ...item,
            lesson: entry?.lesson || item.lesson || { _id: item.id, title: item.title, videoUrl: item.videoUrl },
            module: entry?.module || item.module,
            moduleKey: entry?.moduleKey || item._moduleKey,
          }
        }
        return item
      })
    }
    return [...moduleItems.flatMap(({ items }) => items), ...courseLevelItems]
  }, [sequencedActivities, lessons, moduleItems, courseLevelItems])
  const [activeLessonId, setActiveLessonId] = useState(() => (
    lessons.some(({ lesson }) => String(lesson._id) === requestedLessonId)
      ? requestedLessonId
      : lessons[0]?.lessonKey || ''
  ))
  const [activeContentItemId, setActiveContentItemId] = useState(() => {
    if (!requestedActivityId || !['quiz', 'assignment'].includes(requestedActivityType)) return ''
    return allContentItems.find((item) => (
      item.type === requestedActivityType
      && String(item.type === 'quiz' ? item.quiz?._id || item._learningKey : item._learningKey) === requestedActivityId
    ))?._learningKey || ''
  })
  const [detailsTab, setDetailsTab] = useState('overview')
  const [lessonInfoTab, setLessonInfoTab] = useState('overview')
  const [videoOpenSequence, setVideoOpenSequence] = useState(0)
  const [transcriptPlayback, setTranscriptPlayback] = useState({ lessonKey: '', cueIndex: -1 })
  const [expandedModules, setExpandedModules] = useState(() => new Set(
    course.modules?.length ? [String(course.modules[0]._id || `${course.modules[0].title}-0`)] : [],
  ))
  const [savingLessonId, setSavingLessonId] = useState('')
  const [progressError, setProgressError] = useState('')
  const [autoplayBlockedLessonId, setAutoplayBlockedLessonId] = useState('')
  const [assignmentSubmissions, setAssignmentSubmissions] = useState(enrollment.assignmentSubmissions || [])
  const [quizAttempts, setQuizAttempts] = useState(enrollment.quizAttempts || [])
  const [courseCertificate, setCourseCertificate] = useState(null)
  const [courseCertificateLoading, setCourseCertificateLoading] = useState(true)
  const [courseCertificateError, setCourseCertificateError] = useState('')
  const [courseCertificateRefresh, setCourseCertificateRefresh] = useState(0)
  const [courseCertificatePdf, setCourseCertificatePdf] = useState({ certificateId: '', url: '' })
  const [courseCertificatePdfLoading, setCourseCertificatePdfLoading] = useState(false)
  const [courseCertificatePdfError, setCourseCertificatePdfError] = useState('')
  const [courseCertificatePdfRetry, setCourseCertificatePdfRetry] = useState(0)
  const courseCertificatePdfUrlRef = useRef('')
  const videoPlayerRef = useRef(null)
  const pendingSeekTimeRef = useRef(null)
  const requestOpenNoteEditorRef = useRef(null)
  const transcriptCueListRef = useRef(null)
  const transcriptCueRefs = useRef([])
  const transcriptScriptRef = useRef(null)
  const transcriptScriptCueRefs = useRef([])
  const assignmentStatusRefreshRef = useRef(false)
  const lessonPlaybackPositionsRef = useRef({ ...(enrollment.lessonPlaybackPositions || {}) })
  const playbackPositionSaveRef = useRef(new Map())
  const initialAttentionLesson = lessons.find(({ lesson, lessonKey }) => (
    String(lesson._id || lessonKey) === activeLessonId
  ))?.lesson
  const attentionSessionRef = useRef(createEmptyAttentionSession(
    initialAttentionLesson ? String(initialAttentionLesson._id || activeLessonId) : '',
  ))
  const attentionResponseFinalizationRef = useRef('')
  const attentionTimeoutTriggeredRef = useRef('')
  const [attentionCheckChallenge, setAttentionCheckChallenge] = useState(null)
  const [attentionCheckAnswer, setAttentionCheckAnswer] = useState([])
  const [attentionCheckSecondsRemaining, setAttentionCheckSecondsRemaining] = useState(10)
  const [attentionCheckLoading, setAttentionCheckLoading] = useState(false)
  const [attentionCheckError, setAttentionCheckError] = useState('')
  const [attentionCheckConfigurationError, setAttentionCheckConfigurationError] = useState('')
  const [attentionCheckPlaybackError, setAttentionCheckPlaybackError] = useState('')
  const [attentionCheckRetry, setAttentionCheckRetry] = useState(null)
  const startedLessonIds = useRef(new Set([
    ...(enrollment.startedLessonIds || []).map(String),
    ...(enrollment.completedLessonIds || []).map(String),
  ]))
  const activeIndex = Math.max(0, lessons.findIndex(({ lesson, lessonKey }) => (
    String(lesson._id || lessonKey) === activeLessonId
  )))
  const activeEntry = lessons[activeIndex]
  const activeVideoKey = `${String(course._id)}:${String(activeEntry?.lesson?._id || activeEntry?.lessonKey || '')}`
  const transcriptCues = Array.isArray(activeEntry?.lesson?.transcriptCues)
    ? activeEntry.lesson.transcriptCues
    : []
  const activeTranscriptCueIndex = transcriptPlayback.lessonKey === activeVideoKey
    ? transcriptPlayback.cueIndex
    : findActiveTranscriptCueIndex(transcriptCues, 0)
  const activeContentItem = allContentItems.find((item) => String(item._learningKey || item.id) === activeContentItemId)
  const showCourseCertificate = course.generateCertificate !== false
  const hasCurrentCourseCertificate = String(courseCertificate?.courseId || '') === String(course._id)
  const completedLessonIds = new Set((enrollment.completedLessonIds || []).map(String))
  const hasPassedQuiz = (quizId) => Boolean(quizId) && quizAttempts.some((attempt) => (
    String(attempt.quizId) === String(quizId)
    && attempt.status === 'submitted'
    && attempt.passed === true
  ))
  const filteredModuleItems = moduleItems.map((group) => ({
    ...group,
    items: group.items.filter((item) => (
      !contentSearch || item.title?.toLowerCase().includes(contentSearch.trim().toLowerCase())
    )),
  }))
  const filteredCourseLevelItems = courseLevelItems.filter((item) => (
    !contentSearch || item.title?.toLowerCase().includes(contentSearch.trim().toLowerCase())
  ))
  const courseResources = [
    ...lessons.flatMap(({ lesson }) => lesson.resources || []),
    ...allContentItems.flatMap((item) => item.resources || []),
  ].filter((resource) => resource.url)
    .filter((resource, index, resources) => resources.findIndex((entry) => entry.url === resource.url) === index)
  const courseNotes = allContentItems.filter((item) => item.type === 'note')
  const activeContentIndex = allContentItems.findIndex((item) => (
    item._learningKey === activeContentItemId
    || (!activeContentItemId && item.type === 'video-lesson' && item._learningKey === activeEntry?.lessonKey)
  ))
  const showVideoPlayer = (detailsTab === 'overview' || detailsTab === 'notes' || detailsTab === 'resources')
    && activeContentItemId !== COURSE_NOTES_KEY
    && activeContentItemId !== COURSE_RESOURCES_KEY
    && activeContentItemId !== COURSE_CERTIFICATE_KEY
    && detailsTab !== 'certificate'
    && (!activeContentItem || activeContentItem.type === 'video-lesson')
  const isActiveQuiz = detailsTab === 'overview' && activeContentItem?.type === 'quiz'
  const isActiveAssignment = detailsTab === 'overview' && activeContentItem?.type === 'assignment'
  const hasActiveQuizAttempt = isActiveQuiz && quizAttempts.some((attempt) => (
    String(attempt.quizId) === String(activeContentItem.quiz?._id)
    && attempt.status === 'started'
  ))

  useEffect(() => {
    if (activeTranscriptCueIndex < 0) return
    const container = lessonInfoTab === 'transcript'
      ? transcriptScriptRef.current
      : transcriptCueListRef.current
    const cue = lessonInfoTab === 'transcript'
      ? transcriptScriptCueRefs.current[activeTranscriptCueIndex]
      : transcriptCueRefs.current[activeTranscriptCueIndex]
    if (!container || !cue) return
    const containerBounds = container.getBoundingClientRect()
    const cueBounds = cue.getBoundingClientRect()
    if (cueBounds.top < containerBounds.top) {
      container.scrollTo({
        top: container.scrollTop + cueBounds.top - containerBounds.top - 6,
        behavior: 'smooth',
      })
    } else if (cueBounds.bottom > containerBounds.bottom) {
      container.scrollTo({
        top: container.scrollTop + cueBounds.bottom - containerBounds.bottom + 6,
        behavior: 'smooth',
      })
    }
  }, [activeTranscriptCueIndex, activeVideoKey, lessonInfoTab, transcriptCues])

  function seekToTranscriptCue(cue) {
    const video = videoPlayerRef.current
    if (!video || !Number.isFinite(cue.startTimeMs)) return
    video.currentTime = cue.startTimeMs / 1000
    updateTranscriptPlaybackTime(video)
  }

  function updateTranscriptPlaybackTime(video) {
    if (!Number.isFinite(video.currentTime)) return
    const cueIndex = findActiveTranscriptCueIndex(transcriptCues, video.currentTime)
    setTranscriptPlayback((current) => (
      current.lessonKey === activeVideoKey && current.cueIndex === cueIndex
        ? current
        : { lessonKey: activeVideoKey, cueIndex }
    ))
  }

  useEffect(() => {
    if (!showCourseCertificate) return undefined
    const controller = new AbortController()
    if (!hasCurrentCourseCertificate) setCourseCertificateLoading(true)
    setCourseCertificateError('')
    fetchStudentCourseCertificate(course._id, onLogout, controller.signal)
      .then((result) => setCourseCertificate(result))
      .catch((certificateError) => {
        if (certificateError.name !== 'AbortError') {
          setCourseCertificateError(certificateError instanceof Error
            ? certificateError.message
            : 'Certificate status could not be loaded.')
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setCourseCertificateLoading(false)
      })
    return () => controller.abort()
  }, [course._id, showCourseCertificate, onLogout, courseCertificateRefresh])

  useEffect(() => {
    if (!showCourseCertificate) return undefined
    const refresh = () => setCourseCertificateRefresh((current) => current + 1)
    const intervalId = window.setInterval(() => {
      if (document.visibilityState === 'visible') refresh()
    }, 30000)
    window.addEventListener('focus', refresh)
    return () => {
      window.clearInterval(intervalId)
      window.removeEventListener('focus', refresh)
    }
  }, [showCourseCertificate])

  useEffect(() => {
    const controller = new AbortController()
    async function refreshAssignmentStatuses() {
      if (assignmentStatusRefreshRef.current) return
      assignmentStatusRefreshRef.current = true
      try {
        const { assignmentSubmissions: submissions } = await fetchStudentCourseContent(
          course._id,
          onLogout,
          controller.signal,
        )
        if (controller.signal.aborted) return
        setProgressError((current) => current === 'API route not found.' ? '' : current)
        setAssignmentSubmissions((current) => {
          const currentById = new Map(current.map((submission) => [String(submission._id), submission]))
          const refreshedIds = new Set(submissions.map((submission) => String(submission._id)))
          const refreshed = submissions.map((submission) => ({
            ...currentById.get(String(submission._id)),
            ...submission,
          }))
          return [...refreshed, ...current.filter((submission) => !refreshedIds.has(String(submission._id)))]
        })
      } catch (refreshError) {
        if (!controller.signal.aborted) {
          setProgressError(refreshError instanceof Error
            ? refreshError.message
            : 'Assignment review status could not be loaded.')
        }
      } finally {
        assignmentStatusRefreshRef.current = false
      }
    }

    const handleFocus = () => { void refreshAssignmentStatuses() }
    const intervalId = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refreshAssignmentStatuses()
    }, 30000)
    window.addEventListener('focus', handleFocus)
    return () => {
      window.clearInterval(intervalId)
      window.removeEventListener('focus', handleFocus)
      controller.abort()
    }
  }, [course._id, enrollment._id, onLogout])

  useEffect(() => {
    const certificate = courseCertificate?.certificate
    if (detailsTab !== 'certificate' || !hasCurrentCourseCertificate || !certificate?.id) return undefined
    if (courseCertificatePdf.certificateId === certificate.id && courseCertificatePdf.url) return undefined

    const controller = new AbortController()
    setCourseCertificatePdfLoading(true)
    setCourseCertificatePdfError('')
    async function loadCertificatePdf() {
      try {
        const savedAuth = sessionStorage.getItem('lms.auth')
        const auth = savedAuth ? JSON.parse(savedAuth) : null
        if (typeof auth?.token !== 'string') {
          onLogout()
          throw new Error('Your session has ended. Please sign in again.')
        }
        const response = await fetchWithAuth(
          `${API_BASE_URL}/certificates/${encodeURIComponent(certificate.id)}/pdf`,
          { headers: { Authorization: `Bearer ${auth.token}` }, signal: controller.signal },
          API_BASE_URL,
          auth.token,
        )
        const result = response.ok ? null : await response.json().catch(() => ({}))
        if (isInvalidSessionResponse(response, result)) {
          onLogout()
          throw new Error('Your session has ended. Please sign in again.')
        }
        if (!response.ok) throw new Error(result?.message || 'The certificate preview could not be generated.')
        const pdfBlob = await response.blob()
        if (!pdfBlob.size || (pdfBlob.type && pdfBlob.type !== 'application/pdf')) {
          throw new Error('The server did not return a valid certificate PDF.')
        }
        const url = URL.createObjectURL(pdfBlob)
        if (controller.signal.aborted) {
          URL.revokeObjectURL(url)
          return
        }
        if (courseCertificatePdfUrlRef.current) URL.revokeObjectURL(courseCertificatePdfUrlRef.current)
        courseCertificatePdfUrlRef.current = url
        setCourseCertificatePdf({ certificateId: certificate.id, url })
      } catch (pdfError) {
        if (!controller.signal.aborted) {
          setCourseCertificatePdfError(pdfError instanceof Error
            ? pdfError.message
            : 'The certificate preview could not be generated.')
        }
      } finally {
        if (!controller.signal.aborted) setCourseCertificatePdfLoading(false)
      }
    }

    void loadCertificatePdf()
    return () => controller.abort()
  }, [
    courseCertificate?.certificate?.id,
    courseCertificatePdf.certificateId,
    courseCertificatePdf.url,
    courseCertificatePdfRetry,
    detailsTab,
    hasCurrentCourseCertificate,
    onLogout,
  ])

  useEffect(() => () => {
    if (courseCertificatePdfUrlRef.current) URL.revokeObjectURL(courseCertificatePdfUrlRef.current)
  }, [])

  function initializeAttentionCheckSession(video, entry = activeEntry) {
    const lesson = entry?.lesson
    const settings = lesson?.attentionCheck
    if (!lesson || settings?.enabled !== true) return
    const lessonId = String(lesson._id || entry.lessonKey)
    if (attentionSessionRef.current.lessonId === lessonId && attentionSessionRef.current.initialized) return

    try {
      const durationSeconds = Number(video.duration)
      const configuration = {
        durationSeconds,
        videoUrl: String(lesson.videoUrl || lesson.video || ''),
        questionsDuringVideo: Number(settings.questionsDuringVideo),
        minIntervalSeconds: Number(settings.minIntervalSeconds),
        maxIntervalSeconds: Number(settings.maxIntervalSeconds),
      }
      sessionStorage.removeItem(getAttentionCheckSessionStorageKey(lessonId))
      const schedule = createAttentionCheckSchedule(
        durationSeconds,
        configuration.questionsDuringVideo,
        configuration.minIntervalSeconds,
        configuration.maxIntervalSeconds,
      )
      const session = {
        ...createEmptyAttentionSession(lessonId),
        ...configuration,
        sessionId: createAttentionCheckSessionId(),
        schedule,
        initialized: true,
      }
      attentionSessionRef.current = session
      setAttentionCheckError('')
      setAttentionCheckConfigurationError('')
      setAttentionCheckRetry(null)
    } catch (scheduleError) {
      attentionSessionRef.current = { ...createEmptyAttentionSession(lessonId), initialized: true }
      setAttentionCheckConfigurationError(scheduleError instanceof Error ? scheduleError.message : 'Attention checks could not be scheduled for this video.')
    }
  }

  function getAttentionCheckSessionStorageKey(lessonId) {
    return `lms.video-attention:${course._id}:${enrollment?._id || 'enrollment'}:${lessonId}`
  }

  function createAttentionCheckSessionId() {
    const randomUUID = globalThis.crypto?.randomUUID
    return typeof randomUUID === 'function'
      ? randomUUID.call(globalThis.crypto)
      : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (character) => {
        const value = Math.floor(Math.random() * 16)
        return (character === 'x' ? value : (value & 0x3) | 0x8).toString(16)
      })
  }

  function endCurrentAttentionCheckSession() {
    const lessonId = String(activeEntry?.lesson?._id || activeEntry?.lessonKey || '')
    if (lessonId) sessionStorage.removeItem(getAttentionCheckSessionStorageKey(lessonId))
    attentionSessionRef.current = createEmptyAttentionSession()
    attentionResponseFinalizationRef.current = ''
    attentionTimeoutTriggeredRef.current = ''
    setAttentionCheckChallenge(null)
    setAttentionCheckAnswer([])
    setAttentionCheckSecondsRemaining(10)
    setAttentionCheckLoading(false)
    setAttentionCheckError('')
    setAttentionCheckConfigurationError('')
    setAttentionCheckPlaybackError('')
    setAttentionCheckRetry(null)
  }

  async function requestAttentionQuestion(triggerIndex, positionSeconds) {
    const session = attentionSessionRef.current
    const lessonId = String(activeEntry?.lesson?._id || '')
    if (!lessonId || !session.sessionId) return
    session.pending = true
    session.blocked = true
    session.pendingDetails = { triggerIndex, positionSeconds }
    setAttentionCheckLoading(true)
    setAttentionCheckError('')
    setAttentionCheckRetry(null)
    try {
      const savedAuth = sessionStorage.getItem('lms.auth')
      const auth = savedAuth ? JSON.parse(savedAuth) : null
      if (typeof auth?.token !== 'string') {
        onLogout()
        return
      }
      const response = await fetchWithAuth(`${API_BASE_URL}/courses/${encodeURIComponent(course._id)}/attention-checks/${encodeURIComponent(lessonId)}/start`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${auth.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ sessionId: session.sessionId, triggerIndex, positionSeconds }),
      }, API_BASE_URL, auth.token)
      const result = await response.json()
      if (isInvalidSessionResponse(response, result)) {
        onLogout()
        return
      }
      if (result.recorded === true && ['answered', 'not_answered'].includes(result.status)) {
        completeAttentionCheck(triggerIndex)
        return
      }
      if (!response.ok || !result.responseId || !result.question) {
        throw new Error(result.message || 'The attention check could not be loaded.')
      }
      setAttentionCheckAnswer([])
      attentionResponseFinalizationRef.current = ''
      attentionTimeoutTriggeredRef.current = ''
      setAttentionCheckSecondsRemaining(10)
      setAttentionCheckChallenge({ ...result, triggerIndex })
    } catch (requestError) {
      session.pending = false
      setAttentionCheckError(requestError instanceof Error ? requestError.message : 'The attention check could not be loaded.')
      setAttentionCheckRetry({ triggerIndex, positionSeconds })
    } finally {
      setAttentionCheckLoading(false)
    }
  }

  function checkAttentionSchedule(video) {
    const session = attentionSessionRef.current
    if (!session.initialized || session.pending || !session.schedule.length) return
    session.lastVideoPositionSeconds = video.currentTime
    const triggerIndex = session.nextIndex
    if (triggerIndex >= session.schedule.length || video.currentTime < session.schedule[triggerIndex]) return
    video.pause()
    void requestAttentionQuestion(triggerIndex, video.currentTime)
  }

  function completeAttentionCheck(triggerIndex) {
    const video = videoPlayerRef.current
    const session = attentionSessionRef.current
    session.nextIndex = Math.max(session.nextIndex, triggerIndex + 1)
    session.pending = false
    session.blocked = false
    session.pendingDetails = null
    session.lastVideoPositionSeconds = Number(video?.currentTime) || 0
    attentionResponseFinalizationRef.current = ''
    attentionTimeoutTriggeredRef.current = ''
    setAttentionCheckChallenge(null)
    setAttentionCheckAnswer([])
    setAttentionCheckPlaybackError('')
    const playback = video?.play()
    if (playback && typeof playback.catch === 'function') {
      playback.catch(() => setAttentionCheckPlaybackError('Your response was recorded. Resume the video when ready.'))
    }
  }

  async function finalizeAttentionCheck(selectedOptionIndices, notAnswered = false) {
    if (!attentionCheckChallenge) return
    const responseId = attentionCheckChallenge.responseId
    if (!responseId || attentionResponseFinalizationRef.current === responseId) return
    attentionResponseFinalizationRef.current = responseId
    setAttentionCheckLoading(true)
    setAttentionCheckError('')
    try {
      const savedAuth = sessionStorage.getItem('lms.auth')
      const auth = savedAuth ? JSON.parse(savedAuth) : null
      if (typeof auth?.token !== 'string') {
        onLogout()
        return
      }
      const lessonId = String(activeEntry?.lesson?._id || '')
      const response = await fetchWithAuth(`${API_BASE_URL}/courses/${encodeURIComponent(course._id)}/attention-checks/${encodeURIComponent(lessonId)}/submit`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${auth.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(notAnswered
          ? { responseId, notAnswered: true }
          : { responseId, selectedOptionIndices }),
      }, API_BASE_URL, auth.token)
      const result = await response.json()
      if (isInvalidSessionResponse(response, result)) {
        onLogout()
        return
      }
      if (!response.ok || result.recorded !== true) {
        if (notAnswered && response.status === 409 && result.message === 'The 10-second response window is still active.') {
          attentionResponseFinalizationRef.current = ''
          window.setTimeout(() => {
            if (
              attentionCheckChallenge?.responseId === responseId
              && attentionResponseFinalizationRef.current !== responseId
            ) {
              void finalizeAttentionCheck([], true)
            }
          }, 100)
          return
        }
        throw new Error(result.message || 'Your attention check response could not be recorded.')
      }
      completeAttentionCheck(attentionCheckChallenge.triggerIndex)
    } catch (submitError) {
      attentionResponseFinalizationRef.current = ''
      setAttentionCheckError(submitError instanceof Error ? submitError.message : 'Your attention check response could not be recorded.')
      if (notAnswered || attentionCheckSecondsRemaining <= 0) {
        window.setTimeout(() => {
          if (
            attentionCheckChallenge?.responseId === responseId
            && attentionResponseFinalizationRef.current !== responseId
          ) {
            void finalizeAttentionCheck([], true)
          }
        }, 1000)
      }
    } finally {
      setAttentionCheckLoading(false)
    }
  }

  async function submitAttentionAnswer(event) {
    event.preventDefault()
    if (!attentionCheckChallenge || !attentionCheckAnswer.length || attentionCheckSecondsRemaining <= 0) return
    await finalizeAttentionCheck(attentionCheckAnswer)
  }

  useEffect(() => {
    if (!attentionCheckChallenge) {
      setAttentionCheckSecondsRemaining(10)
      return undefined
    }
    const presentedAtMs = Date.parse(attentionCheckChallenge.presentedAt)
    const serverTimeMs = Date.parse(attentionCheckChallenge.serverTime)
    const elapsedBeforeDisplayMs = Number.isFinite(presentedAtMs) && Number.isFinite(serverTimeMs)
      ? Math.max(0, serverTimeMs - presentedAtMs)
      : 0
    const deadlineMs = Date.now() + Math.max(0, 10_000 - elapsedBeforeDisplayMs)
    const updateCountdown = () => {
      setAttentionCheckSecondsRemaining(Math.max(0, Math.ceil((deadlineMs - Date.now()) / 1000)))
    }
    updateCountdown()
    const intervalId = window.setInterval(updateCountdown, 100)
    return () => window.clearInterval(intervalId)
  }, [attentionCheckChallenge])

  useEffect(() => {
    if (!attentionCheckChallenge || attentionCheckSecondsRemaining > 0) return
    const responseId = attentionCheckChallenge.responseId
    if (!responseId || attentionTimeoutTriggeredRef.current === responseId) return
    attentionTimeoutTriggeredRef.current = responseId
    void finalizeAttentionCheck([], true)
  }, [attentionCheckChallenge, attentionCheckSecondsRemaining])

  function handleAttentionVideoSeeking(video) {
    const session = attentionSessionRef.current
    const lessonId = String(activeEntry?.lesson?._id || activeEntry?.lessonKey || '')
    if (!lessonId || session.lessonId !== lessonId) return
    if (video.currentTime <= 1 && session.lastVideoPositionSeconds > 5 && !session.pending && !session.blocked) {
      sessionStorage.removeItem(getAttentionCheckSessionStorageKey(lessonId))
      attentionSessionRef.current = createEmptyAttentionSession(lessonId)
      initializeAttentionCheckSession(video)
    }
    attentionSessionRef.current.lastVideoPositionSeconds = video.currentTime
  }

  useEffect(() => {
    const lessonId = String(activeEntry?.lesson?._id || activeEntry?.lessonKey || '')
    if (attentionSessionRef.current.lessonId === lessonId) return
    attentionSessionRef.current = createEmptyAttentionSession()
    setAttentionCheckChallenge(null)
    setAttentionCheckAnswer([])
    setAttentionCheckLoading(false)
    setAttentionCheckError('')
    setAttentionCheckConfigurationError('')
    setAttentionCheckPlaybackError('')
    setAttentionCheckRetry(null)
    setAutoplayBlockedLessonId('')
  }, [activeLessonId])

  useEffect(() => {
    const matchedLesson = lessons.find(({ lesson }) => String(lesson._id) === requestedLessonId)
    if (matchedLesson) {
      setActiveLessonId(String(matchedLesson.lesson._id))
      setExpandedModules((current) => new Set(current).add(matchedLesson.moduleKey))
    } else if (lessons.length && !lessons.some(({ lesson, lessonKey }) => String(lesson._id || lessonKey) === activeLessonId)) {
      setActiveLessonId(lessons[0].lessonKey)
    }
  }, [requestedLessonId, course._id])

  useEffect(() => {
    if (!requestedActivityId || !['quiz', 'assignment'].includes(requestedActivityType)) return
    const item = allContentItems.find((entry) => (
      entry.type === requestedActivityType
      && String(entry.type === 'quiz' ? entry.quiz?._id || entry._learningKey : entry._learningKey) === requestedActivityId
    ))
    if (!item) return
    videoPlayerRef.current?.pause()
    setActiveContentItemId(item._learningKey)
    setDetailsTab('overview')
    if (item._moduleKey) {
      setExpandedModules((current) => new Set(current).add(item._moduleKey))
    }
  }, [requestedActivityId, requestedActivityType, course._id])

  useEffect(() => {
    if (activeEntry && !activeContentItemId) void setLessonStarted(activeEntry)
  }, [activeLessonId, activeContentItemId, enrollment._id])

  function selectLesson(entry) {
    if (attentionCheckChallenge || attentionCheckLoading || attentionSessionRef.current.blocked) return
    const id = String(entry.lesson._id || entry.lessonKey)
    if (videoPlayerRef.current && activeEntry) {
      saveLessonPlaybackPosition(activeEntry, videoPlayerRef.current.currentTime, true)
      videoPlayerRef.current.pause()
    }
    endCurrentAttentionCheckSession()
    setActiveContentItemId('')
    setDetailsTab('overview')
    setVideoOpenSequence((current) => current + 1)
    setActiveLessonId(id)
    setExpandedModules((current) => new Set(current).add(entry.moduleKey))
    const params = new URLSearchParams(location.search)
    params.set('lesson', id)
    params.delete('activity')
    params.delete('activityType')
    navigate(`${location.pathname}?${params.toString()}`, { replace: true })
  }

  function selectContentItem(item) {
    if (attentionCheckChallenge || attentionCheckLoading || attentionSessionRef.current.blocked) return
    if (item.type === 'video-lesson') {
      const lesson = lessons.find((entry) => String(entry.lesson._id || entry.lessonKey) === item._learningKey)
      if (lesson) selectLesson(lesson)
      return
    }
    endCurrentAttentionCheckSession()
    videoPlayerRef.current?.pause()
    setActiveContentItemId(item._learningKey)
    setDetailsTab(item.type === 'note' ? 'notes' : 'overview')
    if (item._moduleKey) {
      setExpandedModules((current) => new Set(current).add(item._moduleKey))
    }
  }

  function addAssignmentSubmission(submission) {
    setAssignmentSubmissions((current) => [submission, ...current])
    setCourseCertificateRefresh((current) => current + 1)
  }

  function addQuizAttempt(attempt) {
    setQuizAttempts((current) => [attempt, ...current.filter((entry) => String(entry._id) !== String(attempt._id))])
    if (attempt.status === 'submitted') {
      setCourseCertificateRefresh((current) => current + 1)
    }
  }

  function getAssignmentReviewStatus(assignment) {
    const submission = assignmentSubmissions.find((entry) => (
      String(entry.assignmentId) === String(assignment?._id)
    ))
    if (!submission) return 'not-submitted'
    if (['approved', 'rejected', 'pending'].includes(submission.reviewStatus)) {
      return submission.reviewStatus
    }
    const requirement = courseCertificate?.pendingRequirements?.find((entry) => (
      entry.type === 'assignment' && String(entry.id) === String(assignment?._id)
    ))
    if (requirement?.status === 'resubmit') return 'rejected'
    if (requirement) return 'pending'
    if (
      assignment?.requiredForCertificate !== false
      && Array.isArray(courseCertificate?.pendingRequirements)
      && hasCurrentCourseCertificate
    ) {
      return 'approved'
    }
    return 'pending'
  }

  function getAssignmentSidebarLabel(status) {
    if (status === 'approved') return 'Completed'
    if (status === 'pending') return 'Awaiting Admin Review'
    if (status === 'rejected') return 'Rejected'
    return 'Assignment'
  }

  function saveLessonPlaybackPosition(entry, positionSeconds, force = false) {
    const lessonId = String(entry?.lesson?._id || '')
    if (!isValidLessonId(lessonId) || !Number.isFinite(positionSeconds) || positionSeconds < 0) return

    const position = Math.min(43200, Math.floor(positionSeconds))
    let saveState = playbackPositionSaveRef.current.get(lessonId)
    if (!saveState) {
      const savedPosition = Number(lessonPlaybackPositionsRef.current[lessonId])
      saveState = {
        lastSavedPosition: Number.isFinite(savedPosition) ? Math.floor(savedPosition) : 0,
        inFlight: false,
        queuedPosition: null,
      }
      playbackPositionSaveRef.current.set(lessonId, saveState)
    }
    if (saveState.inFlight) {
      if (force) saveState.queuedPosition = position
      return
    }
    if (!force && (
      position === saveState.lastSavedPosition
      || Math.abs(position - saveState.lastSavedPosition) < 10
    )) return

    saveState.inFlight = true
    void (async () => {
      try {
        const savedAuth = sessionStorage.getItem('lms.auth')
        const auth = savedAuth ? JSON.parse(savedAuth) : null
        if (typeof auth?.token !== 'string') {
          onLogout()
          return
        }
        const response = await fetchWithAuth(`${API_BASE_URL}/enrollments/${encodeURIComponent(enrollment._id)}/progress`, {
          method: 'PATCH',
          headers: {
            Authorization: `Bearer ${auth.token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ lessonId, positionSeconds: position }),
        }, API_BASE_URL, auth.token)
        const result = await response.json()
        if (isInvalidSessionResponse(response, result)) {
          onLogout()
          return
        }
        if (!response.ok) throw new Error(result.message || 'Video playback position could not be saved.')
        saveState.lastSavedPosition = position
        lessonPlaybackPositionsRef.current = {
          ...lessonPlaybackPositionsRef.current,
          [lessonId]: position,
        }
        onEnrollmentUpdated({ lessonPlaybackPositions: { ...lessonPlaybackPositionsRef.current } })
      } catch (saveError) {
        setProgressError(saveError instanceof Error ? saveError.message : 'Video playback position could not be saved.')
      } finally {
        saveState.inFlight = false
        const queuedPosition = saveState.queuedPosition
        saveState.queuedPosition = null
        if (queuedPosition !== null && queuedPosition !== saveState.lastSavedPosition) {
          saveLessonPlaybackPosition(entry, queuedPosition, true)
        }
      }
    })()
  }

  function handleVideoMetadata(video, entry) {
    initializeAttentionCheckSession(video, entry)
    if (pendingSeekTimeRef.current !== null && !isNaN(pendingSeekTimeRef.current)) {
      video.currentTime = pendingSeekTimeRef.current
      pendingSeekTimeRef.current = null
    } else {
      video.currentTime = 0
    }
    updateTranscriptPlaybackTime(video)
    setAutoplayBlockedLessonId('')
    const playback = video.play()
    if (playback && typeof playback.catch === 'function') {
      playback.catch((playError) => {
        if (playError?.name !== 'AbortError' && activeLessonId === lessonId) {
          setAutoplayBlockedLessonId(lessonId)
        }
      })
    }
  }

  function handleSeekToLessonTimestamp(targetLessonId, timestampSeconds) {
    const matchedEntry = lessons.find(({ lesson, lessonKey }) => (
      String(lesson._id || lessonKey) === String(targetLessonId)
    ))

    const currentLessonId = String(activeEntry?.lesson?._id || activeEntry?.lessonKey || '')
    const isSameLesson = matchedEntry && String(matchedEntry.lesson._id || matchedEntry.lessonKey) === currentLessonId

    if (isSameLesson) {
      if (videoPlayerRef.current && timestampSeconds != null && !isNaN(timestampSeconds)) {
        videoPlayerRef.current.currentTime = timestampSeconds
        videoPlayerRef.current.play().catch(() => {})
        videoPlayerRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' })
      }
    } else if (matchedEntry) {
      if (timestampSeconds != null && !isNaN(timestampSeconds)) {
        pendingSeekTimeRef.current = timestampSeconds
      }
      selectLesson(matchedEntry)
    }
  }

  async function setLessonStarted(entry) {
    const lessonId = String(entry.lesson._id || '')
    if (!isValidLessonId(lessonId) || startedLessonIds.current.has(lessonId)) return
    startedLessonIds.current.add(lessonId)
    setProgressError('')
    try {
      const savedAuth = sessionStorage.getItem('lms.auth')
      const auth = savedAuth ? JSON.parse(savedAuth) : null
      if (typeof auth?.token !== 'string') {
        startedLessonIds.current.delete(lessonId)
        onLogout()
        return
      }
      const response = await fetchWithAuth(`${API_BASE_URL}/enrollments/${encodeURIComponent(enrollment._id)}/progress`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${auth.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ lessonId, started: true }),
      }, API_BASE_URL, auth.token)
      const result = await response.json()
      if (isInvalidSessionResponse(response, result)) {
        startedLessonIds.current.delete(lessonId)
        onLogout()
        return
      }
      if (!response.ok) throw new Error(result.message || 'Lesson progress could not be saved.')
      onLearningDataChanged()
    } catch (saveError) {
      startedLessonIds.current.delete(lessonId)
      setProgressError(saveError instanceof Error ? saveError.message : 'Lesson progress could not be saved.')
    }
  }

  async function setLessonCompleted(entry, completed) {
    const lessonId = String(entry.lesson._id || '')
    if (!isValidLessonId(lessonId)) {
      setProgressError('This lesson cannot be tracked because it has no saved lesson ID.')
      return
    }
    if (completed && !videoPlayerRef.current?.ended) {
      setProgressError('Watch the entire video before completing this lesson.')
      return
    }
    setSavingLessonId(lessonId)
    setProgressError('')
    try {
      const savedAuth = sessionStorage.getItem('lms.auth')
      const auth = savedAuth ? JSON.parse(savedAuth) : null
      if (typeof auth?.token !== 'string') {
        onLogout()
        return
      }
      const response = await fetchWithAuth(`${API_BASE_URL}/enrollments/${encodeURIComponent(enrollment._id)}/progress`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${auth.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ lessonId, completed }),
      }, API_BASE_URL, auth.token)
      const result = await response.json()
      if (isInvalidSessionResponse(response, result)) {
        onLogout()
        return
      }
      if (!response.ok) throw new Error(result.message || 'Lesson progress could not be saved.')
      onEnrollmentUpdated({
        ...enrollment,
        completedLessonIds: result.completedLessonIds || [],
        lessonPlaybackPositions: { ...lessonPlaybackPositionsRef.current },
      })
      startedLessonIds.current.add(lessonId)
      if (completed) setCourseCertificateRefresh((current) => current + 1)
      onLearningDataChanged()
    } catch (saveError) {
      setProgressError(saveError instanceof Error ? saveError.message : 'Lesson progress could not be saved.')
    } finally {
      setSavingLessonId('')
    }
  }

  function downloadCourseCertificate() {
    const certificate = courseCertificate?.certificate
    const pdfUrl = courseCertificatePdf.certificateId === certificate?.id ? courseCertificatePdf.url : ''
    if (!certificate?.id || !pdfUrl) return
    const link = document.createElement('a')
    link.href = pdfUrl
    link.download = `aiHustle-certificate-${certificate.certificateId}.pdf`
    document.body.append(link)
    link.click()
    link.remove()
  }

  function renderCourseCertificate() {
    return (
      <section className="student-certificate-card student-course-learning__certificate" aria-labelledby="student-course-certificate-title">
        <div className="student-certificate-card__heading">
          <div>
            <span className={`student-certificate-card__status${courseCertificate?.certificate ? ' is-earned' : ' is-locked'}`}>
              {courseCertificate?.certificate ? 'Certificate unlocked' : 'Certificate locked'}
            </span>
            <h3 id="student-course-certificate-title">Course Certificate</h3>
          </div>
          <span className="student-certificate-card__icon" aria-hidden="true">
            <Icon name={courseCertificate?.certificate ? 'award' : 'lock'} size={21} />
          </span>
        </div>
        {courseCertificateError && <p className="student-certificates__error" role="alert">{courseCertificateError}</p>}
        {hasCurrentCourseCertificate && courseCertificate?.certificate ? (
          <div className="student-certificate-card__earned">
            {courseCertificatePdfError && <p className="student-certificates__error" role="alert">{courseCertificatePdfError}</p>}
            {courseCertificatePdfLoading && (
              <p className="student-certificate-card__pending" role="status">Generating your personalized certificate…</p>
            )}
            {courseCertificatePdf.certificateId === courseCertificate.certificate.id && courseCertificatePdf.url && (
              <>
                <iframe
                  className="student-course-learning__certificate-preview"
                  title={`Certificate for ${courseCertificate.certificate.courseName}`}
                  src={courseCertificatePdf.url}
                />
                <div className="student-certificate-card__actions">
                  <button type="button" className="student-button" onClick={downloadCourseCertificate}>
                    Download Certificate PDF
                  </button>
                </div>
              </>
            )}
            {courseCertificatePdfError && (
              <button type="button" className="student-button student-button--quiet" onClick={() => setCourseCertificatePdfRetry((current) => current + 1)}>
                Retry certificate generation
              </button>
            )}
          </div>
        ) : courseCertificateLoading && !hasCurrentCourseCertificate ? (
          <p className="student-certificate-card__pending" role="status">Checking your course requirements…</p>
        ) : courseCertificate?.pendingRequirements?.length ? (
          <div className="student-certificate-card__pending">
            <strong>Complete these requirements to unlock your certificate</strong>
            <ul>
              {courseCertificate.pendingRequirements.map((requirement, index) => (
                <li key={`${requirement.type}-${requirement.title}-${index}`}>
                  <span aria-hidden="true">○</span>
                  <span>{requirement.title}</span>
                  <small>{requirement.type === 'assignment'
                    ? requirement.status === 'awaiting-review' ? 'Awaiting Admin review' : requirement.status === 'resubmit' ? 'Resubmit required' : 'Not submitted'
                    : requirement.type === 'quiz' ? 'Pass required'
                      : requirement.type === 'profile' ? 'Update profile'
                        : requirement.type === 'course' ? 'Admin setup required' : 'Not completed'}</small>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="student-certificate-card__pending" role="status">
            {courseCertificateError ? 'Certificate requirements could not be checked.' : 'Course requirements are being checked.'}
          </p>
        )}
        {courseCertificateError && (
          <button type="button" className="student-button student-button--quiet" onClick={() => setCourseCertificateRefresh((current) => current + 1)}>
            Retry
          </button>
        )}
      </section>
    )
  }

  function moveLesson(offset) {
    const nextEntry = lessons[activeIndex + offset]
    if (nextEntry) selectLesson(nextEntry)
  }

  function moveContent(offset) {
    const nextItem = allContentItems[activeContentIndex + offset]
    if (nextItem) selectContentItem(nextItem)
  }

  return (
    <div className="student-course-learning">
      {progressError && <p className="student-courses__message is-error" role="alert">{progressError}</p>}
      {allContentItems.length ? (
        <div className="student-course-learning__layout">
          <aside className="student-course-learning__sidebar" aria-label="Course modules and lessons">
            <header className="student-course-learning__sidebar-header">
              <h2 className={course.title?.trim().toLowerCase() === 'python' ? 'is-python' : undefined}>{course.title}</h2>
            </header>
            {sequencedActivities.length > 0 ? (
              <section className="student-course-learning__module is-expanded" style={{ borderBottom: 'none' }}>
                <div style={{ padding: '10px 16px 6px', fontWeight: '700', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--student-ink-muted, #777)' }}>
                  Course Activities ({allContentItems.length})
                </div>
                <ul>
                  {allContentItems
                    .filter((item) => !contentSearch || item.title?.toLowerCase().includes(contentSearch.trim().toLowerCase()))
                    .map((item, index) => {
                      const isSelected = String(item._learningKey || item.id) === String(activeContentItemId)
                        || (!activeContentItemId && detailsTab === 'overview' && item.type === 'video-lesson' && String(item._learningKey || item.id) === String(activeEntry?.lessonKey || activeEntry?.lesson?._id))

                      const isLessonCompleted = item.type === 'video-lesson' && completedLessonIds.has(String(item.id || item.lesson?._id))

                      const attempts = quizAttempts.filter((a) => String(a.quizId) === String(item.quizId || item.quiz?._id || item.id))
                      const isQuizPassed = attempts.some((a) => a.status === 'submitted' && a.passed === true) || (item.isCompleted === true && item.type === 'quiz')
                      const isQuizFailed = attempts.length > 0 && !isQuizPassed

                      const isAssessmentSubmitted = (item.type === 'assignment' || item.type === 'assessment') && (
                        assignmentSubmissions.some((s) => String(s.assignmentId) === String(item.assignmentId || item._id || item.id))
                        || (item.isCompleted === true)
                      )

                      const isItemComplete = isLessonCompleted || isQuizPassed || isAssessmentSubmitted
                      const isItemFailed = isQuizFailed

                      const statusText = item.type === 'video-lesson'
                        ? isItemComplete ? 'Completed' : item.durationSeconds ? `${Math.ceil(item.durationSeconds / 60)} min` : 'Video'
                        : item.type === 'quiz'
                          ? isItemComplete ? 'Passed (✓)' : isItemFailed ? 'Failed - Retry' : 'Quiz (Pending)'
                          : item.type === 'assessment' || item.type === 'assignment'
                            ? isItemComplete ? 'Submitted (✓)' : 'Pending submission'
                            : getStudentContentLabel(item.type)

                      return (
                        <li key={item._learningKey || `${item.type}-${index}`}>
                          <button
                            id={item.id ? `student-content-${item.id}` : undefined}
                            className={`${isSelected ? 'is-selected' : ''} ${isItemFailed ? 'is-item-failed' : ''}`}
                            type="button"
                            aria-current={isSelected ? 'true' : undefined}
                            onClick={() => selectContentItem(item)}
                            style={isItemFailed ? { borderColor: 'rgba(211, 47, 47, 0.4)' } : undefined}
                          >
                            <span
                              className={`student-course-learning__item-icon${isItemComplete ? ' is-complete' : ''}${isItemFailed ? ' is-failed' : ''}`}
                              style={isItemFailed ? { background: 'rgba(211, 47, 47, 0.15)', color: '#d32f2f' } : undefined}
                            >
                              <Icon
                                name={isItemComplete ? 'check' : isItemFailed ? 'alertCircle' : item.type === 'assignment' || item.type === 'assessment' ? 'clipboardCheck' : item.type === 'quiz' ? 'clipboardCheck' : 'play'}
                                size={15}
                              />
                            </span>
                            <span className="student-course-learning__item-copy">
                              <strong>
                                <span style={{ color: 'var(--student-ink-muted, #777)', marginRight: '4px', fontSize: '11px' }}>
                                  #${item.sequenceNumber || item.sequenceIndex || (index + 1)}.
                                </span>
                                {item.title}
                              </strong>
                              <small style={isItemFailed ? { color: '#d32f2f', fontWeight: '600' } : undefined}>
                                {statusText}
                              </small>
                            </span>
                            {isSelected && <span className="student-course-learning__play">▶</span>}
                          </button>
                        </li>
                      )
                    })}
                </ul>
              </section>
            ) : filteredModuleItems.map(({ module, moduleKey, items }) => {
              const expanded = expandedModules.has(moduleKey) || Boolean(contentSearch.trim())
              return (
                <section className={`student-course-learning__module${expanded ? ' is-expanded' : ''}`} key={moduleKey}>
                  <button type="button" aria-expanded={expanded} onClick={() => {
                    setExpandedModules((current) => {
                      const next = new Set(current)
                      if (next.has(moduleKey)) next.delete(moduleKey)
                      else next.add(moduleKey)
                      return next
                    })
                  }}>
                    <span>{module.title}<small>{items.length} {items.length === 1 ? 'item' : 'items'}</small></span><span>{expanded ? '⌃' : '⌄'}</span>
                  </button>
                  {expanded && (items.length
                    ? <ul>{items.map((item) => {
                      const isSelected = item._learningKey === activeContentItemId
                        || (!activeContentItem && detailsTab === 'overview' && item.type === 'video-lesson' && item._learningKey === activeEntry?.lessonKey)
                      const quizPassed = item.type === 'quiz' && hasPassedQuiz(item.quiz?._id)
                      const assignmentReviewStatus = item.type === 'assignment'
                        ? getAssignmentReviewStatus(item)
                        : ''
                      const assignmentApproved = assignmentReviewStatus === 'approved'
                      const assignmentAwaitingReview = assignmentReviewStatus === 'pending'
                      const assignmentRejected = assignmentReviewStatus === 'rejected'
                      const isCompleted = (item.type === 'video-lesson' && completedLessonIds.has(String(item._id)))
                        || quizPassed
                        || assignmentApproved
                      const quizAttemptCount = item.quiz?._id
                        ? quizAttempts.filter((attempt) => String(attempt.quizId) === String(item.quiz._id)).length
                        : 0
                      const status = item.type === 'video-lesson'
                        ? isCompleted ? 'Completed' : item.durationSeconds ? `${Math.ceil(item.durationSeconds / 60)} min` : 'Video'
                        : item.type === 'quiz'
                          ? quizPassed ? 'Passed' : `${quizAttemptCount} ${quizAttemptCount === 1 ? 'attempt' : 'attempts'}`
                          : item.type === 'assignment'
                            ? getAssignmentSidebarLabel(assignmentReviewStatus)
                            : item.type === 'note' ? 'Notes / PDF' : getStudentContentLabel(item.type)
                      const itemIconClassName = [
                        'student-course-learning__item-icon',
                        isCompleted && 'is-complete',
                        assignmentAwaitingReview && 'is-awaiting-review',
                        assignmentRejected && 'is-rejected',
                      ].filter(Boolean).join(' ')
                      const statusClassName = assignmentAwaitingReview
                        ? 'is-awaiting-review'
                        : assignmentRejected ? 'is-rejected' : ''
                      const itemIcon = isCompleted
                        ? 'check'
                        : assignmentAwaitingReview
                          ? 'clock'
                          : assignmentRejected
                            ? 'circleX'
                            : item.type === 'assignment' || item.type === 'quiz'
                              ? 'clipboardCheck'
                              : item.type === 'note' ? 'folderOpen' : 'play'
                      return (
                        <li key={item._learningKey}>
                          <button
                            id={item._id ? `student-content-${item._id}` : undefined}
                            className={isSelected ? 'is-selected' : ''}
                            type="button"
                            aria-current={isSelected ? 'true' : undefined}
                            onClick={() => selectContentItem(item)}
                          >
                            <span className={itemIconClassName}>
                              <Icon name={itemIcon} size={15} />
                            </span>
                            <span className="student-course-learning__item-copy"><strong>{item.title}</strong><small className={statusClassName}>{status}</small></span>
                            {isSelected && <span className="student-course-learning__play">▶</span>}
                          </button>
                        </li>
                      )
                    })}</ul>
                    : <p className="student-course-learning__empty-module">{contentSearch ? 'No matching content in this module.' : 'No content in this module.'}</p>)}
                </section>
              )
            })}
            {filteredCourseLevelItems.length > 0 && (
              <section className="student-course-learning__module student-course-learning__course-items">
                <strong>Course activities</strong>
                <ul>{filteredCourseLevelItems.map((item) => {
                  const quizPassed = item.type === 'quiz' && hasPassedQuiz(item.quiz?._id)
                  const assignmentReviewStatus = item.type === 'assignment'
                    ? getAssignmentReviewStatus(item)
                    : ''
                  const assignmentApproved = assignmentReviewStatus === 'approved'
                  const assignmentAwaitingReview = assignmentReviewStatus === 'pending'
                  const assignmentRejected = assignmentReviewStatus === 'rejected'
                  const isCompleted = quizPassed || assignmentApproved
                  const itemIconClassName = [
                    'student-course-learning__item-icon',
                    isCompleted && 'is-complete',
                    assignmentAwaitingReview && 'is-awaiting-review',
                    assignmentRejected && 'is-rejected',
                  ].filter(Boolean).join(' ')
                  const statusClassName = assignmentAwaitingReview
                    ? 'is-awaiting-review'
                    : assignmentRejected ? 'is-rejected' : ''
                  return (
                    <li key={item._learningKey}>
                      <button
                        className={item._learningKey === activeContentItemId ? 'is-selected' : ''}
                        type="button"
                        aria-current={item._learningKey === activeContentItemId ? 'true' : undefined}
                        onClick={() => selectContentItem(item)}
                      >
                        <span className={itemIconClassName}>
                          <Icon
                            name={isCompleted ? 'check' : assignmentAwaitingReview ? 'clock' : assignmentRejected ? 'circleX' : 'clipboardCheck'}
                            size={15}
                          />
                        </span>
                        <span className="student-course-learning__item-copy">
                          <strong>{item.title}</strong>
                          <small className={statusClassName}>
                            {item.type === 'assignment'
                              ? getAssignmentSidebarLabel(assignmentReviewStatus)
                              : quizPassed ? 'Passed' : getStudentContentLabel(item.type)}
                          </small>
                        </span>
                      </button>
                    </li>
                  )
                })}</ul>
              </section>
            )}
            <section className="student-course-learning__sidebar-links" aria-label="Course materials">
              {showCourseCertificate && (
                <button
                  className={detailsTab === 'certificate' ? 'is-selected' : ''}
                  type="button"
                  aria-pressed={detailsTab === 'certificate'}
                  onClick={() => {
                    if (attentionCheckChallenge || attentionCheckLoading || attentionSessionRef.current.blocked) return
                    videoPlayerRef.current?.pause()
                    endCurrentAttentionCheckSession()
                    setActiveContentItemId(COURSE_CERTIFICATE_KEY)
                    setDetailsTab('certificate')
                  }}
                >
                  <span className="student-course-learning__item-icon"><Icon name="award" size={15} /></span>
                  <strong>Certificate</strong>
                </button>
              )}
              <button
                className={detailsTab === 'notes' ? 'is-selected' : ''}
                type="button"
                aria-pressed={detailsTab === 'notes'}
                onClick={() => {
                  if (attentionCheckChallenge || attentionCheckLoading || attentionSessionRef.current.blocked) return
                  videoPlayerRef.current?.pause()
                  endCurrentAttentionCheckSession()
                  setActiveContentItemId(COURSE_NOTES_KEY)
                  setDetailsTab('notes')
                }}
              >
                <span className="student-course-learning__item-icon"><Icon name="pen" size={15} /></span>
                <strong>Notes</strong>
              </button>
              <button
                className={detailsTab === 'resources' ? 'is-selected' : ''}
                type="button"
                aria-pressed={detailsTab === 'resources'}
                onClick={() => {
                  if (attentionCheckChallenge || attentionCheckLoading || attentionSessionRef.current.blocked) return
                  videoPlayerRef.current?.pause()
                  endCurrentAttentionCheckSession()
                  setActiveContentItemId(COURSE_RESOURCES_KEY)
                  setDetailsTab('resources')
                }}
              >
                <span className="student-course-learning__item-icon"><Icon name="link" size={15} /></span>
                <strong>Resources</strong>
              </button>
            </section>
            {contentSearch && !filteredModuleItems.some(({ items }) => items.length) && !filteredCourseLevelItems.length && (
              <p className="student-course-learning__empty-module">No course content matches “{contentSearch}”.</p>
            )}
          </aside>
          <div className={`student-course-learning__main${showVideoPlayer ? ' student-course-learning__main--video' : ' student-course-learning__main--activity'}${isActiveAssignment ? ' student-course-learning__main--assignment' : ''}`}>
            {isActiveAssignment && (
              <button
                className="student-course-learning__assignment-back"
                type="button"
                onClick={() => {
                  setActiveContentItemId('')
                  setDetailsTab('overview')
                }}
              >
                ← Back to Course
              </button>
            )}
            {showVideoPlayer && (
              <div className="student-course-learning__active-heading">
                <div>
                  <h2>{activeEntry?.lesson.title || 'Select course content'}</h2>
                  <span className="student-course-learning__type student-course-learning__type--video-lesson">
                    <Icon name="book" size={14} />
                    {getStudentContentLabel('video-lesson')}
                  </span>
                </div>
              </div>
            )}
            {showVideoPlayer && (
              <div className="student-course-learning__player">
                {activeEntry?.lesson.videoUrl
                  ? <video
                    ref={videoPlayerRef}
                    key={`${String(activeEntry.lesson._id || activeEntry.lessonKey)}:${activeEntry.lesson.videoUrl}:${videoOpenSequence}`}
                    controls
                    playsInline
                    preload="metadata"
                    src={activeEntry.lesson.videoUrl}
                    onLoadedMetadata={(event) => {
                      handleVideoMetadata(event.currentTarget, activeEntry)
                      updateTranscriptPlaybackTime(event.currentTarget)
                    }}
                    onPlay={(event) => {
                      updateTranscriptPlaybackTime(event.currentTarget)
                      saveLessonPlaybackPosition(activeEntry, event.currentTarget.currentTime, true)
                      const settings = activeEntry.lesson.attentionCheck
                      if (settings?.enabled === true) {
                        initializeAttentionCheckSession(event.currentTarget)
                        if (attentionSessionRef.current.pending || attentionSessionRef.current.blocked) event.currentTarget.pause()
                      }
                    }}
                    onTimeUpdate={(event) => {
                      updateTranscriptPlaybackTime(event.currentTarget)
                      saveLessonPlaybackPosition(activeEntry, event.currentTarget.currentTime)
                      checkAttentionSchedule(event.currentTarget)
                    }}
                    onSeeking={(event) => {
                      updateTranscriptPlaybackTime(event.currentTarget)
                      handleAttentionVideoSeeking(event.currentTarget)
                    }}
                    onSeeked={(event) => updateTranscriptPlaybackTime(event.currentTarget)}
                    onPause={(event) => {
                      updateTranscriptPlaybackTime(event.currentTarget)
                      saveLessonPlaybackPosition(activeEntry, event.currentTarget.currentTime, true)
                    }}
                    onEnded={() => {
                      endCurrentAttentionCheckSession()
                      const video = videoPlayerRef.current
                      if (video) updateTranscriptPlaybackTime(video)
                      saveLessonPlaybackPosition(activeEntry, video?.currentTime || 0, true)
                      if (!completedLessonIds.has(String(activeEntry.lesson._id))) setLessonCompleted(activeEntry, true)
                    }}
                  >
                    Your browser does not support video playback.
                  </video>
                  : <div className="student-course-learning__no-video">No video has been uploaded for this lesson.</div>}
                {attentionCheckLoading && !attentionCheckChallenge && (
                  <div className="student-course-learning__attention-overlay" role="status">Loading attention check…</div>
                )}
                {attentionCheckChallenge && (
                  <form className="student-course-learning__attention-overlay" onSubmit={submitAttentionAnswer} role="dialog" aria-modal="true" aria-labelledby="student-attention-question">
                    <h3 id="student-attention-question">{attentionCheckChallenge.question.prompt}</h3>
                    <p role="timer" aria-live="off">Time remaining: {attentionCheckSecondsRemaining}s</p>
                    <div className="student-course-learning__attention-options">
                      {attentionCheckChallenge.question.options.map((option, index) => {
                        const multiSelect = attentionCheckChallenge.question.type === 'multiple-select'
                        const checked = attentionCheckAnswer.includes(index)
                        return (
                          <label key={`${index}-${option}`}>
                            <input
                              type={multiSelect ? 'checkbox' : 'radio'}
                              name={`attention-${activeEntry.lesson._id}-${attentionCheckChallenge.triggerIndex}`}
                              checked={checked}
                              disabled={attentionCheckLoading || attentionCheckSecondsRemaining <= 0}
                              onChange={(event) => setAttentionCheckAnswer((current) => (
                                multiSelect
                                  ? event.target.checked ? [...current, index] : current.filter((value) => value !== index)
                                  : [index]
                              ))}
                            />
                            <span>{option}</span>
                          </label>
                        )
                      })}
                    </div>
                    {attentionCheckError && <p role="alert">{attentionCheckError}</p>}
                    <button type="submit" disabled={attentionCheckLoading || !attentionCheckAnswer.length || attentionCheckSecondsRemaining <= 0}>
                      {attentionCheckLoading ? 'Recording…' : 'Submit answer'}
                    </button>
                  </form>
                )}
                {attentionCheckError && !attentionCheckChallenge && !attentionCheckLoading && (
                  <div className="student-course-learning__attention-overlay" role="alert">
                    <p>{attentionCheckError}</p>
                    {attentionCheckRetry && (
                      <button type="button" onClick={() => requestAttentionQuestion(attentionCheckRetry.triggerIndex, attentionCheckRetry.positionSeconds)}>Retry attention check</button>
                    )}
                  </div>
                )}
              </div>
            )}
            {showVideoPlayer && attentionCheckConfigurationError && (
              <p className="student-course-learning__attention-warning" role="alert">
                {attentionCheckConfigurationError} The video can still be watched, but attention checks could not be scheduled. Please contact an administrator.
              </p>
            )}
            {showVideoPlayer && attentionCheckPlaybackError && (
              <p className="student-course-learning__attention-warning" role="status">
                {attentionCheckPlaybackError}{' '}
                <button type="button" onClick={() => {
                  setAttentionCheckPlaybackError('')
                  videoPlayerRef.current?.play()?.catch(() => setAttentionCheckPlaybackError('Playback could not resume. Press play on the video controls.'))
                }}>Resume video</button>
              </p>
            )}
            {showVideoPlayer && autoplayBlockedLessonId === String(activeEntry?.lesson?._id || activeEntry?.lessonKey) && (
              <p className="student-course-learning__attention-warning" role="status">
                Autoplay was blocked by your browser. Press Play on the video controls to start the lesson.
              </p>
            )}
            {showVideoPlayer && (
              <div className="student-course-learning__video-nav">
                <button type="button" disabled={activeContentIndex <= 0} onClick={() => moveContent(-1)}>← Previous</button>
                <button
                  type="button"
                  className="student-course-learning__take-note-nav-btn"
                  onClick={() => {
                    setActiveContentItemId('')
                    setDetailsTab('notes')
                    if (requestOpenNoteEditorRef.current) {
                      requestOpenNoteEditorRef.current()
                    }
                  }}
                  title="Add a personal study note at this exact video moment"
                >
                  <Icon name="pen" size={13} />
                  <span>Take Note</span>
                </button>
                <button type="button" disabled={activeContentIndex < 0 || activeContentIndex >= allContentItems.length - 1} onClick={() => moveContent(1)}>Next →</button>
              </div>
            )}
            {showVideoPlayer && activeEntry && (
              <div className="student-course-learning__video-completion">
                <button
                  className={`student-button${completedLessonIds.has(String(activeEntry.lesson._id)) ? ' student-button--quiet' : ''}`}
                  type="button"
                  disabled={
                    savingLessonId === String(activeEntry.lesson._id)
                    || !activeEntry.lesson._id
                    || !completedLessonIds.has(String(activeEntry.lesson._id))
                  }
                  title={completedLessonIds.has(String(activeEntry.lesson._id))
                    ? 'This lesson is complete.'
                    : 'Watch the entire video to complete this lesson.'}
                >
                  {savingLessonId === String(activeEntry.lesson._id)
                    ? 'Saving…'
                    : completedLessonIds.has(String(activeEntry.lesson._id)) ? 'Completed' : 'Watch video to complete'}
                </button>
              </div>
            )}
            <section className="student-course-learning__details">
              {!showVideoPlayer && !isActiveAssignment && <div className="student-course-learning__active-heading">
                <div>
                  <h2>{detailsTab === 'certificate' ? 'Course Certificate' : activeContentItem?.title || (detailsTab === 'notes' ? 'Notes' : detailsTab === 'resources' ? 'Resources' : activeEntry?.lesson.title) || 'Select course content'}</h2>
                  {detailsTab === 'certificate'
                    ? <span className="student-course-learning__type student-course-learning__type--certificate"><Icon name="award" size={14} />Certificate</span>
                    : <span className={`student-course-learning__type student-course-learning__type--${activeContentItem?.type || 'video-lesson'}`}>
                      <Icon name={activeContentItem?.type === 'assignment' ? 'clipboardCheck' : activeContentItem?.type === 'note' || detailsTab === 'notes' ? 'folderOpen' : activeContentItem?.type === 'quiz' ? 'check' : detailsTab === 'resources' ? 'link' : 'book'} size={14} />
                      {detailsTab === 'resources'
                        ? 'Resources'
                        : getStudentContentLabel(activeContentItem?.type || (detailsTab === 'notes' ? 'note' : 'video-lesson'))}
                    </span>}
                </div>
                {!showVideoPlayer && detailsTab !== 'certificate' && !isActiveQuiz && <div className="student-course-learning__detail-nav">
                  <button type="button" disabled={activeContentIndex <= 0} onClick={() => moveContent(-1)}>← Previous</button>
                  <button type="button" disabled={activeContentIndex < 0 || activeContentIndex >= allContentItems.length - 1} onClick={() => moveContent(1)}>Next →</button>
                </div>}
              </div>}
              {detailsTab === 'overview' && !isActiveAssignment && (activeContentItem?.description || (!activeContentItem && activeEntry?.lesson.content)) && (
                <p className="student-course-learning__active-description">
                  {activeContentItem?.description || activeEntry?.lesson.content}
                </p>
              )}
              {detailsTab !== 'certificate' && !isActiveAssignment && <div className="student-course-learning__tabs" role="tablist" aria-label="Course information">
                {showVideoPlayer ? (
                  <>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={detailsTab === 'overview' && lessonInfoTab === 'overview'}
                      className={detailsTab === 'overview' && lessonInfoTab === 'overview' ? 'is-active' : ''}
                      onClick={() => {
                        setActiveContentItemId('')
                        setDetailsTab('overview')
                        setLessonInfoTab('overview')
                      }}
                    >
                      <Icon name="book" size={15} />
                      Lesson Overview
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={detailsTab === 'overview' && lessonInfoTab === 'transcript'}
                      className={detailsTab === 'overview' && lessonInfoTab === 'transcript' ? 'is-active' : ''}
                      onClick={() => {
                        setActiveContentItemId('')
                        setDetailsTab('overview')
                        setLessonInfoTab('transcript')
                      }}
                    >
                      <Icon name="book" size={15} />
                      Transcript
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    role="tab"
                    aria-selected={detailsTab === 'overview'}
                    className={detailsTab === 'overview' ? 'is-active' : ''}
                    onClick={() => {
                      setActiveContentItemId('')
                      setDetailsTab('overview')
                    }}
                  >
                    <Icon name="book" size={15} />
                    Overview
                  </button>
                )}
                <button
                  type="button"
                  role="tab"
                  aria-selected={detailsTab === 'notes'}
                  className={detailsTab === 'notes' ? 'is-active' : ''}
                  onClick={() => {
                    setActiveContentItemId('')
                    setDetailsTab('notes')
                  }}
                >
                  <Icon name="pen" size={15} />
                  My Notes
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={detailsTab === 'resources'}
                  className={detailsTab === 'resources' ? 'is-active' : ''}
                  onClick={() => {
                    setActiveContentItemId('')
                    setDetailsTab('resources')
                  }}
                >
                  <Icon name="link" size={15} />
                  Resources
                  {courseResources.length > 0 && <span className="student-course-learning__tab-badge">{courseResources.length}</span>}
                </button>
              </div>}
              {detailsTab === 'certificate' ? (
                <div className="student-course-learning__tab-content">{renderCourseCertificate()}</div>
              ) : detailsTab === 'notes' ? (
                <div className="student-course-learning__tab-content">
                  <StudentNotesSection
                    course={course}
                    lessons={lessons}
                    activeEntry={activeEntry}
                    videoPlayerRef={videoPlayerRef}
                    onSeekToLessonTimestamp={handleSeekToLessonTimestamp}
                    onLogout={onLogout}
                    apiBaseUrl={API_BASE_URL}
                    onRequestOpenEditorRef={requestOpenNoteEditorRef}
                  />
                </div>
              ) : detailsTab === 'resources' ? (
                <div className="student-course-learning__tab-content">
                  {courseResources.length ? (
                    <ul className="student-course-note__resources">
                      {courseResources.map((resource, index) => (
                        <li key={resource._id || `${resource.url}-${index}`}>
                          <a href={resource.url} target="_blank" rel="noreferrer" download={resource.resourceType === 'raw' || resource.format === 'pdf' ? resource.title : undefined}>
                            {resource.title || `Resource ${index + 1}`}
                          </a>
                          {resource.format && <small>{resource.format.toUpperCase()}</small>}
                        </li>
                      ))}
                    </ul>
                  ) : <p className="student-course-learning__tab-empty">No resources have been added to this course.</p>}
                </div>
              ) : showVideoPlayer ? (
                <div className="student-course-learning__tab-content">
                  <section className="student-course-learning__transcript" aria-labelledby="student-course-transcript-title">
                    <h3 id="student-course-transcript-title">Transcript</h3>
                    {transcriptCues.length ? lessonInfoTab === 'transcript' ? (
                      <div
                        key={activeVideoKey}
                        ref={transcriptScriptRef}
                        className="student-course-learning__transcript-script"
                        aria-label="Video transcript"
                      >
                        <p>
                          {transcriptCues.map((cue, index) => (
                            <React.Fragment key={`${activeVideoKey}-${cue.startTimeMs}-${index}`}>
                              {index > 0 ? ' ' : ''}
                              <button
                                type="button"
                                ref={(element) => { transcriptScriptCueRefs.current[index] = element }}
                                className={`student-course-learning__transcript-script-cue${index === activeTranscriptCueIndex ? ' is-active' : ''}`}
                                aria-current={index === activeTranscriptCueIndex ? 'true' : undefined}
                                aria-label={`Jump to ${formatTranscriptTime(cue.startTimeMs)}: ${cue.text}`}
                                onClick={() => seekToTranscriptCue(cue)}
                              >
                                {cue.text}
                              </button>
                            </React.Fragment>
                          ))}
                        </p>
                      </div>
                    ) : (
                      <ol
                        key={activeVideoKey}
                        ref={transcriptCueListRef}
                        className="student-course-learning__transcript-cues"
                        aria-label="Video transcript"
                      >
                        {transcriptCues.map((cue, index) => (
                          <li
                            key={`${activeVideoKey}-${cue.startTimeMs}-${index}`}
                            ref={(element) => { transcriptCueRefs.current[index] = element }}
                            className={`student-course-learning__transcript-cue${index === activeTranscriptCueIndex ? ' is-active' : ''}`}
                            aria-current={index === activeTranscriptCueIndex ? 'true' : undefined}
                          >
                            <time>{formatTranscriptTime(cue.startTimeMs)}</time>
                            <button
                              type="button"
                              className="student-course-learning__transcript-text"
                              aria-label={`Jump to ${formatTranscriptTime(cue.startTimeMs)}: ${cue.text}`}
                              onClick={() => seekToTranscriptCue(cue)}
                            >
                              {cue.text}
                            </button>
                          </li>
                        ))}
                      </ol>
                    ) : <p className="student-course-learning__transcript-empty">Transcript not available</p>}
                  </section>
                </div>
              ) : (
                <div className="student-course-learning__tab-content">
                  {activeContentItem?.type === 'quiz' ? (
                    activeContentItem.quiz?.questions?.length ? (
                      <StudentQuizExperience
                        key={activeContentItem._learningKey}
                        courseId={course._id}
                        enrollmentId={enrollment._id}
                        quiz={activeContentItem.quiz}
                        attempts={quizAttempts}
                        onAttemptAdded={addQuizAttempt}
                        onLearningDataChanged={onLearningDataChanged}
                        onLogout={onLogout}
                        showHeader={false}
                      />
                    ) : <EmptyState icon="check" title="Quiz is not available" description="This quiz does not contain any questions." />
                  ) : activeContentItem?.type === 'assignment' ? (
                    <StudentAssignmentPanel
                      key={activeContentItem._learningKey}
                      courseId={course._id}
                      enrollmentId={enrollment._id}
                      assignment={activeContentItem}
                      submissions={assignmentSubmissions}
                      onSubmitted={addAssignmentSubmission}
                      onLearningDataChanged={onLearningDataChanged}
                      onLogout={onLogout}
                      showHeader
                      canSubmit={['not-submitted', 'rejected'].includes(getAssignmentReviewStatus(activeContentItem))}
                    />
                  ) : activeContentItem?.type === 'note' ? (
                    <StudentNotePanel item={activeContentItem} />
                  ) : activeEntry ? (
                    <section className="student-course-learning__lesson">
                      <span className="student-eyebrow">{activeEntry.module.title}</span>
                    </section>
                  ) : <EmptyState icon="book" title="Select course content" description="Choose a video, quiz, assignment, or note from the course content list." />}
                </div>
              )}
              {(isActiveAssignment || (isActiveQuiz && !hasActiveQuizAttempt)) && (
                <div className={`student-course-learning__detail-nav student-course-learning__detail-nav--bottom${isActiveAssignment ? ' student-course-learning__detail-nav--assignment' : ''}`}>
                  <button type="button" disabled={activeContentIndex <= 0} onClick={() => moveContent(-1)}>← Previous</button>
                  <button type="button" disabled={activeContentIndex < 0 || activeContentIndex >= allContentItems.length - 1} onClick={() => moveContent(1)}>Next →</button>
                </div>
              )}
            </section>
          </div>
        </div>
      ) : showCourseCertificate ? (
        <div className="student-course-learning__layout">
          <aside className="student-course-learning__sidebar" aria-label="Course modules and lessons">
            <header className="student-course-learning__sidebar-header"><h2>{course.title}</h2></header>
            <section className="student-course-learning__sidebar-links" aria-label="Course materials">
              <button
                className={detailsTab === 'certificate' ? 'is-selected' : ''}
                type="button"
                aria-pressed={detailsTab === 'certificate'}
                onClick={() => setDetailsTab('certificate')}
              >
                <span className="student-course-learning__item-icon"><Icon name="award" size={15} /></span>
                <strong>Certificate</strong>
              </button>
              <button className={detailsTab === 'notes' ? 'is-selected' : ''} type="button" aria-pressed={detailsTab === 'notes'} onClick={() => setDetailsTab('notes')}>
                <span className="student-course-learning__item-icon"><Icon name="pen" size={15} /></span>
                <strong>Notes</strong>
              </button>
              <button className={detailsTab === 'resources' ? 'is-selected' : ''} type="button" aria-pressed={detailsTab === 'resources'} onClick={() => setDetailsTab('resources')}>
                <span className="student-course-learning__item-icon"><Icon name="link" size={15} /></span>
                <strong>Resources</strong>
              </button>
            </section>
          </aside>
          <div className="student-course-learning__main student-course-learning__main--activity">
            {detailsTab === 'certificate' ? (
              <>
                <div className="student-course-learning__active-heading"><h2>Course Certificate</h2></div>
                <div className="student-course-learning__tab-content">{renderCourseCertificate()}</div>
              </>
            ) : detailsTab === 'notes' ? (
              <div className="student-course-learning__tab-content">
                <StudentNotesSection
                  course={course}
                  lessons={lessons}
                  activeEntry={activeEntry}
                  videoPlayerRef={videoPlayerRef}
                  onSeekToLessonTimestamp={handleSeekToLessonTimestamp}
                  onLogout={onLogout}
                  apiBaseUrl={API_BASE_URL}
                  onRequestOpenEditorRef={requestOpenNoteEditorRef}
                />
              </div>
            ) : <EmptyState icon="book" title="Course content is not available yet" description="This enrolled course does not currently have any lessons or activities." />}
          </div>
        </div>
      ) : <EmptyState icon="book" title="Course content is not available yet" description="This enrolled course does not currently have any lessons or activities." />}
    </div>
  )
}

async function referralsRequest(path, { onLogout, method = 'GET', body, signal }) {
  const savedAuth = sessionStorage.getItem('lms.auth')
  const auth = savedAuth ? JSON.parse(savedAuth) : null
  if (typeof auth?.token !== 'string') {
    onLogout()
    throw new Error('Your session has ended. Please sign in again.')
  }
  const response = await fetchWithAuth(`${API_BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${auth.token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal,
  }, API_BASE_URL, auth.token)
  const result = await response.json()
  if (isInvalidSessionResponse(response, result)) {
    onLogout()
    throw new Error('Your session has ended. Please sign in again.')
  }
  if (!response.ok) {
    const message = response.status === 404
      ? 'The referral service is unavailable right now. Please try again shortly.'
      : result.message || 'Referral information could not be loaded.'
    const error = new Error(message)
    error.statusCode = response.status
    throw error
  }
  return result
}



function formatReferralDate(value) {
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? 'Date unavailable'
    : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

async function learningRequest(path, { onLogout, method = 'GET', body, signal } = {}) {
  const savedAuth = sessionStorage.getItem('lms.auth')
  const auth = savedAuth ? JSON.parse(savedAuth) : null
  if (typeof auth?.token !== 'string') {
    if (onLogout) onLogout()
    throw new Error('Your session has ended. Please sign in again.')
  }
  const response = await fetch(`${API_BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${auth.token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal,
  })
  const result = await response.json()
  if (isInvalidSessionResponse(response, result)) {
    if (onLogout) onLogout()
    throw new Error('Your session has ended. Please sign in again.')
  }
  if (!response.ok) {
    throw new Error(result.message || 'Learning data could not be loaded.')
  }
  return result
}

function formatDuration(totalSeconds = 0) {
  const secs = Math.max(0, Math.round(Number(totalSeconds) || 0))
  if (secs < 60) return `${secs}s`
  const minutes = Math.floor(secs / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const remainingMins = minutes % 60
  return remainingMins > 0 ? `${hours}h ${remainingMins}m` : `${hours}h`
}

function formatMinutes(totalMinutes = 0) {
  const mins = Math.max(0, Math.round(Number(totalMinutes) || 0))
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  const remainingMins = mins % 60
  return remainingMins > 0 ? `${hours}h ${remainingMins}m` : `${hours}h`
}


function StudentReferrals({ onLogout }) {
  const [referralData, setReferralData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState('')
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [notice, setNotice] = useState('')
  const [copiedCode, setCopiedCode] = useState('')
  const [selectedQuantity, setSelectedQuantity] = useState(1)
  const [filterTab, setFilterTab] = useState('active') // 'active', 'all', 'used', 'expired'
  const pendingRequestId = useRef('')

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError('')
    referralsRequest('/referrals/me', { onLogout, signal: controller.signal })
      .then((result) => {
        if (!Array.isArray(result.codes) || !result.stats) {
          throw new Error('The server returned invalid referral information.')
        }
        setReferralData(result)
        const remaining = result.stats.remainingGenerations !== undefined
          ? result.stats.remainingGenerations
          : (result.stats.remainingSlots !== undefined ? result.stats.remainingSlots : Math.max(0, 20 - (result.stats.totalGenerated || 0)))
        setSelectedQuantity((prev) => Math.min(Math.max(1, prev), Math.max(1, remaining)))
      })
      .catch((loadError) => {
        if (loadError.name !== 'AbortError') {
          setError(loadError instanceof Error ? loadError.message : 'Referral information could not be loaded.')
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [onLogout, loadAttempt])

  const stats = referralData?.stats || {
    totalGenerated: 0,
    maxLifetimeLimit: 20,
    lifetimeLimit: 20,
    active: 0,
    remainingSlots: 20,
    remainingGenerations: 20,
    successfullyUsed: 0,
    expired: 0,
  }

  const allCodes = referralData?.codes || []
  const totalGenerated = stats.totalGenerated !== undefined ? stats.totalGenerated : allCodes.length
  const maxLimit = stats.maxLifetimeLimit || stats.lifetimeLimit || stats.maxActiveLimit || 20
  const remainingSlots = stats.remainingSlots !== undefined
    ? stats.remainingSlots
    : (stats.remainingGenerations !== undefined ? stats.remainingGenerations : Math.max(0, maxLimit - totalGenerated))
  const remainingGenerations = remainingSlots
  const isAtLimit = remainingSlots <= 0 || totalGenerated >= maxLimit

  async function generateReferralCodes() {
    if (isAtLimit) return
    setGenerating(true)
    setError('')
    setNotice('')
    try {
      if (!pendingRequestId.current) {
        if (typeof window.crypto?.randomUUID !== 'function') {
          throw new Error('Your browser cannot securely start a referral request. Please update your browser.')
        }
        pendingRequestId.current = window.crypto.randomUUID()
      }

      const qty = Math.min(Math.max(1, Number(selectedQuantity) || 1), remainingGenerations)
      const res = await referralsRequest('/referrals/generate', {
        onLogout,
        method: 'POST',
        body: {
          requestId: pendingRequestId.current,
          quantity: qty,
        },
      })
      pendingRequestId.current = ''
      const countGenerated = res?.count || (res?.codes ? res.codes.length : 1)
      setNotice(
        countGenerated === 1
          ? 'Your referral code has been generated.'
          : `Successfully generated ${countGenerated} referral codes.`,
      )
      const result = await referralsRequest('/referrals/me', { onLogout })
      setReferralData(result)
      const newRemaining = result.stats.remainingGenerations !== undefined
        ? result.stats.remainingGenerations
        : (result.stats.remainingSlots !== undefined ? result.stats.remainingSlots : Math.max(0, 20 - (result.stats.totalGenerated || 0)))
      setSelectedQuantity(Math.min(1, Math.max(1, newRemaining)))
      setFilterTab('active')
    } catch (generateError) {
      setError(generateError instanceof Error ? generateError.message : 'A referral code could not be generated.')
    } finally {
      setGenerating(false)
    }
  }

  async function copyReferralCode(code) {
    try {
      await navigator.clipboard.writeText(code)
      setCopiedCode(code)
      setNotice(`Referral code ${code} copied to clipboard.`)
      setError('')
      setTimeout(() => setCopiedCode(''), 3000)
    } catch {
      setError('The referral code could not be copied. Please copy it manually.')
    }
  }

  const activeCodes = allCodes.filter((c) => c.status === 'active' && !c.friendRegistered)
  const usedCodes = allCodes.filter((c) => c.friendRegistered || c.status === 'used')
  const expiredCodes = allCodes.filter((c) => c.status === 'expired')

  const displayedCodes = filterTab === 'active'
    ? activeCodes
    : filterTab === 'used'
      ? usedCodes
      : filterTab === 'expired'
        ? expiredCodes
        : allCodes

  const summary = [
    { label: 'Total Generated', value: `${totalGenerated} / ${maxLimit}`, tone: 'gold', icon: 'folder' },
    { label: 'Remaining Generations', value: remainingGenerations, tone: 'mint', icon: 'spark' },
    { label: 'Active Codes', value: activeCodes.length, tone: 'peach', icon: 'users' },
    { label: 'Successfully Used', value: stats.successfullyUsed, tone: 'blue', icon: 'check' },
    { label: 'Expired Codes', value: stats.expired, tone: 'lavender', icon: 'clock' },
  ]

  return (
    <div className="student-referrals">
      <section className="student-panel student-referrals__intro">
        <div className="student-referrals__intro-copy">
          <span className="student-eyebrow">SHARE YOUR LEARNING JOURNEY</span>
          <h1>My Referrals</h1>
          <p>Invite friends to join aiHustle with a one-time referral code. You can generate up to 20 referral codes over the lifetime of your account. Each code expires independently 15 days after creation.</p>
        </div>

        <div className="student-referrals__generator-box">
          <div className="student-referrals__slots-meter">
            <div className="student-referrals__slots-meter-info">
              <span>Total Generated: <strong>{totalGenerated} / {maxLimit}</strong></span>
              <span>Remaining Generations: <strong>{remainingGenerations}</strong></span>
            </div>
            <div className="student-progress-bar-track">
              <div
                className="student-progress-bar-fill"
                style={{ width: `${Math.min(100, (totalGenerated / maxLimit) * 100)}%` }}
              />
            </div>
          </div>

          <div className="student-referrals__generator-controls">
            <div className="student-referrals__qty-wrap">
              <label htmlFor="referral-qty-select">Quantity:</label>
              <select
                id="referral-qty-select"
                value={selectedQuantity}
                onChange={(e) => setSelectedQuantity(Number(e.target.value))}
                disabled={loading || generating || isAtLimit}
              >
                {isAtLimit ? (
                  <option value={0}>0 generations available</option>
                ) : (
                  Array.from({ length: Math.min(remainingGenerations, 20) }, (_, i) => i + 1).map((n) => (
                    <option key={n} value={n}>
                      {n} {n === 1 ? 'code' : 'codes'}
                    </option>
                  ))
                )}
              </select>
            </div>

            <button
              className="student-button student-button--primary"
              type="button"
              onClick={generateReferralCodes}
              disabled={loading || !referralData || generating || isAtLimit}
            >
              {generating
                ? 'Generating…'
                : isAtLimit
                  ? 'Lifetime Limit Reached (20/20)'
                  : `Generate ${selectedQuantity > 1 ? selectedQuantity + ' ' : ''}Referral Code${selectedQuantity > 1 ? 's' : ''}`}
            </button>
          </div>

          {isAtLimit ? (
            <div className="student-referrals__status-banner is-limit" role="status">
              <Icon name="lock" size={16} />
              <div>
                <strong>You have reached your lifetime limit of 20 referral codes.</strong>
                <small>Each student account can generate a maximum of 20 referral codes in total. Used and expired codes cannot be restored.</small>
              </div>
            </div>
          ) : (
            <div className="student-referrals__status-banner is-available" role="status">
              <Icon name="spark" size={16} />
              <div>
                <span>{totalGenerated} of {maxLimit} lifetime referral codes generated. You can generate {remainingGenerations} more referral code{remainingGenerations === 1 ? '' : 's'}.</span>
                <small>Each generated code expires independently 15 days after its creation timestamp.</small>
              </div>
            </div>
          )}
        </div>
      </section>

      {error && (
        <p className="student-courses__message is-error" role="alert">
          {error}
          {!referralData && !loading && (
            <button
              className="student-button student-button--quiet"
              type="button"
              onClick={() => setLoadAttempt((attempt) => attempt + 1)}
            >
              Try again
            </button>
          )}
        </p>
      )}
      {notice && <p className="student-courses__message" role="status">{notice}</p>}

      <section className="student-referrals__summary" aria-label="Referral summary">
        {summary.map((item) => (
          <article className="student-stat" key={item.label}>
            <span className={`student-stat__icon is-${item.tone}`}><Icon name={item.icon || 'users'} size={18} /></span>
            <span className="student-stat__label">{item.label}</span>
            <strong className="student-stat__value">{referralData ? item.value : '—'}</strong>
          </article>
        ))}
      </section>

      <section className="student-panel student-referrals__history" aria-labelledby="student-referral-history-title">
        <div className="student-section-heading">
          <div>
            <span className="student-eyebrow">YOUR CODE ACTIVITY</span>
            <h2 id="student-referral-history-title">Referral History</h2>
          </div>
          <span className="student-data-note">Each code expires independently exactly 15 days after creation.</span>
        </div>

        <div className="student-referrals__tabs" role="tablist" aria-label="Filter referral codes">
          <button
            type="button"
            className={`student-referrals__tab ${filterTab === 'active' ? 'is-active' : ''}`}
            onClick={() => setFilterTab('active')}
          >
            Active Codes ({activeCodes.length})
          </button>
          <button
            type="button"
            className={`student-referrals__tab ${filterTab === 'all' ? 'is-active' : ''}`}
            onClick={() => setFilterTab('all')}
          >
            All Codes ({allCodes.length})
          </button>
          <button
            type="button"
            className={`student-referrals__tab ${filterTab === 'used' ? 'is-active' : ''}`}
            onClick={() => setFilterTab('used')}
          >
            Used ({usedCodes.length})
          </button>
          <button
            type="button"
            className={`student-referrals__tab ${filterTab === 'expired' ? 'is-active' : ''}`}
            onClick={() => setFilterTab('expired')}
          >
            Expired ({expiredCodes.length})
          </button>
        </div>

        {filterTab === 'expired' && expiredCodes.length > 0 && (
          <div className="student-referrals__expired-notice">
            <Icon name="clock" size={16} />
            <span>
              Expired codes are preserved in your historical records. Under the referral policy, all generated codes count toward your 20 lifetime limit. Expired codes can no longer be used for registration.
            </span>
          </div>
        )}

        {loading ? (
          <p role="status">Loading your referral history…</p>
        ) : displayedCodes.length ? (
          <div className="student-referrals__list">
            {displayedCodes.map((code) => {
              const isExpired = code.status === 'expired'
              const isUsed = code.status === 'used' || code.friendRegistered
              const isActive = code.status === 'active' && !code.friendRegistered
              const statusLabel = isUsed ? 'Used' : (isExpired ? 'Expired' : 'Active')
              return (
                <article className={`student-referral-card is-${code.status}`} key={code.code}>
                  <div className="student-referral-card__top">
                    <strong className="student-referral-card__code">{code.code}</strong>
                    <span className={`student-referral-card__status is-${code.status}`}>
                      {statusLabel}
                    </span>
                    {isActive && (
                      <button
                        className="student-button student-button--quiet student-button--sm"
                        type="button"
                        onClick={() => copyReferralCode(code.code)}
                      >
                        {copiedCode === code.code ? '✓ Copied' : 'Copy'}
                      </button>
                    )}
                  </div>

                  {isUsed && (code.referralMessage || code.referredStudentName) && (
                    <div className="student-referral-card__attribution-banner">
                      <Icon name="check" size={15} />
                      <span>{code.referralMessage || `${code.referredStudentName} joined aiHustle using your referral code.`}</span>
                    </div>
                  )}

                  <dl>
                    <div><dt>Generated</dt><dd>{formatReferralDate(code.createdAt)}</dd></div>
                    <div>
                      <dt>{isExpired ? 'Expired On' : 'Expires On'}</dt>
                      <dd className={isExpired ? 'is-expired-text' : 'is-active-text'}>
                        {formatReferralDate(code.expiresAt)}
                      </dd>
                    </div>
                    {isUsed ? (
                      <>
                        <div>
                          <dt>Referred Student</dt>
                          <dd><strong>{code.referredStudentName || 'Registered Student'}</strong></dd>
                        </div>
                        {code.referredStudentRegistrationDate && (
                          <div>
                            <dt>Registration Date</dt>
                            <dd>{formatReferralDate(code.referredStudentRegistrationDate)}</dd>
                          </div>
                        )}
                        {code.usedAt && (
                          <div>
                            <dt>Used On</dt>
                            <dd>{formatReferralDate(code.usedAt)}</dd>
                          </div>
                        )}
                      </>
                    ) : (
                      <div><dt>Redeemed</dt><dd>Not yet</dd></div>
                    )}
                    {code.registrationStatus && (
                      <div>
                        <dt>Registration status</dt>
                        <dd>
                          <span className={`student-referral-reg-status is-${code.registrationStatus}`}>
                            {code.registrationStatus === 'account_deleted'
                              ? 'Account Deleted'
                              : code.registrationStatus === 'approved'
                                ? 'Qualified'
                                : code.registrationStatus === 'awaiting_approval'
                                  ? 'Pending Verification'
                                  : code.registrationStatus.replaceAll('_', ' ')}
                          </span>
                        </dd>
                      </div>
                    )}
                    {code.rewardStatus && (
                      <div>
                        <dt>Reward status</dt>
                        <dd>
                          <span className={`student-referral-reward-status is-${code.rewardStatus}`}>
                            {code.rewardStatus === 'cancelled'
                              ? 'Cancelled'
                              : code.rewardStatus === 'earned'
                                ? 'Earned'
                                : code.rewardStatus === 'pending'
                                  ? 'Pending'
                                  : code.rewardStatus}
                          </span>
                        </dd>
                      </div>
                    )}
                  </dl>
                </article>
              )
            })}
          </div>
        ) : !error ? (
          <EmptyState
            icon={filterTab === 'expired' ? 'clock' : filterTab === 'used' ? 'check' : 'users'}
            title={
              filterTab === 'active'
                ? 'No active referral codes'
                : filterTab === 'expired'
                  ? 'No expired referral codes'
                  : filterTab === 'used'
                    ? 'No used referral codes yet'
                    : 'No referral codes yet'
            }
            description={
              filterTab === 'active'
                ? (remainingSlots > 0 ? `You have ${remainingSlots} slot${remainingSlots === 1 ? '' : 's'} available. Select a quantity above and click Generate!` : 'You currently have no active codes.')
                : filterTab === 'expired'
                  ? 'When a referral code reaches its 15-day expiration without being used, it will appear here.'
                  : filterTab === 'used'
                    ? 'When friends register with your referral codes, they will appear here.'
                    : 'Generate a code to invite friends to join aiHustle.'
            }
          />
        ) : null}
      </section>
    </div>
  )
}


function StudentCertificateModal({ certificate, onClose }) {
  if (!certificate) return null

  const issueDateFormatted = certificate.issueDate
    ? new Date(certificate.issueDate).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })
    : new Date().toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })
  const completionDateFormatted = certificate.completionDate
    ? new Date(certificate.completionDate).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })
    : issueDateFormatted

  return (
    <div className="student-cert-modal-backdrop" onClick={onClose} role="dialog" aria-modal="true">
      <div className="student-cert-modal" onClick={(e) => e.stopPropagation()}>
        <div className="student-cert-modal__toolbar no-print">
          <div className="student-cert-modal__info">
            <strong>Verified Certificate of Completion</strong>
            <span>ID: {certificate.certificateId}</span>
          </div>
          <div className="student-cert-modal__toolbar-actions">
            <button
              type="button"
              className="student-button student-button--primary"
              onClick={() => window.print()}
            >
              <Icon name="printer" size={15} />
              <span>Print / Save as PDF</span>
            </button>
            <button
              type="button"
              className="student-cert-modal__close-btn"
              onClick={onClose}
              aria-label="Close certificate"
            >
              <Icon name="xCircle" size={18} />
            </button>
          </div>
        </div>

        <div className="student-cert-document" id="printable-certificate">
          <div className="student-cert-document__border">
            <div className="student-cert-document__inner">
              <header className="student-cert-document__header">
                <div className="student-cert-document__brand">aiHustle LMS</div>
                <span className="student-cert-document__eyebrow">VERIFIED CERTIFICATE OF ACHIEVEMENT</span>
                <h1 className="student-cert-document__title">Certificate of Completion</h1>
              </header>

              <div className="student-cert-document__body">
                <p className="student-cert-document__presentation">This certificate is proudly awarded to</p>
                <h2 className="student-cert-document__recipient">{certificate.studentName}</h2>
                <p className="student-cert-document__narrative">
                  for demonstrating exceptional commitment, completing all video curriculum lessons, and successfully passing all knowledge checkpoints and milestone assessments for
                </p>
                <h3 className="student-cert-document__course-name">{certificate.courseTitle}</h3>
                <p className="student-cert-document__category">{certificate.courseCategory || 'Professional Skill Path'}</p>
              </div>

              <footer className="student-cert-document__footer">
                <div className="student-cert-document__col">
                  <span className="student-cert-document__val">{completionDateFormatted}</span>
                  <span className="student-cert-document__lbl">Completion Date</span>
                </div>
                <div className="student-cert-document__seal">
                  <Icon name="award" size={32} />
                  <span>OFFICIAL CREDENTIAL</span>
                </div>
                <div className="student-cert-document__col">
                  <span className="student-cert-document__val">{certificate.certificateId}</span>
                  <span className="student-cert-document__lbl">Certificate ID</span>
                </div>
              </footer>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function StudentUnenrollConfirmModal({ courseTitle, onConfirm, onCancel, loading, error }) {
  return (
    <div className="student-cert-modal-backdrop" onClick={() => !loading && onCancel()} role="alertdialog" aria-modal="true">
      <div className="student-unenroll-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="student-unenroll-dialog__header">
          <span className="student-unenroll-dialog__icon"><Icon name="alertCircle" size={24} /></span>
          <h3>Unenroll from course?</h3>
        </div>
        <p className="student-unenroll-dialog__message">
          Are you sure you want to unenroll from <strong>{courseTitle}</strong>? Your active enrollment will be deactivated and removed from your active courses.
        </p>
        {error && <p className="student-courses__message is-error" role="alert">{error}</p>}
        <div className="student-unenroll-dialog__actions">
          <button
            type="button"
            className="student-button student-button--subtle"
            onClick={onCancel}
            disabled={loading}
          >
            Cancel
          </button>
          <button
            type="button"
            className="student-button student-button--danger"
            onClick={onConfirm}
            disabled={loading}
          >
            {loading ? 'Unenrolling…' : 'Confirm Unenroll'}
          </button>
        </div>
      </div>
    </div>
  )
}

function StudentCourseDetailsPage({ user, onLogout, onLearningDataChanged }) {
  const { courseId: rawCourseId } = useParams()
  const courseId = (rawCourseId || '').trim().replace(/\/details\/?$/, '').trim()
  const navigate = useNavigate()
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [enrolling, setEnrolling] = useState(false)
  const [enrollSuccessMessage, setEnrollSuccessMessage] = useState('')
  const [showUnenrollModal, setShowUnenrollModal] = useState(false)
  const [unenrolling, setUnenrolling] = useState(false)
  const [unenrollError, setUnenrollError] = useState('')
  const [showCertificateModal, setShowCertificateModal] = useState(false)
  const [expandedModules, setExpandedModules] = useState(() => new Set(['0', '1', '2']))

  const isCollegeStudent = user?.studentType === 'college' || Boolean(user?.collegeId)

  const loadDetails = useCallback((signal) => {
    if (!courseId) {
      setLoading(false)
      setError('A valid course must be selected.')
      return
    }
    setLoading(true)
    setError('')
    fetchCourseDetails(courseId, onLogout, signal)
      .then((res) => {
        setData(res)
        if (res.curriculum?.length) {
          setExpandedModules(new Set(res.curriculum.map((_, i) => String(i))))
        }
      })
      .catch(async (err) => {
        if (err.name === 'AbortError') return

        // Fallback: Check if the course is already available in student enrollments or published catalog
        try {
          const [enrollments, published] = await Promise.all([
            fetchMyEnrollments(onLogout, signal).catch(() => []),
            fetchPublishedCourses(onLogout, signal).catch(() => []),
          ])

          const matchingEnrollment = (enrollments || []).find((e) => {
            const cid = e.courseId && typeof e.courseId === 'object' ? String(e.courseId._id) : String(e.courseId || '')
            return cid === courseId || String(e._id) === courseId
          })
          const enrolledCourse = matchingEnrollment?.courseId && typeof matchingEnrollment.courseId === 'object'
            ? matchingEnrollment.courseId
            : null
          const matchingPublished = (published || []).find((c) => String(c._id) === courseId)
          const fallbackCourse = enrolledCourse || matchingPublished

          if (fallbackCourse) {
            const fallbackCounts = getCourseCounts(fallbackCourse)
            const fallbackProgress = matchingEnrollment ? getCourseProgress(matchingEnrollment) : null
            const isCompleted = Boolean(fallbackProgress?.isCompleted || matchingEnrollment?.status === 'completed')

            const fallbackCurriculum = (fallbackCourse.modules || []).map((mod, mIdx) => {
              const items = (mod.contentItems || []).length
                ? mod.contentItems
                : (mod.lessons || []).map((l) => ({ ...l, type: 'video-lesson' }))
              return {
                moduleId: String(mod._id || `mod-${mIdx}`),
                title: mod.title || `Module ${mIdx + 1}`,
                description: mod.description || '',
                itemCount: items.length,
                items: items.map((item) => ({
                  id: String(item._id),
                  type: item.type || 'video-lesson',
                  title: item.title || 'Lesson',
                  description: item.description || '',
                  durationSeconds: Number(item.durationSeconds) || 0,
                  points: Number(item.points) || 0,
                  isCompleted: false,
                  isFailed: false,
                  isSubmitted: false,
                })),
              }
            })

            setData({
              isEnrolled: Boolean(matchingEnrollment),
              enrollment: matchingEnrollment ? {
                _id: String(matchingEnrollment._id),
                status: matchingEnrollment.status,
                enrolledAt: matchingEnrollment.createdAt,
                completedAt: matchingEnrollment.completedAt,
                isCompleted,
                progressPercentage: fallbackProgress?.percentage || 0,
              } : null,
              course: {
                _id: String(fallbackCourse._id),
                title: fallbackCourse.title || 'Course Details',
                description: fallbackCourse.description || '',
                detailedDescription: fallbackCourse.detailedDescription || fallbackCourse.description || '',
                category: fallbackCourse.category || 'General',
                difficulty: fallbackCourse.difficulty || 'beginner',
                thumbnailUrl: fallbackCourse.thumbnailUrl || '',
                learningObjectives: fallbackCourse.learningObjectives || [],
                prerequisites: fallbackCourse.prerequisites || [],
                targetAudience: fallbackCourse.targetAudience || 'Beginners, professionals, and students.',
                estimatedDurationMinutes: Number(fallbackCourse.estimatedDurationMinutes) || 0,
                instructor: fallbackCourse.instructor || { name: 'aiHustle Certified Instructor' },
                status: fallbackCourse.status || 'published',
              },
              counts: {
                modules: fallbackCourse.modules?.length || 0,
                lessons: fallbackCounts.lessons || 0,
                quizzes: fallbackCourse.quizzes?.length || 0,
                assignments: fallbackCourse.assignments?.length || 0,
                assessments: fallbackCourse.assignments?.length || 0,
                durationMinutes: fallbackCourse.estimatedDurationMinutes || 0,
              },
              curriculum: fallbackCurriculum,
              progress: matchingEnrollment ? {
                progressPercentage: fallbackProgress?.percentage || 0,
                totalRequiredActivities: fallbackProgress?.totalRequired || 0,
                completedActivities: fallbackProgress?.completed || 0,
                isCompleted,
                videoStats: { total: fallbackCounts.lessons, completed: fallbackProgress?.completed || 0 },
                quizStats: { total: 0, completed: 0 },
                assessmentStats: { total: 0, completed: 0 },
                nextActivity: fallbackProgress?.nextActivity || null,
              } : null,
              certificate: null,
              canUnenroll: Boolean(matchingEnrollment && !isCompleted),
            })
            if (fallbackCurriculum.length) {
              setExpandedModules(new Set(fallbackCurriculum.map((_, i) => String(i))))
            }
            return
          }
        } catch {
          // If fallback also fails, set error
        }

        setError(err instanceof Error ? err.message : 'Course details could not be loaded.')
      })
      .finally(() => {
        setLoading(false)
      })
  }, [courseId, onLogout])

  useEffect(() => {
    const controller = new AbortController()
    loadDetails(controller.signal)
    return () => controller.abort()
  }, [loadDetails])

  async function handleEnroll() {
    setEnrolling(true)
    setError('')
    setEnrollSuccessMessage('')
    try {
      const res = await enrollInCourse(courseId, onLogout)
      setEnrollSuccessMessage(res.message || 'You have successfully enrolled in this course!')
      if (typeof onLearningDataChanged === 'function') {
        onLearningDataChanged()
      }
      loadDetails()
    } catch (enrollErr) {
      setError(enrollErr instanceof Error ? enrollErr.message : 'Unable to enroll in course.')
    } finally {
      setEnrolling(false)
    }
  }

  async function handleUnenroll() {
    setUnenrolling(true)
    setUnenrollError('')
    try {
      await unenrollFromCourse(courseId, onLogout)
      setShowUnenrollModal(false)
      if (typeof onLearningDataChanged === 'function') {
        onLearningDataChanged()
      }
      loadDetails()
    } catch (unenrollErr) {
      setUnenrollError(unenrollErr instanceof Error ? unenrollErr.message : 'Unable to unenroll from course.')
    } finally {
      setUnenrolling(false)
    }
  }

  function toggleModule(mIndex) {
    const key = String(mIndex)
    setExpandedModules((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const isEnrolled = Boolean(data?.isEnrolled)
  const isCompleted = Boolean(data?.enrollment?.isCompleted || data?.progress?.isCompleted || data?.enrollment?.status === 'completed')
  const course = data?.course
  const counts = data?.counts || { modules: 0, lessons: 0, quizzes: 0, assignments: 0, assessments: 0, durationMinutes: 0 }
  const curriculum = data?.curriculum || []
  const progress = data?.progress
  const certificate = data?.certificate
  const canUnenroll = Boolean(data?.canUnenroll && !isCompleted)

  const difficultyLabels = {
    beginner: 'Beginner',
    intermediate: 'Intermediate',
    advanced: 'Advanced',
    'all-levels': 'All levels',
  }

  return (
    <div className="student-panel student-course-details-page">
      {/* Breadcrumb Navigation */}
      <nav className="student-course-details__breadcrumb" aria-label="Breadcrumb">
        <Link to="/student/courses" className="student-course-details__breadcrumb-link">
          <Icon name="book" size={14} />
          <span>My Courses</span>
        </Link>
        <span className="student-course-details__breadcrumb-sep">/</span>
        <span className="student-course-details__breadcrumb-current">
          {course?.title || 'Course Details'}
        </span>
      </nav>

      {/* Notifications / Alerts */}
      {enrollSuccessMessage && (
        <div className="student-course-details__success-banner" role="status">
          <Icon name="check" size={16} />
          <span>{enrollSuccessMessage}</span>
        </div>
      )}

      {loading ? (
        <div className="student-activities-loading" role="status">
          <p>Loading course details…</p>
        </div>
      ) : error ? (
        <div className="student-activities-empty-box" role="alert">
          <div className="student-activities-empty-box__icon is-danger">
            <Icon name="alertCircle" size={28} />
          </div>
          <h3>Course Details Unavailable</h3>
          <p>{error}</p>
          <div className="student-activities-empty-box__action" style={{ display: 'flex', gap: '12px' }}>
            <button
              type="button"
              className="student-button student-button--primary"
              onClick={() => loadDetails()}
            >
              <span>Retry</span>
            </button>
            <Link to="/student/courses" className="student-button student-button--subtle">
              <span>Back to My Courses</span>
            </Link>
          </div>
        </div>
      ) : !course ? (
        <EmptyState
          icon="book"
          title="Course Not Found"
          description="The requested course does not exist or has been removed from the catalog."
        />
      ) : (
        <>
          {/* Hero Overview Card */}
          <section className="student-course-details__hero">
            <div className="student-course-details__hero-left">
              <div className="student-course-details__meta-badges">
                <span className="student-course-details__badge is-category">
                  {course.category || 'General'}
                </span>
                <span className="student-course-details__badge is-difficulty">
                  {difficultyLabels[course.difficulty] || 'Beginner'}
                </span>
                {isCompleted ? (
                  <span className="student-course-details__badge is-completed">
                    Completed · 100%
                  </span>
                ) : isEnrolled ? (
                  <span className="student-course-details__badge is-enrolled">
                    In Progress · {progress?.progressPercentage || 0}%
                  </span>
                ) : (
                  <span className="student-course-details__badge is-available">
                    Available for Enrollment
                  </span>
                )}
              </div>

              <h1 className="student-course-details__title">{course.title}</h1>

              <p className="student-course-details__summary">
                {course.description || course.detailedDescription || 'Learn in-demand skills through comprehensive lessons, guided practice checkpoints, and practical milestones.'}
              </p>

              {/* Key Facts Chips */}
              <div className="student-course-details__facts-bar">
                <div className="student-course-details__fact-item">
                  <Icon name="clock" size={14} />
                  <span>{formatCourseDuration(counts.durationMinutes)}</span>
                </div>
                <div className="student-course-details__fact-item">
                  <Icon name="folder" size={14} />
                  <span>{counts.modules} {counts.modules === 1 ? 'module' : 'modules'}</span>
                </div>
                <div className="student-course-details__fact-item">
                  <Icon name="play" size={14} />
                  <span>{counts.lessons} {counts.lessons === 1 ? 'lesson' : 'lessons'}</span>
                </div>
                <div className="student-course-details__fact-item">
                  <Icon name="clipboardCheck" size={14} />
                  <span>{counts.quizzes} {counts.quizzes === 1 ? 'quiz' : 'quizzes'}</span>
                </div>
                <div className="student-course-details__fact-item">
                  <Icon name="check" size={14} />
                  <span>{counts.assignments} {counts.assignments === 1 ? 'assignment' : 'assignments'}</span>
                </div>
              </div>

              {/* Instructor Information */}
              <div className="student-course-details__instructor">
                <span className="student-course-details__instructor-avatar">
                  <Icon name="user" size={15} />
                </span>
                <div className="student-course-details__instructor-text">
                  <span className="student-course-details__instructor-label">Course Instructor</span>
                  <strong>{course.instructor?.name || 'aiHustle Senior Faculty'}</strong>
                </div>
              </div>
            </div>

            {/* Hero Right Card: Banner & Enrollment Action Box */}
            <div className="student-course-details__hero-right">
              <div className="student-course-details__banner-box">
                {course.thumbnailUrl ? (
                  <img
                    src={course.thumbnailUrl}
                    alt={`${course.title} banner`}
                    className="student-course-details__banner-img"
                  />
                ) : (
                  <div className="student-course-details__banner-fallback">
                    <Icon name="book" size={42} />
                  </div>
                )}
              </div>

              {/* Dynamic Action Box based on Enrollment State */}
              <div className="student-course-details__action-box">
                {!isEnrolled ? (
                  /* STATE A: NOT ENROLLED */
                  <div className="student-course-details__state-box">
                    <div className="student-course-details__price-line">
                      <strong>Free Access</strong>
                      <span>Full course &amp; certificate</span>
                    </div>

                    {isCollegeStudent ? (
                      <div className="student-course-details__college-note">
                        <Icon name="alertCircle" size={15} />
                        <p>Enrollment for this course is coordinated by your college administrator.</p>
                      </div>
                    ) : (
                      <button
                        type="button"
                        className="student-button student-button--primary student-course-details__cta-btn"
                        onClick={handleEnroll}
                        disabled={enrolling}
                      >
                        <span>{enrolling ? 'Enrolling in course…' : 'Enroll Now →'}</span>
                      </button>
                    )}

                    <ul className="student-course-details__perks">
                      <li><Icon name="check" size={13} /> Immediate access to all video lessons</li>
                      <li><Icon name="check" size={13} /> Practice quizzes &amp; milestone assessments</li>
                      <li><Icon name="check" size={13} /> Official Certificate upon 100% completion</li>
                    </ul>
                  </div>
                ) : !isCompleted ? (
                  /* STATE B: ENROLLED & INCOMPLETE */
                  <div className="student-course-details__state-box">
                    <div className="student-course-details__progress-block">
                      <div className="student-course-details__progress-header">
                        <span>Learning Progress</span>
                        <strong>{progress?.progressPercentage || 0}%</strong>
                      </div>
                      <div className="student-progress-track">
                        <span style={{ width: `${Math.min(100, Math.max(0, progress?.progressPercentage || 0))}%` }} />
                      </div>
                      <span className="student-course-details__progress-sub">
                        {progress?.completedActivities || 0} of {progress?.totalRequiredActivities || 0} required activities completed
                      </span>
                    </div>

                    <Link
                      to={`/student/course/${encodeURIComponent(courseId)}/learn`}
                      className="student-button student-button--primary student-course-details__cta-btn"
                    >
                      <span>{(progress?.progressPercentage || 0) > 0 ? 'Continue Learning →' : 'Start Learning →'}</span>
                    </Link>

                    {/* Secondary Action: Unenroll */}
                    {canUnenroll && (
                      <button
                        type="button"
                        className="student-course-details__unenroll-btn"
                        onClick={() => setShowUnenrollModal(true)}
                      >
                        Unenroll from course
                      </button>
                    )}
                  </div>
                ) : (
                  /* STATE C: ENROLLED & COMPLETED */
                  <div className="student-course-details__state-box is-completed">
                    <div className="student-course-details__completed-badge">
                      <Icon name="award" size={18} />
                      <strong>Course Completed!</strong>
                    </div>
                    <p className="student-course-details__completed-copy">
                      You have met all curriculum requirements and earned your official credential.
                    </p>

                    <Link
                      to={`/student/course/${encodeURIComponent(courseId)}/learn`}
                      className="student-button student-button--primary student-course-details__cta-btn"
                    >
                      <span>Review Course →</span>
                    </Link>

                    <button
                      type="button"
                      className="student-button student-button--secondary student-course-details__cert-action-btn"
                      onClick={() => setShowCertificateModal(true)}
                    >
                      <Icon name="award" size={14} />
                      <span>View Certificate</span>
                    </button>
                    {/* Unenroll option is COMPLETELY HIDDEN in State C */}
                  </div>
                )}
              </div>
            </div>
          </section>

          {/* Certificate Section (Only when Completed) */}
          {isCompleted && certificate && (
            <section className="student-course-details__certificate-panel" aria-labelledby="certificate-section-title">
              <div className="student-course-details__certificate-header">
                <span className="student-course-details__certificate-icon">
                  <Icon name="award" size={24} />
                </span>
                <div>
                  <span className="student-eyebrow">OFFICIAL ACCREDITATION</span>
                  <h2 id="certificate-section-title">Certificate of Completion</h2>
                  <p>Verified credential for mastering all lessons and passing all required checkpoints.</p>
                </div>
              </div>

              <div className="student-cert-mini-card">
                <div className="student-cert-mini-card__left">
                  <div className="student-cert-mini-card__brand">aiHustle LMS</div>
                  <h3 className="student-cert-mini-card__title">{course.title}</h3>
                  <div className="student-cert-mini-card__meta">
                    <span>Awarded to: <strong>{certificate.studentName || user?.fullName || user?.username}</strong></span>
                    <span>Completed: <strong>{new Date(certificate.completionDate || data.enrollment?.completedAt || Date.now()).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</strong></span>
                    <span>Verification ID: <code>{certificate.certificateId}</code></span>
                  </div>
                </div>

                <div className="student-cert-mini-card__actions">
                  <button
                    type="button"
                    className="student-button student-button--primary"
                    onClick={() => setShowCertificateModal(true)}
                  >
                    <Icon name="award" size={15} />
                    <span>View Certificate</span>
                  </button>
                  <button
                    type="button"
                    className="student-button student-button--secondary"
                    onClick={() => {
                      setShowCertificateModal(true)
                      setTimeout(() => window.print(), 350)
                    }}
                  >
                    <Icon name="download" size={15} />
                    <span>Download Certificate</span>
                  </button>
                </div>
              </div>
            </section>
          )}

          {/* Course Details Grid: Description, Outcomes, Audience */}
          <div className="student-course-details__main-grid">
            <div className="student-course-details__content-col">
              {/* Detailed Description */}
              <section className="student-course-details__section">
                <h2>About this course</h2>
                <div className="student-course-details__rich-text">
                  <p>{course.detailedDescription || course.description}</p>
                </div>
              </section>

              {/* Learning Outcomes */}
              {course.learningObjectives?.length > 0 && (
                <section className="student-course-details__section">
                  <h2>What you’ll learn</h2>
                  <ul className="student-course-details__outcomes-list">
                    {course.learningObjectives.map((obj, i) => (
                      <li key={i} className="student-course-details__outcome-item">
                        <span className="student-course-details__outcome-check"><Icon name="check" size={14} /></span>
                        <span>{obj}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {/* Course Curriculum */}
              <section className="student-course-details__section" aria-labelledby="curriculum-heading">
                <div className="student-section-heading">
                  <div>
                    <h2 id="curriculum-heading">Course Curriculum</h2>
                    <span className="student-course-details__curriculum-summary">
                      {counts.modules} modules · {counts.lessons} lessons · {counts.quizzes} quizzes · {counts.assignments} assignments
                    </span>
                  </div>
                </div>

                <div className="student-course-details__curriculum-accordion">
                  {curriculum.length === 0 ? (
                    <EmptyState
                      icon="book"
                      title="Curriculum pending"
                      description="Lessons and learning activities are currently being prepared for this course."
                    />
                  ) : (
                    curriculum.map((mod, mIndex) => {
                      const isExpanded = expandedModules.has(String(mIndex))
                      return (
                        <div className="student-curriculum-module" key={mod.moduleId || mIndex}>
                          <button
                            type="button"
                            className="student-curriculum-module__header"
                            onClick={() => toggleModule(mIndex)}
                            aria-expanded={isExpanded}
                          >
                            <div className="student-curriculum-module__title-wrap">
                              <span className="student-curriculum-module__index">Module {mIndex + 1}</span>
                              <h3 className="student-curriculum-module__title">{mod.title}</h3>
                            </div>
                            <div className="student-curriculum-module__meta-wrap">
                              <span>{mod.itemCount} {mod.itemCount === 1 ? 'item' : 'items'}</span>
                              <span className="student-curriculum-module__toggle-icon">
                                <Icon name={isExpanded ? 'chevronUp' : 'chevronDown'} size={16} />
                              </span>
                            </div>
                          </button>

                          {isExpanded && (
                            <div className="student-curriculum-module__body">
                              {mod.description && (
                                <p className="student-curriculum-module__description">{mod.description}</p>
                              )}
                              <ul className="student-curriculum-module__items-list">
                                {mod.items.map((item, itemIndex) => {
                                  const isLesson = item.type === 'video-lesson'
                                  const isQuiz = item.type === 'quiz'

                                  return (
                                    <li className="student-curriculum-item" key={item.id || itemIndex}>
                                      <div className="student-curriculum-item__left">
                                        <span className={`student-curriculum-item__icon is-${item.type}`}>
                                          <Icon
                                            name={isLesson ? 'play' : isQuiz ? 'clipboardCheck' : 'check'}
                                            size={14}
                                          />
                                        </span>
                                        <div>
                                          <strong className="student-curriculum-item__title">{item.title}</strong>
                                          <div className="student-curriculum-item__details">
                                            <span className="student-curriculum-item__type-label">
                                              {isLesson ? 'Video Lesson' : isQuiz ? 'Quiz Checkpoint' : 'Milestone Assessment'}
                                            </span>
                                            {item.durationSeconds > 0 && (
                                              <span>· {formatCourseDuration(Math.round(item.durationSeconds / 60))}</span>
                                            )}
                                            {item.points > 0 && (
                                              <span>· {item.points} pts</span>
                                            )}
                                          </div>
                                        </div>
                                      </div>

                                      <div className="student-curriculum-item__right">
                                        {isEnrolled ? (
                                          item.isCompleted ? (
                                            <span className="student-activity-status-badge is-mint">
                                              {isQuiz ? 'Passed' : 'Completed'}
                                            </span>
                                          ) : item.isFailed ? (
                                            <span className="student-activity-status-badge is-peach">
                                              Failed
                                            </span>
                                          ) : item.isSubmitted ? (
                                            <span className="student-activity-status-badge is-teal">
                                              Submitted
                                            </span>
                                          ) : (
                                            <span className="student-activity-status-badge is-neutral">
                                              Pending
                                            </span>
                                          )
                                        ) : (
                                          <span className="student-curriculum-item__preview-tag">
                                            Preview
                                          </span>
                                        )}
                                      </div>
                                    </li>
                                  )
                                })}
                              </ul>
                            </div>
                          )}
                        </div>
                      )
                    })
                  )}
                </div>
              </section>
            </div>

            {/* Sidebar Column: Prerequisites & Audience */}
            <div className="student-course-details__sidebar-col">
              <div className="student-course-details__card">
                <h3>Prerequisites</h3>
                {course.prerequisites?.length > 0 ? (
                  <ul className="student-course-details__check-list">
                    {course.prerequisites.map((req, i) => (
                      <li key={i}>{req}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="student-course-details__muted-text">
                    No prior technical knowledge required. Suitable for beginners and self-paced learners.
                  </p>
                )}
              </div>

              <div className="student-course-details__card">
                <h3>Target Audience</h3>
                <p className="student-course-details__muted-text">
                  {course.targetAudience || 'Curious minds, students, and professionals aiming to build practical, in-demand skills.'}
                </p>
              </div>

              <div className="student-course-details__card">
                <h3>Skill Level &amp; Effort</h3>
                <div className="student-course-details__info-row">
                  <span>Level:</span>
                  <strong>{difficultyLabels[course.difficulty] || 'All Levels'}</strong>
                </div>
                <div className="student-course-details__info-row">
                  <span>Estimated Time:</span>
                  <strong>{formatCourseDuration(counts.durationMinutes)}</strong>
                </div>
                <div className="student-course-details__info-row">
                  <span>Language:</span>
                  <strong>English</strong>
                </div>
                <div className="student-course-details__info-row">
                  <span>Certificate:</span>
                  <strong>Official Verified Certificate</strong>
                </div>
              </div>
            </div>
          </div>

          {/* Certificate Modal */}
          {showCertificateModal && (
            <StudentCertificateModal
              certificate={certificate}
              onClose={() => setShowCertificateModal(false)}
            />
          )}

          {/* Unenroll Confirmation Modal */}
          {showUnenrollModal && (
            <StudentUnenrollConfirmModal
              courseTitle={course.title}
              onConfirm={handleUnenroll}
              onCancel={() => setShowUnenrollModal(false)}
              loading={unenrolling}
              error={unenrollError}
            />
          )}
        </>
      )}
    </div>
  )
}



function StudentCourseLearningPage({
  onLogout,
  onLearningDataChanged,
  onCourseTitleChange,
  contentSearch,
}) {
  const { courseId } = useParams()
  const [enrollment, setEnrollment] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const location = useLocation()
  const requestedLessonId = new URLSearchParams(location.search).get('lesson')

  useEffect(() => {
    onCourseTitleChange(enrollment?.courseId?.title || '')
  }, [enrollment?.courseId?.title, onCourseTitleChange])

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError('')
    fetchStudentCourseContent(courseId, onLogout, controller.signal)
      .then(({ enrollment: courseEnrollment, assignmentSubmissions, quizAttempts }) => {
        setEnrollment({
          ...courseEnrollment,
          assignmentSubmissions,
          quizAttempts,
        })
      })
      .catch((loadError) => {
        if (loadError.name !== 'AbortError') {
          setError(loadError instanceof Error ? loadError.message : 'Your course could not be loaded.')
        }
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [courseId, onLogout])

  return (
    <StudentRoutePage title={enrollment?.courseId?.title || 'Course learning'} className="student-course-learning-page">
      {error && <p className="student-courses__message is-error" role="alert">{error}</p>}
      {loading ? <p role="status">Loading your course…</p> : enrollment && (
        <StudentCourseLearning
          enrollment={enrollment}
          onEnrollmentUpdated={(updates) => setEnrollment((current) => current ? {
            ...current,
            ...updates,
            courseId: current.courseId,
          } : current)}
          onLearningDataChanged={onLearningDataChanged}
          onLogout={onLogout}
          requestedLessonId={requestedLessonId}
          contentSearch={contentSearch}
        />
      )}
    </StudentRoutePage>
  )
}

function StudentCourses({ user, onLogout }) {
  const [initialEnrollments] = useState(getCachedStudentPageEnrollments)
  const [enrollments, setEnrollments] = useState(initialEnrollments || [])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(initialEnrollments === null)
  const location = useLocation()
  const requestedFilter = new URLSearchParams(location.search).get('filter')
  const enrollmentFilter = ['enrolled', 'completed', 'active'].includes(requestedFilter) ? requestedFilter : ''

  useEffect(() => {
    let active = true
    fetchStudentPageEnrollments(onLogout)
      .then((loadedEnrollments) => { if (active) setEnrollments(loadedEnrollments) })
      .catch((loadError) => {
        if (active) {
          setError(loadError instanceof Error ? loadError.message : 'Unable to load your enrolled courses.')
        }
      })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [onLogout, user?.id])

  const filteredEnrollments = enrollmentFilter
    ? enrollments.filter((entry) => {
      const { percentage } = getCourseProgress(entry)
      const isComplete = entry.status === 'completed' || percentage >= 100
      if (enrollmentFilter === 'enrolled') return true
      if (enrollmentFilter === 'completed') return isComplete
      if (enrollmentFilter === 'active') return !isComplete
      return true
    })
    : enrollments
  const pageTitle = enrollmentFilter === 'completed'
    ? 'Completed Courses'
    : enrollmentFilter === 'active'
      ? 'Courses In Progress'
      : 'My Courses'

  return (
    <StudentRoutePage title={pageTitle} showHeading>
      {error && <p className="student-courses__message is-error" role="alert">{error}</p>}
      {loading ? <EnrollmentCourseSkeletons /> : (!error || initialEnrollments !== null) && (
        <EnrollmentCourseCards
          enrollments={filteredEnrollments}
          emptyTitle={enrollmentFilter === 'completed'
            ? 'No completed courses yet'
            : enrollmentFilter === 'active'
              ? 'No courses in progress'
              : 'No enrolled courses yet'}
          emptyDescription="Your courses and progress will appear here when an enrollment is available."
        />
      )}
    </StudentRoutePage>
  )
}



function formatActivityDueDate(dateStr, isOverdue) {
  if (!dateStr) return { text: 'No due date', isOverdue: false }
  try {
    const d = new Date(dateStr)
    if (Number.isNaN(d.getTime())) return { text: 'No due date', isOverdue: false }
    const formatted = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
    return {
      text: isOverdue ? `Overdue · Due ${formatted}` : `Due ${formatted}`,
      isOverdue,
    }
  } catch {
    return { text: 'No due date', isOverdue: false }
  }
}

function getActivityStatusDetails(activity) {
  const isQuiz = activity.type === 'quiz'
  if (isQuiz) {
    if (activity.status === 'completed') return { text: 'Completed', tone: 'mint' }
    if (activity.status === 'failed') return { text: 'Failed', tone: 'peach' }
    if (activity.status === 'in_progress') return { text: 'In Progress', tone: 'blue' }
    return { text: 'Pending', tone: 'neutral' }
  }
  if (activity.status === 'graded') return { text: 'Graded', tone: 'mint' }
  if (activity.status === 'submitted') return { text: 'Submitted', tone: 'teal' }
  if (activity.status === 'overdue' || activity.isOverdue) return { text: 'Overdue', tone: 'peach' }
  return { text: 'Pending', tone: 'neutral' }
}

function getActivityActionLabel(activity) {
  const isQuiz = activity.type === 'quiz'
  if (isQuiz) {
    if (activity.status === 'completed') return 'Review Quiz'
    if (activity.status === 'failed') return 'Retry Quiz'
    if (activity.status === 'in_progress') return 'Continue Quiz'
    return 'Start Quiz'
  }
  if (activity.status === 'graded') return 'View Submission'
  if (activity.status === 'submitted') return 'View Submission'
  if (activity.status === 'overdue' || activity.isOverdue) return 'Submit Assignment'
  return 'Submit Assignment'
}

function StudentQuizzesAndAssignments({ user, onLogout }) {
  const [data, setData] = useState({
    summary: { total: 0, completed: 0, remaining: 0, overdue: 0 },
    quizStats: { total: 0, completed: 0, remaining: 0, percentage: 0 },
    assignmentStats: { total: 0, completed: 0, remaining: 0, percentage: 0 },
    activities: [],
  })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [activeFilter, setActiveFilter] = useState('all')
  const [searchQuery, setSearchQuery] = useState('')
  const [refreshKey, setRefreshKey] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError('')
    fetchStudentActivities(onLogout, controller.signal)
      .then((res) => {
        if (!controller.signal.aborted) {
          setData({
            summary: res.summary || { total: 0, completed: 0, remaining: 0, overdue: 0 },
            quizStats: res.quizStats || { total: 0, completed: 0, remaining: 0, percentage: 0 },
            assignmentStats: res.assignmentStats || { total: 0, completed: 0, remaining: 0, percentage: 0 },
            activities: Array.isArray(res.activities) ? res.activities : [],
          })
        }
      })
      .catch((err) => {
        if (err.name !== 'AbortError') {
          setError(err instanceof Error ? err.message : 'Unable to load quizzes and assignments.')
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [onLogout, user?.id, refreshKey])

  const activities = data.activities || []

  const filteredActivities = useMemo(() => {
    return activities.filter((item) => {
      if (activeFilter === 'quizzes' && item.type !== 'quiz') return false
      if (activeFilter === 'assignments' && item.type !== 'assignment') return false
      if (activeFilter === 'completed') {
        const isComplete = item.type === 'quiz'
          ? item.status === 'completed'
          : (item.status === 'submitted' || item.status === 'graded')
        if (!isComplete) return false
      }
      if (activeFilter === 'remaining') {
        const isComplete = item.type === 'quiz'
          ? item.status === 'completed'
          : (item.status === 'submitted' || item.status === 'graded')
        if (isComplete) return false
      }
      if (activeFilter === 'overdue') {
        if (!item.isOverdue && item.status !== 'overdue') return false
      }

      if (searchQuery.trim()) {
        const q = searchQuery.trim().toLowerCase()
        const matchesTitle = item.title?.toLowerCase().includes(q)
        const matchesCourse = item.courseName?.toLowerCase().includes(q)
        const matchesModule = item.moduleTitle?.toLowerCase().includes(q)
        if (!matchesTitle && !matchesCourse && !matchesModule) return false
      }

      return true
    })
  }, [activities, activeFilter, searchQuery])

  const tabs = [
    { id: 'all', label: 'All Activities', count: data.summary.total },
    { id: 'quizzes', label: 'Quizzes', count: data.quizStats.total },
    { id: 'assignments', label: 'Assignments', count: data.assignmentStats.total },
    { id: 'completed', label: 'Completed', count: data.summary.completed },
    { id: 'remaining', label: 'Remaining', count: data.summary.remaining },
    { id: 'overdue', label: 'Overdue', count: data.summary.overdue },
  ]

  return (
    <section className="student-panel student-activities-page" aria-labelledby="student-activities-heading">
      <div className="student-section-heading student-activities-page__header">
        <div>
          <span className="student-eyebrow">CENTRALIZED ACTIVITY TRACKER</span>
          <h2 id="student-activities-heading">Quizzes &amp; Assignments</h2>
          <p className="student-activities-subtitle">
            Track quizzes, milestone assignments, submission statuses, and deadlines across all your enrolled courses.
          </p>
        </div>
        <button
          type="button"
          className="student-activities-refresh-btn"
          onClick={() => setRefreshKey((k) => k + 1)}
          disabled={loading}
          aria-label="Refresh activities"
        >
          <Icon name="spark" size={15} />
          <span>{loading ? 'Refreshing…' : 'Refresh'}</span>
        </button>
      </div>

      {error && (
        <div className="student-activities-error-banner" role="alert">
          <Icon name="alertCircle" size={18} />
          <div className="student-activities-error-banner__content">
            <strong>Unable to load activities</strong>
            <p>{error}</p>
          </div>
          <button
            type="button"
            className="student-activities-retry-btn"
            onClick={() => setRefreshKey((k) => k + 1)}
          >
            Retry
          </button>
        </div>
      )}

      {loading && !activities.length ? (
        <div className="student-activities-loading" role="status">
          <p>Loading your quizzes and assignments…</p>
        </div>
      ) : !error && (
        <>
          {/* Top 4 Summary Cards */}
          <div className="student-activities-summary-grid">
            <article className="student-activity-stat-card is-gold">
              <div className="student-activity-stat-card__header">
                <span className="student-activity-stat-card__icon is-gold"><Icon name="clipboardCheck" size={18} /></span>
                <span className="student-activity-stat-card__eyebrow">TOTAL ACTIVITIES</span>
              </div>
              <strong className="student-activity-stat-card__value">{data.summary.total}</strong>
              <span className="student-activity-stat-card__caption">Quizzes &amp; assignments assigned</span>
            </article>

            <article className="student-activity-stat-card is-mint">
              <div className="student-activity-stat-card__header">
                <span className="student-activity-stat-card__icon is-mint"><Icon name="award" size={18} /></span>
                <span className="student-activity-stat-card__eyebrow">COMPLETED</span>
              </div>
              <strong className="student-activity-stat-card__value">{data.summary.completed}</strong>
              <span className="student-activity-stat-card__caption">Passed quizzes &amp; submissions</span>
            </article>

            <article className="student-activity-stat-card is-blue">
              <div className="student-activity-stat-card__header">
                <span className="student-activity-stat-card__icon is-blue"><Icon name="clock" size={18} /></span>
                <span className="student-activity-stat-card__eyebrow">REMAINING</span>
              </div>
              <strong className="student-activity-stat-card__value">{data.summary.remaining}</strong>
              <span className="student-activity-stat-card__caption">Pending or in progress work</span>
            </article>

            <article className="student-activity-stat-card is-peach">
              <div className="student-activity-stat-card__header">
                <span className="student-activity-stat-card__icon is-peach"><Icon name="alertCircle" size={18} /></span>
                <span className="student-activity-stat-card__eyebrow">OVERDUE</span>
              </div>
              <strong className="student-activity-stat-card__value">{data.summary.overdue}</strong>
              <span className="student-activity-stat-card__caption">Past scheduled deadline</span>
            </article>
          </div>

          {/* Separate Activity Statistics */}
          <div className="student-activities-split">
            <article className="student-activities-section-card">
              <div className="student-activities-section-card__top">
                <div>
                  <span className="student-activity-type-pill is-quiz">QUIZZES</span>
                  <h3 className="student-activities-section-card__title">Knowledge Checkpoints</h3>
                </div>
                <span className="student-activities-section-card__badge">{data.quizStats.percentage}% Completed</span>
              </div>
              <div className="student-progress-track student-activities-section-card__progress">
                <span style={{ width: `${Math.min(100, Math.max(0, data.quizStats.percentage))}%` }} />
              </div>
              <div className="student-activities-stats-row">
                <div className="student-activities-stat-cell">
                  <span className="student-activities-stat-cell__label">Total Quizzes</span>
                  <strong className="student-activities-stat-cell__val">{data.quizStats.total}</strong>
                </div>
                <div className="student-activities-stat-cell">
                  <span className="student-activities-stat-cell__label">Passed</span>
                  <strong className="student-activities-stat-cell__val is-mint">{data.quizStats.completed}</strong>
                </div>
                <div className="student-activities-stat-cell">
                  <span className="student-activities-stat-cell__label">Remaining</span>
                  <strong className="student-activities-stat-cell__val">{data.quizStats.remaining}</strong>
                </div>
                <div className="student-activities-stat-cell">
                  <span className="student-activities-stat-cell__label">Pass Rate</span>
                  <strong className="student-activities-stat-cell__val">{data.quizStats.percentage}%</strong>
                </div>
              </div>
            </article>

            <article className="student-activities-section-card">
              <div className="student-activities-section-card__top">
                <div>
                  <span className="student-activity-type-pill is-assignment">ASSIGNMENTS</span>
                  <h3 className="student-activities-section-card__title">Practical Milestones</h3>
                </div>
                <span className="student-activities-section-card__badge">{data.assignmentStats.percentage}% Completed</span>
              </div>
              <div className="student-progress-track student-activities-section-card__progress">
                <span style={{ width: `${Math.min(100, Math.max(0, data.assignmentStats.percentage))}%` }} />
              </div>
              <div className="student-activities-stats-row">
                <div className="student-activities-stat-cell">
                  <span className="student-activities-stat-cell__label">Total Assignments</span>
                  <strong className="student-activities-stat-cell__val">{data.assignmentStats.total}</strong>
                </div>
                <div className="student-activities-stat-cell">
                  <span className="student-activities-stat-cell__label">Submitted / Graded</span>
                  <strong className="student-activities-stat-cell__val is-mint">{data.assignmentStats.completed}</strong>
                </div>
                <div className="student-activities-stat-cell">
                  <span className="student-activities-stat-cell__label">Remaining</span>
                  <strong className="student-activities-stat-cell__val">{data.assignmentStats.remaining}</strong>
                </div>
                <div className="student-activities-stat-cell">
                  <span className="student-activities-stat-cell__label">Submission Rate</span>
                  <strong className="student-activities-stat-cell__val">{data.assignmentStats.percentage}%</strong>
                </div>
              </div>
            </article>
          </div>

          {/* Filters & Search Toolbar */}
          <div className="student-activities-toolbar">
            <div className="student-activities-tabs" role="tablist" aria-label="Activity filter tabs">
              {tabs.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={activeFilter === tab.id}
                  className={`student-activities-tab ${activeFilter === tab.id ? 'is-active' : ''}`}
                  onClick={() => setActiveFilter(tab.id)}
                >
                  <span>{tab.label}</span>
                  <span className="student-activities-tab__badge">{tab.count}</span>
                </button>
              ))}
            </div>

            <div className="student-activities-search">
              <span className="student-activities-search__icon"><Icon name="search" size={16} /></span>
              <input
                type="search"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search by activity, course, or module..."
                aria-label="Search quizzes and assignments"
                className="student-activities-search__input"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery('')}
                  className="student-activities-search__clear"
                  aria-label="Clear search"
                >
                  <Icon name="xCircle" size={15} />
                </button>
              )}
            </div>
          </div>

          {/* Activity Cards List or Empty States */}
          {activities.length === 0 ? (
            <div className="student-activities-empty-box">
              <EmptyState
                icon="clipboardCheck"
                title="No quizzes or assignments yet"
                description="Your enrolled courses do not have quizzes or assignments assigned yet. As you advance through your lessons, activities will automatically appear here."
              />
              <div className="student-activities-empty-box__action">
                <Link to="/student/courses" className="student-button">
                  <span>Browse My Courses</span>
                  <Icon name="arrow" size={14} />
                </Link>
              </div>
            </div>
          ) : filteredActivities.length === 0 ? (
            <div className="student-activities-empty-box">
              <EmptyState
                icon="search"
                title="No matching activities found"
                description="No quizzes or assignments match your current filter or search criteria."
              />
              <div className="student-activities-empty-box__action">
                <button
                  type="button"
                  className="student-button student-button--subtle"
                  onClick={() => { setActiveFilter('all'); setSearchQuery('') }}
                >
                  <span>Reset filters</span>
                </button>
              </div>
            </div>
          ) : (
            <div className="student-activities-list">
              {filteredActivities.map((item) => {
                const isQuiz = item.type === 'quiz'
                const statusDetails = getActivityStatusDetails(item)
                const actionLabel = getActivityActionLabel(item)
                const dueInfo = formatActivityDueDate(item.dueDate, item.isOverdue || item.status === 'overdue')

                return (
                  <article
                    className={`student-activity-card is-${statusDetails.tone}`}
                    key={`${item.enrollmentId}:${item.id}`}
                  >
                    <div className="student-activity-card__main">
                      <div className="student-activity-card__header-line">
                        <span className={`student-activity-type-pill is-${item.type}`}>
                          {isQuiz ? 'Quiz' : 'Assignment'}
                        </span>
                        <Link
                          to={`/student/course/${encodeURIComponent(item.courseId)}`}
                          className="student-activity-card__course-tag"
                          title={`Go to ${item.courseName}`}
                        >
                          <Icon name="book" size={13} />
                          <span>{item.courseName}</span>
                        </Link>
                        {item.moduleTitle && (
                          <span className="student-activity-card__module-tag">
                            {item.moduleTitle}
                          </span>
                        )}
                        <span className={`student-activity-status-badge is-${statusDetails.tone}`}>
                          {statusDetails.text}
                        </span>
                      </div>

                      <h4 className="student-activity-card__title">{item.title}</h4>

                      {item.description && (
                        <p className="student-activity-card__desc">{item.description}</p>
                      )}

                      <div className="student-activity-card__meta-bar">
                        <span className={`student-activity-meta-item ${dueInfo.isOverdue ? 'is-overdue' : ''}`}>
                          <Icon name="clock" size={13} />
                          <span>{dueInfo.text}</span>
                        </span>

                        {item.score && (
                          <span className="student-activity-meta-item is-score">
                            <Icon name="award" size={13} />
                            <span>Score: {item.score}</span>
                          </span>
                        )}

                        {!item.score && (item.points || item.totalPoints) && (
                          <span className="student-activity-meta-item">
                            <Icon name="chart" size={13} />
                            <span>{item.points || item.totalPoints} pts</span>
                          </span>
                        )}

                        {isQuiz && (
                          <span className="student-activity-meta-item">
                            <span>Attempts: {item.attemptsCount || 0} / {item.maxAttempts || 3}</span>
                          </span>
                        )}

                        {isQuiz && item.passingPercentage && (
                          <span className="student-activity-meta-item">
                            <span>Pass requirement: {item.passingPercentage}%</span>
                          </span>
                        )}

                        {!isQuiz && item.latestSubmission?.submittedAt && (
                          <span className="student-activity-meta-item">
                            <span>Submitted {new Date(item.latestSubmission.submittedAt).toLocaleDateString()}</span>
                          </span>
                        )}
                      </div>
                    </div>

                    <div className="student-activity-card__action">
                      <Link
                        to={item.navigationUrl}
                        className={`student-activity-action-btn ${statusDetails.tone === 'mint' ? 'is-secondary' : 'is-primary'}`}
                      >
                        <span>{actionLabel}</span>
                        <Icon name="arrow" size={13} />
                      </Link>
                    </div>
                  </article>
                )
              })}
            </div>
          )}
        </>
      )}
    </section>
  )
}

function StudentAchievements({ user, onLogout }) {
  const [enrollments, setEnrollments] = useState([])
  const [certificatesByCourse, setCertificatesByCourse] = useState(new Map())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [actionCertificateId, setActionCertificateId] = useState('')
  const [actionType, setActionType] = useState('')
  const [preview, setPreview] = useState(null)
  const previewUrlRef = useRef('')

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError('')

    Promise.all([
      fetchMyEnrollments(onLogout, controller.signal),
      fetchStudentCertificates(onLogout, controller.signal).catch(() => []),
    ])
      .then(([enrollmentsData, certsData]) => {
        if (controller.signal.aborted) return
        setEnrollments(Array.isArray(enrollmentsData) ? enrollmentsData : [])
        const certMap = new Map()
        if (Array.isArray(certsData)) {
          for (const item of certsData) {
            if (item?.certificate && item?.courseId) {
              certMap.set(String(item.courseId), item.certificate)
            }
          }
        }
        setCertificatesByCourse(certMap)
      })
      .catch((loadError) => {
        if (!controller.signal.aborted && loadError.name !== 'AbortError') {
          setError(loadError instanceof Error ? loadError.message : 'Achievements could not be loaded.')
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })

    return () => controller.abort()
  }, [onLogout])

  useEffect(() => {
    return () => {
      if (previewUrlRef.current) {
        URL.revokeObjectURL(previewUrlRef.current)
        previewUrlRef.current = ''
      }
    }
  }, [])

  useEffect(() => {
    if (!preview) return
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') closePreview()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [preview])

  function closePreview() {
    setPreview(null)
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current)
      previewUrlRef.current = ''
    }
  }

  async function getStudentAuthToken() {
    let auth
    try {
      auth = JSON.parse(sessionStorage.getItem('lms.auth') || 'null')
    } catch {
      onLogout()
      throw new Error('Your saved student session is invalid. Please sign in again.')
    }
    if (typeof auth?.token !== 'string') {
      onLogout()
      throw new Error('Your session has ended. Please sign in again.')
    }
    return auth.token
  }

  async function handlePreviewCertificate(certificate, courseTitle) {
    const certKey = certificate?.id || certificate?._id || certificate?.certificateId
    if (!certKey) return
    setActionCertificateId(certKey)
    setActionType('preview')
    setError('')
    try {
      const token = await getStudentAuthToken()
      const response = await fetchWithAuth(
        `${API_BASE_URL}/certificates/${encodeURIComponent(certKey)}/pdf`,
        { headers: { Authorization: `Bearer ${token}` } },
        API_BASE_URL,
        token,
      )
      const result = response.ok ? null : await response.json().catch(() => ({}))
      if (isInvalidSessionResponse(response, result)) {
        onLogout()
        throw new Error('Your session has ended. Please sign in again.')
      }
      if (!response.ok) {
        throw new Error(result?.message || 'The certificate PDF could not be opened.')
      }

      const blob = await response.blob()
      const objectUrl = URL.createObjectURL(blob)
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current)
      previewUrlRef.current = objectUrl
      setPreview({
        ...certificate,
        id: certKey,
        courseName: certificate.courseName || courseTitle || 'Course Certificate',
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The certificate PDF could not be opened.')
    } finally {
      setActionCertificateId('')
      setActionType('')
    }
  }

  async function handleDownloadCertificate(certificate, courseTitle) {
    const certKey = certificate?.id || certificate?._id || certificate?.certificateId
    if (!certKey) return
    setActionCertificateId(certKey)
    setActionType('download')
    setError('')
    try {
      const token = await getStudentAuthToken()
      const response = await fetchWithAuth(
        `${API_BASE_URL}/certificates/${encodeURIComponent(certKey)}/pdf?download=true`,
        { headers: { Authorization: `Bearer ${token}` } },
        API_BASE_URL,
        token,
      )
      const result = response.ok ? null : await response.json().catch(() => ({}))
      if (isInvalidSessionResponse(response, result)) {
        onLogout()
        throw new Error('Your session has ended. Please sign in again.')
      }
      if (!response.ok) {
        throw new Error(result?.message || 'The certificate PDF could not be downloaded.')
      }

      const blob = await response.blob()
      const objectUrl = URL.createObjectURL(blob)
      const title = certificate.courseName || courseTitle || certificate.name || 'Course'
      const slug = title
        .replace(/[^a-zA-Z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
      const filename = slug ? `aiHustle-${slug}-Certificate.pdf` : `aiHustle-certificate-${certificate.certificateId || certKey}.pdf`

      const link = document.createElement('a')
      link.href = objectUrl
      link.download = filename
      document.body.append(link)
      link.click()
      link.remove()
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The certificate PDF could not be downloaded.')
    } finally {
      setActionCertificateId('')
      setActionType('')
    }
  }

  const completed = enrollments.filter((entry) => entry.status === 'completed')

  return (
    <StudentRoutePage eyebrow="YOUR ACHIEVEMENTS" title="My Achievements">
      {error && <p className="student-courses__message is-error" role="alert">{error}</p>}
      {loading ? (
        <p role="status">Loading your achievements…</p>
      ) : (
        completed.length ? (
          <div className="student-achievements-list">
            {completed.map((entry) => {
              const courseId = String(entry.courseId?._id || entry.courseId || '')
              const courseTitle = entry.courseId?.title || 'Completed course'
              const certificate = certificatesByCourse.get(courseId) || entry.certificate || null
              const certKey = certificate?.id || certificate?._id || certificate?.certificateId
              const isPreviewing = Boolean(certKey && actionCertificateId === certKey && actionType === 'preview')
              const isDownloading = Boolean(certKey && actionCertificateId === certKey && actionType === 'download')
              const isBusy = Boolean(certKey && actionCertificateId === certKey)
              const formattedDate = entry.completedAt || entry.updatedAt
                ? new Date(entry.completedAt || entry.updatedAt).toLocaleDateString()
                : 'Date unavailable'

              return (
                <article className="student-achievement-item" key={entry._id}>
                  <span className="student-stat__icon is-mint">
                    <Icon name="award" size={19} />
                  </span>
                  <div className="student-achievement-info">
                    <strong>{courseTitle}</strong>
                    <small>Course completion milestone</small>
                  </div>
                  <div className="student-achievement-actions">
                    {certificate ? (
                      <>
                        <button
                          type="button"
                          className="student-achievement-btn student-achievement-btn--preview student-achievement-btn--primary"
                          disabled={isBusy}
                          onClick={() => handlePreviewCertificate(certificate, courseTitle)}
                          title="Preview Certificate"
                        >
                          <Icon name="eye" size={13} />
                          <span>{isPreviewing ? 'Opening…' : 'Preview Certificate'}</span>
                        </button>
                        <button
                          type="button"
                          className="student-achievement-btn student-achievement-btn--download student-achievement-btn--secondary"
                          disabled={isBusy}
                          onClick={() => handleDownloadCertificate(certificate, courseTitle)}
                          title="Download Certificate"
                        >
                          <Icon name="download" size={13} />
                          <span>{isDownloading ? 'Downloading…' : 'Download Certificate'}</span>
                        </button>
                      </>
                    ) : (
                      <span className="student-achievement-unavailable">Certificate unavailable</span>
                    )}
                  </div>
                  <span className="student-achievement-date">{formattedDate}</span>
                </article>
              )
            })}
          </div>
        ) : (
          <EmptyState
            icon="award"
            title="No achievements yet"
            description="Completed course milestones and earned certificates will appear here as you finish your courses."
          />
        )
      )}

      {/* Preview Certificate Modal */}
      {preview && previewUrlRef.current && (
        <div
          className="student-certificate-preview"
          role="dialog"
          aria-modal="true"
          aria-label={`Certificate preview for ${preview.courseName}`}
          onClick={(e) => { if (e.target === e.currentTarget) closePreview() }}
        >
          <div className="student-certificate-preview__panel">
            <header>
              <div className="student-certificate-preview__title-group">
                <strong>{preview.courseName}</strong>
                {preview.certificateId && <small>Certificate ID: {preview.certificateId}</small>}
              </div>
              <div className="student-certificate-preview__header-actions">
                <button
                  type="button"
                  className="student-certificate-preview__download-btn"
                  disabled={actionCertificateId === (preview.id || preview.certificateId) && actionType === 'download'}
                  onClick={() => handleDownloadCertificate(preview, preview.courseName)}
                  title="Download Certificate PDF"
                >
                  <Icon name="download" size={14} />
                  <span>
                    {actionCertificateId === (preview.id || preview.certificateId) && actionType === 'download'
                      ? 'Downloading…'
                      : 'Download Certificate'}
                  </span>
                </button>
                <button
                  type="button"
                  className="student-certificate-preview__close-btn"
                  onClick={closePreview}
                  aria-label="Close certificate preview"
                >
                  ×
                </button>
              </div>
            </header>
            <iframe
              title={`Certificate for ${preview.courseName}`}
              src={`${previewUrlRef.current}#view=Fit`}
            />
          </div>
        </div>
      )}
    </StudentRoutePage>
  )
}



function StudentSearch({ onLogout, navigateTo }) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])
  const [status, setStatus] = useState('idle')
  const [error, setError] = useState('')
  const [isOpen, setIsOpen] = useState(false)

  useEffect(() => {
    const normalizedQuery = query.trim().toLowerCase()
    if (normalizedQuery.length < 2) {
      setResults([])
      setError('')
      setStatus('idle')
      return undefined
    }

    const controller = new AbortController()
    const timeoutId = window.setTimeout(async () => {
      setStatus('loading')
      setError('')
      try {
        const savedAuth = sessionStorage.getItem('lms.auth')
        const auth = savedAuth ? JSON.parse(savedAuth) : null
        if (typeof auth?.token !== 'string') {
          onLogout()
          throw new Error('Your session has ended. Please sign in again.')
        }
        const response = await fetch(`${API_BASE_URL}/enrollments/me`, {
          headers: { Authorization: `Bearer ${auth.token}` },
          signal: controller.signal,
        })
        const result = await response.json()
        if (isInvalidSessionResponse(response, result)) {
          onLogout()
          throw new Error('Your session has ended. Please sign in again.')
        }
        if (!response.ok) throw new Error(result.message || 'Search is temporarily unavailable.')
        if (!Array.isArray(result.enrollments)) throw new Error('The server returned invalid course search data.')

        const matches = []
        for (const enrollment of result.enrollments) {
          const course = enrollment.courseId
          if (!course || typeof course !== 'object') continue
          const courseText = `${course.title || ''} ${course.description || ''}`.toLowerCase()
          if (courseText.includes(normalizedQuery)) {
            matches.push({
              id: `course-${course._id}`,
              title: course.title,
              detail: 'Course',
              courseId: course._id,
            })
          }
          for (const { module, lesson, lessonKey } of getCourseLessons(course)) {
            const lessonText = `${lesson.title || ''} ${lesson.content || ''} ${module.title || ''}`.toLowerCase()
            if (lessonText.includes(normalizedQuery)) {
              matches.push({
                id: `lesson-${course._id}-${lessonKey}`,
                title: lesson.title,
                detail: `${course.title} · ${module.title}`,
                courseId: course._id,
                lessonId: lesson._id,
              })
            }
          }
        }
        if (!controller.signal.aborted) {
          setResults(matches.slice(0, 8))
          setStatus('ready')
        }
      } catch (searchError) {
        if (!controller.signal.aborted) {
          setError(searchError instanceof Error ? searchError.message : 'Search is temporarily unavailable.')
          setResults([])
          setStatus('error')
        }
      }
    }, 250)

    return () => {
      window.clearTimeout(timeoutId)
      controller.abort()
    }
  }, [query, onLogout])

  function selectResult(result) {
    setQuery('')
    setIsOpen(false)
    const path = `/student/course/${encodeURIComponent(result.courseId)}/learn`
    const params = new URLSearchParams()
    if (result.lessonId) params.set('lesson', result.lessonId)
    navigateTo(params.size ? `${path}?${params.toString()}` : path)
  }

  return (
    <div
      className="student-search-wrap"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setIsOpen(false)
      }}
    >
      <label className="student-search">
        <Icon name="search" size={18} />
        <input
          type="search"
          placeholder="Search courses and lessons..."
          aria-label="Search courses and lessons"
          aria-expanded={isOpen && query.trim().length >= 2}
          aria-controls="student-search-results"
          value={query}
          onFocus={() => setIsOpen(true)}
          onChange={(event) => {
            setQuery(event.currentTarget.value)
            setIsOpen(true)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setIsOpen(false)
            if (event.key === 'Enter' && results.length) {
              event.preventDefault()
              selectResult(results[0])
            }
          }}
        />
        <kbd>⌘ K</kbd>
      </label>
      {isOpen && query.trim().length >= 2 && (
        <div className="student-search-results" id="student-search-results" role="listbox" aria-label="Search results">
          {status === 'loading' && <p role="status">Searching your courses…</p>}
          {status === 'error' && <p className="is-error" role="alert">{error}</p>}
          {status === 'ready' && results.length === 0 && (
            <p>No matching enrolled courses or lessons were found.</p>
          )}
          {status === 'ready' && results.map((result) => (
            <button
              className="student-search-result"
              type="button"
              role="option"
              aria-selected="false"
              key={result.id}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => selectResult(result)}
            >
              <span><strong>{result.title}</strong><small>{result.detail}</small></span>
              <Icon name="arrow" size={16} />
            </button>
          ))}
        </div>
      )}
    </div>
  )
}



function StudentPurchases() {
  return (
    <StudentRoutePage eyebrow="YOUR ACCOUNT ACTIVITY" title="My Purchases">
      <EmptyState icon="book" title="No purchases yet" description="Purchase history, payment status, transaction details, and invoices are not currently available from the LMS." />
    </StudentRoutePage>
  )
}

function StudentUpdates() {
  return (
    <StudentRoutePage eyebrow="FROM YOUR LEARNING COMMUNITY" title="Updates">
      <EmptyState icon="bell" title="Updates aren’t available yet" description="The LMS does not currently provide an announcements or platform-updates feed for this account." />
    </StudentRoutePage>
  )
}

function StudentProfile({ user, onLogout }) {
  const [enrollments, setEnrollments] = useState([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    const controller = new AbortController()

    async function loadEnrollments() {
      try {
        const savedAuth = sessionStorage.getItem('lms.auth')
        const auth = savedAuth ? JSON.parse(savedAuth) : null
        if (typeof auth?.token !== 'string') {
          onLogout()
          return
        }
        const response = await fetch(`${API_BASE_URL}/enrollments/me`, {
          headers: { Authorization: `Bearer ${auth.token}` },
          signal: controller.signal,
        })
        const result = await response.json()
        if (isInvalidSessionResponse(response, result)) {
          onLogout()
          return
        }
        if (!response.ok) throw new Error(result.message || 'Learning overview could not be loaded.')
        if (!Array.isArray(result.enrollments)) {
          throw new Error('The server returned invalid enrollment data.')
        }
        setEnrollments(result.enrollments)
      } catch (loadError) {
        if (loadError.name !== 'AbortError') {
          setError(loadError instanceof Error ? loadError.message : 'Learning overview could not be loaded.')
        }
      } finally {
        if (!controller.signal.aborted) setIsLoading(false)
      }
    }

    loadEnrollments()
    return () => controller.abort()
  }, [onLogout])

  const accountType = user?.studentType === 'college'
    ? 'College Student'
    : user?.studentType === 'independent'
      ? 'Independent Student'
      : 'Not available'
  const completedCount = enrollments.filter((entry) => entry.status === 'completed').length
  const inProgressCount = enrollments.filter((entry) => entry.status === 'active').length
  const emailVerification = typeof user?.emailVerified === 'boolean'
    ? user.emailVerified ? 'Verified' : 'Not verified'
    : 'Not recorded by the platform'

  return (
    <div className="student-profile-layout">
      <div className="student-profile-overview">
      <StudentRoutePage title="Account Information" showHeading>
        <div className="student-profile-actions">
          <Link className="student-profile-settings-link" to="/student/settings">Manage account settings <Icon name="arrow" size={15} /></Link>
          <Link className="student-profile-settings-link" to="/student/help">Help Center <Icon name="arrow" size={15} /></Link>
        </div>
        <dl className="student-profile-details">
          <div><dt>Full name</dt><dd>{user?.fullName || 'Not available'}</dd></div>
          <div><dt>Username</dt><dd>{user?.username || 'Not available'}</dd></div>
          <div><dt>Email</dt><dd>{user?.email || 'Not available'}</dd></div>
          <div><dt>Email verification</dt><dd>{emailVerification}</dd></div>
          <div><dt>Account type</dt><dd>{accountType}</dd></div>
        </dl>
      </StudentRoutePage>

      <StudentRoutePage title="Learning Overview" showHeading>
        {error && <p className="student-courses__message is-error" role="alert">{error}</p>}
        {isLoading ? (
          <p role="status">Loading your learning overview…</p>
        ) : !error ? (
          <>
            <section className="student-stats" aria-label="Learning overview statistics">
              {[
                ['Enrolled Courses', enrollments.length, 'book', 'peach', 'Open your enrolled courses', '/student/courses?filter=enrolled'],
                ['Completed Courses', completedCount, 'award', 'mint', 'View completed courses', '/student/courses?filter=completed'],
                ['In Progress', inProgressCount, 'chart', 'gold', 'View courses in progress', '/student/courses?filter=active'],
                ['Learning Streak', 0, 'spark', 'blue', 'View learning activity details', '/student/learning-activity'],
              ].map(([label, count, icon, tone, note, to]) => (
                <Link className={`student-stat is-${tone} student-profile-stat-link`} key={label} to={to}>
                  <span className={`student-stat__icon is-${tone}`}><Icon name={icon} size={19} /></span>
                  <span className="student-stat__label">{label}</span>
                  <strong className="student-stat__value">{count}{label === 'Learning Streak' ? ' days' : ''}</strong>
                  <small>{note}</small>
                </Link>
              ))}
            </section>
          </>
        ) : null}
      </StudentRoutePage>
      </div>

      <div className="student-profile-sections">
        <StudentRoutePage title="My Purchases" to="/student/purchases" showHeading>
          <EmptyState icon="book" title="Purchase history unavailable" description="The LMS does not currently provide purchase records, payment status, or invoices." />
        </StudentRoutePage>
        <StudentRoutePage title="Updates" to="/student/updates" showHeading>
          <EmptyState icon="bell" title="Open your updates" description="View platform announcements and course updates when they are available." />
        </StudentRoutePage>
        <StudentRoutePage title="My Achievements" to="/student/achievements" showHeading>
          <EmptyState icon="award" title="View your achievements" description="Completed-course milestones and earned achievements appear here." />
        </StudentRoutePage>
      </div>
    </div>
  )
}

function LearningActivitySection({
  overview,
  todaySummary,
  weeklyData,
  weekOffset,
  onWeekChange,
  onGoalChange,
  loading,
  error,
}) {
  const [selectedGoal, setSelectedGoal] = useState(60)
  const [savingGoal, setSavingGoal] = useState(false)
  const [goalFeedback, setGoalFeedback] = useState('')

  useEffect(() => {
    if (todaySummary?.dailyLearningGoalMinutes) {
      setSelectedGoal(todaySummary.dailyLearningGoalMinutes)
    } else if (overview?.dailyLearningGoalMinutes) {
      setSelectedGoal(overview.dailyLearningGoalMinutes)
    }
  }, [todaySummary?.dailyLearningGoalMinutes, overview?.dailyLearningGoalMinutes])

  const handleGoalSelect = async (newGoal) => {
    setSelectedGoal(newGoal)
    setSavingGoal(true)
    setGoalFeedback('')
    try {
      if (onGoalChange) {
        await onGoalChange(newGoal)
        setGoalFeedback(`Goal updated to ${newGoal} min/day`)
        setTimeout(() => setGoalFeedback(''), 3000)
      }
    } catch (err) {
      setGoalFeedback(err instanceof Error ? err.message : 'Failed to update goal')
    } finally {
      setSavingGoal(false)
    }
  }

  if (loading && !overview && !todaySummary) {
    return (
      <section className="student-learning-section" aria-busy="true">
        <div className="student-section-heading">
          <div>
            <span className="student-eyebrow"><span /> YOUR LEARNING ACTIVITY</span>
            <h2>Your Learning Activity</h2>
            <p className="student-section-subtitle">Loading your real-time learning metrics…</p>
          </div>
        </div>
        <div className="student-learning-skeleton">
          <div className="student-skeleton-card" />
          <div className="student-skeleton-card" />
        </div>
      </section>
    )
  }

  const safeToday = todaySummary || {
    totalDurationSeconds: 0,
    totalMinutes: 0,
    lessonsCompleted: 0,
    videosWatched: 0,
    dailyLearningGoalMinutes: selectedGoal,
    goalProgressPercentage: 0,
    today: '',
  }

  const safeWeekly = weeklyData || {
    days: [],
    totalWeeklyMinutes: 0,
    averageDailyMinutes: 0,
    mostActiveDay: null,
    mostActiveDayMinutes: 0,
  }

  const safeOverview = overview || {
    totalHours: 0,
    totalMinutes: 0,
    totalCompletedLessons: 0,
    totalEnrolledCourses: 0,
    totalCompletedCourses: 0,
    pendingLessonsCount: 0,
    overallProgressPercentage: 0,
    currentStreak: 0,
    longestStreak: 0,
    courses: [],
  }

  const maxWeeklyMinutes = Math.max(
    selectedGoal,
    ...(safeWeekly.days?.map((d) => d.durationMinutes || 0) || [0]),
    30,
  )

  return (
    <section className="student-learning-section" aria-labelledby="learning-activity-heading">
      <div className="student-section-heading">
        <div>
          <span className="student-eyebrow"><span /> YOUR LEARNING ACTIVITY</span>
          <h2 id="learning-activity-heading">Your Learning Activity</h2>
          <p className="student-section-subtitle">Track your daily learning habits and weekly progress.</p>
        </div>
      </div>

      {error && <p className="student-courses__message is-error" role="alert">{error}</p>}
      {goalFeedback && <p className="student-courses__message" role="status">{goalFeedback}</p>}

      {/* Top 2-Column Grid: Daily Summary + Weekly Activity Chart */}
      <div className="student-learning-grid">
        {/* Card 1: Daily Learning Summary */}
        <article className="student-panel student-learning-card student-daily-summary-card">
          <div className="student-learning-card__header">
            <div>
              <span className="student-learning-card__tag">TODAY’S HABIT</span>
              <h3>Daily Learning Summary</h3>
            </div>
            <div className="student-goal-selector">
              <label htmlFor="daily-learning-goal-select">Goal:</label>
              <select
                id="daily-learning-goal-select"
                value={selectedGoal}
                onChange={(e) => handleGoalSelect(Number(e.target.value))}
                disabled={savingGoal}
              >
                <option value={15}>15 mins</option>
                <option value={30}>30 mins</option>
                <option value={45}>45 mins</option>
                <option value={60}>60 mins</option>
                <option value={90}>90 mins</option>
                <option value={120}>120 mins</option>
              </select>
            </div>
          </div>

          <div className="student-daily-stats-row">
            <div className="student-daily-stat-primary">
              <strong className="student-daily-stat__number">
                {formatDuration(safeToday.totalDurationSeconds)}
              </strong>
              <span className="student-daily-stat__label">Total learning time today</span>
            </div>

            {/* Circular Goal Gauge */}
            <div className="student-daily-goal-gauge">
              <svg className="student-gauge-svg" viewBox="0 0 100 100">
                <circle className="student-gauge-bg" cx="50" cy="50" r="40" />
                <circle
                  className="student-gauge-fill"
                  cx="50"
                  cy="50"
                  r="40"
                  strokeDasharray={251.2}
                  strokeDashoffset={251.2 - (251.2 * Math.min(100, safeToday.goalProgressPercentage)) / 100}
                />
              </svg>
              <div className="student-gauge-center">
                <strong>{safeToday.goalProgressPercentage}%</strong>
                <span>GOAL</span>
              </div>
            </div>
          </div>

          {/* Goal Progress Bar */}
          <div className="student-goal-progress-bar-wrap">
            <div className="student-goal-progress-info">
              <span>{safeToday.totalMinutes} of {selectedGoal} min daily goal</span>
              <span className="student-goal-badge">
                {safeToday.goalProgressPercentage >= 100
                  ? '🎉 Daily Goal Achieved!'
                  : `${Math.max(0, selectedGoal - safeToday.totalMinutes)} min to go`}
              </span>
            </div>
            <div className="student-progress-bar-track">
              <div
                className="student-progress-bar-fill"
                style={{ width: `${Math.min(100, safeToday.goalProgressPercentage)}%` }}
              />
            </div>
          </div>

          {/* Today sub-metrics */}
          <div className="student-daily-mini-grid">
            <div className="student-daily-mini-item">
              <div className="student-daily-mini-icon is-mint">
                <Icon name="check" size={16} />
              </div>
              <div>
                <strong>{safeToday.lessonsCompleted}</strong>
                <span>Lessons completed today</span>
              </div>
            </div>
            <div className="student-daily-mini-item">
              <div className="student-daily-mini-icon is-blue">
                <Icon name="play" size={14} />
              </div>
              <div>
                <strong>{safeToday.videosWatched}</strong>
                <span>Videos watched today</span>
              </div>
            </div>
          </div>
        </article>

        {/* Card 2: Weekly Learning Activity Chart */}
        <article className="student-panel student-learning-card student-weekly-chart-card">
          <div className="student-learning-card__header">
            <div>
              <span className="student-learning-card__tag">7-DAY ACTIVITY</span>
              <h3>Weekly Learning Activity</h3>
            </div>
            <div className="student-week-toggle" role="tablist" aria-label="Select week">
              <button
                type="button"
                className={`student-week-btn ${weekOffset === 0 ? 'is-active' : ''}`}
                onClick={() => onWeekChange(0)}
              >
                This Week
              </button>
              <button
                type="button"
                className={`student-week-btn ${weekOffset === -1 ? 'is-active' : ''}`}
                onClick={() => onWeekChange(-1)}
              >
                Previous Week
              </button>
            </div>
          </div>

          {/* 7-day Bar Chart */}
          <div className="student-bar-chart-container">
            <div className="student-bar-chart">
              {safeWeekly.days?.map((day) => {
                const isToday = day.date === safeToday.today
                const heightPercent = maxWeeklyMinutes > 0
                  ? Math.max(day.durationMinutes > 0 ? 10 : 3, Math.round((day.durationMinutes / maxWeeklyMinutes) * 100))
                  : 3
                return (
                  <div
                    key={day.date}
                    className={`student-chart-col ${isToday ? 'is-today' : ''}`}
                    tabIndex={0}
                    aria-label={`${day.label}: ${formatDuration(day.durationSeconds)}, ${day.lessonsCompleted} lessons`}
                  >
                    <div className="student-chart-tooltip" role="tooltip">
                      <strong>{day.label} {isToday ? '(Today)' : ''}</strong>
                      <span>{formatDuration(day.durationSeconds)}</span>
                      <span>{day.lessonsCompleted} lesson{day.lessonsCompleted === 1 ? '' : 's'} completed</span>
                    </div>
                    <div className="student-chart-bar-wrap">
                      <div
                        className="student-chart-bar-fill"
                        style={{ height: `${heightPercent}%` }}
                      />
                    </div>
                    <span className="student-chart-col__label">{day.dayName}</span>
                  </div>
                )
              })}
            </div>
          </div>

          {/* Weekly Summary Metrics Pills */}
          <div className="student-weekly-pills">
            <div className="student-weekly-pill">
              <span>Total this week</span>
              <strong>{formatMinutes(safeWeekly.totalWeeklyMinutes)}</strong>
            </div>
            <div className="student-weekly-pill">
              <span>Daily average</span>
              <strong>{formatMinutes(safeWeekly.averageDailyMinutes)} / day</strong>
            </div>
            <div className="student-weekly-pill">
              <span>Most active day</span>
              <strong>
                {safeWeekly.mostActiveDay
                  ? `${safeWeekly.mostActiveDay} (${formatMinutes(safeWeekly.mostActiveDayMinutes)})`
                  : '—'}
              </strong>
            </div>
          </div>
        </article>
      </div>

      {/* Card 3: Overall Learning Progress */}
      <article className="student-panel student-learning-card student-overall-progress-card">
        <div className="student-learning-card__header">
          <div>
            <span className="student-learning-card__tag">ALL-TIME METRICS</span>
            <h3>Overall Learning Progress</h3>
          </div>
          <div className="student-streak-badge">
            <span className="student-streak-fire"><Icon name="flame" size={20} /></span>
            <div>
              <strong>{safeOverview.currentStreak} Day{safeOverview.currentStreak === 1 ? '' : 's'} Streak</strong>
              <small>Personal best: {safeOverview.longestStreak} days</small>
            </div>
          </div>
        </div>

        {/* 4 Stat Tiles */}
        <div className="student-overall-tiles">
          <div className="student-overall-tile">
            <span className="student-overall-tile__icon is-gold"><Icon name="clock" size={18} /></span>
            <span className="student-overall-tile__label">Learning Hours</span>
            <strong>{safeOverview.totalHours} hrs</strong>
            <small>{safeOverview.totalMinutes} total minutes</small>
          </div>
          <div className="student-overall-tile">
            <span className="student-overall-tile__icon is-mint"><Icon name="check" size={18} /></span>
            <span className="student-overall-tile__label">Completed Lessons</span>
            <strong>{safeOverview.totalCompletedLessons}</strong>
            <small>Across all enrolled courses</small>
          </div>
          <div className="student-overall-tile">
            <span className="student-overall-tile__icon is-blue"><Icon name="book" size={18} /></span>
            <span className="student-overall-tile__label">Enrolled Courses</span>
            <strong>{safeOverview.totalEnrolledCourses}</strong>
            <small>{safeOverview.totalCompletedCourses} courses completed</small>
          </div>
          <div className="student-overall-tile">
            <span className="student-overall-tile__icon is-peach"><Icon name="chart" size={18} /></span>
            <span className="student-overall-tile__label">Overall Completion</span>
            <strong>{safeOverview.overallProgressPercentage}%</strong>
            <small>Curriculum mastery</small>
          </div>
        </div>

        {/* Course-wise Progress Section */}
        <div className="student-course-progress-list">
          <h4>Course-Wise Progress</h4>
          {safeOverview.courses && safeOverview.courses.length > 0 ? (
            <div className="student-course-progress-cards">
              {safeOverview.courses.map((course) => (
                <div className="student-course-progress-item" key={course.courseId}>
                  <div className="student-course-progress-info">
                    <div className="student-course-progress-title-row">
                      <h5>{course.title}</h5>
                      <span className={`student-course-status-pill is-${course.status}`}>
                        {course.status === 'completed'
                          ? 'Completed'
                          : course.status === 'in_progress'
                            ? 'In Progress'
                            : 'Not Started'}
                      </span>
                    </div>
                    <p className="student-course-progress-meta">
                      {course.completedLessons} of {course.totalLessons} lessons completed ({course.progressPercentage}%)
                    </p>
                    <div className="student-progress-bar-track">
                      <div
                        className="student-progress-bar-fill"
                        style={{ width: `${course.progressPercentage}%` }}
                      />
                    </div>
                  </div>
                  <div className="student-course-progress-action">
                    <Link
                      to={
                        course.nextLessonId
                          ? `/student/courses?course=${course.courseId}&lesson=${course.nextLessonId}`
                          : `/student/courses?course=${course.courseId}`
                      }
                      className="student-button student-button--primary student-button--sm"
                    >
                      {course.status === 'completed' ? 'Review Course' : 'Continue Learning →'}
                    </Link>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="student-empty-learning-journey">
              <div className="student-empty-journey-icon">
                <Icon name="rocket" size={32} />
              </div>
              <h5>Your learning journey starts here!</h5>
              <p>Enroll in a course to track your daily progress, build learning streaks, and master new skills.</p>
              <Link to="/student/courses" className="student-button student-button--primary">
                Explore Courses
              </Link>
            </div>
          )}
        </div>
      </article>
    </section>
  )
}

function StudentLearningActivity({ onLogout }) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [overview, setOverview] = useState(null)
  const [todaySummary, setTodaySummary] = useState(null)
  const [weeklyData, setWeeklyData] = useState(null)
  const [weekOffset, setWeekOffset] = useState(0)

  const loadData = useCallback(async (offset = weekOffset) => {
    setLoading(true)
    setError('')
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
    try {
      const [ovRes, tdRes, wkRes] = await Promise.all([
        learningRequest(`/learning/overview?timezone=${encodeURIComponent(tz)}`, { onLogout }),
        learningRequest(`/learning/summary/today?timezone=${encodeURIComponent(tz)}`, { onLogout }),
        learningRequest(`/learning/activity/weekly?weekOffset=${offset}&timezone=${encodeURIComponent(tz)}`, { onLogout }),
      ])
      setOverview(ovRes)
      setTodaySummary(tdRes)
      setWeeklyData(wkRes)
    } catch (loadError) {
      if (loadError.message !== 'Your session has ended. Please sign in again.') {
        setError(loadError instanceof Error ? loadError.message : 'Learning activity could not be loaded.')
      }
    } finally {
      setLoading(false)
    }
  }, [onLogout, weekOffset])

  useEffect(() => {
    loadData(weekOffset)
  }, [weekOffset, loadData])

  const handleGoalChange = async (minutes) => {
    const res = await learningRequest('/learning/goal', {
      onLogout,
      method: 'PUT',
      body: { dailyLearningGoalMinutes: minutes },
    })
    if (res?.dailyLearningGoalMinutes) {
      setTodaySummary((prev) => prev ? {
        ...prev,
        dailyLearningGoalMinutes: res.dailyLearningGoalMinutes,
        goalProgressPercentage: Math.min(100, Math.round((prev.totalMinutes / res.dailyLearningGoalMinutes) * 100)),
      } : prev)
      setOverview((prev) => prev ? {
        ...prev,
        dailyLearningGoalMinutes: res.dailyLearningGoalMinutes,
      } : prev)
    }
  }

  return (
    <StudentRoutePage eyebrow="YOUR LEARNING ACTIVITY" title="Learning Streak">
      <LearningActivitySection
        overview={overview}
        todaySummary={todaySummary}
        weeklyData={weeklyData}
        weekOffset={weekOffset}
        onWeekChange={setWeekOffset}
        onGoalChange={handleGoalChange}
        loading={loading}
        error={error}
      />
    </StudentRoutePage>
  )
}





function StudentDashboard({
  user,
  loading = false,
  error = '',
  onRetry,
  onLogout,
  isDark = false,
  onToggleTheme,
  themePreference = 'light',
  onSetTheme,
  onAccountUpdated,
}) {
  const [sidebarOpen, setSidebarOpen] = useState(false)

  const handleToggleTheme = () => {
    if (typeof onToggleTheme === 'function') {
      onToggleTheme()
    } else if (typeof onSetTheme === 'function') {
      onSetTheme(isDark ? 'light' : 'dark')
    } else {
      const nextTheme = isDark ? 'light' : 'dark'
      document.documentElement.dataset.theme = nextTheme
      try {
        localStorage.setItem('lms.theme', nextTheme)
      } catch (_) {}
    }
  }
  const [selectedCategory, setSelectedCategory] = useState('')
  const [profileMenuOpen, setProfileMenuOpen] = useState(false)
  const profileMenuRef = useRef(null)
  const [publishedCourseCategories, setPublishedCourseCategories] = useState([])
  const [selectedCourseCategory, setSelectedCourseCategory] = useState('')
  const [courseLearningTitle, setCourseLearningTitle] = useState('')
  const [courseContentSearch, setCourseContentSearch] = useState('')
  const [courseBookmarked, setCourseBookmarked] = useState(false)
  const [learningSummary, setLearningSummary] = useState(emptyLearningSummary)
  const [learningSummaryLoading, setLearningSummaryLoading] = useState(true)
  const [learningSummaryError, setLearningSummaryError] = useState('')
  const [dashboardRefreshKey, setDashboardRefreshKey] = useState(0)

  const [learningOverview, setLearningOverview] = useState(null)
  const [todaySummary, setTodaySummary] = useState(null)
  const [weeklyData, setWeeklyData] = useState(null)
  const [weekOffset, setWeekOffset] = useState(0)
  const [learningLoading, setLearningLoading] = useState(true)
  const [learningError, setLearningError] = useState('')

  const location = useLocation()
  const navigate = useNavigate()
  const navigateTo = navigate
  const isCourseLearning = /^\/student\/course\/[^/]+\/learn$/.test(location.pathname) || (location.pathname.startsWith('/student/course/') && location.pathname.endsWith('/learn'))
  const isCourseLearningPage = isCourseLearning
  const isResultsPage = location.pathname.startsWith('/student/results')
  const isHelpPage = location.pathname.startsWith('/student/help')
  const visibleNavigation = user?.studentType === 'independent'
    ? navigation
    : navigation.filter((item) => item.path !== '/student/referrals')
  const currentPage = visibleNavigation.find((item) => item.path === location.pathname)
  const secondaryPage = secondaryPages[location.pathname]
  const pageTitle = isCourseLearning
    ? (courseLearningTitle || 'Course learning')
    : currentPage?.label || (isHelpPage ? 'Help Center' : secondaryPage?.label || 'Dashboard')
  const pageIcon = isCourseLearning
    ? 'book'
    : currentPage
      ? {
        Dashboard: 'layoutDashboard',
        'My Courses': 'bookOpen',
        Assignments: 'clipboardCheck',
        'Grades & Results': 'chartNoAxesCombined',
        'Learning Resources': 'folderOpen',
        Messages: 'messageCircle',
        Certificates: 'award',
        'My Referrals': 'users',
        'My Profile': 'userRound',
        Settings: 'settings',
        'Help Center': 'circleHelp',
      }[currentPage.label] || 'grid'
      : isHelpPage ? 'circleHelp' : secondaryPage?.icon || 'layoutDashboard'
  const firstName = user?.fullName?.trim().split(/\s+/)[0] || 'Student'
  const initials = user?.fullName
    ? user.fullName.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase()
    : 'S'
  const completionPercentage = learningSummary.completionPercentage || 0
  const exploreCategories = [
    ...categories,
    ...publishedCourseCategories
      .filter((name) => !categories.some((category) => (
        normalizeCourseCategory(category.label) === normalizeCourseCategory(name)
      )))
      .map((label) => ({ label, icon: 'book' })),
  ]

  useEffect(() => {
    if (!profileMenuOpen) return undefined

    const closeOnOutsideClick = (event) => {
      if (!profileMenuRef.current?.contains(event.target)) setProfileMenuOpen(false)
    }
    const closeOnEscape = (event) => {
      if (event.key === 'Escape') setProfileMenuOpen(false)
    }

    document.addEventListener('pointerdown', closeOnOutsideClick)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsideClick)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [profileMenuOpen])

  useEffect(() => {
    setProfileMenuOpen(false)
  }, [location.pathname])

  const refreshLearningSummary = useCallback(() => {
    if (typeof invalidateStudentLearningPageCaches === 'function') {
      try { invalidateStudentLearningPageCaches() } catch (_) {}
    }
    setLearningSummaryLoading(true)
    fetchStudentLearningSummary(onLogout)
      .then((summary) => {
        setLearningSummary(summary)
        setLearningSummaryError('')
      })
      .catch((summaryError) => {
        setLearningSummary(emptyLearningSummary)
        setLearningSummaryError(summaryError instanceof Error ? summaryError.message : 'Learning statistics could not be loaded.')
      })
      .finally(() => {
        setLearningSummaryLoading(false)
      })
    setDashboardRefreshKey((current) => current + 1)
  }, [onLogout])

  const loadLearningMetrics = useCallback(async (offset = weekOffset) => {
    setLearningLoading(true)
    setLearningError('')
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
    try {
      const [ovRes, tdRes, wkRes] = await Promise.all([
        learningRequest(`/learning/overview?timezone=${encodeURIComponent(tz)}`, { onLogout }),
        learningRequest(`/learning/summary/today?timezone=${encodeURIComponent(tz)}`, { onLogout }),
        learningRequest(`/learning/activity/weekly?weekOffset=${offset}&timezone=${encodeURIComponent(tz)}`, { onLogout }),
      ])
      setLearningOverview(ovRes)
      setTodaySummary(tdRes)
      setWeeklyData(wkRes)
    } catch (err) {
      if (err?.message !== 'Your session has ended. Please sign in again.') {
        setLearningError(err instanceof Error ? err.message : 'Learning activity could not be loaded.')
      }
    } finally {
      setLearningLoading(false)
    }
  }, [onLogout, weekOffset])

  const handleGoalChange = useCallback(async (minutes) => {
    try {
      const res = await learningRequest('/learning/goal', {
        onLogout,
        method: 'PUT',
        body: { dailyLearningGoalMinutes: minutes },
      })
      if (res?.dailyLearningGoalMinutes) {
        setTodaySummary((prev) => (prev ? { ...prev, dailyLearningGoalMinutes: res.dailyLearningGoalMinutes } : prev))
        setLearningOverview((prev) => (prev ? { ...prev, dailyLearningGoalMinutes: res.dailyLearningGoalMinutes } : prev))
      }
    } catch {
      // preserve
    }
  }, [onLogout])

  useEffect(() => {
    refreshLearningSummary()
  }, [refreshLearningSummary])

  useEffect(() => {
    loadLearningMetrics(weekOffset)
  }, [loadLearningMetrics, weekOffset, dashboardRefreshKey])

  useEffect(() => {
    setSidebarOpen(false)
    window.scrollTo(0, 0)
    document.querySelector('.student-main')?.scrollTo(0, 0)
  }, [location.pathname])

  useEffect(() => {
    if (!isCourseLearning) {
      setCourseLearningTitle('')
      setCourseContentSearch('')
      setCourseBookmarked(false)
    }
  }, [isCourseLearning])

  useEffect(() => {
    if (!sidebarOpen) return undefined
    function closeOnEscape(event) {
      if (event.key === 'Escape') setSidebarOpen(false)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [sidebarOpen])

  return (
    <div
      className={`student-dashboard${isDark ? ' is-dark' : ''}${sidebarOpen ? ' is-sidebar-open' : ''}${isCourseLearning ? ' is-course-learning' : ''}${isResultsPage ? ' is-results-page' : ''}`}
      data-theme={isDark ? 'dark' : 'light'}
    >
      <aside
        id="student-navigation"
        className={`student-sidebar${sidebarOpen ? ' is-open' : ''}`}
        aria-label="Student primary navigation"
      >
        <div className="student-sidebar__brand">
          <div className="student-brand-mark">
            <span className="student-brand-dot" />
            aiHustle
          </div>
          <span className="student-brand-tag">Student</span>
        </div>

        <nav className="student-sidebar__nav student-nav" aria-label="Student navigation links">
          {visibleNavigation.map((item) => {
            const active = item.path === location.pathname
              || (item.path === '/student/courses' && location.pathname.startsWith('/student/course/'))
              || (item.path === '/student/help' && location.pathname.startsWith('/student/help'))
            return (
              <Link
                key={item.path}
                className={`student-sidebar__link student-nav__item${active ? ' is-active' : ''}`}
                to={item.path}
                onClick={() => setSidebarOpen(false)}
              >
                <span className="student-nav__icon"><Icon name={item.icon} size={18} /></span>
                <span>{item.label}</span>
                {item.label === 'Messages' && <span className="student-sidebar__soon">Soon</span>}
              </Link>
            )
          })}
        </nav>

        <div className="student-sidebar__bottom student-sidebar__footer">
          <div className="student-sidebar__profile student-user-card">
            <span className="student-avatar student-user-avatar">{initials}</span>
            <div className="student-sidebar__identity student-user-meta">
              <strong>{user?.fullName || 'Student'}</strong>
              <small>{user?.studentType === 'college' ? (user?.collegeName || 'College Student') : 'Independent'}</small>
            </div>
          </div>
          <button className="student-sidebar__logout" type="button" onClick={onLogout}>
            <Icon name="logout" size={17} />
            <span>Sign Out</span>
          </button>
        </div>
      </aside>

      <div className={`student-backdrop${sidebarOpen ? ' is-open' : ''}`} onClick={() => setSidebarOpen(false)} />

      <main className="student-main" id="student-overview">
        <header className="student-topbar">
          <div className="student-topbar__left">
            {(!isCourseLearning || sidebarOpen) && (
              <button
                className="student-icon-button student-menu-toggle"
                type="button"
                aria-label={sidebarOpen ? 'Close navigation' : 'Open navigation'}
                aria-expanded={sidebarOpen}
                aria-controls="student-navigation"
                onClick={() => setSidebarOpen((current) => !current)}
              >
                <Icon name="menu" size={20} />
              </button>
            )}
            <div className={`student-breadcrumb student-page-heading${isCourseLearning ? ' student-course-learning-topbar__identity' : ''}`}>
              {isCourseLearning ? (
                <>
                  <Link to="/student/courses">← Back to My Courses</Link>
                  <span aria-hidden="true" />
                  <strong>{courseLearningTitle || 'Course learning'}</strong>
                </>
              ) : isResultsPage ? null : (
                <>
                  <Icon name={pageIcon} size={19} />
                  <strong>{pageTitle}</strong>
                </>
              )}
            </div>
          </div>
          <div className="student-topbar__right">
            {isCourseLearningPage ? (
              <label className="student-search student-course-learning-topbar__search">
                <Icon name="search" size={17} />
                <input
                  type="search"
                  value={courseContentSearch}
                  onChange={(event) => setCourseContentSearch(event.target.value)}
                  placeholder="Search here..."
                  aria-label="Search course content"
                />
              </label>
            ) : <StudentSearch onLogout={onLogout} navigateTo={navigateTo} />}
            {isCourseLearningPage && (
              <button
                className={`student-course-learning__bookmark student-course-learning-topbar__bookmark${courseBookmarked ? ' is-active' : ''}`}
                type="button"
                aria-label={courseBookmarked ? 'Remove course bookmark' : 'Bookmark course'}
                aria-pressed={courseBookmarked}
                onClick={() => setCourseBookmarked((saved) => !saved)}
              >
                <Icon name="book" size={17} />
              </button>
            )}
            <div className="student-topbar__actions">
              <ThemeToggle isDark={isDark} onToggle={handleToggleTheme} onToggleTheme={handleToggleTheme} className="student-theme-toggle" />
              <StudentNotificationBell onLogout={onLogout} />
              <div className={`student-profile-menu${profileMenuOpen ? ' is-open' : ''}`} ref={profileMenuRef}>
                <button
                  className="student-profile-trigger"
                  type="button"
                  aria-haspopup="menu"
                  aria-expanded={profileMenuOpen}
                  aria-controls="student-profile-dropdown"
                  onClick={() => setProfileMenuOpen((isOpen) => !isOpen)}
                >
                  <span className="student-avatar">{initials}</span>
                  <span className="student-profile-trigger__copy">
                    <strong>{user?.fullName || 'Student'}</strong>
                    <small>{user?.studentType === 'college' ? (user?.collegeName || 'College Student') : 'Independent'}</small>
                  </span>
                </button>
                {profileMenuOpen && (
                  <div className="student-profile-dropdown" id="student-profile-dropdown" role="menu">
                    <button
                      className="student-profile-dropdown__logout"
                      type="button"
                      role="menuitem"
                      onClick={onLogout}
                    >
                      <Icon name="logout" size={16} /> Logout
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
        </header>

        <div className="student-content student-body">
          {error ? (
            <div className="student-panel student-state-panel is-error">
              <Icon name="alertCircle" size={28} />
              <h2>Something went wrong</h2>
              <p>{error}</p>
              {onRetry && (
                <button className="student-button" type="button" onClick={onRetry}>
                  Try again
                </button>
              )}
            </div>
          ) : loading ? (
            <div className="student-panel student-state-panel is-loading">
              <Icon name="spark" size={28} />
              <p>Loading your dashboard…</p>
            </div>
          ) : (
            <Routes>
              <Route path="/student/dashboard" element={
                <>
                  <section className="student-welcome">
                    <div className="student-welcome__copy">
                      <span className="student-eyebrow"><span /> YOUR LEARNING SPACE</span>
                      <h1>Welcome back, {firstName}!</h1>
                      <p>Continue learning, achieve your goals and track your progress.</p>
                      <span className="student-welcome__today"><Icon name="spark" size={16} /> A little progress adds up.</span>
                    </div>
                    <LearningIllustration />
                  </section>

                  {learningSummaryError && (
                    <p className="student-courses__message is-error" role="alert">{learningSummaryError}</p>
                  )}
                  <section className="student-stats student-stats-grid" aria-label="Student statistics">
                    {stats.map((stat) => {
                      const count = learningSummary[stat.value] ?? 0
                      return (
                        <article key={stat.label} className={`student-stat student-stat-card is-${stat.tone} student-stat-card--${stat.tone}`}>
                          <span className={`student-stat__icon student-stat-card__icon is-${stat.tone}`}><Icon name={stat.icon} size={19} /></span>
                          <span className="student-stat__label">{stat.label}</span>
                          <strong className="student-stat__value" aria-label={`${count} ${stat.label.toLowerCase()}`}>
                            {count}
                          </strong>
                          <small>{learningSummaryLoading ? 'Updating your learning data…' : stat.caption}</small>
                        </article>
                      )
                    })}
                  </section>

                  <LearningActivitySection
                    overview={learningOverview}
                    todaySummary={todaySummary}
                    weeklyData={weeklyData}
                    weekOffset={weekOffset}
                    onWeekChange={setWeekOffset}
                    onGoalChange={handleGoalChange}
                    loading={learningLoading}
                    error={learningError}
                  />

                  <section className="student-panel student-progress-panel" aria-labelledby="student-progress-title">
                    <div className="student-section-heading">
                      <div><span className="student-eyebrow">YOUR JOURNEY</span><h2 id="student-progress-title">My learning progress</h2></div>
                      <span className="student-data-note">
                        {learningSummaryLoading ? 'Updating progress…' : `${learningSummary.totalLessons} lessons across enrolled courses`}
                      </span>
                    </div>
                    <div className="student-progress-layout">
                      <div
                        className="student-donut"
                        role="img"
                        aria-label={`Overall learning completion ${completionPercentage}%`}
                        style={{ background: `conic-gradient(#5d9a83 ${completionPercentage}%, #dedfd5 ${completionPercentage}% 100%)` }}
                      >
                        <div><strong>{completionPercentage}%</strong><span>OVERALL</span></div>
                      </div>
                      <div className="student-lesson-counts">
                        {[
                          ['Completed lessons', 'completedLessons', 'mint'],
                          ['Lessons in progress', 'inProgressLessons', 'gold'],
                          ['Lessons not started', 'notStartedLessons', 'gray'],
                        ].map(([label, value, tone]) => (
                          <div className="student-lesson-count" key={label}>
                            <span className={`student-lesson-count__dot is-${tone}`} />
                            <span>{label}</span>
                            <strong>{learningSummary[value]}</strong>
                          </div>
                        ))}
                        <p>Counts update as you start and complete lessons.</p>
                      </div>
                    </div>
                  </section>

                  <section className="student-categories" aria-labelledby="student-categories-title">
                    <h2 id="student-categories-title">Explore categories</h2>
                    <div className="student-categories__list">
                      <button
                        className={`student-category student-category-link${!selectedCourseCategory && !selectedCategory ? ' is-selected is-active' : ''}`}
                        type="button"
                        onClick={() => {
                          setSelectedCategory('')
                          setSelectedCourseCategory('')
                        }}
                      >
                        <Icon name="grid" size={16} />
                        <span>All Courses</span>
                      </button>
                      {exploreCategories.map((category) => (
                        <button
                          className={`student-category student-category-link${(selectedCourseCategory === category.label || selectedCategory === category.label) ? ' is-selected is-active' : ''}`}
                          key={category.label}
                          type="button"
                          aria-pressed={selectedCourseCategory === category.label || selectedCategory === category.label}
                          onClick={() => {
                            const next = (selectedCourseCategory === category.label || selectedCategory === category.label) ? '' : category.label
                            setSelectedCategory(next)
                            setSelectedCourseCategory(next)
                          }}
                        >
                          <Icon name={category.icon || 'book'} size={16} />
                          <span>{category.label}</span>
                        </button>
                      ))}
                    </div>
                  </section>

                  <section className="student-panel" aria-labelledby="student-courses-title">
                    <div className="student-section-heading">
                      <div><span className="student-eyebrow">PICK UP WHERE YOU LEFT OFF</span><h2 id="student-courses-title">My Courses</h2></div>
                      <div className="student-dashboard-courses__actions">
                        {(selectedCategory || selectedCourseCategory) && (
                          <button
                            className="student-section-link"
                            type="button"
                            onClick={() => {
                              setSelectedCategory('')
                              setSelectedCourseCategory('')
                            }}
                          >
                            Clear filter
                          </button>
                        )}
                        <Link className="student-section-link" to="/student/courses">View all</Link>
                      </div>
                    </div>
                    <StudentDashboardCourses
                      onLogout={onLogout}
                      selectedCategory={selectedCourseCategory || selectedCategory}
                      refreshKey={dashboardRefreshKey}
                    />
                  </section>

                  <StudentAvailableCourses
                    user={user}
                    onLogout={onLogout}
                    onLearningDataChanged={refreshLearningSummary}
                    onCategoriesLoaded={setPublishedCourseCategories}
                    selectedCategory={selectedCourseCategory || selectedCategory}
                  />

                  <div className="student-two-column">
                    <section className="student-panel" aria-labelledby="student-assignments-title">
                      <div className="student-section-heading">
                        <div><span className="student-eyebrow">STAY ON TRACK</span><h2 id="student-assignments-title">Upcoming assignments</h2></div>
                        <Link className="student-section-link student-section-link--muted" to="/student/assignments">View all</Link>
                      </div>
                      <StudentDashboardUpcomingAssignments onLogout={onLogout} />
                    </section>
                    <section className="student-panel student-announcements" aria-labelledby="student-announcements-title">
                      <div className="student-section-heading">
                        <div><span className="student-eyebrow">FROM YOUR LEARNING COMMUNITY</span><h2 id="student-announcements-title">Announcements</h2></div>
                        <Link className="student-section-link student-section-link--muted" to="/student/announcements">
                          Updates <Icon name="arrow" size={15} />
                        </Link>
                      </div>
                      <NotificationFeed role="student" onLogout={onLogout} />
                    </section>
                  </div>

                  <div className="student-two-column student-lower-grid">
                    <section className="student-panel student-weekly-goal" aria-labelledby="student-goal-title">
                      <span className="student-eyebrow">A STEADY RHYTHM</span>
                      <h2 id="student-goal-title">Weekly learning goal</h2>
                      <div className="student-goal-values"><strong>— <small>hrs</small></strong><span>of — hrs this week</span></div>
                      <div className="student-progress-track"><span /></div>
                      <p>Learning time and weekly goal tracking aren’t connected yet.</p>
                    </section>
                    <section className="student-panel student-ai-card" aria-labelledby="student-ai-title">
                      <span className="student-ai-card__icon"><Icon name="spark" size={20} /></span>
                      <span className="student-eyebrow">A HELPFUL STUDY SPACE</span>
                      <h2 id="student-ai-title">AI Study Companion</h2>
                      <p>Topic explanations, lesson summaries and practice questions are planned for a future release.</p>
                      <span className="student-ai-card__status">Not connected to an AI service</span>
                    </section>
                  </div>

                  <section className="student-tools" aria-labelledby="student-tools-title">
                    <div className="student-section-heading">
                      <div><span className="student-eyebrow">MORE FOR YOUR JOURNEY</span><h2 id="student-tools-title">Student tools</h2></div>
                    </div>
                    <div className="student-tools-grid">
                      {tools.map((tool) => (
                        <Link className="student-tool-card" id={tool.id} key={tool.id} to={tool.path}>
                          <span className="student-tool-card__icon"><Icon name={tool.icon} size={19} /></span>
                          <span className="student-tool-card__copy">
                            <h3>{tool.title}</h3>
                            <p>{tool.description}</p>
                          </span>
                          <span className="student-tool-card__arrow" aria-hidden="true"><Icon name="arrow" size={18} /></span>
                        </Link>
                      ))}
                    </div>
                  </section>
                  <footer className="student-footer"><span>Made for curious minds</span><span>Keep going, one lesson at a time.</span></footer>
                </>
              } />
              <Route path="/student/course/:courseId/learn" element={
                <StudentCourseLearningPage
                  onLogout={onLogout}
                  onLearningDataChanged={refreshLearningSummary}
                  onCourseTitleChange={setCourseLearningTitle}
                  contentSearch={courseContentSearch}
                />
              } />
              <Route path="/student/course/:courseId/details" element={
                <StudentCourseDetailsPage user={user} onLogout={onLogout} onLearningDataChanged={refreshLearningSummary} />
              } />
              <Route path="/student/course/:courseId" element={
                <StudentCourseDetailsPage user={user} onLogout={onLogout} onLearningDataChanged={refreshLearningSummary} />
              } />
              <Route path="/student/learning" element={<StudentLearningActivity onLogout={onLogout} />} />
              <Route path="/student/courses" element={<StudentCourses user={user} onLogout={onLogout} />} />
              <Route path="/student/assignments" element={
                <StudentAssignmentsPage onLogout={onLogout} onLearningDataChanged={refreshLearningSummary} />
              } />
              <Route path="/student/quizzes-assignments" element={
                <StudentQuizzesAndAssignments user={user} onLogout={onLogout} />
              } />
              <Route path="/student/results" element={
                <StudentResultsPage onLogout={onLogout} />
              } />
              <Route path="/student/resources" element={
                <StudentLearningResourcesPage user={user} onLogout={onLogout} />
              } />
              <Route path="/student/messages" element={
                <StudentRoutePage eyebrow="YOUR LEARNING COMMUNITY" title="Messages">
                  <EmptyState icon="message" title="Messages are not connected yet" description="Course conversations and messages will appear here when messaging is available." />
                </StudentRoutePage>
              } />
              <Route path="/student/certificates" element={
                <StudentCertificatesPage user={user} onLogout={onLogout} />
              } />
              <Route
                path="/student/referrals"
                element={user?.studentType === 'independent'
                  ? <StudentReferrals onLogout={onLogout} />
                  : <Navigate to="/student/dashboard" replace />}
              />
              <Route path="/student/profile" element={<StudentProfile user={user} onLogout={onLogout} />} />
              <Route path="/student/purchases" element={<StudentPurchases />} />
              <Route path="/student/achievements" element={<StudentAchievements user={user} onLogout={onLogout} />} />
              <Route path="/student/learning-activity" element={<StudentLearningActivity onLogout={onLogout} />} />
              <Route path="/student/updates" element={<StudentUpdates />} />
              <Route path="/student/settings" element={
                <StudentRoutePage eyebrow="PREFERENCES" title="Settings">
                  <SettingsPage
                    user={user}
                    onAccountUpdated={onAccountUpdated}
                    themePreference={themePreference}
                    onSetTheme={onSetTheme}
                    onLogout={onLogout}
                  />
                </StudentRoutePage>
              } />
              <Route path="/student/help" element={<HelpCenterHome />} />
              <Route path="/student/help/email" element={<EmailSupportPage user={user} onLogout={onLogout} />} />
              <Route path="/student/help/complaint" element={<SubmitComplaintPage />} />
              <Route path="/student/help/submit-ticket" element={<SubmitSupportTicketPage user={user} onLogout={onLogout} />} />
              <Route path="/student/help/faqs" element={<SupportFaqPage />} />
              <Route path="/student/help/requests" element={<SupportRequestsPage user={user} onLogout={onLogout} />} />
              <Route path="/student/help/requests/:ticketId" element={<SupportTicketDetailPage user={user} onLogout={onLogout} />} />
              <Route path="/student/announcements" element={
                <StudentNotificationsPage onLogout={onLogout} />
              } />
              <Route path="/student/study-companion" element={
                <StudentRoutePage eyebrow="A HELPFUL STUDY SPACE" title="AI Study Companion">
                  <EmptyState icon="spark" title="Study Companion is not connected" description="Topic explanations, lesson summaries and practice questions are planned for a future release." />
                </StudentRoutePage>
              } />
              <Route path="*" element={<Navigate to="/student/dashboard" replace />} />
            </Routes>
          )}
        </div>
      </main>
    </div>
  )
}



export {
  StudentQuizzesAndAssignments,
  fetchStudentActivities,
  formatActivityDueDate,
  getActivityStatusDetails,
  getActivityActionLabel,
  StudentCourseDetailsPage,
  StudentCertificatesPage,
  fetchCourseDetails,
  enrollInCourse,
  unenrollFromCourse,
  fetchStudentCertificates,
}

export default StudentDashboard
