import React, { useEffect, useState } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import { isInvalidSessionResponse } from './auth-session.js'
import './SupportCenter.css'

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || 'http://localhost:5000/api').replace(/\/+$/, '')
const supportEmail = import.meta.env.VITE_SUPPORT_EMAIL?.trim() || ''

const ticketCategories = [
  'Account and Registration',
  'Login and Security',
  'Courses and Learning',
  'Enrollments',
  'Assignments and Results',
  'Certificates',
  'Payments',
  'Technical Issues',
  'Other',
]
const priorities = ['Low', 'Medium', 'High']
const ticketStatuses = ['Open', 'In Progress', 'Waiting for Student', 'Resolved', 'Closed']

function getToken(onLogout) {
  const storedAuth = sessionStorage.getItem('lms.auth')
  let token
  try {
    token = storedAuth ? JSON.parse(storedAuth)?.token : null
  } catch {
    sessionStorage.removeItem('lms.auth')
    if (typeof onLogout === 'function') onLogout()
    const error = new Error('Your session has expired. Please sign in again.')
    error.isSessionExpired = true
    throw error
  }
  if (typeof token !== 'string' || !token) {
    sessionStorage.removeItem('lms.auth')
    if (typeof onLogout === 'function') onLogout()
    const error = new Error('Your session has expired. Please sign in again.')
    error.isSessionExpired = true
    throw error
  }
  return token
}

async function supportRequest(path, options = {}, onLogout) {
  const token = getToken(onLogout)
  const headers = new Headers(options.headers)
  headers.set('Authorization', `Bearer ${token}`)
  if (options.body && !(options.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json')
  }
  const response = await fetch(`${API_BASE_URL}/support${path}`, {
    ...options,
    headers,
  })
  let result
  try {
    result = await response.json()
  } catch {
    throw new Error('The server returned an invalid response. Please try again.')
  }
  if (!response.ok) {
    if (response.status === 401 || isInvalidSessionResponse(response, result)) {
      sessionStorage.removeItem('lms.auth')
      if (typeof onLogout === 'function') {
        onLogout()
      }
      const sessionError = new Error('Your session has expired. Please sign in again.')
      sessionError.isSessionExpired = true
      throw sessionError
    }
    throw new Error(typeof result.message === 'string' ? result.message : 'The support request failed.')
  }
  return result
}

async function complaintRequest(path, options = {}) {
  const headers = new Headers(options.headers)
  headers.set('Authorization', `Bearer ${getToken()}`)
  if (options.body) headers.set('Content-Type', 'application/json')
  const response = await fetch(`${API_BASE_URL}/complaints${path}`, { ...options, headers })
  let result
  try {
    result = await response.json()
  } catch {
    throw new Error('The server returned an invalid response. Please try again.')
  }
  if (!response.ok) {
    throw new Error(typeof result.message === 'string' ? result.message : 'The complaint request failed.')
  }
  return result
}

function Icon({ name }) {
  const paths = {
    email: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m4 7 8 6 8-6" /></>,
    ticket: <><path d="M4 5h16v4a3 3 0 0 0 0 6v4H4v-4a3 3 0 0 0 0-6z" /><path d="M12 8v2m0 4v2" /></>,
    message: <><path d="M20 11.5a7.5 7.5 0 0 1-7.5 7.5 8 8 0 0 1-3.5-.8L4 20l1.5-4A7.5 7.5 0 1 1 20 11.5Z" /><path d="M8 11h.01M12 11h.01M16 11h.01" /></>,
    faq: <><circle cx="12" cy="12" r="9" /><path d="M9.6 9a2.5 2.5 0 1 1 4.5 1.5c-.9 1.1-2.1 1.3-2.1 3m0 3h.01" /></>,
    list: <><path d="M9 6h11M9 12h11M9 18h11" /><path d="M4 6h.01M4 12h.01M4 18h.01" /></>,
    search: <><circle cx="10.8" cy="10.8" r="6.8" /><path d="m16 16 4.5 4.5" /></>,
    arrow: <><path d="M5 12h14m-6-6 6 6-6 6" /></>,
    upload: <><path d="M12 16V4m-5 5 5-5 5 5" /><path d="M5 14v5h14v-5" /></>,
    download: <><path d="M12 4v12m-5-5 5 5 5-5" /><path d="M5 19h14" /></>,
    chevronDown: <path d="m6 9 6 6 6-6" />,
    clear: <path d="M18 6 6 18M6 6l12 12" />,
    thumbsUp: <><path d="M7 10v12" /><path d="M15 10.5V6a3 3 0 0 0-3-3l-4 7v12h11.3a2 2 0 0 0 2-1.7l1.3-8.4a2 2 0 0 0-2-2.2H15z" /><path d="M2 10h5v12H2z" /></>,
    thumbsDown: <><path d="M17 14V2" /><path d="M9 13.5V18a3 3 0 0 0 3 3l4-7V2H4.7a2 2 0 0 0-2 1.7l-1.3 8.4a2 2 0 0 0 2 2.2H9z" /><path d="M22 14h-5V2h5z" /></>,
    check: <path d="M20 6 9 17l-5-5" />,
    lifeBuoy: <><circle cx="12" cy="12" r="10" /><circle cx="12" cy="12" r="4" /><line x1="4.93" y1="4.93" x2="9.17" y2="9.17" /><line x1="14.83" y1="14.83" x2="19.07" y2="19.07" /><line x1="14.83" y1="9.17" x2="19.07" y2="4.93" /><line x1="4.93" y1="19.07" x2="9.17" y2="14.83" /></>,
    alertCircle: <><circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" /></>,
    book: <><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1-2.5-2.5Z" /><path d="M6 2v20" /></>,
    lock: <><rect width="18" height="11" x="3" y="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></>,
    user: <><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></>,
    award: <><circle cx="12" cy="8" r="6" /><path d="M15.477 12.89 17 22l-5-3-5 3 1.523-9.11" /></>,
    creditCard: <><rect width="20" height="14" x="2" y="5" rx="2" /><line x1="2" x2="22" y1="10" y2="10" /></>,
    tool: <><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" /></>,
    spark: <><path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3Z" /></>,
    plus: <path d="M12 5v14M5 12h14" />,
    clock: <><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></>,
    send: <><line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" /></>,
    messageSquare: <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />,
    filter: <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />,
  }
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths[name] || paths.faq}
    </svg>
  )
}

function SupportPage({ eyebrow, title, children, backTo = '/student/help', backLabel = 'Back to Help Center' }) {
  return (
    <div className="support-center-page">
      <Link className="support-back-link" to={backTo}><span aria-hidden="true">←</span> {backLabel}</Link>
      <section className="student-panel student-route-page support-page-panel">
        <div className="student-section-heading">
          <div>
            <span className="student-eyebrow">{eyebrow}</span>
            <h2>{title}</h2>
          </div>
        </div>
        {children}
      </section>
    </div>
  )
}

function SupportEmptyState({ title, description }) {
  return (
    <div className="support-empty-state">
      <span className="support-empty-state__icon"><Icon name="ticket" /></span>
      <h3>{title}</h3>
      <p>{description}</p>
    </div>
  )
}

export function HelpCenterHome() {
  const cards = [
    { title: 'Email Support', description: 'Send a support request to the LMS team.', icon: 'email', to: '/student/help/email' },
    { title: 'Submit a Support Ticket', description: 'Report an issue and track its status.', icon: 'ticket', to: '/student/help/submit-ticket' },
    { title: 'Submit a Complaint', description: 'Send a complaint to the Main Admin for review.', icon: 'message', to: '/student/help/complaint' },
    { title: 'Browse FAQs', description: 'Find answers to common questions.', icon: 'faq', to: '/student/help/faqs' },
    { title: 'My Support Requests', description: 'View previous tickets and replies.', icon: 'list', to: '/student/help/requests' },
  ]

  return (
    <div className="support-center-page">
      <section className="support-center-hero">
        <span className="student-eyebrow">SUPPORT AND GUIDANCE</span>
        <h1>How can we help you?</h1>
        <p>Choose how you'd like to get assistance with your LMS account.</p>
      </section>
      <div className="support-center-options">
        {cards.map((card) => (
          <Link className="student-panel support-option-card" to={card.to} key={card.title}>
            <span className="support-option-card__icon"><Icon name={card.icon} /></span>
            <span className="support-option-card__copy">
              <strong>{card.title}</strong>
              <small>{card.description}</small>
            </span>
            <Icon name="arrow" />
          </Link>
        ))}
      </div>
    </div>
  )
}

