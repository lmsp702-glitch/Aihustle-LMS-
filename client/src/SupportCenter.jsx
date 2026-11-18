import React, { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { API_BASE_URL } from './api-base-url.js'
import './SupportCenter.css'

const ticketCategories = [
  'Account and Login',
  'Course and Enrollment',
  'Assignments and Results',
  'Payments and Purchases',
  'Technical Issue',
  'Other',
]
const priorities = ['Low', 'Medium', 'High']
const ticketStatuses = ['Open', 'In Progress', 'Waiting for User', 'Resolved', 'Closed']

function getToken() {
  const storedAuth = sessionStorage.getItem('lms.auth')
  let token
  try {
    token = storedAuth ? JSON.parse(storedAuth)?.token : null
  } catch {
    throw new Error('Your saved session is invalid. Please sign in again.')
  }
  if (typeof token !== 'string' || !token) {
    throw new Error('Your session has expired. Please sign in again.')
  }
  return token
}

async function supportRequest(path, options = {}) {
  const headers = new Headers(options.headers)
  headers.set('Authorization', `Bearer ${getToken()}`)
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
    tag: <><path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V4h9l8.6 8.6a.6.6 0 0 1 0 .8Z" /><circle cx="7.5" cy="8" r="1" /></>,
    grid: <><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></>,
    flag: <><path d="M5 21V5m0 0c5-4 9 4 14 0v11c-5 4-9-4-14 0" /></>,
    document: <><path d="M7 3h7l5 5v13H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z" /><path d="M14 3v6h6M9 13h6m-6 4h6" /></>,
    send: <><path d="m22 2-7 20-4-9-9-4Z" /><path d="M22 2 11 13" /></>,
    reset: <><path d="M3 12a9 9 0 1 0 2.6-6.4L3 8" /><path d="M3 3v5h5" /><path d="M12 7v5l3 2" /></>,
    cloudUpload: <><path d="M17.5 19H9a7 7 0 1 1 6.7-9h1.8a4.5 4.5 0 0 1 0 9Z" /><path d="m9 15 3-3 3 3m-3-3v7" /></>,
  }
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths[name] || paths.faq}
    </svg>
  )
}

