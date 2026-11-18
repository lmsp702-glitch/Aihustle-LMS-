import React, { useEffect, useMemo, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { API_BASE_URL } from './api-base-url.js'
import WorkspaceTopbar from './WorkspaceTopbar.jsx'
import './AdminDashboard.css'
import './AdminSupport.css'
import './SupportCenter.css'

const statuses = ['Open', 'In Progress', 'Waiting for User', 'Resolved', 'Closed']
const mainAdminStatuses = ['Open', 'In Progress', 'Resolved', 'Closed']
const categories = [
  'Account and Login',
  'Course and Enrollment',
  'Assignments and Results',
  'Payments and Purchases',
  'Technical Issue',
  'Other',
]
const priorities = ['Low', 'Medium', 'High']
const adminNavigation = [
  { label: 'Overview', group: 'WORKSPACE', icon: '◫' },
  { label: 'Students', group: 'USER MANAGEMENT', icon: '♙' },
  { label: 'Student Approval', icon: '✓' },
  { label: 'Colleges', icon: '▦' },
  { label: 'Courses', group: 'COURSE MANAGEMENT', icon: '▤' },
  { label: 'Enrollments', icon: '⇄' },
  { label: 'Reports & Analytics', icon: '⌁' },
  { label: 'Notifications', group: 'COMMUNICATION & SUPPORT', icon: '♧' },
  { label: 'Feedback & Complaints', icon: '☷' },
  { label: 'Support Tickets', icon: '✉', active: true },
  { label: 'Settings', group: 'SYSTEM', icon: '⚙' },
]
const mainAdminNavigation = [
  { label: 'Overview', group: 'WORKSPACE', icon: '◫' },
  { label: 'Students', group: 'USER MANAGEMENT', icon: '♙' },
  { label: 'Student Approval', icon: '✓' },
  { label: 'Colleges', icon: '▦' },
  { label: 'Courses', group: 'COURSE MANAGEMENT', icon: '▤' },
  { label: 'Enrollments', icon: '⇄' },
  { label: 'Reports & Analytics', icon: '⌁' },
  { label: 'Feedback', group: 'COMMUNICATION & SUPPORT', icon: '☷', to: '/admin/dashboard?section=feedback' },
  { label: 'Complaints', icon: '▣', tab: 'complaints' },
  { label: 'Notifications', icon: '♧', to: '/admin/dashboard?section=notifications' },
  { label: 'Settings', group: 'SYSTEM', icon: '⚙' },
]

function getToken() {
  const storedAuth = sessionStorage.getItem('lms.auth')
  let token
  try {
    token = storedAuth ? JSON.parse(storedAuth)?.token : null
  } catch {
    throw new Error('Your saved session is invalid. Please sign in again.')
  }
  if (typeof token !== 'string' || !token) throw new Error('Your session has expired. Please sign in again.')
  return token
}

function getTicketQuery(filters) {
  const query = new URLSearchParams(Object.entries(filters).filter(([, value]) => value))
  const serialized = query.toString()
  return serialized ? `?${serialized}` : ''
}

function displayTicketValue(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : 'Not available'
}

function formatTicketDate(value) {
  if (value === undefined || value === null || value === '') return 'Not available'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? 'Not available' : date.toLocaleString()
}

function formatTicketListDate(value) {
  if (value === undefined || value === null || value === '') return 'Not available'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? 'Not available' : date.toLocaleDateString()
}

async function adminSupportRequest(path, options = {}) {
  const headers = new Headers(options.headers)
  headers.set('Authorization', `Bearer ${getToken()}`)
  if (options.body) headers.set('Content-Type', 'application/json')
  const response = await fetch(`${API_BASE_URL}/support${path}`, { ...options, headers })
  let result
  try {
    result = await response.json()
  } catch {
    throw new Error('The server returned an invalid response.')
  }
  if (!response.ok) throw new Error(result.message || 'The support request failed.')
  return result
}

async function adminComplaintRequest(path, options = {}) {
  const headers = new Headers(options.headers)
  headers.set('Authorization', `Bearer ${getToken()}`)
  if (options.body) headers.set('Content-Type', 'application/json')
  const response = await fetch(`${API_BASE_URL}/complaints${path}`, { ...options, headers })
  let result
  try {
    result = await response.json()
  } catch {
    throw new Error('The server returned an invalid response.')
  }
  if (!response.ok) throw new Error(result.message || 'The complaint request failed.')
  return result
}

function AdminSupport({
  onLogout,
  isDark,
  onToggleTheme,
  dashboardPath = '/admin/dashboard',
  supportPath = '/admin/support',
  settingsPath = '/admin/settings',
  user,
  roleLabel = 'Main Admin',
  initialTab = 'tickets',
  sidebarOpen: controlledSidebarOpen,
  sidebarCollapsed: controlledSidebarCollapsed,
  onSidebarOpenChange,
  onSidebarCollapsedChange,
  embedded = false,
}) {
  const location = useLocation()
  const navigate = useNavigate()
  const isMainAdminView = embedded || roleLabel === 'Main Admin'
  const [localSidebarOpen, setLocalSidebarOpen] = useState(false)
  const [localSidebarCollapsed, setLocalSidebarCollapsed] = useState(roleLabel === 'Main Admin')
  const sidebarOpen = controlledSidebarOpen ?? localSidebarOpen
  const sidebarCollapsed = controlledSidebarCollapsed ?? localSidebarCollapsed
  const setSidebarOpen = onSidebarOpenChange || setLocalSidebarOpen
  const setSidebarCollapsed = onSidebarCollapsedChange || setLocalSidebarCollapsed
  const [activeTab, setActiveTab] = useState(initialTab)
  const [complaintFilter, setComplaintFilter] = useState('all')
  const ticketId = useMemo(() => {
    const parts = location.pathname.split('/').filter(Boolean)
    return parts.length > 2 ? decodeURIComponent(parts[2]) : ''
  }, [location.pathname])
  const [filters, setFilters] = useState({ status: '', category: '', priority: '' })
  const [ticketSearch, setTicketSearch] = useState('')
  const [tickets, setTickets] = useState([])
  const [complaints, setComplaints] = useState([])
  const [ticket, setTicket] = useState(null)
  const [complaint, setComplaint] = useState(null)
  const [handlers, setHandlers] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [reply, setReply] = useState('')
  const [notice, setNotice] = useState('')
  const isComplaintsTab = isMainAdminView && activeTab === 'complaints'
  const displayedStatus = (status) =>
    isMainAdminView && !isComplaintsTab && status === 'Waiting for User' ? 'In Progress' : status
  const isDrawerViewport = window.matchMedia(
    roleLabel === 'Main Admin' ? '(max-width: 1024px)' : '(max-width: 760px)',
  ).matches
  const [isSaving, setIsSaving] = useState(false)
  const visibleTickets = useMemo(() => {
    const query = ticketSearch.trim().toLocaleLowerCase()
    return tickets.filter((item) => {
      const matchesSearch = !query || [
        item.ticketId,
        item.subject,
        item.category,
        item.priority,
        item.status,
        item.requester?.fullName,
        item.requester?.email,
      ].some((value) => String(value || '').toLocaleLowerCase().includes(query))
      return matchesSearch
    })
  }, [ticketSearch, tickets])
  const visibleComplaints = useMemo(() => {
    const query = ticketSearch.trim().toLocaleLowerCase()
    return [...complaints]
      .sort((first, second) => new Date(second.createdAt) - new Date(first.createdAt))
      .filter((item) => {
        const matchesSearch = !query || [
          item.complaintId,
          item.subject,
          item.category,
          item.status,
          item.requester?.fullName,
          item.requester?.studentId,
          item.requester?.email,
        ].some((value) => String(value || '').toLocaleLowerCase().includes(query))
        const matchesFilter = complaintFilter === 'all' ||
          (complaintFilter === 'solved' ? item.status === 'Solved' : item.status === 'Unsolved')
        return matchesSearch && matchesFilter
      })
  }, [complaintFilter, complaints, ticketSearch])
  const activeRecord = isComplaintsTab ? complaint : ticket
  const visibleRecords = isComplaintsTab ? visibleComplaints : visibleTickets
  const activeTicketStatus = displayTicketValue(displayedStatus(activeRecord?.status))
  const supportNavigation = (roleLabel === 'Main Admin' ? mainAdminNavigation : adminNavigation).map((item) => ({
    ...item,
    active: item.tab === 'complaints' ? isMainAdminView : item.tab ? item.tab === activeTab : Boolean(item.active),
  }))

  useEffect(() => {
    setActiveTab(initialTab)
  }, [initialTab])

  useEffect(() => {
    const requestedTab = new URLSearchParams(location.search).get('tab')
    setActiveTab(isMainAdminView && requestedTab === 'complaints' ? 'complaints' : initialTab)
  }, [initialTab, isMainAdminView, location.pathname, location.search])

  useEffect(() => {
    let active = true
    setLoading(true)
    setError('')
    const request = isComplaintsTab
      ? adminComplaintRequest('/admin').then((result) => {
        if (active) setComplaints(result.complaints)
      })
      : adminSupportRequest(`/admin/tickets${getTicketQuery(filters)}`).then((result) => {
        if (active) setTickets(result.tickets)
      })
    request
      .catch((requestError) => {
        if (active) setError(requestError instanceof Error
          ? requestError.message
          : isComplaintsTab ? 'Complaints could not be loaded.' : 'Support tickets could not be loaded.')
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => { active = false }
  }, [filters, isComplaintsTab])

  useEffect(() => {
    if (!ticketId) {
      setTicket(null)
      setComplaint(null)
      return undefined
    }
    let active = true
    setLoading(true)
    setError('')
    const request = isComplaintsTab
      ? adminComplaintRequest(`/admin/${encodeURIComponent(ticketId)}`).then((result) => {
        if (active) {
          setComplaint(result.complaint)
          setTicket(null)
        }
      })
      : isMainAdminView
        ? adminSupportRequest(`/admin/tickets/${encodeURIComponent(ticketId)}`).then((ticketResult) => {
          if (active) {
            setTicket(ticketResult.ticket)
            setComplaint(null)
          }
        })
        : Promise.all([
          adminSupportRequest(`/admin/tickets/${encodeURIComponent(ticketId)}`),
          adminSupportRequest('/admin/tickets/handlers'),
        ]).then(([ticketResult, handlerResult]) => {
          if (active) {
            setTicket(ticketResult.ticket)
            setComplaint(null)
            setHandlers(handlerResult.handlers)
          }
        })
    request
      .catch((requestError) => {
        if (active) setError(requestError instanceof Error
          ? requestError.message
          : isComplaintsTab ? 'Complaint details could not be loaded.' : 'Support ticket details could not be loaded.')
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => { active = false }
  }, [isComplaintsTab, ticketId])

  async function updateTicket(path, body, successMessage) {
    setIsSaving(true)
    setError('')
    setNotice('')
    try {
      const result = await adminSupportRequest(`/admin/tickets/${encodeURIComponent(ticketId)}${path}`, {
        method: ['/status', '/assignment', '/priority'].includes(path) ? 'PATCH' : 'POST',
        body: JSON.stringify(body),
      })
      setTicket((current) => ({ ...current, ...result.ticket, requester: current?.requester }))
      setNotice(successMessage)
      const [ticketResult, listResult] = await Promise.all([
        adminSupportRequest(`/admin/tickets/${encodeURIComponent(ticketId)}`),
        adminSupportRequest(`/admin/tickets${getTicketQuery(filters)}`),
      ])
      setTicket(ticketResult.ticket)
      setTickets(listResult.tickets)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'The ticket could not be updated.')
    } finally {
      setIsSaving(false)
    }
  }

  async function updateComplaint(path, body, successMessage) {
    setIsSaving(true)
    setError('')
    setNotice('')
    try {
      await adminComplaintRequest(`/admin/${encodeURIComponent(ticketId)}${path}`, {
        method: path === '/status' ? 'PATCH' : 'POST',
        body: JSON.stringify(body),
      })
      const [detailResult, listResult] = await Promise.all([
        adminComplaintRequest(`/admin/${encodeURIComponent(ticketId)}`),
        adminComplaintRequest('/admin'),
      ])
      setComplaint(detailResult.complaint)
      setComplaints(listResult.complaints)
      setNotice(successMessage)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'The complaint could not be updated.')
    } finally {
      setIsSaving(false)
    }
  }

  async function downloadAttachment() {
    try {
      const response = await fetch(
        `${API_BASE_URL}/support/admin/tickets/${encodeURIComponent(ticketId)}/attachment?id=${encodeURIComponent(ticket.attachment.id)}`,
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
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (downloadError) {
      setError(downloadError instanceof Error ? downloadError.message : 'The attachment could not be downloaded.')
    }
  }

  return (
    <div className={`admin-app admin-support${embedded ? ' admin-support--embedded' : ''}${isDark ? ' is-dark' : ''}${roleLabel === 'Main Admin' ? ' is-main-admin' : ''}${sidebarCollapsed ? ' admin-app--sidebar-collapsed' : ''}`} data-theme={isDark ? 'dark' : 'light'}>
      {!embedded && sidebarOpen && <div className="admin-backdrop" aria-hidden="true" />}
      {!embedded && <aside className={`admin-sidebar${sidebarOpen ? ' admin-sidebar--open' : ''}`}>
        <Link className="admin-brand" to={dashboardPath} aria-label="AIHustle Admin Dashboard">
          <img className="admin-brand__image" src="/logo.png" alt="LMS logo" />
        </Link>
        <nav className="admin-nav" aria-label="Admin navigation">
          {supportNavigation.map((item) => (
            <React.Fragment key={item.label}>
              {item.group && <div className="admin-nav__group">{item.group}</div>}
              <Link
                className={`admin-nav__item${item.active ? ' is-active' : ''}`}
                to={item.to || (item.tab ? `${supportPath}?tab=${item.tab}` : item.active ? supportPath : item.label === 'Settings' ? settingsPath : dashboardPath)}
                aria-current={item.active ? 'page' : undefined}
              >
                <span className="admin-nav__icon" aria-hidden="true">{item.icon}</span>
                <span>{item.label}</span>
              </Link>
            </React.Fragment>
          ))}
        </nav>
        <div className="admin-sidebar__bottom">
          <div className="admin-sidebar__help"><span>✦</span><strong>Need a hand?</strong><small>Help center and support</small></div>
        </div>
      </aside>}
      <div className={embedded ? 'admin-support__embedded-shell' : 'admin-main admin-support__main-shell'}>
        {!embedded && <div className="admin-support__topbar-wrap">
          <button
            type="button"
            className="admin-support__menu-toggle"
            aria-label={isDrawerViewport
              ? sidebarOpen ? 'Close navigation' : 'Open navigation'
              : sidebarCollapsed ? 'Open sidebar' : 'Close sidebar'}
            aria-expanded={isDrawerViewport ? sidebarOpen : !sidebarCollapsed}
            onClick={() => {
              if (isDrawerViewport) {
                const nextOpen = !sidebarOpen
                setSidebarCollapsed(roleLabel === 'Main Admin' ? !nextOpen : false)
                setSidebarOpen(nextOpen)
              } else {
                setSidebarOpen(false)
                setSidebarCollapsed((collapsed) => !collapsed)
              }
            }}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
          {roleLabel === 'Main Admin' && (
            <Link
              className="admin-home-button admin-support__home-link"
              to={dashboardPath}
              aria-label="Go to home"
              title="Home"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z" />
              </svg>
            </Link>
          )}
          <WorkspaceTopbar
            title={roleLabel === 'Main Admin' ? '' : 'Support'}
            name={user?.fullName}
            email={user?.email}
            roleLabel={roleLabel}
            dashboardPath={dashboardPath}
            helpPath={supportPath}
            isDark={isDark}
            onToggleTheme={onToggleTheme}
            onLogout={onLogout}
          />
        </div>}
        <main className={`admin-support__main${embedded ? ' admin-support__main--embedded' : ''}`}>
        {isMainAdminView && !ticketId ? (
          <section className="admin-support__hero">
            <div className="admin-support__hero-copy">
              <p>COMMUNICATION &amp; SUPPORT</p>
              <h1>{isComplaintsTab ? 'COMPLAINTS' : 'SUPPORT'}</h1>
            </div>
            <div className="admin-support__hero-art" aria-hidden="true">
              <svg viewBox="0 0 180 140" focusable="false">
                <circle cx="90" cy="65" r="53" fill="#e4eee5" />
                <path d="M62 75V59a28 28 0 0 1 56 0v16" fill="none" stroke="#719183" strokeLinecap="round" strokeWidth="9" />
                <rect x="51" y="69" width="78" height="46" rx="10" fill="#527b6e" />
                <rect x="55" y="55" width="10" height="23" rx="5" fill="#d9b34d" />
                <rect x="115" y="55" width="10" height="23" rx="5" fill="#d9b34d" />
                <path d="M68 87h39M68 98h29" fill="none" stroke="#f8f3e8" strokeLinecap="round" strokeWidth="3" />
                <path d="M120 77c0 13-9 20-20 22" fill="none" stroke="#d9b34d" strokeLinecap="round" strokeWidth="3" />
                <circle cx="99" cy="100" r="5" fill="#d9b34d" />
                <path d="M16 123h148" stroke="#b7c8b7" strokeLinecap="round" strokeWidth="3" />
                <path d="m31 35 2.5 6.5L40 44l-6.5 2.5L31 53l-2.5-6.5L22 44l6.5-2.5z" fill="#86aa98" />
                <circle cx="148" cy="31" r="3" fill="#d9b34d" />
              </svg>
            </div>
            <button
              className="admin-support__hero-switch"
              type="button"
              onClick={() => {
                const nextTab = isComplaintsTab ? 'tickets' : 'complaints'
                setActiveTab(nextTab)
                setFilters({ status: '', category: '', priority: '' })
                setTicketSearch('')
                navigate(`${supportPath}?tab=${nextTab}`)
              }}
            >
              <span aria-hidden="true">{isComplaintsTab ? '✉' : '▣'}</span>
              {isComplaintsTab ? 'Support Tickets' : 'Complaints'}
            </button>
          </section>
        ) : embedded ? <section className="admin-page-heading admin-page-heading--compact">
          <div>
            <p className="admin-eyebrow">COMMUNICATION &amp; SUPPORT</p>
            <h1>{ticketId
              ? isComplaintsTab ? 'Review Complaint' : 'Review Support Request'
              : isComplaintsTab ? 'Complaints' : 'Support Tickets'}</h1>
            <p>{isComplaintsTab
              ? 'Review submitted complaints and respond to users.'
              : 'Review, organize and respond to submitted support requests.'}</p>
          </div>
        </section> : <div className="admin-support__heading">
          <div>
            <span className="student-eyebrow">SUPPORT MANAGEMENT</span>
            <h1>{ticketId ? isComplaintsTab ? 'Review Complaint' : 'Review Support Request' : isComplaintsTab ? 'Complaints' : 'Support Tickets'}</h1>
          </div>
        </div>}

        <div className={`admin-support__content-card${isMainAdminView && !ticketId ? ' admin-support__content-card--list' : ''}`}>
        {ticketId && (
          <Link
            className="admin-support__back-link admin-support__back-link--tickets"
            to={`${supportPath}${isMainAdminView ? `?tab=${isComplaintsTab ? 'complaints' : 'tickets'}` : ''}`}
          >
            <span aria-hidden="true">←</span> Back to {isComplaintsTab ? 'Complaints' : 'Support Tickets'}
          </Link>
        )}
        {error && <div className="support-notice is-error" role="alert">{error}</div>}
        {notice && <div className="support-notice is-success" role="status">{notice}</div>}

        {ticketId ? (
          loading ? <p className="support-loading" role="status">Loading {isComplaintsTab ? 'complaint' : 'ticket'}…</p> : activeRecord ? (
            <section className="student-panel admin-support__detail">
              {isComplaintsTab ? (
                <>
                  <div className="admin-support__ticket-title">
                    <div><small>Complaint {activeRecord.complaintId} · {activeRecord.category}</small><h2>{activeRecord.subject}</h2></div>
                    <span className={`support-status is-${displayedStatus(activeRecord.status).toLowerCase().replaceAll(' ', '-')}`}>{displayedStatus(activeRecord.status)}</span>
                  </div>
                  <div className="admin-support__requester">
                    <span>Student: {activeRecord.requester?.fullName || 'Student'} · {activeRecord.requester?.email || 'Email unavailable'}</span>
                    <span>Student ID: {activeRecord.requester?.studentId || activeRecord.requester?.id || activeRecord.userId}</span>
                    <span>Account: {activeRecord.userCollection === 'clg_students' || activeRecord.accountType === 'college' ? 'College student' : 'Independent student'}</span>
                    <span>Submitted: {new Date(activeRecord.createdAt).toLocaleString()}</span>
                  </div>
                  <section className="support-ticket-description">
                    <h3>Complaint details</h3><p>{activeRecord.description}</p>
                  </section>
                </>
              ) : (
                <>
                  <div className="admin-support__ticket-title">
                    <div><small>Support ticket</small><h2>{displayTicketValue(activeRecord.subject)}</h2></div>
                  </div>
                  <dl className="admin-support__ticket-metadata">
                    <div>
                      <dt>Ticket Number</dt>
                      <dd>{displayTicketValue(activeRecord.ticketId)}</dd>
                    </div>
                    <div>
                      <dt>Status</dt>
                      <dd><span className={`support-status is-${activeTicketStatus.toLowerCase().replaceAll(' ', '-')}`}>{activeTicketStatus}</span></dd>
                    </div>
                    <div>
                      <dt>Priority</dt>
                      <dd>{displayTicketValue(activeRecord.priority)}</dd>
                    </div>
                    <div className="admin-support__ticket-metadata-reason">
                      <dt>Reason</dt>
                      <dd>
                        <strong>{displayTicketValue(activeRecord.category)}</strong>
                        <p>{displayTicketValue(activeRecord.description)}</p>
                      </dd>
                    </div>
                    <div>
                      <dt>Generated By</dt>
                      <dd className="admin-support__ticket-requester">
                        <strong>{displayTicketValue(activeRecord.requester?.fullName)}</strong>
                        <span>{displayTicketValue(activeRecord.requester?.email)}</span>
                      </dd>
                    </div>
                    <div>
                      <dt>Date</dt>
                      <dd>{formatTicketDate(activeRecord.createdAt)}</dd>
                    </div>
                  </dl>
                  {activeRecord.attachment && (
                    <div className="admin-support__attachment">
                      <span className="admin-support__attachment-type" aria-hidden="true">
                        {activeRecord.attachment.contentType === 'application/pdf' ? 'PDF' : 'FILE'}
                      </span>
                      <div className="admin-support__attachment-info">
                        <strong>Attached document</strong>
                        <span>{displayTicketValue(activeRecord.attachment.fileName)}</span>
                      </div>
                      <button className="support-text-button" type="button" onClick={downloadAttachment}>
                        Download
                      </button>
                    </div>
                  )}
                </>
              )}
              {isComplaintsTab ? (
                <div className="admin-support__completion-actions">
                  <button
                    className="student-button"
                    type="button"
                    disabled={isSaving || activeRecord.status === 'Solved'}
                    onClick={() => updateComplaint(
                      '/status',
                      { status: 'Solved' },
                      'Complaint marked solved.',
                    )}
                  >
                    {activeRecord.status === 'Solved' ? 'Solved' : 'Mark Solved'}
                  </button>
                </div>
              ) : isMainAdminView ? (
                <div className="admin-support__completion-actions">
                  <button
                    className="student-button"
                    type="button"
                    disabled={isSaving || ['Resolved', 'Closed'].includes(activeRecord.status)}
                    onClick={() => updateTicket('/status', { status: 'Resolved' }, 'Ticket marked completed.')}
                  >
                    {['Resolved', 'Closed'].includes(activeRecord.status) ? 'Completed' : 'Mark Completed'}
                  </button>
                </div>
              ) : (
                <div className="admin-support__controls">
                  <label>Status
                    <select value={displayedStatus(activeRecord.status)} disabled={isSaving} onChange={(event) => updateTicket('/status', { status: event.currentTarget.value }, 'Ticket status updated.')}>
                      {mainAdminStatuses.map((status) => <option key={status}>{status}</option>)}
                    </select>
                  </label>
                  <label>Priority
                    <select value={activeRecord.priority} disabled={isSaving} onChange={(event) => updateTicket('/priority', { priority: event.currentTarget.value }, 'Ticket priority updated.')}>
                      {priorities.map((priority) => <option key={priority}>{priority}</option>)}
                    </select>
                  </label>
                  <label>Assigned support handler
                    <select value={activeRecord.assignedTo || ''} disabled={isSaving} onChange={(event) => updateTicket('/assignment', { assignedTo: event.currentTarget.value || null }, 'Ticket assignment updated.')}>
                      <option value="">Unassigned</option>
                      {handlers.map((handler) => <option key={handler.id} value={handler.id}>{handler.fullName} · {handler.email}</option>)}
                    </select>
                  </label>
                </div>
              )}
              {(!isMainAdminView || isComplaintsTab) && (
                <section className="support-conversation">
                  <h3>Conversation</h3>
                  {activeRecord.replies?.length ? activeRecord.replies.map((item) => (
                    <article className={`support-message is-${item.authorRole}`} key={item._id}>
                      <div><strong>{item.authorRole === 'admin' || item.authorRole === 'main_admin' ? isComplaintsTab ? 'Main Admin' : 'Support team' : activeRecord.requester?.fullName || 'Student'}</strong><time>{new Date(item.createdAt).toLocaleString()}</time></div>
                      <p>{item.message}</p>
                    </article>
                  )) : <p className="support-muted">No replies yet.</p>}
                </section>
              )}
              <section className="support-status-history">
                <h3>Status history</h3>
                <ol>
                  <li><span>Generated</span><time>{formatTicketDate(activeRecord.createdAt)}</time></li>
                  {activeRecord.statusHistory?.filter((entry) => entry.from).map((entry) => (
                    <li key={entry._id}><span>{displayedStatus(entry.to)}</span><time>{formatTicketDate(entry.createdAt)}</time></li>
                  ))}
                </ol>
              </section>
              {!isMainAdminView && !isComplaintsTab && activeRecord.priorityHistory?.length > 0 && (
                <section className="support-status-history">
                  <h3>Priority history</h3>
                  <ol>{activeRecord.priorityHistory.map((entry) => (
                    <li key={entry._id}><span>{entry.from ? `${entry.from} → ` : ''}{entry.to}</span><time>{new Date(entry.createdAt).toLocaleString()}</time></li>
                  ))}</ol>
                </section>
              )}
              {(!isMainAdminView || isComplaintsTab) && (isComplaintsTab || !['Resolved', 'Closed'].includes(activeRecord.status)) && (
                <form className="support-form support-reply-form" onSubmit={(event) => {
                  event.preventDefault()
                  if (isComplaintsTab) {
                    updateComplaint('/replies', { message: reply }, 'Reply sent.')
                  } else {
                    updateTicket('/replies', { message: reply }, 'Reply sent.')
                  }
                  setReply('')
                }}>
                  <label>Reply to {isComplaintsTab ? 'complainant' : 'student'}<textarea value={reply} onChange={(event) => setReply(event.currentTarget.value)} required maxLength={5000} rows={4} /></label>
                  <button className="student-button" type="submit" disabled={isSaving}>{isSaving ? 'Sending…' : 'Send reply'}</button>
                </form>
              )}
            </section>
          ) : null
        ) : (
          <>
            <div className="admin-support__filters">
              <label className="admin-support__search">Search {isComplaintsTab ? 'complaints' : 'tickets'}<input type="search" value={ticketSearch} onChange={(event) => setTicketSearch(event.currentTarget.value)} placeholder="ID, subject, requester or category" /></label>
              {isComplaintsTab ? (
                <label>Filter<select value={complaintFilter} onChange={(event) => setComplaintFilter(event.currentTarget.value)}>
                  <option value="all">All Complaints</option>
                  <option value="unsolved">Unsolved</option>
                  <option value="solved">Solved</option>
                </select></label>
              ) : (
                <>
                  <label>Status<select value={filters.status} onChange={(event) => setFilters((current) => ({ ...current, status: event.currentTarget.value }))}><option value="">All statuses</option>{(isMainAdminView ? mainAdminStatuses : statuses).map((status) => <option key={status}>{status}</option>)}</select></label>
                  <label>Category<select value={filters.category} onChange={(event) => setFilters((current) => ({ ...current, category: event.currentTarget.value }))}><option value="">All categories</option>{categories.map((category) => <option key={category}>{category}</option>)}</select></label>
                  <label>Priority<select value={filters.priority} onChange={(event) => setFilters((current) => ({ ...current, priority: event.currentTarget.value }))}><option value="">All priorities</option>{priorities.map((priority) => <option key={priority}>{priority}</option>)}</select></label>
                </>
              )}
            </div>
            {loading ? <p className="support-loading" role="status">Loading {isComplaintsTab ? 'complaints' : 'support tickets'}…</p> : visibleRecords.length ? (
              isMainAdminView ? (
                <div className="admin-support__table-wrap">
                  <table className="admin-support__table">
                    <thead>
                      <tr>
                        <th>{isComplaintsTab ? 'Complaint ID' : 'Ticket ID'}</th>
                        <th>Subject</th>
                        <th>Date</th>
                        <th>Status</th>
                        <th>Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleRecords.map((item) => {
                        const displayId = isComplaintsTab ? item.complaintId : item.ticketId
                        const detailId = isComplaintsTab ? item._id : item.ticketId
                        const detailTab = isMainAdminView ? `?tab=${isComplaintsTab ? 'complaints' : 'tickets'}` : ''
                        const detailPath = `${supportPath}/${encodeURIComponent(detailId)}${detailTab}`
                        const status = displayTicketValue(isComplaintsTab ? item.status : displayedStatus(item.status))
                        return (
                        <tr key={detailId}>
                          <td><Link className="admin-support__record-link" to={detailPath}>{displayTicketValue(displayId)}</Link></td>
                          <td><Link className="admin-support__record-link" to={detailPath}>{displayTicketValue(item.subject)}</Link></td>
                          <td>{formatTicketListDate(item.createdAt)}</td>
                          <td><span className={`support-status is-${status.toLowerCase().replaceAll(' ', '-')}`}>{status}</span></td>
                          <td><Link className="admin-support__record-link" to={detailPath}>View Details</Link></td>
                        </tr>
                      )})}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="support-ticket-list">
                  {visibleRecords.map((item) => (
                    <Link className="support-ticket-row" to={`${supportPath}/${encodeURIComponent(item.ticketId)}`} key={item.ticketId}>
                      <span className="support-ticket-row__main">
                        <strong>{item.subject}</strong>
                        <small>{item.ticketId} · {item.requester?.fullName || 'Student'} · {item.category}</small>
                      </span>
                      <span className="support-ticket-row__meta">
                        <span className={`support-status is-${item.status.toLowerCase().replaceAll(' ', '-')}`}>{item.status}</span>
                        <small>{item.priority} · Submitted {new Date(item.createdAt).toLocaleDateString()}</small>
                      </span>
                    </Link>
                  ))}
                </div>
              )
            ) : !error ? <div className="support-empty-state"><h3>{ticketSearch
              ? `No matching ${isComplaintsTab ? 'complaints' : 'support tickets'}`
              : `No ${isComplaintsTab ? 'complaints' : 'support tickets'} found`}</h3><p>{ticketSearch
              ? 'Try another search or adjust the filters.'
              : `${isComplaintsTab ? 'Complaints' : 'Tickets'} matching these filters will appear here.`}</p></div> : null}
          </>
        )}
        </div>
      </main>
      </div>
    </div>
  )
}

export default AdminSupport