export function EmailSupportPage({ user }) {
  const [values, setValues] = useState({
    name: user?.fullName || '',
    email: user?.email || '',
    subject: '',
    message: '',
  })
  const [notice, setNotice] = useState('')

  useEffect(() => {
    setValues((current) => ({
      ...current,
      name: user?.fullName || '',
      email: user?.email || '',
    }))
  }, [user?.fullName, user?.email])

  function updateValue(event) {
    const { name, value } = event.currentTarget
    setValues((current) => ({ ...current, [name]: value }))
    setNotice('')
  }

  function submitEmail(event) {
    event.preventDefault()
    if (!supportEmail) {
      setNotice('Email support is not configured yet. Please submit a support ticket instead.')
      return
    }
    const body = `Name: ${values.name.trim()}\nEmail: ${values.email.trim()}\n\n${values.message.trim()}`
    window.location.href = `mailto:${encodeURIComponent(supportEmail)}?subject=${encodeURIComponent(values.subject.trim())}&body=${encodeURIComponent(body)}`
    setNotice('Your email application is opening. Review the request and send it there.')
  }

  return (
    <SupportPage eyebrow="CONTACT THE LMS TEAM" title="Email Support">
      {!supportEmail && (
        <div className="support-notice is-warning" role="status">
          Email support is not configured yet. Configure the official VITE_SUPPORT_EMAIL setting to enable this form.
        </div>
      )}
      <form className="support-form" onSubmit={submitEmail}>
        <div className="support-form__grid">
          <label>Name<input name="name" autoComplete="name" value={values.name} onChange={updateValue} required maxLength={120} /></label>
          <label>Email<input name="email" type="email" autoComplete="email" value={values.email} onChange={updateValue} required maxLength={254} /></label>
        </div>
        <label>Subject<input name="subject" value={values.subject} onChange={updateValue} required minLength={3} maxLength={160} /></label>
        <label>Message<textarea name="message" value={values.message} onChange={updateValue} required minLength={10} maxLength={10000} rows={7} /></label>
        <button className="student-button" type="submit" disabled={!supportEmail}>Continue to email</button>
        {notice && <p className="support-form__notice" role="status">{notice}</p>}
      </form>
    </SupportPage>
  )
}

function fileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result !== 'string') {
        reject(new Error('The attachment could not be read.'))
        return
      }
      resolve(reader.result.slice(reader.result.indexOf(',') + 1))
    }
    reader.onerror = () => reject(new Error('The attachment could not be read.'))
    reader.readAsDataURL(file)
  })
}

export function SubmitSupportTicketPage({ onLogout }) {
  const navigate = useNavigate()
  const location = useLocation()
  const queryParams = new URLSearchParams(location.search)
  const initialCategory = location.state?.category || queryParams.get('category') || ''
  const initialSubject = location.state?.subject || queryParams.get('subject') || ''

  const [values, setValues] = useState({
    subject: initialSubject,
    category: ticketCategories.includes(initialCategory) ? initialCategory : '',
    priority: 'Medium',
    description: '',
  })
  const [file, setFile] = useState(null)
  const [error, setError] = useState('')
  const [isSessionExpired, setIsSessionExpired] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)

  function updateValue(event) {
    const { name, value } = event.currentTarget
    setValues((current) => ({ ...current, [name]: value }))
    setError('')
  }

  function updateFile(event) {
    const selected = event.currentTarget.files?.[0] || null
    if (selected && (selected.size > 5 * 1024 * 1024 || !['image/png', 'image/jpeg', 'image/webp', 'application/pdf'].includes(selected.type))) {
      setFile(null)
      event.currentTarget.value = ''
      setError('Choose a PNG, JPEG, WebP, or PDF file no larger than 5 MB.')
      return
    }
    setFile(selected)
    setError('')
  }

  async function submitTicket(event) {
    event.preventDefault()
    setIsSubmitting(true)
    setError('')
    try {
      const attachment = file
        ? { fileName: file.name, contentType: file.type, data: await fileAsBase64(file) }
        : undefined
      const result = await supportRequest(
        '/tickets',
        {
          method: 'POST',
          body: JSON.stringify({ ...values, ...(attachment ? { attachment } : {}) }),
        },
        onLogout,
      )
      navigate(`/student/help/requests/${encodeURIComponent(result.ticket.ticketId)}`, {
        replace: true,
        state: { created: true },
      })
    } catch (requestError) {
      if (requestError?.isSessionExpired) {
        setIsSessionExpired(true)
      }
      setError(requestError instanceof Error ? requestError.message : 'Your support ticket could not be submitted.')
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <SupportPage eyebrow="WE'RE HERE TO HELP" title="Submit a Support Ticket">
      <p className="support-page-intro">Tell us what happened. Your request will be saved securely to your LMS account.</p>
      {isSessionExpired ? (
        <div className="support-notice is-warning" role="alert">
          <div className="support-session-alert">
            <span>Your session has expired. Please sign in again to submit a support request.</span>
            <Link to="/login" className="student-button" style={{ padding: '6px 14px', fontSize: '12px' }}>
              Sign In Again
            </Link>
          </div>
        </div>
      ) : (
        <form className="support-form" onSubmit={submitTicket}>
          <label>Subject<input name="subject" value={values.subject} onChange={updateValue} required minLength={3} maxLength={160} placeholder="Brief summary of the issue" /></label>
          <div className="support-form__grid">
            <label>Category
              <select name="category" value={values.category} onChange={updateValue} required>
                <option value="">Choose a category</option>
                {ticketCategories.map((category) => <option key={category} value={category}>{category}</option>)}
              </select>
            </label>
            <label>Priority
              <select name="priority" value={values.priority} onChange={updateValue} required>
                {priorities.map((priority) => <option key={priority} value={priority}>{priority}</option>)}
              </select>
            </label>
          </div>
          <label>Detailed description<textarea name="description" value={values.description} onChange={updateValue} required minLength={10} maxLength={10000} rows={7} placeholder="Please provide details about what happened, steps to reproduce, or any relevant context..." /></label>
          <label className="support-file-field">Optional screenshot or attachment
            <input type="file" accept="image/png,image/jpeg,image/webp,application/pdf" onChange={updateFile} />
            <span>PNG, JPEG, WebP, or PDF · maximum 5 MB{file ? ` · Selected: ${file.name}` : ''}</span>
          </label>
          {error && <div className="support-notice is-error" role="alert">{error}</div>}
          <button className="student-button" type="submit" disabled={isSubmitting}>
            <Icon name="ticket" /> {isSubmitting ? 'Submitting…' : 'Submit ticket'}
          </button>
        </form>
      )}
    </SupportPage>
  )
}

export function SubmitComplaintPage() {
  const [profile, setProfile] = useState(null)
  const [isLoadingProfile, setIsLoadingProfile] = useState(true)
  const [profileError, setProfileError] = useState('')
  const [values, setValues] = useState({ subject: '', category: '', description: '' })
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)

  useEffect(() => {
    let active = true
    complaintRequest('/profile')
      .then((result) => {
        if (!result.student) throw new Error('Your student profile could not be loaded.')
        if (active) setProfile(result.student)
      })
      .catch((requestError) => {
        if (active) {
          setProfileError(requestError instanceof Error
            ? requestError.message
            : 'Your student profile could not be loaded.')
        }
      })
      .finally(() => {
        if (active) setIsLoadingProfile(false)
      })
    return () => { active = false }
  }, [])

  function updateValue(event) {
    const { name, value } = event.currentTarget
    setValues((current) => ({ ...current, [name]: value }))
    setError('')
    setNotice('')
  }

  async function submitComplaint(event) {
    event.preventDefault()
    setIsSubmitting(true)
    setError('')
    setNotice('')
    try {
      const result = await complaintRequest('/', {
        method: 'POST',
        body: JSON.stringify(values),
      })
      setValues({ subject: '', category: '', description: '' })
      setNotice(`Complaint ${result.complaint?.complaintId || ''} submitted successfully.`.trim())
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Your complaint could not be submitted.')
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <SupportPage eyebrow="STUDENT COMPLAINTS" title="Submit a Complaint">
      <p className="support-page-intro">Your account details are securely added from your student profile.</p>
      {isLoadingProfile ? <p className="support-loading" role="status">Loading your profile…</p> : profileError ? (
        <div className="support-notice is-error" role="alert">{profileError}</div>
      ) : profile ? (
        <form className="support-form" onSubmit={submitComplaint}>
          <div className="support-form__grid">
            <label>Full name<input value={profile.fullName || 'Not available'} readOnly /></label>
            <label>Email<input value={profile.email || 'Not available'} readOnly /></label>
            {profile.studentType === 'college' && (
              <>
                <label>Student ID<input value={profile.studentId || 'Not available'} readOnly /></label>
                <label>College ID<input value={profile.collegeId || 'Not available'} readOnly /></label>
              </>
            )}
          </div>
          <label>Subject<input name="subject" value={values.subject} onChange={updateValue} required minLength={3} maxLength={160} /></label>
          <label>Category
            <select name="category" value={values.category} onChange={updateValue} required>
              <option value="">Choose a category</option>
              {ticketCategories.map((category) => <option key={category} value={category}>{category}</option>)}
            </select>
          </label>
          <label>Detailed description<textarea name="description" value={values.description} onChange={updateValue} required minLength={10} maxLength={10000} rows={7} /></label>
          {error && <div className="support-notice is-error" role="alert">{error}</div>}
          {notice && <div className="support-notice is-success" role="status">{notice}</div>}
          <button className="student-button" type="submit" disabled={isSubmitting}>
            {isSubmitting ? 'Submitting…' : 'Submit complaint'}
          </button>
        </form>
      ) : null}
    </SupportPage>
  )
}