function SupportPage({ eyebrow, title, children, backTo = '/student/help', backLabel = 'Back to Help Center', className = '' }) {
  return (
    <div className="support-center-page">
      <Link className="support-back-link" to={backTo}><span aria-hidden="true">←</span> {backLabel}</Link>
      <section className={`student-panel student-route-page support-page-panel ${className}`}>
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
  const [profile, setProfile] = useState({
    fullName: user?.fullName || '',
    email: user?.email || '',
  })
  const [subject, setSubject] = useState('')
  const [message, setMessage] = useState('')
  const [profileError, setProfileError] = useState('')
  const [isLoadingProfile, setIsLoadingProfile] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const submissionLock = useRef(false)

  useEffect(() => {
    let active = true
    complaintRequest('/profile')
      .then((result) => {
        if (!result.student) throw new Error('Your student profile could not be loaded.')
        if (active) setProfile(result.student)
      })
      .catch((profileRequestError) => {
        if (active) {
          setProfileError(profileRequestError instanceof Error
            ? profileRequestError.message
            : 'Your student profile could not be loaded.')
        }
      })
      .finally(() => {
        if (active) setIsLoadingProfile(false)
      })
    return () => { active = false }
  }, [])

  async function submitEmail(event) {
    event.preventDefault()
    if (submissionLock.current) return
    submissionLock.current = true
    setIsSubmitting(true)
    setError('')
    setNotice('')
    try {
      const result = await complaintRequest('/email-support', {
        method: 'POST',
        body: JSON.stringify({ subject, message }),
      })
      setSubject('')
      setMessage('')
      if (result.emailSent === false) {
        setError(result.message || 'Your message was saved, but its email notification could not be sent. Please do not resubmit.')
      } else {
        setNotice(`Your support message ${result.complaint?.complaintId || ''} was sent successfully.`.trim())
      }
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Your support message could not be submitted.')
    } finally {
      submissionLock.current = false
      setIsSubmitting(false)
    }
  }

  return (
    <SupportPage eyebrow="CONTACT THE LMS TEAM" title="Email Support">
      <p className="support-page-intro">Your account name and email are securely added from your student profile.</p>
      {isLoadingProfile ? <p className="support-loading" role="status">Loading your profile…</p> : profileError ? (
        <div className="support-notice is-error" role="alert">{profileError}</div>
      ) : (
        <form className="support-form" onSubmit={submitEmail}>
          <div className="support-form__grid">
            <label>Name<input autoComplete="name" value={profile.fullName || ''} readOnly required /></label>
            <label>Email<input type="email" autoComplete="email" value={profile.email || ''} readOnly required /></label>
          </div>
          <label>Subject<input value={subject} onChange={(event) => {
            setSubject(event.currentTarget.value)
            setError('')
          }} required minLength={3} maxLength={160} disabled={isSubmitting} /></label>
          <label>Message<textarea value={message} onChange={(event) => {
            setMessage(event.currentTarget.value)
            setError('')
          }} required minLength={10} maxLength={10000} rows={7} disabled={isSubmitting} /></label>
          {error && <div className="support-notice is-error" role="alert">{error}</div>}
          {notice && <div className="support-notice is-success" role="status">{notice}</div>}
          <button className="student-button" type="submit" disabled={isSubmitting}>
            {isSubmitting ? 'Sending…' : 'Send support message'}
          </button>
        </form>
      )}
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

export function SubmitSupportTicketPage() {
  const navigate = useNavigate()
  const fileInputRef = useRef(null)
  const [values, setValues] = useState({ subject: '', category: '', priority: 'Medium', description: '' })
  const [otherCategoryDetail, setOtherCategoryDetail] = useState('')
  const [file, setFile] = useState(null)
  const [error, setError] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)

  function updateValue(event) {
    const { name, value } = event.currentTarget
    setValues((current) => ({ ...current, [name]: value }))
    if (name === 'category' && value !== 'Other') setOtherCategoryDetail('')
    setError('')
  }

  function updateOtherCategoryDetail(event) {
    setOtherCategoryDetail(event.currentTarget.value)
    setError('')
  }

  function setSelectedFile(selected, input) {
    if (selected && (selected.size > 5 * 1024 * 1024 || !['image/png', 'image/jpeg', 'image/webp', 'application/pdf'].includes(selected.type))) {
      setFile(null)
      if (input) input.value = ''
      else if (fileInputRef.current) fileInputRef.current.value = ''
      setError('Choose a PNG, JPEG, WebP, or PDF file no larger than 5 MB.')
      return
    }
    setFile(selected)
    setError('')
  }

  function updateFile(event) {
    setSelectedFile(event.currentTarget.files?.[0] || null, event.currentTarget)
  }

  function resetTicketForm() {
    setValues({ subject: '', category: '', priority: 'Medium', description: '' })
    setOtherCategoryDetail('')
    setFile(null)
    if (fileInputRef.current) fileInputRef.current.value = ''
    setError('')
  }

  async function submitTicket(event) {
    event.preventDefault()
    const otherDetails = values.category === 'Other' ? otherCategoryDetail.trim() : ''
    if (values.category === 'Other' && !otherDetails) {
      setError('Describe the other category before submitting.')
      return
    }
    const description = otherDetails
      ? `${values.description.trim()}\n\nOther category: ${otherDetails}`
      : values.description.trim()
    if (description.length > 10000) {
      setError('The description and other category details cannot exceed 10,000 characters.')
      return
    }
    setIsSubmitting(true)
    setError('')
    try {
      const attachment = file
        ? { fileName: file.name, contentType: file.type, data: await fileAsBase64(file) }
        : undefined
      const result = await supportRequest('/tickets', {
        method: 'POST',
        body: JSON.stringify({ ...values, description, ...(attachment ? { attachment } : {}) }),
      })
      navigate(`/student/help/requests/${encodeURIComponent(result.ticket.ticketId)}`, {
        replace: true,
        state: { created: true },
      })
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Your support ticket could not be submitted.')
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <SupportPage eyebrow="WE'RE HERE TO HELP" title="Submit a Support Ticket" className="support-ticket-page-panel">
      <div className="support-ticket-layout">
        <form className="support-form support-ticket-form" onSubmit={submitTicket}>
          <h3 className="support-ticket-form-heading">Support Ticket</h3>
          <label className="support-ticket-field">
            <span className="support-ticket-label">Subject <b>*</b></span>
            <span className="support-ticket-control">
              <Icon name="tag" />
              <input name="subject" autoComplete="off" value={values.subject} onChange={updateValue} required minLength={3} maxLength={160} placeholder="Briefly describe your issue" />
            </span>
          </label>
          <div className="support-form__grid">
            <label className="support-ticket-field">
              <span className="support-ticket-label">Category <b>*</b></span>
              <span className="support-ticket-control">
                <Icon name="grid" />
                <select name="category" value={values.category} onChange={updateValue} required>
                  <option value="">Choose a category</option>
                  {ticketCategories.map((category) => <option key={category} value={category}>{category}</option>)}
                </select>
                <span className="support-ticket-chevron" aria-hidden="true" />
              </span>
            </label>
            <label className="support-ticket-field">
              <span className="support-ticket-label">Priority <b>*</b></span>
              <span className="support-ticket-control">
                <Icon name="flag" />
                <select name="priority" value={values.priority} onChange={updateValue} required>
                  {priorities.map((priority) => <option key={priority} value={priority}>{priority}</option>)}
                </select>
                <span className="support-ticket-chevron" aria-hidden="true" />
              </span>
            </label>
          </div>
          {values.category === 'Other' && (
            <label className="support-ticket-field">
              <span className="support-ticket-label">What other category? <b>*</b></span>
              <span className="support-ticket-control">
                <Icon name="message" />
                <input
                  name="otherCategoryDetail"
                  value={otherCategoryDetail}
                  onChange={updateOtherCategoryDetail}
                  required
                  maxLength={500}
                  placeholder="Please specify"
                />
              </span>
            </label>
          )}
          <label className="support-ticket-field">
            <span className="support-ticket-label">Detailed description <b>*</b></span>
            <span className="support-ticket-textarea-wrap">
              <Icon name="document" />
              <textarea name="description" value={values.description} onChange={updateValue} required minLength={10} maxLength={10000} rows={5} placeholder="Provide more details about the issue..." />
            </span>
            <span className="support-ticket-character-count">{values.description.length} / 10000</span>
          </label>
          <label
            className="support-ticket-upload"
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault()
              setSelectedFile(event.dataTransfer.files?.[0] || null)
            }}
          >
            <input ref={fileInputRef} type="file" accept="image/png,image/jpeg,image/webp,application/pdf" onChange={updateFile} />
            <Icon name="cloudUpload" />
            <span className="support-ticket-upload__copy">
              <span><strong>Click to upload</strong> or drag and drop</span>
              <small>PNG, JPEG, WebP or PDF · Maximum 5 MB{file ? ` · Selected: ${file.name}` : ''}</small>
            </span>
          </label>
          {error && <div className="support-notice is-error" role="alert">{error}</div>}
          <div className="support-ticket-actions">
            <button className="student-button support-ticket-submit" type="submit" disabled={isSubmitting}>
              <Icon name="send" /> {isSubmitting ? 'Submitting…' : 'Submit Ticket'}
            </button>
            <button className="support-ticket-reset" type="button" onClick={resetTicketForm} disabled={isSubmitting}>
              <Icon name="reset" /> Reset
            </button>
          </div>
        </form>
      </div>
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

export function SupportRequestsPage() {
  const [tickets, setTickets] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    supportRequest('/tickets/mine')
      .then((result) => {
        if (active) setTickets(result.tickets)
      })
      .catch((requestError) => {
        if (active) setError(requestError instanceof Error ? requestError.message : 'Support requests could not be loaded.')
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => { active = false }
  }, [])

  return (
    <SupportPage eyebrow="YOUR ACCOUNT" title="My Support Requests">
      {loading ? <p className="support-loading" role="status">Loading your requests…</p> : error ? (
        <div className="support-notice is-error" role="alert">{error}</div>
      ) : tickets.length === 0 ? (
        <SupportEmptyState title="You haven't submitted any support requests yet." description="Submit a ticket and it will appear here with its status and replies." />
      ) : (
        <div className="support-ticket-list">
          {tickets.map((ticket) => (
            <Link className="support-ticket-row" to={`/student/help/requests/${encodeURIComponent(ticket.ticketId)}`} key={ticket.ticketId}>
              <span className="support-ticket-row__main">
                <strong>{ticket.subject}</strong>
                <small>{ticket.ticketId} · {ticket.category}</small>
              </span>
              <span className="support-ticket-row__meta">
                <span className={`support-status is-${ticket.status.toLowerCase().replaceAll(' ', '-')}`}>{ticket.status}</span>
                <small>{new Date(ticket.createdAt).toLocaleDateString()}</small>
              </span>
            </Link>
          ))}
        </div>
      )}
    </SupportPage>
  )
}

export function SupportTicketDetailPage() {
  const { ticketId } = useParams()
  const navigate = useNavigate()
  const [ticket, setTicket] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [reply, setReply] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [notice, setNotice] = useState('')

  useEffect(() => {
    let active = true
    setLoading(true)
    setError('')
    supportRequest(`/tickets/mine/${encodeURIComponent(ticketId)}`)
      .then((result) => {
        if (active) setTicket(result.ticket)
      })
      .catch((requestError) => {
        if (active) setError(requestError instanceof Error ? requestError.message : 'Support request could not be loaded.')
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => { active = false }
  }, [ticketId])

  async function sendReply(event) {
    event.preventDefault()
    setIsSubmitting(true)
    setError('')
    try {
      const result = await supportRequest(`/tickets/mine/${encodeURIComponent(ticketId)}/replies`, {
        method: 'POST',
        body: JSON.stringify({ message: reply }),
      })
      setTicket(result.ticket)
      setReply('')
      setNotice('Your reply was added.')
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Your reply could not be sent.')
    } finally {
      setIsSubmitting(false)
    }
  }

  async function downloadAttachment() {
    try {
      const response = await fetch(
        `${API_BASE_URL}/support/tickets/mine/${encodeURIComponent(ticketId)}/attachment?id=${encodeURIComponent(ticket.attachment.id)}`,
        { headers: { Authorization: `Bearer ${getToken()}` } },
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

  const canReply = ticket && ['Open', 'Waiting for User'].includes(ticket.status)
  const created = window.history.state?.usr?.created

  return (
    <SupportPage eyebrow={ticket?.ticketId || 'SUPPORT REQUEST'} title={ticket?.subject || 'Support Request'}>
      {loading ? <p className="support-loading" role="status">Loading support request…</p> : error && !ticket ? (
        <div className="support-notice is-error" role="alert">{error}</div>
      ) : ticket ? (
        <div className="support-ticket-detail">
          {created && <div className="support-notice is-success" role="status">Your support request was submitted. Ticket ID: <strong>{ticket.ticketId}</strong></div>}
          {notice && <div className="support-notice is-success" role="status">{notice}</div>}
          {error && <div className="support-notice is-error" role="alert">{error}</div>}
          <div className="support-ticket-summary">
            <span><strong>Category</strong>{ticket.category}</span>
            <span><strong>Priority</strong>{ticket.priority}</span>
            <span><strong>Status</strong><span className={`support-status is-${ticket.status.toLowerCase().replaceAll(' ', '-')}`}>{ticket.status}</span></span>
            <span><strong>Submitted</strong>{new Date(ticket.createdAt).toLocaleString()}</span>
          </div>
          <section className="support-ticket-description">
            <h3>Request details</h3>
            <p>{ticket.description}</p>
            {ticket.attachment && (
              <button className="support-text-button" type="button" onClick={downloadAttachment}>
                <Icon name="download" /> Download {ticket.attachment.fileName}
              </button>
            )}
          </section>
          <section className="support-conversation">
            <h3>Conversation</h3>
            {ticket.replies?.length ? ticket.replies.map((item) => (
              <article className={`support-message is-${item.authorRole}`} key={item._id}>
                <div><strong>{item.authorRole === 'admin' ? 'Support team' : 'You'}</strong><time>{new Date(item.createdAt).toLocaleString()}</time></div>
                <p>{item.message}</p>
              </article>
            )) : <p className="support-muted">No replies yet.</p>}
          </section>
          <section className="support-status-history">
            <h3>Status history</h3>
            {ticket.statusHistory?.length ? (
              <ol>{ticket.statusHistory.map((entry) => (
                <li key={entry._id}>
                  <span>{entry.from ? `${entry.from} → ` : ''}{entry.to}</span>
                  <time>{new Date(entry.createdAt).toLocaleString()}</time>
                </li>
              ))}</ol>
            ) : <p className="support-muted">No status changes recorded.</p>}
          </section>
          {canReply && (
            <form className="support-form support-reply-form" onSubmit={sendReply}>
              <label>Reply<textarea value={reply} onChange={(event) => setReply(event.currentTarget.value)} required maxLength={5000} rows={4} /></label>
              <button className="student-button" type="submit" disabled={isSubmitting}>{isSubmitting ? 'Sending…' : 'Send reply'}</button>
            </form>
          )}
          <button className="student-button student-button--quiet" type="button" onClick={() => navigate('/student/help/requests')}>Back to My Support Requests</button>
        </div>
      ) : null}
    </SupportPage>
  )
}

const faqsByCategory = [
  {
    category: 'Account and Registration',
    items: [
      ['How do I create an account?', 'Public registration currently supports independent student accounts. Use the Register option on the login page and complete the required account details.'],
      ['Can I change my username?', 'Username changes are not currently available from the student dashboard. Contact support if you need help with your account identity.'],
    ],
  },
  {
    category: 'Login and Security',
    items: [
      ['How do I sign in?', 'Sign in with the username or email address and password associated with your account. Google sign-in is available for existing accounts linked to that Google identity.'],
      ['Can I reset my password?', 'Password reset is not currently connected in the LMS. Do not share your password in a support request.'],
    ],
  },
  {
    category: 'Courses and Learning',
    items: [
      ['Where do I find course content?', 'Use My Courses to view enrolled courses. Course enrollment and lesson data are not currently connected to this account.'],
    ],
  },
  {
    category: 'Enrollments',
    items: [
      ['How can I enroll in a course?', 'Course enrollment and purchasing workflows are not currently available in the student dashboard.'],
    ],
  },
  {
    category: 'Assignments and Results',
    items: [
      ['Where are my assignments and grades?', 'Assignment and assessment results are not connected to the current account yet, so the dashboard cannot show personal results at this time.'],
    ],
  },
  {
    category: 'Certificates',
    items: [
      ['Where can I access certificates?', 'Certificates you earn will appear in Certificates when certificate records are available. No certificate records are currently connected.'],
    ],
  },
  {
    category: 'Purchases and Payments',
    items: [
      ['Where can I see purchases or invoices?', 'The LMS does not currently provide purchase, payment, or invoice records in the student dashboard.'],
    ],
  },
]

export function SupportFaqPage() {
  const [search, setSearch] = useState('')
  const normalizedSearch = search.trim().toLowerCase()
  const categories = faqsByCategory
    .map((item) => ({
      ...item,
      items: item.items.filter(([question, answer]) => `${question} ${answer} ${item.category}`.toLowerCase().includes(normalizedSearch)),
    }))
    .filter((item) => item.items.length)

  return (
    <SupportPage eyebrow="ANSWERS AND GUIDANCE" title="Browse FAQs">
      <label className="support-faq-search">
        <Icon name="search" />
        <input type="search" placeholder="Search common questions..." value={search} onChange={(event) => setSearch(event.currentTarget.value)} />
      </label>
      {categories.length ? categories.map(({ category, items }) => (
        <section className="support-faq-category" key={category}>
          <h3>{category}</h3>
          {items.map(([question, answer]) => (
            <details className="support-faq-item" key={question}>
              <summary>{question}</summary>
              <p>{answer}</p>
            </details>
          ))}
        </section>
      )) : <SupportEmptyState title="No matching FAQs" description="Try a different search term." />}
    </SupportPage>
  )
}