export function SupportRequestsPage({ onLogout }) {
  const [tickets, setTickets] = useState([])
  const [stats, setStats] = useState({ total: 0, open: 0, inProgress: 0, resolved: 0 })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [isSessionExpired, setIsSessionExpired] = useState(false)
  const [statusFilter, setStatusFilter] = useState('')
  const [categoryFilter, setCategoryFilter] = useState('')
  const [search, setSearch] = useState('')
  const [showCreateModal, setShowCreateModal] = useState(false)

  // New ticket inline form state
  const [createValues, setCreateValues] = useState({
    subject: '',
    category: '',
    priority: 'Medium',
    description: '',
  })
  const [createFile, setCreateFile] = useState(null)
  const [createError, setCreateError] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [createNotice, setCreateNotice] = useState('')

  const fetchTickets = async () => {
    try {
      setLoading(true)
      setError('')
      setIsSessionExpired(false)
      const result = await supportRequest('/tickets', {}, onLogout)
      setTickets(result.tickets || [])
      if (result.stats) {
        setStats(result.stats)
      } else {
        const all = result.tickets || []
        setStats({
          total: all.length,
          open: all.filter((t) => t.status === 'Open').length,
          inProgress: all.filter((t) => t.status === 'In Progress').length,
          resolved: all.filter((t) => t.status === 'Resolved').length,
        })
      }
    } catch (requestError) {
      if (requestError?.isSessionExpired) {
        setIsSessionExpired(true)
      }
      setError(requestError instanceof Error ? requestError.message : 'Support requests could not be loaded.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchTickets()
  }, [])

  function updateCreateValue(event) {
    const { name, value } = event.currentTarget
    setCreateValues((current) => ({ ...current, [name]: value }))
    setCreateError('')
  }

  function updateCreateFile(event) {
    const selected = event.currentTarget.files?.[0] || null
    if (selected && (selected.size > 5 * 1024 * 1024 || !['image/png', 'image/jpeg', 'image/webp', 'application/pdf'].includes(selected.type))) {
      setCreateFile(null)
      event.currentTarget.value = ''
      setCreateError('Choose a PNG, JPEG, WebP, or PDF file no larger than 5 MB.')
      return
    }
    setCreateFile(selected)
    setCreateError('')
  }

  async function handleCreateTicket(event) {
    event.preventDefault()
    setIsSubmitting(true)
    setCreateError('')
    setCreateNotice('')
    try {
      const attachment = createFile
        ? { fileName: createFile.name, contentType: createFile.type, data: await fileAsBase64(createFile) }
        : undefined
      const result = await supportRequest(
        '/tickets',
        {
          method: 'POST',
          body: JSON.stringify({ ...createValues, ...(attachment ? { attachment } : {}) }),
        },
        onLogout,
      )
      setCreateNotice(`Support request ${result.ticket.ticketId} created successfully!`)
      setCreateValues({ subject: '', category: '', priority: 'Medium', description: '' })
      setCreateFile(null)
      setShowCreateModal(false)
      await fetchTickets()
    } catch (requestError) {
      if (requestError?.isSessionExpired) {
        setIsSessionExpired(true)
      }
      setCreateError(requestError instanceof Error ? requestError.message : 'Your support request could not be created.')
    } finally {
      setIsSubmitting(false)
    }
  }

  const normalizedSearch = search.trim().toLowerCase()
  const filteredTickets = tickets.filter((ticket) => {
    if (statusFilter && ticket.status !== statusFilter) {
      return false
    }
    if (categoryFilter && ticket.category !== categoryFilter) {
      return false
    }
    if (normalizedSearch) {
      const matchId = (ticket.ticketId || '').toLowerCase().includes(normalizedSearch)
      const matchSubject = (ticket.subject || '').toLowerCase().includes(normalizedSearch)
      return matchId || matchSubject
    }
    return true
  })

  const resetFilters = () => {
    setStatusFilter('')
    setCategoryFilter('')
    setSearch('')
  }

  return (
    <div className="support-center-page">
      <Link className="support-back-link" to="/student/help">
        <span aria-hidden="true">←</span> Back to Help Center
      </Link>

      <section className="student-panel student-route-page support-page-panel">
        {/* Page Header */}
        <div className="support-requests-header">
          <div className="support-requests-header__copy">
            <span className="student-eyebrow">SUPPORT PORTAL</span>
            <h1 className="support-requests-header__title">My Support Requests</h1>
            <p className="support-requests-header__subtitle">
              Track your support queries, view responses and get help from our team.
            </p>
          </div>
          <button
            type="button"
            className="student-button support-create-btn"
            onClick={() => setShowCreateModal((prev) => !prev)}
            aria-expanded={showCreateModal}
          >
            <Icon name={showCreateModal ? 'clear' : 'plus'} />
            <span>{showCreateModal ? 'Close Form' : 'New Support Request'}</span>
          </button>
        </div>

        {createNotice && (
          <div className="support-notice is-success" role="status">
            {createNotice}
          </div>
        )}

        {/* Section A: Summary Cards */}
        <div className="support-stats-grid" role="region" aria-label="Support statistics">
          <button
            type="button"
            className={`support-stat-card tone-gold${statusFilter === '' ? ' is-selected' : ''}`}
            onClick={() => setStatusFilter('')}
            title="Show all requests"
          >
            <div className="support-stat-card__icon">
              <Icon name="ticket" />
            </div>
            <div className="support-stat-card__body">
              <span className="support-stat-card__count">{stats.total}</span>
              <span className="support-stat-card__label">Total Requests</span>
            </div>
          </button>

          <button
            type="button"
            className={`support-stat-card tone-peach${statusFilter === 'Open' ? ' is-selected' : ''}`}
            onClick={() => setStatusFilter('Open')}
            title="Filter by Open requests"
          >
            <div className="support-stat-card__icon">
              <Icon name="clock" />
            </div>
            <div className="support-stat-card__body">
              <span className="support-stat-card__count">{stats.open}</span>
              <span className="support-stat-card__label">Open Requests</span>
            </div>
          </button>

          <button
            type="button"
            className={`support-stat-card tone-teal${statusFilter === 'In Progress' ? ' is-selected' : ''}`}
            onClick={() => setStatusFilter('In Progress')}
            title="Filter by In Progress requests"
          >
            <div className="support-stat-card__icon">
              <Icon name="tool" />
            </div>
            <div className="support-stat-card__body">
              <span className="support-stat-card__count">{stats.inProgress}</span>
              <span className="support-stat-card__label">In Progress</span>
            </div>
          </button>

          <button
            type="button"
            className={`support-stat-card tone-mint${statusFilter === 'Resolved' ? ' is-selected' : ''}`}
            onClick={() => setStatusFilter('Resolved')}
            title="Filter by Resolved requests"
          >
            <div className="support-stat-card__icon">
              <Icon name="check" />
            </div>
            <div className="support-stat-card__body">
              <span className="support-stat-card__count">{stats.resolved}</span>
              <span className="support-stat-card__label">Resolved</span>
            </div>
          </button>
        </div>

        {/* Section B: Create Support Request Form (Collapsible / Modal Drawer) */}
        {showCreateModal && (
          <section className="support-create-box" aria-labelledby="create-request-heading">
            <div className="support-create-box__header">
              <div>
                <span className="student-eyebrow">NEW TICKET</span>
                <h3 id="create-request-heading">Create Support Request</h3>
              </div>
              <button
                type="button"
                className="support-close-btn"
                onClick={() => setShowCreateModal(false)}
                aria-label="Cancel and close request form"
              >
                <Icon name="clear" />
              </button>
            </div>

            <form className="support-form" onSubmit={handleCreateTicket}>
              <label>
                Subject *
                <input
                  name="subject"
                  value={createValues.subject}
                  onChange={updateCreateValue}
                  required
                  minLength={3}
                  maxLength={160}
                  placeholder="e.g. Issue accessing lesson video in Module 2"
                />
              </label>

              <div className="support-form__grid">
                <label>
                  Category *
                  <select
                    name="category"
                    value={createValues.category}
                    onChange={updateCreateValue}
                    required
                  >
                    <option value="">Select a category</option>
                    {ticketCategories.map((category) => (
                      <option key={category} value={category}>
                        {category}
                      </option>
                    ))}
                  </select>
                </label>

                <label>
                  Priority *
                  <select
                    name="priority"
                    value={createValues.priority}
                    onChange={updateCreateValue}
                    required
                  >
                    {priorities.map((priority) => (
                      <option key={priority} value={priority}>
                        {priority}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <label>
                Detailed description *
                <textarea
                  name="description"
                  value={createValues.description}
                  onChange={updateCreateValue}
                  required
                  minLength={10}
                  maxLength={10000}
                  rows={5}
                  placeholder="Describe your issue with as much detail as possible so our support team can assist you promptly..."
                />
              </label>

              <label className="support-file-field">
                Optional attachment (PNG, JPEG, WebP, or PDF)
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp,application/pdf"
                  onChange={updateCreateFile}
                />
                <span>Maximum file size 5 MB{createFile ? ` · Selected: ${createFile.name}` : ''}</span>
              </label>

              {createError && (
                <div className="support-notice is-error" role="alert">
                  {createError}
                </div>
              )}

              <div className="support-form-actions">
                <button
                  type="button"
                  className="student-button student-button--quiet"
                  onClick={() => setShowCreateModal(false)}
                >
                  Cancel
                </button>
                <button
                  className="student-button"
                  type="submit"
                  disabled={isSubmitting}
                >
                  <Icon name="ticket" /> {isSubmitting ? 'Submitting…' : 'Submit Support Request'}
                </button>
              </div>
            </form>
          </section>
        )}

        {/* Section C: Requests Toolbar */}
        <div className="support-requests-toolbar" role="search" aria-label="Filter support requests">
          <div className="support-search-wrapper">
            <span className="support-search-icon" aria-hidden="true">
              <Icon name="search" />
            </span>
            <input
              type="search"
              className="support-search-input"
              placeholder="Search by ticket ID or subject..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search support requests"
            />
            {search && (
              <button
                type="button"
                className="support-search-clear"
                onClick={() => setSearch('')}
                aria-label="Clear search"
              >
                <Icon name="clear" />
              </button>
            )}
          </div>

          <div className="support-filter-controls">
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="support-select-filter"
              aria-label="Filter by status"
            >
              <option value="">All Statuses</option>
              {ticketStatuses.map((st) => (
                <option key={st} value={st}>
                  {st}
                </option>
              ))}
            </select>

            <select
              value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value)}
              className="support-select-filter"
              aria-label="Filter by category"
            >
              <option value="">All Categories</option>
              {ticketCategories.map((cat) => (
                <option key={cat} value={cat}>
                  {cat}
                </option>
              ))}
            </select>

            {(statusFilter || categoryFilter || search) && (
              <button
                type="button"
                className="support-reset-filters-btn"
                onClick={resetFilters}
                aria-label="Reset all search and filter options"
              >
                <Icon name="clear" />
                <span>Reset filters</span>
              </button>
            )}
          </div>
        </div>

        {/* Feedback / Error state */}
        {isSessionExpired ? (
          <div className="support-notice is-warning" role="alert">
            <div className="support-session-alert">
              <span>Your session has expired. Please sign in again to view and manage your support requests.</span>
              <Link to="/login" className="student-button" style={{ padding: '6px 14px', fontSize: '12px' }}>
                Sign In Again
              </Link>
            </div>
          </div>
        ) : error ? (
          <div className="support-notice is-error" role="alert">
            <div className="support-session-alert">
              <span>{error}</span>
              <button type="button" className="student-button student-button--quiet" onClick={fetchTickets}>
                Try Again
              </button>
            </div>
          </div>
        ) : loading ? (
          <div className="support-loading-container" role="status">
            <div className="support-loading-spinner" />
            <p className="support-loading">Loading your support requests…</p>
          </div>
        ) : filteredTickets.length === 0 ? (
          tickets.length === 0 ? (
            /* Compact Elegant Empty State */
            <div className="support-empty-card" role="region" aria-label="No requests">
              <div className="support-empty-card__icon-wrap">
                <Icon name="messageSquare" />
              </div>
              <h3 className="support-empty-card__title">No support requests yet</h3>
              <p className="support-empty-card__desc">
                Need help with a course, account or technical issue? Create a support request and our team will assist you.
              </p>
              <button
                type="button"
                className="student-button support-empty-card__btn"
                onClick={() => setShowCreateModal(true)}
              >
                <Icon name="plus" />
                <span>Create Your First Request</span>
              </button>
            </div>
          ) : (
            /* Filter Empty State */
            <div className="support-empty-card" role="region" aria-label="No matching requests">
              <div className="support-empty-card__icon-wrap is-search">
                <Icon name="search" />
              </div>
              <h3 className="support-empty-card__title">No matching support requests</h3>
              <p className="support-empty-card__desc">
                No tickets match your search keywords or selected filters. Try broadening your criteria.
              </p>
              <button
                type="button"
                className="student-button student-button--secondary support-empty-card__btn"
                onClick={resetFilters}
              >
                <Icon name="clear" />
                <span>Reset all filters</span>
              </button>
            </div>
          )
        ) : (
          /* When Tickets Exist: Polished Support Request List */
          <div className="support-ticket-table-wrap">
            <div className="support-ticket-list-header">
              <span>Showing {filteredTickets.length} of {tickets.length} support requests</span>
              {(statusFilter || categoryFilter || search) && (
                <button type="button" className="support-inline-reset" onClick={resetFilters}>
                  Clear filters
                </button>
              )}
            </div>

            <div className="support-ticket-cards">
              {filteredTickets.map((ticket) => (
                <article className="support-ticket-card" key={ticket.ticketId}>
                  <div className="support-ticket-card__header">
                    <div className="support-ticket-card__id-group">
                      <span className="support-ticket-id-badge">{ticket.ticketId}</span>
                      <span className="support-ticket-category-tag">{ticket.category}</span>
                      <span className={`support-priority-tag is-${ticket.priority?.toLowerCase() || 'medium'}`}>
                        <span className="support-priority-dot" aria-hidden="true" />
                        {ticket.priority || 'Medium'}
                      </span>
                    </div>
                    <span className={`support-status is-${ticket.status.toLowerCase().replaceAll(' ', '-')}`}>
                      {ticket.status}
                    </span>
                  </div>

                  <h3 className="support-ticket-card__subject">
                    <Link to={`/student/help/requests/${encodeURIComponent(ticket.ticketId)}`}>
                      {ticket.subject}
                    </Link>
                  </h3>

                  <div className="support-ticket-card__footer">
                    <div className="support-ticket-card__dates">
                      <span className="support-date-item">
                        <span className="support-date-label">Created:</span>
                        <span>{new Date(ticket.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</span>
                      </span>
                      <span className="support-date-dot" aria-hidden="true">·</span>
                      <span className="support-date-item">
                        <span className="support-date-label">Updated:</span>
                        <span>{new Date(ticket.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</span>
                      </span>
                    </div>

                    <Link
                      className="support-details-link"
                      to={`/student/help/requests/${encodeURIComponent(ticket.ticketId)}`}
                    >
                      <span>View Details</span>
                      <Icon name="arrow" />
                    </Link>
                  </div>
                </article>
              ))}
            </div>
          </div>
        )}
      </section>
    </div>
  )
}

export function SupportTicketDetailPage({ onLogout }) {
  const { ticketId } = useParams()
  const navigate = useNavigate()
  const [ticket, setTicket] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [isSessionExpired, setIsSessionExpired] = useState(false)
  const [reply, setReply] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [notice, setNotice] = useState('')

  const fetchTicket = async () => {
    try {
      setLoading(true)
      setError('')
      setIsSessionExpired(false)
      const result = await supportRequest(`/tickets/${encodeURIComponent(ticketId)}`, {}, onLogout)
      setTicket(result.ticket)
    } catch (requestError) {
      if (requestError?.isSessionExpired) {
        setIsSessionExpired(true)
      }
      setError(requestError instanceof Error ? requestError.message : 'Support request could not be loaded.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchTicket()
  }, [ticketId])

  async function sendReply(event) {
    event.preventDefault()
    setIsSubmitting(true)
    setError('')
    setNotice('')
    try {
      const result = await supportRequest(
        `/tickets/${encodeURIComponent(ticketId)}/messages`,
        {
          method: 'POST',
          body: JSON.stringify({ message: reply }),
        },
        onLogout,
      )
      setTicket(result.ticket)
      setReply('')
      setNotice('Your reply was added successfully.')
    } catch (requestError) {
      if (requestError?.isSessionExpired) {
        setIsSessionExpired(true)
      }
      setError(requestError instanceof Error ? requestError.message : 'Your reply could not be sent.')
    } finally {
      setIsSubmitting(false)
    }
  }

  async function downloadAttachment() {
    try {
      const response = await fetch(
        `${API_BASE_URL}/support/tickets/${encodeURIComponent(ticketId)}/attachment?id=${encodeURIComponent(ticket.attachment.id)}`,
        { headers: { Authorization: `Bearer ${getToken(onLogout)}` } },
      )
      if (!response.ok) {
        const result = await response.json().catch(() => ({}))
        throw new Error(result.message || 'The attachment could not be downloaded.')
      }
      const url = URL.createObjectURL(await response.blob())
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = ticket.attachment.fileName
      anchor.click()
      URL.revokeObjectURL(url)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'The attachment could not be downloaded.')
    }
  }

  const canReply =
    ticket && ['Open', 'In Progress', 'Waiting for Student', 'Waiting for User'].includes(ticket.status)
  const isCompleted = ticket && ['Resolved', 'Closed'].includes(ticket.status)
  const created = window.history.state?.usr?.created

  return (
    <div className="support-center-page">
      <Link className="support-back-link" to="/student/help/requests">
        <span aria-hidden="true">←</span> Back to My Support Requests
      </Link>

      <section className="student-panel student-route-page support-page-panel">
        <div className="student-section-heading">
          <div>
            <span className="student-eyebrow">{ticket?.ticketId || 'SUPPORT REQUEST'}</span>
            <h2>{ticket?.subject || 'Support Request Details'}</h2>
          </div>
        </div>

        {isSessionExpired ? (
          <div className="support-notice is-warning" role="alert">
            <div className="support-session-alert">
              <span>Your session has expired. Please sign in again to view your ticket.</span>
              <Link to="/login" className="student-button" style={{ padding: '6px 14px', fontSize: '12px' }}>
                Sign In Again
              </Link>
            </div>
          </div>
        ) : loading ? (
          <div className="support-loading-container" role="status">
            <div className="support-loading-spinner" />
            <p className="support-loading">Loading support request…</p>
          </div>
        ) : error && !ticket ? (
          <div className="support-notice is-error" role="alert">
            <div className="support-session-alert">
              <span>{error}</span>
              <button type="button" className="student-button student-button--quiet" onClick={fetchTicket}>
                Retry
              </button>
            </div>
          </div>
        ) : ticket ? (
          <div className="support-ticket-detail">
            {created && (
              <div className="support-notice is-success" role="status">
                Your support request was submitted. Ticket ID: <strong>{ticket.ticketId}</strong>
              </div>
            )}
            {notice && (
              <div className="support-notice is-success" role="status">
                {notice}
              </div>
            )}
            {error && (
              <div className="support-notice is-error" role="alert">
                {error}
              </div>
            )}

            {/* Ticket Summary Header Bar */}
            <div className="support-ticket-summary">
              <span>
                <strong>Category</strong>
                {ticket.category}
              </span>
              <span>
                <strong>Priority</strong>
                <span className={`support-priority-tag is-${ticket.priority?.toLowerCase() || 'medium'}`}>
                  {ticket.priority}
                </span>
              </span>
              <span>
                <strong>Status</strong>
                <span className={`support-status is-${ticket.status.toLowerCase().replaceAll(' ', '-')}`}>
                  {ticket.status}
                </span>
              </span>
              <span>
                <strong>Submitted</strong>
                {new Date(ticket.createdAt).toLocaleString()}
              </span>
              {ticket.resolvedAt && (
                <span>
                  <strong>Resolved</strong>
                  {new Date(ticket.resolvedAt).toLocaleString()}
                </span>
              )}
            </div>

            {/* Original Request Details */}
            <section className="support-ticket-description">
              <h3>Original Request</h3>
              <p>{ticket.description}</p>
              {ticket.attachment && (
                <button className="support-text-button" type="button" onClick={downloadAttachment}>
                  <Icon name="download" /> Download Attachment: {ticket.attachment.fileName}
                </button>
              )}
            </section>

            {/* Section 3: Conversation / Message History */}
            <section className="support-conversation" aria-label="Ticket conversation">
              <h3>Conversation History</h3>
              {ticket.messages?.length || ticket.replies?.length ? (
                <div className="support-messages-stream">
                  {(ticket.messages || ticket.replies).map((item) => {
                    const isAdmin = item.authorRole === 'admin'
                    return (
                      <article
                        className={`support-message is-${item.authorRole}`}
                        key={item._id || `${item.authorId}-${item.createdAt}`}
                      >
                        <div className="support-message__header">
                          <div className="support-message__author">
                            <span className={`support-author-pill is-${item.authorRole}`}>
                              {isAdmin ? 'Support Team' : 'You (Student)'}
                            </span>
                          </div>
                          <time className="support-message__time">
                            {new Date(item.createdAt).toLocaleString()}
                          </time>
                        </div>
                        <p className="support-message__body">{item.message}</p>
                      </article>
                    )
                  })}
                </div>
              ) : (
                <div className="support-no-replies-box">
                  <Icon name="lifeBuoy" />
                  <p>
                    No replies yet. Our support team has received your ticket and will follow up here.
                  </p>
                </div>
              )}
            </section>

            {/* Status History Timeline */}
            <section className="support-status-history">
              <h3>Status History</h3>
              {ticket.statusHistory?.length ? (
                <ol className="support-status-timeline">
                  {ticket.statusHistory.map((entry, index) => (
                    <li key={entry._id || index}>
                      <span>
                        {entry.from ? `${entry.from} → ` : 'Created as '}
                        <strong>{entry.to}</strong> by {entry.changedByRole === 'admin' ? 'Support Team' : 'Student'}
                      </span>
                      <time>{new Date(entry.createdAt).toLocaleString()}</time>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="support-muted">No status transitions recorded.</p>
              )}
            </section>

            {/* Reply Area or Closed Notice */}
            {canReply ? (
              <form className="support-form support-reply-form" onSubmit={sendReply}>
                <label>
                  Add a reply
                  <textarea
                    value={reply}
                    onChange={(event) => setReply(event.currentTarget.value)}
                    required
                    minLength={1}
                    maxLength={5000}
                    rows={4}
                    placeholder="Type your message or response to the support team here..."
                  />
                </label>
                <button className="student-button" type="submit" disabled={isSubmitting || !reply.trim()}>
                  <Icon name="send" /> {isSubmitting ? 'Sending…' : 'Send reply'}
                </button>
              </form>
            ) : isCompleted ? (
              <div className="support-ticket-closed-banner">
                <span className="support-ticket-closed-icon">
                  <Icon name="check" />
                </span>
                <div>
                  <strong>This support request is {ticket.status.toLowerCase()}.</strong>
                  <p>
                    Replies are disabled for resolved or closed tickets. If you have an additional inquiry or need further help, please create a new support request.
                  </p>
                </div>
                <Link to="/student/help/requests" className="student-button student-button--secondary">
                  Back to My Requests
                </Link>
              </div>
            ) : null}

            <div className="support-detail-footer-actions">
              <button
                className="student-button student-button--quiet"
                type="button"
                onClick={() => navigate('/student/help/requests')}
              >
                ← Back to My Support Requests
              </button>
            </div>
          </div>
        ) : null}
      </section>
    </div>
  )
}

const faqsByCategory = [
  {
    id: 'account-registration',
    category: 'Account and Registration',
    icon: 'user',
    description: 'Registration, student credentials, and profile management',
    items: [
      {
        id: 'create-account',
        question: 'How do I create an account?',
        answer: (
          <>
            <p>
              Account creation depends on whether you are joining independently or through an affiliated college:
            </p>
            <ul>
              <li>
                <strong>Independent Students:</strong> You can create your own account using the public registration form at <Link to="/register">Register as an Independent Student</Link>. Fill in your name, email, password, how you heard about us, and an optional referral code. Once submitted, your registration will be reviewed and activated by the platform administrator.
              </li>
              <li>
                <strong>College Students:</strong> College student accounts are created directly by your college administrator. Your institution assigns your department, batch, and provides your student login credentials. No public registration is required.
              </li>
            </ul>
          </>
        ),
        plainText: 'Account creation depends on whether you are joining independently or through an affiliated college. Independent Students register at Register. College Students receive credentials from their college administrator.',
        tags: ['register', 'signup', 'account', 'create', 'new user', 'credentials', 'independent', 'college'],
      },
      {
        id: 'change-username',
        question: 'Can I change my username?',
        answer: (
          <>
            <p>
              Direct username modifications are not currently available from the student dashboard to preserve academic grading records and institutional batch alignment.
            </p>
            <p>
              If your username contains a typographical error or you require an official name update, please reach out by submitting a ticket via <Link to="/student/help/submit-ticket">Submit a Support Ticket</Link> or contact your college administrator.
            </p>
          </>
        ),
        plainText: 'Direct username self-modification is not currently available from the student dashboard to preserve academic records. Contact support or your college administrator.',
        tags: ['username', 'change', 'handle', 'name', 'rename'],
      },
      {
        id: 'update-profile-info',
        question: 'How do I update my profile information?',
        answer: (
          <>
            <p>
              You can review your account details, registered email address, and student classification anytime in <Link to="/student/profile">My Profile</Link>.
            </p>
            <ul>
              <li>
                To update your interface preferences (such as Light, Dark, or System theme), visit <Link to="/student/settings">Settings</Link>.
              </li>
              <li>
                For corrections to your legal name or registered email address, please contact your college administration coordinator or submit a ticket through <Link to="/student/help/submit-ticket">Support</Link>.
              </li>
            </ul>
          </>
        ),
        plainText: 'Review your account information in My Profile. Update theme preferences in Settings. Contact college admin or support for official name or email changes.',
        tags: ['profile', 'update', 'edit', 'settings', 'email', 'avatar', 'theme'],
      },
    ],
  },
  {
    id: 'login-security',
    category: 'Login and Security',
    icon: 'lock',
    description: 'Sign in, session access, and account protection',
    items: [
      {
        id: 'how-do-i-sign-in',
        question: 'How do I sign in?',
        answer: (
          <>
            <p>
              aiHustle uses a single unified sign-in portal for all students, college administrators, and main administrators:
            </p>
            <ol>
              <li>Go to the main sign-in page at <Link to="/login">Sign In</Link>.</li>
              <li>Enter your registered email address (or username) and password.</li>
              <li>The system automatically detects your role and redirects you to your respective dashboard.</li>
              <li>If your account is linked with Google, you can sign in directly with <strong>Sign in with Google</strong>.</li>
            </ol>
          </>
        ),
        plainText: 'Go to Sign In, enter your email or username and password. The system auto-detects your role. Google sign-in is also supported.',
        tags: ['login', 'signin', 'password', 'credentials', 'google', 'role', 'portal'],
      },
      {
        id: 'can-i-reset-password',
        question: 'Can I reset my password?',
        answer: (
          <>
            <p>
              Automated self-service password reset is not currently connected in the LMS.
            </p>
            <p>
              If you forgot your password or cannot access your account:
            </p>
            <ul>
              <li><strong>College Students:</strong> Reach out to your college department coordinator or administrator to reset your student password.</li>
              <li><strong>Independent Students:</strong> Contact our team via <Link to="/student/help/submit-ticket">Submit a Support Ticket</Link> or reach out via email. For your security, never share passwords in ticket messages.</li>
            </ul>
          </>
        ),
        plainText: 'Self-service password reset is not currently connected. College students contact college admin. Independent students submit a support ticket.',
        tags: ['reset', 'forgot', 'password', 'recover', 'locked out'],
      },
      {
        id: 'how-to-secure-account',
        question: 'How do I secure my account?',
        answer: (
          <>
            <p>
              To maintain optimal security for your learning records and account:
            </p>
            <ul>
              <li>Use a strong, unique password and keep your credentials confidential.</li>
              <li>Always sign out of your session when accessing the LMS on public computers or shared devices using the <strong>Log out</strong> button.</li>
              <li>Never disclose your account authentication token or password to anyone.</li>
              <li>If you detect any suspicious activity or unauthorized access, report it immediately via <Link to="/student/help/submit-ticket?category=Technical+Issue" state={{ category: 'Technical Issue' }}>Report a Problem</Link>.</li>
            </ul>
          </>
        ),
        plainText: 'Use a strong password, keep credentials confidential, log out on shared computers, and report suspicious activity via Report a Problem.',
        tags: ['security', 'password', 'logout', 'safety', 'protect', 'unauthorized'],
      },
    ],
  },
  {
    id: 'courses-learning',
    category: 'Courses and Learning',
    icon: 'book',
    description: 'Accessing modules, tracking progress, and video playback',
    items: [
      {
        id: 'where-find-course-content',
        question: 'Where do I find course content?',
        answer: (
          <>
            <p>
              All course materials and modules are housed in <Link to="/student/courses">My Courses</Link>.
            </p>
            <p>
              Clicking on any course opens the syllabus breakdown, module overview, and individual lesson reading units and lectures.
            </p>
          </>
        ),
        plainText: 'All course materials and modules are housed in My Courses. Click any course to view syllabus, modules, and lessons.',
        tags: ['courses', 'content', 'lessons', 'find', 'syllabus', 'modules'],
      },
      {
        id: 'how-track-course-progress',
        question: 'How do I track my course progress?',
        answer: (
          <>
            <p>
              You can track your educational milestones across several areas:
            </p>
            <ul>
              <li><strong>Course Status:</strong> In <Link to="/student/courses">My Courses</Link>, courses display status badges such as <em>Enrolled</em>, <em>In Progress</em>, or <em>Completed</em>.</li>
              <li><strong>Study Activity:</strong> View your active study calendar and continuous daily habits in <Link to="/student/learning-activity">Learning Streak</Link>.</li>
              <li><strong>Achievements:</strong> Finished courses and milestone accomplishments are highlighted in <Link to="/student/achievements">My Achievements</Link>.</li>
            </ul>
          </>
        ),
        plainText: 'Track status badges in My Courses. View daily activity in Learning Streak. See completed courses in My Achievements.',
        tags: ['progress', 'track', 'streak', 'achievements', 'completion', 'status'],
      },
      {
        id: 'can-resume-lesson',
        question: 'Can I resume a lesson where I left off?',
        answer: (
          <>
            <p>
              Yes! When you open a course in <Link to="/student/courses">My Courses</Link>, the course viewer maintains lesson URL anchors and highlights the currently selected lesson. You can pick up your studies right where you left off.
            </p>
          </>
        ),
        plainText: 'Yes, opening a course in My Courses maintains lesson anchors and highlights your selected lesson so you can resume where you left off.',
        tags: ['resume', 'continue', 'bookmark', 'lesson', 'leave off'],
      },
      {
        id: 'can-watch-videos-again',
        question: 'Can I watch videos again?',
        answer: (
          <>
            <p>
              Yes, you have unlimited re-watch access to all lectures and video lessons throughout your active enrollment. You can revisit lessons at any time from <Link to="/student/courses">My Courses</Link> to review key concepts or prepare for exams.
            </p>
          </>
        ),
        plainText: 'Yes, you have unlimited re-watch access to all lectures and video lessons throughout your active enrollment in My Courses.',
        tags: ['video', 'watch', 'replay', 'rewatch', 'media', 'lecture'],
      },
      {
        id: 'how-access-course-modules',
        question: 'How do I access course modules?',
        answer: (
          <>
            <p>
              To view course modules:
            </p>
            <ol>
              <li>Navigate to <Link to="/student/courses">My Courses</Link>.</li>
              <li>Select any enrolled course from your list.</li>
              <li>The course detail view presents each module with its description and expandable list of lesson topics.</li>
            </ol>
          </>
        ),
        plainText: 'Go to My Courses, click on your enrolled course, and view the module breakdown with lesson topics in sequence.',
        tags: ['modules', 'units', 'chapters', 'syllabus', 'lessons', 'topics'],
      },
    ],
  },
  {
    id: 'enrollments',
    category: 'Enrollments',
    icon: 'spark',
    description: 'Course enrollment procedures for independent and college students',
    items: [
      {
        id: 'how-enroll-in-course',
        question: 'How can I enroll in a course?',
        answer: (
          <>
            <p>
              Course enrollment depends on your student profile:
            </p>
            <ul>
              <li>
                <strong>Independent Students:</strong> Open <Link to="/student/courses">My Courses</Link> and browse the <em>Published courses</em> catalog. Click <strong>Enroll</strong> on any course card to enroll immediately.
              </li>
              <li>
                <strong>College Students:</strong> Course enrollments are handled centrally by your college administrator or department head. Courses assigned to your batch will appear automatically in your dashboard.
              </li>
            </ul>
          </>
        ),
        plainText: 'Independent students click Enroll on published courses in My Courses. College students are enrolled centrally by their college administrator.',
        tags: ['enroll', 'join', 'registration', 'course', 'add course', 'catalog'],
      },
      {
        id: 'where-find-enrolled-courses',
        question: 'Where can I find my enrolled courses?',
        answer: (
          <>
            <p>
              All courses you are currently enrolled in appear in <Link to="/student/courses">My Courses</Link> under <em>Current enrollments</em>.
            </p>
            <p>
              You can filter the list to view courses currently in progress or courses you have already completed.
            </p>
          </>
        ),
        plainText: 'All enrolled courses appear in My Courses under Current enrollments. You can filter by in-progress or completed.',
        tags: ['enrolled', 'my courses', 'active', 'filter', 'classes', 'list'],
      },
    ],
  },
  {
    id: 'assignments-results',
    category: 'Assignments and Results',
    icon: 'list',
    description: 'Submissions, evaluations, grading, and score reports',
    items: [
      {
        id: 'where-assignments-and-grades',
        question: 'Where are my assignments and grades?',
        answer: (
          <>
            <p>
              Academic tasks and evaluation records are available in two main areas:
            </p>
            <ul>
              <li>View pending homework, project requirements, and due dates in <Link to="/student/assignments">Assignments</Link>.</li>
              <li>Check official marks, exam evaluations, and grade cards in <Link to="/student/results">Grades &amp; Results</Link>.</li>
            </ul>
          </>
        ),
        plainText: 'Pending tasks and homework are in Assignments. Official marks, exams, and grades are in Grades & Results.',
        tags: ['assignments', 'grades', 'results', 'scores', 'marks', 'report card'],
      },
      {
        id: 'how-submit-assignment',
        question: 'How do I submit an assignment?',
        answer: (
          <>
            <p>
              When an assignment is assigned:
            </p>
            <ol>
              <li>Go to <Link to="/student/assignments">Assignments</Link> or the specific module in <Link to="/student/courses">My Courses</Link>.</li>
              <li>Open the assignment prompt to inspect submission instructions and deadlines.</li>
              <li>Upload your work or paste your solution as directed by your instructor.</li>
            </ol>
            <p>
              <em>Note:</em> Assignment submissions are activated by your instructor or college department. If a course has not enabled submissions yet, check back closer to the announced due date.
            </p>
          </>
        ),
        plainText: 'Go to Assignments, review instructions and deadlines, then upload your work or paste your solution. Submissions are activated by instructors.',
        tags: ['submit', 'upload', 'assignment', 'homework', 'task', 'instructions'],
      },
      {
        id: 'can-resubmit-assignment',
        question: 'Can I resubmit an assignment?',
        answer: (
          <>
            <p>
              Resubmission policies are determined by your course instructor or institution. If resubmissions are allowed for your assessment, you will see an option to upload an updated submission prior to the deadline in <Link to="/student/assignments">Assignments</Link>.
            </p>
            <p>
              Once a submission has been graded and finalized by your instructor, updates generally require approval from your instructor or college administrator.
            </p>
          </>
        ),
        plainText: 'Resubmission depends on instructor policy. If permitted, an update option is visible before the deadline in Assignments. Finalized grades require instructor approval.',
        tags: ['resubmit', 'retry', 'edit submission', 'deadline', 'late submission'],
      },
      {
        id: 'how-check-quiz-scores',
        question: 'How can I check my quiz scores?',
        answer: (
          <>
            <p>
              Quiz and examination results are published in <Link to="/student/results">Grades &amp; Results</Link>.
            </p>
            <p>
              If you recently completed an assessment and the score is not visible, allow time for automated grading processing or instructor verification.
            </p>
          </>
        ),
        plainText: 'Quiz and exam results are published in Grades & Results. Allow time for automated grading or instructor evaluation.',
        tags: ['quiz', 'scores', 'test', 'exam', 'marks', 'results', 'evaluation'],
      },
    ],
  },
  {
    id: 'certificates',
    category: 'Certificates',
    icon: 'award',
    description: 'Course completion credentials, verification, and downloads',
    items: [
      {
        id: 'where-access-certificates',
        question: 'Where can I access certificates?',
        answer: (
          <>
            <p>
              All completion certificates are located in <Link to="/student/certificates">Certificates</Link> in the student sidebar.
            </p>
            <p>
              This section collects all verified credentials you earn across completed courses.
            </p>
          </>
        ),
        plainText: 'All completion certificates are located in Certificates in the student sidebar.',
        tags: ['certificates', 'credentials', 'diploma', 'achievements', 'access'],
      },
      {
        id: 'when-receive-certificate',
        question: 'When will I receive my certificate?',
        answer: (
          <>
            <p>
              Certificates are generated once you have satisfied all completion requirements:
            </p>
            <ul>
              <li>Complete 100% of the lessons in an eligible course.</li>
              <li>Pass all required quizzes or module assessments.</li>
              <li>Receive completion verification from your instructor or administrator.</li>
            </ul>
            <p>
              Upon verification, your certificate will appear automatically in <Link to="/student/certificates">Certificates</Link>.
            </p>
          </>
        ),
        plainText: 'Certificates are generated after completing 100% of course lessons, passing assessments, and administrator verification.',
        tags: ['when', 'receive', 'issue', 'unlock', 'completion', 'eligibility'],
      },
      {
        id: 'how-download-certificate',
        question: 'How do I download my certificate?',
        answer: (
          <>
            <p>
              Go to <Link to="/student/certificates">Certificates</Link>. When you have an earned credential, click on the certificate card to view and download your high-resolution PDF document.
            </p>
            <p>
              You can also share your certificate ID or link on your professional resume or LinkedIn profile.
            </p>
          </>
        ),
        plainText: 'Go to Certificates, click on your earned credential to view and download your official PDF document.',
        tags: ['download', 'save', 'pdf', 'export', 'print certificate', 'share'],
      },
    ],
  },
  {
    id: 'purchases-payments',
    category: 'Purchases and Payments',
    icon: 'creditCard',
    description: 'Order history, invoices, payment status, and refund inquiries',
    items: [
      {
        id: 'where-see-purchases-invoices',
        question: 'Where can I see purchases or invoices?',
        answer: (
          <>
            <p>
              You can view purchase history and invoices in <Link to="/student/purchases">My Purchases</Link>.
            </p>
            <p>
              <em>For College Students:</em> Course licensing and materials are provided through your college or institution, so individual student billing invoices are not issued.
            </p>
          </>
        ),
        plainText: 'View purchase history and invoices in My Purchases. College student courses are funded by the institution.',
        tags: ['purchases', 'invoices', 'receipts', 'billing', 'orders', 'payments'],
      },
      {
        id: 'how-check-payment-status',
        question: 'How can I check my payment status?',
        answer: (
          <>
            <p>
              Check the status of course orders and transactions in <Link to="/student/purchases">My Purchases</Link>.
            </p>
            <p>
              Completed payments will immediately show active course access in <Link to="/student/courses">My Courses</Link>.
            </p>
          </>
        ),
        plainText: 'Check the status of course orders in My Purchases. Completed payments immediately unlock courses in My Courses.',
        tags: ['status', 'payment status', 'pending', 'confirmed', 'order'],
      },
      {
        id: 'what-if-payment-fails',
        question: 'What should I do if my payment fails?',
        answer: (
          <>
            <p>
              If a transaction does not go through:
            </p>
            <ul>
              <li>Check with your bank to verify that online or international transactions are enabled on your card.</li>
              <li>Confirm your card number, expiration date, and CVV.</li>
              <li>If money was deducted from your account but your course was not activated, submit a ticket via <Link to="/student/help/submit-ticket?category=Payments+and+Purchases" state={{ category: 'Payments and Purchases' }}>Submit a Support Ticket</Link> under <strong>Payments and Purchases</strong> with your bank transaction reference so we can credit and activate your account.</li>
            </ul>
          </>
        ),
        plainText: 'Verify card details with your bank. If money was deducted without course activation, submit a support ticket under Payments and Purchases.',
        tags: ['failed', 'payment failed', 'declined', 'deducted', 'transaction error'],
      },
      {
        id: 'how-request-refund',
        question: 'How can I request a refund?',
        answer: (
          <>
            <p>
              Refund requests are evaluated under our student enrollment policy.
            </p>
            <p>
              To submit a refund request, navigate to <Link to="/student/help/submit-ticket?category=Payments+and+Purchases" state={{ category: 'Payments and Purchases' }}>Submit a Support Ticket</Link>, choose <strong>Payments and Purchases</strong>, and provide your course name, date of purchase, and reason for the request. Our support team will assist you within 1-2 business days.
            </p>
          </>
        ),
        plainText: 'Submit a refund request via Submit a Support Ticket under Payments and Purchases with your course name and purchase date.',
        tags: ['refund', 'money back', 'cancel', 'return', 'reimbursement'],
      },
    ],
  },
  {
    id: 'technical-issues',
    category: 'Technical Issues',
    icon: 'tool',
    description: 'Video streaming, browser compatibility, and troubleshooting',
    items: [
      {
        id: 'video-not-playing',
        question: 'What should I do if a video is not playing?',
        answer: (
          <>
            <p>
              If a lecture video is buffering or will not start, please try the following steps:
            </p>
            <ul>
              <li><strong>Refresh your browser:</strong> Often a simple page reload restores the video stream.</li>
              <li><strong>Check your connection:</strong> Ensure you have a stable network connection.</li>
              <li><strong>Clear cache:</strong> Clear your browser cache and cookies, then sign back in.</li>
              <li><strong>Disable conflicting extensions:</strong> Some ad-blocking or privacy extensions block embedded media players. Try opening the lesson in an incognito/private window.</li>
              <li><strong>Try an alternate browser:</strong> Test with Chrome, Edge, Safari, or Firefox.</li>
            </ul>
            <p>
              If the video continues to fail, report it via <Link to="/student/help/submit-ticket?category=Technical+Issue" state={{ category: 'Technical Issue' }}>Report a Problem</Link> including the course and lesson title.
            </p>
          </>
        ),
        plainText: 'Refresh browser, check internet connection, clear cache, disable ad-blockers, or try another browser. If it still fails, submit a ticket under Report a Problem.',
        tags: ['video', 'not playing', 'buffering', 'black screen', 'playback', 'media'],
      },
      {
        id: 'course-page-not-loading',
        question: 'What if a course page is not loading?',
        answer: (
          <>
            <p>
              If a course page appears blank or stops responding:
            </p>
            <ul>
              <li>Check your internet connection and reload the page.</li>
              <li>Verify that your session is still valid. If your session expired, sign in again at <Link to="/login">Sign In</Link>.</li>
              <li>Perform a hard refresh (<kbd>Ctrl+F5</kbd> on Windows or <kbd>Cmd+Shift+R</kbd> on Mac).</li>
            </ul>
            <p>
              If the issue persists, let us know through <Link to="/student/help/submit-ticket?category=Technical+Issue" state={{ category: 'Technical Issue' }}>Report a Problem</Link>.
            </p>
          </>
        ),
        plainText: 'Check internet connection, verify active login session, and hard refresh. If unresolved, submit a ticket under Report a Problem.',
        tags: ['loading', 'blank', 'stuck', 'error', 'page not loading', 'crash'],
      },
      {
        id: 'supported-browsers',
        question: 'Which browsers are supported?',
        answer: (
          <>
            <p>
              aiHustle is optimized for modern, standards-compliant web browsers:
            </p>
            <ul>
              <li><strong>Google Chrome:</strong> Version 100+ (Recommended)</li>
              <li><strong>Microsoft Edge:</strong> Version 100+</li>
              <li><strong>Mozilla Firefox:</strong> Version 100+</li>
              <li><strong>Apple Safari:</strong> Version 15+ (macOS, iPadOS, iOS)</li>
            </ul>
            <p>
              Ensure JavaScript and local storage are enabled for full interactive features.
            </p>
          </>
        ),
        plainText: 'Supported browsers include modern Google Chrome, Microsoft Edge, Mozilla Firefox, and Apple Safari. Ensure JavaScript and local storage are enabled.',
        tags: ['browsers', 'chrome', 'firefox', 'safari', 'edge', 'compatibility', 'requirements'],
      },
    ],
  },
]

export function SupportFaqPage() {
  const [search, setSearch] = useState('')
  const [selectedCategory, setSelectedCategory] = useState('all')
  const [openItems, setOpenItems] = useState({})
  const [feedback, setFeedback] = useState({})

  const normalizedSearch = search.trim().toLowerCase()

  const filteredCategories = faqsByCategory
    .map((cat) => {
      if (selectedCategory !== 'all' && cat.id !== selectedCategory) {
        return null
      }
      const matchingItems = cat.items.filter((item) => {
        if (!normalizedSearch) return true
        const textToSearch = `${item.question} ${item.plainText} ${item.tags.join(' ')} ${cat.category}`.toLowerCase()
        return textToSearch.includes(normalizedSearch)
      })
      if (!matchingItems.length) return null
      return {
        ...cat,
        items: matchingItems,
      }
    })
    .filter(Boolean)

  const totalResults = filteredCategories.reduce((acc, cat) => acc + cat.items.length, 0)
  const totalAllQuestions = faqsByCategory.reduce((acc, cat) => acc + cat.items.length, 0)

  const isItemOpen = (itemId) => {
    if (normalizedSearch) {
      return openItems[itemId] !== false
    }
    return Boolean(openItems[itemId])
  }

  const toggleItem = (itemId) => {
    setOpenItems((prev) => {
      const currentlyOpen = isItemOpen(itemId)
      return {
        ...prev,
        [itemId]: !currentlyOpen,
      }
    })
  }

  const allCurrentItemsOpen =
    totalResults > 0 &&
    filteredCategories.every((cat) => cat.items.every((item) => isItemOpen(item.id)))

  const toggleAll = () => {
    const nextState = !allCurrentItemsOpen
    const next = {}
    filteredCategories.forEach((cat) => {
      cat.items.forEach((item) => {
        next[item.id] = nextState
      })
    })
    setOpenItems(next)
  }

  const handleFeedback = (itemId, vote) => {
    setFeedback((prev) => ({
      ...prev,
      [itemId]: vote,
    }))
  }

  const clearSearch = () => {
    setSearch('')
  }

  return (
    <div className="support-center-page faq-support-center-page">
      <Link className="support-back-link" to="/student/help">
        <span aria-hidden="true">←</span> Back to Help Center
      </Link>

      <section className="faq-header-hero">
        <span className="student-eyebrow">AIHUSTLE SUPPORT &amp; HELP CENTER</span>
        <h1>How can we help you?</h1>
        <p>Find answers to common questions and learn how to make the most of aiHustle.</p>

        <div className="faq-search-bar-wrapper">
          <div className="faq-search-input-box">
            <span className="faq-search-icon" aria-hidden="true">
              <Icon name="search" />
            </span>
            <input
              id="faq-search-input"
              type="search"
              placeholder="Search by keywords, questions, or topics (e.g. enroll, certificates, password)..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search FAQs"
            />
            {search && (
              <button
                type="button"
                className="faq-search-clear-btn"
                onClick={clearSearch}
                aria-label="Clear search input"
                title="Clear search"
              >
                <Icon name="clear" />
              </button>
            )}
          </div>
        </div>

        <div className="faq-category-pills" role="tablist" aria-label="FAQ categories">
          <button
            type="button"
            role="tab"
            aria-selected={selectedCategory === 'all'}
            className={`faq-category-pill${selectedCategory === 'all' ? ' is-active' : ''}`}
            onClick={() => setSelectedCategory('all')}
          >
            <span>All Questions</span>
            <small className="faq-category-count">{totalAllQuestions}</small>
          </button>
          {faqsByCategory.map((cat) => (
            <button
              key={cat.id}
              type="button"
              role="tab"
              aria-selected={selectedCategory === cat.id}
              className={`faq-category-pill${selectedCategory === cat.id ? ' is-active' : ''}`}
              onClick={() => setSelectedCategory(cat.id)}
            >
              <Icon name={cat.icon} />
              <span>{cat.category}</span>
              <small className="faq-category-count">{cat.items.length}</small>
            </button>
          ))}
        </div>
      </section>

      <div className="faq-content-container">
        <div className="faq-list-toolbar">
          <div className="faq-list-toolbar__meta">
            {normalizedSearch ? (
              <span>
                Found <strong>{totalResults}</strong> result{totalResults === 1 ? '' : 's'} for &ldquo;{search}&rdquo;
                {selectedCategory !== 'all' ? ` in ${faqsByCategory.find((c) => c.id === selectedCategory)?.category}` : ''}
              </span>
            ) : selectedCategory !== 'all' ? (
              <span>
                Showing <strong>{totalResults}</strong> questions in{' '}
                <strong>{faqsByCategory.find((c) => c.id === selectedCategory)?.category}</strong>
              </span>
            ) : (
              <span>
                Showing all <strong>{totalAllQuestions}</strong> questions across {faqsByCategory.length} categories
              </span>
            )}
          </div>
          {totalResults > 0 && (
            <button
              type="button"
              className="faq-toolbar-toggle-btn"
              onClick={toggleAll}
              aria-label={allCurrentItemsOpen ? 'Collapse all FAQ answers' : 'Expand all FAQ answers'}
            >
              {allCurrentItemsOpen ? 'Collapse All' : 'Expand All'}
            </button>
          )}
        </div>

        {filteredCategories.length > 0 ? (
          <div className="faq-categories-stack">
            {filteredCategories.map(({ id, category, icon, description, items }) => (
              <section className="faq-category-section" key={id} aria-labelledby={`faq-cat-${id}`}>
                <div className="faq-category-header">
                  <span className="faq-category-icon" aria-hidden="true">
                    <Icon name={icon} />
                  </span>
                  <div>
                    <h2 id={`faq-cat-${id}`} className="faq-category-title">
                      {category}
                    </h2>
                    {description && <p className="faq-category-desc">{description}</p>}
                  </div>
                </div>

                <div className="faq-accordion-group">
                  {items.map((item) => {
                    const open = isItemOpen(item.id)
                    const userFeedback = feedback[item.id]

                    return (
                      <article
                        className={`faq-accordion-item${open ? ' is-open' : ''}`}
                        key={item.id}
                      >
                        <button
                          type="button"
                          className="faq-accordion-header"
                          onClick={() => toggleItem(item.id)}
                          aria-expanded={open}
                          aria-controls={`faq-body-${item.id}`}
                          id={`faq-header-${item.id}`}
                        >
                          <span className="faq-question-text">{item.question}</span>
                          <span className="faq-accordion-chevron" aria-hidden="true">
                            <Icon name="chevronDown" />
                          </span>
                        </button>

                        {open && (
                          <div
                            id={`faq-body-${item.id}`}
                            className="faq-accordion-body"
                            role="region"
                            aria-labelledby={`faq-header-${item.id}`}
                          >
                            <div className="faq-answer-content">{item.answer}</div>

                            <div className="faq-feedback-container">
                              {userFeedback ? (
                                <div className="faq-feedback-response">
                                  <span className="faq-feedback-icon" aria-hidden="true">
                                    <Icon name={userFeedback === 'yes' ? 'check' : 'ticket'} />
                                  </span>
                                  <span>
                                    {userFeedback === 'yes'
                                      ? 'Thank you for your feedback!'
                                      : 'Thank you for letting us know.'}
                                  </span>
                                  {userFeedback === 'no' && (
                                    <Link
                                      to="/student/help/submit-ticket"
                                      className="faq-feedback-ticket-link"
                                    >
                                      Need more help? Contact Support →
                                    </Link>
                                  )}
                                  <span className="faq-feedback-status-pill">
                                    Saved locally · Feedback telemetry is not connected
                                  </span>
                                </div>
                              ) : (
                                <div className="faq-feedback-prompt">
                                  <span>Was this helpful?</span>
                                  <div className="faq-feedback-buttons">
                                    <button
                                      type="button"
                                      className="faq-feedback-btn"
                                      onClick={() => handleFeedback(item.id, 'yes')}
                                      aria-label={`Mark "${item.question}" as helpful`}
                                    >
                                      <Icon name="thumbsUp" />
                                      <span>Yes</span>
                                    </button>
                                    <button
                                      type="button"
                                      className="faq-feedback-btn"
                                      onClick={() => handleFeedback(item.id, 'no')}
                                      aria-label={`Mark "${item.question}" as not helpful`}
                                    >
                                      <Icon name="thumbsDown" />
                                      <span>No</span>
                                    </button>
                                  </div>
                                </div>
                              )}
                            </div>
                          </div>
                        )}
                      </article>
                    )
                  })}
                </div>
              </section>
            ))}
          </div>
        ) : (
          <div className="faq-empty-state">
            <div className="faq-empty-state__icon">
              <Icon name="search" />
            </div>
            <h3>No matching FAQs found</h3>
            <p>
              We couldn&rsquo;t find any questions matching &ldquo;<strong>{search}</strong>&rdquo;
              {selectedCategory !== 'all' ? ` in the selected category` : ''}.
              Try searching for different keywords or reset your filters below.
            </p>
            <div className="faq-empty-state__actions">
              {search && (
                <button type="button" className="student-button" onClick={clearSearch}>
                  <Icon name="clear" /> Clear search filter
                </button>
              )}
              {selectedCategory !== 'all' && (
                <button
                  type="button"
                  className="student-button student-button--secondary"
                  onClick={() => setSelectedCategory('all')}
                >
                  View all categories
                </button>
              )}
            </div>
          </div>
        )}

        <section className="faq-support-card" aria-labelledby="faq-support-heading">
          <div className="faq-support-card__content">
            <span className="faq-support-card__badge">
              <Icon name="lifeBuoy" /> STILL NEED HELP?
            </span>
            <h3 id="faq-support-heading" className="faq-support-card__title">
              Still need help?
            </h3>
            <p className="faq-support-card__desc">
              Can&rsquo;t find the answer you&rsquo;re looking for? Our support team is here to help.
            </p>
          </div>
          <div className="faq-support-card__actions">
            <Link to="/student/help/submit-ticket" className="faq-support-btn is-primary">
              <Icon name="ticket" /> Contact Support
            </Link>
            <Link
              to="/student/help/submit-ticket?category=Technical+Issue"
              state={{ category: 'Technical Issue' }}
              className="faq-support-btn is-secondary"
            >
              <Icon name="alertCircle" /> Report a Problem
            </Link>
          </div>
        </section>
      </div>
    </div>
  )
}
