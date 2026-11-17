import React, { useEffect, useMemo, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { API_BASE_URL } from './api-base-url.js'
import WorkspaceTopbar from './WorkspaceTopbar.jsx'
import './AdminSupport.css'
import './SupportCenter.css'

const statuses = [
  'Open',
  'In Progress',
  'Waiting for Student',
  'Waiting for User',
  'Resolved',
  'Closed',
]
const mainAdminStatuses = ['Open', 'In Progress', 'Resolved', 'Closed']
const categories = [
  'Account and Login',
  'Account and Registration',
  'Login and Security',
  'Courses and Learning',
  'Course and Enrollment',
  'Enrollments',
  'Assignments and Results',
  'Certificates',
  'Payments and Purchases',
  'Payments',
  'Technical Issue',
  'Technical Issues',
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

function getToken(onLogout) {
  const storedAuth = sessionStorage.getItem('lms.auth')
  let token
  try {
    token = storedAuth ? JSON.parse(storedAuth)?.token : null
  } catch {
    sessionStorage.removeItem('lms.auth')
    if (typeof onLogout === 'function') onLogout()
    const err = new Error('Your saved session is invalid. Please sign in again.')
    err.isSessionExpired = true
    throw err
  }
  if (typeof token !== 'string' || !token) {
    sessionStorage.removeItem('lms.auth')
    if (typeof onLogout === 'function') onLogout()
    const err = new Error('Your session has expired. Please sign in again.')
    err.isSessionExpired = true
    throw err
  }
  return token
}

function getTicketQuery(filters) {
  const query = new URLSearchParams(Object.entries(filters).filter(([, value]) => value))
  const serialized = query.toString()
  return serialized ? `?${serialized}` : ''
}

async function adminSupportRequest(path, options = {}, onLogout) {
  const token = getToken(onLogout)
  const headers = new Headers(options.headers)
  headers.set('Authorization', `Bearer ${token}`)
  if (options.body) headers.set('Content-Type', 'application/json')
  const response = await fetch(`${API_BASE_URL}/support${path}`, { ...options, headers })
  if (response.status === 401) {
    sessionStorage.removeItem('lms.auth')
    if (typeof onLogout === 'function') {
      try { onLogout() } catch {}
    }
    const err = new Error('Your session has expired. Please sign in again.')
    err.isSessionExpired = true
    throw err
  }
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
  const [search, setSearch] = useState('')
  const ticketSearch = search
  const setTicketSearch = setSearch
  const [tickets, setTickets] = useState([])
  const [complaints, setComplaints] = useState([])
  const [ticket, setTicket] = useState(null)
  const [complaint, setComplaint] = useState(null)
  const [handlers, setHandlers] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [isSessionExpired, setIsSessionExpired] = useState(false)
  const [reply, setReply] = useState('')
  const [notice, setNotice] = useState('')
  const [isSaving, setIsSaving] = useState(false)

  const isComplaintsTab = isMainAdminView && activeTab === 'complaints'
  const displayedStatus = (status) =>
    isMainAdminView && !isComplaintsTab && (status === 'Waiting for User' || status === 'Waiting for Student') ? 'In Progress' : status
  const isDrawerViewport = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(
    roleLabel === 'Main Admin' ? '(max-width: 1024px)' : '(max-width: 760px)',
  ).matches : false

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

  // Fetch ticket list
  useEffect(() => {
    let active = true
    setLoading(true)
    setError('')
    setIsSessionExpired(false)
    const request = isComplaintsTab
      ? adminComplaintRequest('/admin').then((result) => {
        if (active) setComplaints(result.complaints || [])
      })
      : adminSupportRequest(`/admin/tickets${getTicketQuery(filters)}`, {}, onLogout).then((result) => {
        if (active) setTickets(result.tickets || [])
      })
    request
      .catch((requestError) => {
        if (!active) return
        if (requestError?.isSessionExpired) {
          setIsSessionExpired(true)
        }
        setError(requestError instanceof Error
          ? requestError.message
          : isComplaintsTab ? 'Complaints could not be loaded.' : 'Support tickets could not be loaded.')
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => { active = false }
  }, [filters, isComplaintsTab, onLogout])

  // Fetch single ticket details
  useEffect(() => {
    if (!ticketId) {
      setTicket(null)
      setComplaint(null)
      return undefined
    }
    let active = true
    setLoading(true)
    setError('')
    setIsSessionExpired(false)
    const request = isComplaintsTab
      ? adminComplaintRequest(`/admin/${encodeURIComponent(ticketId)}`).then((result) => {
        if (active) {
          setComplaint(result.complaint)
          setTicket(null)
        }
      })
      : Promise.all([
        adminSupportRequest(`/admin/tickets/${encodeURIComponent(ticketId)}`, {}, onLogout),
        adminSupportRequest('/admin/tickets/handlers', {}, onLogout).catch(() => ({ handlers: [] })),
      ]).then(([ticketResult, handlerResult]) => {
        if (active) {
          setTicket(ticketResult.ticket)
          setComplaint(null)
          setHandlers(handlerResult.handlers || [])
        }
      })
    request
      .catch((requestError) => {
        if (!active) return
        if (requestError?.isSessionExpired) {
          setIsSessionExpired(true)
        }
        setError(requestError instanceof Error
          ? requestError.message
          : isComplaintsTab ? 'Complaint details could not be loaded.' : 'Support ticket details could not be loaded.')
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => { active = false }
  }, [isComplaintsTab, ticketId, onLogout])

  // Compute live statistics from tickets
  const stats = useMemo(() => {
    const total = tickets.length
    const open = tickets.filter((t) => t.status === 'Open').length
    const inProgress = tickets.filter((t) => t.status === 'In Progress').length
    const waiting = tickets.filter((t) => ['Waiting for Student', 'Waiting for User'].includes(t.status)).length
    const resolved = tickets.filter((t) => ['Resolved', 'Closed'].includes(t.status)).length
    return { total, open, inProgress, waiting, resolved }
  }, [tickets])

  // Filter tickets by search text
  const filteredTickets = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return tickets
    return tickets.filter((t) => {
      const matchId = (t.ticketId || '').toLowerCase().includes(q)
      const matchSubject = (t.subject || '').toLowerCase().includes(q)
      const matchRequester = (t.requester?.fullName || '').toLowerCase().includes(q)
      const matchEmail = (t.requester?.email || '').toLowerCase().includes(q)
      return matchId || matchSubject || matchRequester || matchEmail
    })
  }, [tickets, search])

  async function updateTicket(path, body, successMessage) {
    setIsSaving(true)
    setError('')
    setNotice('')
    try {
      const result = await adminSupportRequest(`/admin/tickets/${encodeURIComponent(ticketId)}${path}`, {
        method: path === '/status' || path === '/assignment' ? 'PATCH' : 'POST',
        body: JSON.stringify(body),
      }, onLogout)
      setTicket((current) => ({ ...current, ...result.ticket, requester: current?.requester }))
      setNotice(successMessage)
      const [ticketResult, listResult] = await Promise.all([
        adminSupportRequest(`/admin/tickets/${encodeURIComponent(ticketId)}`, {}, onLogout),
        adminSupportRequest(`/admin/tickets${getTicketQuery(filters)}`, {}, onLogout),
      ])
      setTicket(ticketResult.ticket)
      setTickets(listResult.tickets || [])
    } catch (requestError) {
      if (requestError?.isSessionExpired) {
        setIsSessionExpired(true)
      }
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
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (downloadError) {
      setError(downloadError instanceof Error ? downloadError.message : 'The attachment could not be downloaded.')
    }
  }

  const resetFilters = () => {
    setFilters({ status: '', category: '', priority: '' })
    setSearch('')
  }

  return (
    <div className={`admin-app admin-support${embedded ? ' admin-support--embedded' : ''}${isDark ? ' is-dark' : ''}${roleLabel === 'Main Admin' ? ' is-main-admin' : ''}${sidebarCollapsed ? ' admin-app--sidebar-collapsed' : ''}`} data-theme={isDark ? 'dark' : 'light'}>
      {!embedded && sidebarOpen && <button className="admin-backdrop" type="button" aria-label="Close navigation" onClick={() => {
        setSidebarOpen(false)
        if (roleLabel === 'Main Admin') setSidebarCollapsed(true)
      }} />}
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
                onClick={() => {
                  if (roleLabel !== 'Main Admin') setSidebarOpen(false)
                }}
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
      <div
        className={embedded ? 'admin-support__embedded-shell' : 'admin-main admin-support__main-shell'}
        onClick={(event) => {
          if (
            !embedded &&
            roleLabel === 'Main Admin' &&
            !sidebarCollapsed &&
            !event.target.closest('.admin-support__menu-toggle')
          ) {
            setSidebarOpen(false)
            setSidebarCollapsed(true)
          }
        }}
      >
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
          >☰</button>
          <WorkspaceTopbar
            title="Support"
            name={user?.fullName}
            email={user?.email}
            roleLabel={roleLabel}
            dashboardPath={dashboardPath}
            helpPath={supportPath}
            settingsPath={settingsPath}
            isDark={isDark}
            onToggleTheme={onToggleTheme}
            onLogout={onLogout}
          />
        </div>}
        <main className={`admin-support__main${embedded ? ' admin-support__main--embedded' : ''}`}>
        {!embedded && <Link className="admin-back-dashboard admin-support__back-link admin-support__back-link--dashboard" to={dashboardPath}>
          <span aria-hidden="true">←</span> Back to Dashboard
        </Link>}
        {embedded ? <section className="admin-page-heading admin-page-heading--compact">
          <div>
            <p className="admin-eyebrow">COMMUNICATION &amp; SUPPORT</p>
            <h1>{ticketId
              ? isComplaintsTab ? 'Review Complaint' : 'Review Support Request'
              : isComplaintsTab ? 'Complaints' : 'Support Tickets'}</h1>
            <p>{isComplaintsTab
              ? 'Review submitted complaints and respond to users.'
              : 'Review, organize and respond to submitted support requests.'}</p>
          </div>
          {!ticketId && (
            <div className="admin-page-heading__actions">
              <button
                className="admin-button admin-button--primary admin-support__switch-button"
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
            </div>
          )}
        </section> : <div className="admin-support__heading">
          <div>
            <span className="student-eyebrow">SUPPORT MANAGEMENT</span>
            <h1>{ticketId ? isComplaintsTab ? 'Review Complaint' : 'Review Support Request' : isComplaintsTab ? 'Complaints' : 'Support Tickets'}</h1>
          </div>
          {ticketId && (
            <button
              className="student-button student-button--quiet"
              type="button"
              onClick={() => navigate(supportPath)}
            >
              ← Back to all tickets
            </button>
          )}
        </div>}

        <div className="admin-support__content-card">
        {ticketId && (
          <Link
            className="admin-support__back-link admin-support__back-link--tickets"
            to={`${supportPath}${isMainAdminView ? `?tab=${isComplaintsTab ? 'complaints' : 'tickets'}` : ''}`}
          >
            <span aria-hidden="true">←</span> Back to {isComplaintsTab ? 'Complaints' : 'Support Tickets'}
          </Link>
        )}

        {isSessionExpired ? (
          <div className="support-notice is-warning" role="alert">
            <div className="support-session-alert">
              <span>Your session has expired. Please sign in again to access the support desk.</span>
              <Link to="/login" className="student-button" style={{ padding: '6px 14px', fontSize: '12px' }}>
                Sign In Again
              </Link>
            </div>
          </div>
        ) : null}

        {error && !isSessionExpired && <div className="support-notice is-error" role="alert">{error}</div>}
        {notice && <div className="support-notice is-success" role="status">{notice}</div>}

        {ticketId ? (
          loading ? (
            <div className="support-loading-container" role="status">
              <div className="support-loading-spinner" />
              <p className="support-loading">Loading {isComplaintsTab ? 'complaint' : 'support request'}…</p>
            </div>
          ) : activeRecord ? (
            <section className="student-panel admin-support__detail">
              <div className="admin-support__ticket-title">
                <div>
                  <div className="admin-support__badges-row">
                    <span className="support-ticket-id-badge">
                      {isComplaintsTab ? activeRecord.complaintId : activeRecord.ticketId}
                    </span>
                    <span className="support-ticket-category-tag">{activeRecord.category}</span>
                    {!isComplaintsTab && (
                      <span className={`support-priority-tag is-${activeRecord.priority?.toLowerCase() || 'medium'}`}>
                        {activeRecord.priority || 'Medium'}
                      </span>
                    )}
                  </div>
                  <h2>{activeRecord.subject}</h2>
                </div>
                <span className={`support-status is-${displayedStatus(activeRecord.status).toLowerCase().replaceAll(' ', '-')}`}>
                  {displayedStatus(activeRecord.status)}
                </span>
              </div>

              {/* Requester Info Card */}
              <div className="admin-support__requester">
                <div>
                  <strong>Requester:</strong> {activeRecord.requester?.fullName || 'Student'} ({activeRecord.requester?.email || 'No email'})
                </div>
                <div>
                  <strong>Student ID:</strong> {activeRecord.requester?.studentId || activeRecord.requester?.id || activeRecord.userId || 'N/A'}
                </div>
                <div>
                  <strong>Account Type:</strong> {activeRecord.userCollection === 'clg_students' || activeRecord.accountType === 'college' ? 'College Student' : 'Independent Student'}
                </div>
                {!isComplaintsTab && (
                  <div>
                    <strong>Priority:</strong> {activeRecord.priority || 'Medium'}
                  </div>
                )}
                <div>
                  <strong>Submitted:</strong> {new Date(activeRecord.createdAt).toLocaleString()}
                </div>
                {activeRecord.resolvedAt && (
                  <div>
                    <strong>Resolved:</strong> {new Date(activeRecord.resolvedAt).toLocaleString()}
                  </div>
                )}
              </div>

              {/* Quick Status Action Controls */}
              {!isComplaintsTab && (
                <div className="admin-support__quick-actions-bar">
                  <span className="admin-support__quick-actions-label">Quick Actions:</span>
                  {activeRecord.status !== 'In Progress' && activeRecord.status !== 'Resolved' && activeRecord.status !== 'Closed' && (
                    <button
                      type="button"
                      className="admin-support__quick-btn is-teal"
                      disabled={isSaving}
                      onClick={() => updateTicket('/status', { status: 'In Progress' }, 'Status updated to In Progress.')}
                    >
                      Mark In Progress
                    </button>
                  )}
                  {activeRecord.status !== 'Waiting for Student' && activeRecord.status !== 'Waiting for User' && activeRecord.status !== 'Resolved' && activeRecord.status !== 'Closed' && (
                    <button
                      type="button"
                      className="admin-support__quick-btn is-amber"
                      disabled={isSaving}
                      onClick={() => updateTicket('/status', { status: 'Waiting for Student' }, 'Status updated to Waiting for Student.')}
                    >
                      Waiting for Student
                    </button>
                  )}
                  {activeRecord.status !== 'Resolved' && (
                    <button
                      type="button"
                      className="admin-support__quick-btn is-green"
                      disabled={isSaving}
                      onClick={() => updateTicket('/status', { status: 'Resolved' }, 'Ticket resolved successfully.')}
                    >
                      Mark as Resolved
                    </button>
                  )}
                  {activeRecord.status !== 'Closed' && (
                    <button
                      type="button"
                      className="admin-support__quick-btn is-slate"
                      disabled={isSaving}
                      onClick={() => updateTicket('/status', { status: 'Closed' }, 'Ticket closed.')}
                    >
                      Close Ticket
                    </button>
                  )}
                  {(activeRecord.status === 'Resolved' || activeRecord.status === 'Closed') && (
                    <button
                      type="button"
                      className="admin-support__quick-btn is-teal"
                      disabled={isSaving}
                      onClick={() => updateTicket('/status', { status: 'In Progress' }, 'Ticket reopened in progress.')}
                    >
                      Reopen Ticket
                    </button>
                  )}
                </div>
              )}

              {/* Request Details */}
              <section className="support-ticket-description">
                <h3>{isComplaintsTab ? 'Complaint details' : 'Original Request'}</h3>
                <p>{activeRecord.description}</p>
                {!isComplaintsTab && activeRecord.attachment && (
                  <button className="support-text-button" type="button" onClick={downloadAttachment}>
                    Download Attachment: {activeRecord.attachment.fileName}
                  </button>
                )}
              </section>

              {/* Management Controls */}
              {isComplaintsTab ? (
                <div className="admin-support__complaint-actions">
                  <button
                    className="student-button"
                    type="button"
                    disabled={isSaving}
                    onClick={() => updateComplaint(
                      '/status',
                      { status: activeRecord.status === 'Solved' ? 'Unsolved' : 'Solved' },
                      activeRecord.status === 'Solved' ? 'Complaint reopened.' : 'Complaint resolved.',
                    )}
                  >
                    {activeRecord.status === 'Solved' ? 'Mark Unsolved' : 'Mark Solved'}
                  </button>
                </div>
              ) : (
                <div className="admin-support__controls">
                  <label>
                    Change Status
                    <select
                      value={activeRecord.status}
                      disabled={isSaving}
                      onChange={(event) =>
                        updateTicket('/status', { status: event.currentTarget.value }, 'Ticket status updated.')
                      }
                    >
                      {(isMainAdminView ? mainAdminStatuses : statuses).map((status) => (
                        <option key={status} value={status}>
                          {status}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Priority
                    <select
                      value={activeRecord.priority || 'Medium'}
                      disabled={isSaving}
                      onChange={(event) =>
                        updateTicket('/priority', { priority: event.currentTarget.value }, 'Ticket priority updated.')
                      }
                    >
                      {priorities.map((priority) => (
                        <option key={priority} value={priority}>
                          {priority}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Assigned Support Handler
                    <select
                      value={activeRecord.assignedTo || ''}
                      disabled={isSaving}
                      onChange={(event) =>
                        updateTicket(
                          '/assignment',
                          { assignedTo: event.currentTarget.value || null },
                          'Ticket assignment updated.',
                        )
                      }
                    >
                      <option value="">Unassigned</option>
                      {handlers.map((handler) => (
                        <option key={handler.id} value={handler.id}>
                          {handler.fullName} · {handler.email}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              )}

              {/* Conversation History */}
              <section className="support-conversation">
                <h3>Conversation History</h3>
                {(activeRecord.messages || activeRecord.replies)?.length ? (
                  <div className="support-messages-stream">
                    {(activeRecord.messages || activeRecord.replies).map((item) => {
                      const isAdmin = item.authorRole === 'admin' || item.authorRole === 'main_admin'
                      return (
                        <article className={`support-message is-${item.authorRole}`} key={item._id}>
                          <div className="support-message__header">
                            <span className={`support-author-pill is-${item.authorRole}`}>
                              {isAdmin ? (isComplaintsTab ? 'Main Admin' : 'Support Team (Admin)') : (activeRecord.requester?.fullName || 'Student')}
                            </span>
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
                  <p className="support-muted">No replies yet.</p>
                )}
              </section>

              {/* Status History */}
              <section className="support-status-history">
                <h3>Status History</h3>
                {activeRecord.statusHistory?.length ? (
                  <ol className="support-status-timeline">
                    {activeRecord.statusHistory.map((entry, index) => (
                      <li key={entry._id || index}>
                        <span>
                          {entry.from ? `${displayedStatus(entry.from)} → ` : 'Created as '}
                          <strong>{displayedStatus(entry.to)}</strong>
                          {entry.changedByRole ? ` by ${entry.changedByRole === 'admin' ? 'Support Team' : 'Student'}` : ''}
                        </span>
                        <time>{new Date(entry.createdAt).toLocaleString()}</time>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p className="support-muted">No status transitions recorded.</p>
                )}
              </section>

              {!isComplaintsTab && activeRecord.priorityHistory?.length > 0 && (
                <section className="support-status-history">
                  <h3>Priority history</h3>
                  <ol className="support-status-timeline">
                    {activeRecord.priorityHistory.map((entry) => (
                      <li key={entry._id}>
                        <span>{entry.from ? `${entry.from} → ` : ''}{entry.to}</span>
                        <time>{new Date(entry.createdAt).toLocaleString()}</time>
                      </li>
                    ))}
                  </ol>
                </section>
              )}

              {/* Reply Form */}
              {(isComplaintsTab || !['Resolved', 'Closed'].includes(activeRecord.status)) && (
                <form
                  className="support-form support-reply-form"
                  onSubmit={(event) => {
                    event.preventDefault()
                    if (!reply.trim()) return
                    if (isComplaintsTab) {
                      updateComplaint('/replies', { message: reply }, 'Reply sent to complainant.')
                    } else {
                      updateTicket('/messages', { message: reply }, 'Reply sent to student.')
                    }
                    setReply('')
                  }}
                >
                  <label>
                    Reply to {isComplaintsTab ? 'complainant' : 'student'}
                    <textarea
                      value={reply}
                      onChange={(event) => setReply(event.currentTarget.value)}
                      required
                      minLength={1}
                      maxLength={5000}
                      rows={4}
                      placeholder={isComplaintsTab ? 'Type your response to the complainant...' : 'Type your response to the student...'}
                    />
                  </label>
                  <button className="student-button" type="submit" disabled={isSaving || !reply.trim()}>
                    {isSaving ? 'Sending…' : 'Send reply'}
                  </button>
                </form>
              )}
            </section>
          ) : null
        ) : (
          <>
            {!isComplaintsTab && (
              <div className="support-stats-grid" role="region" aria-label="Support statistics">
                <button
                  type="button"
                  className={`support-stat-card tone-gold${filters.status === '' ? ' is-selected' : ''}`}
                  onClick={() => setFilters((prev) => ({ ...prev, status: '' }))}
                >
                  <div className="support-stat-card__icon">
                    <span style={{ fontSize: '20px' }}>✉</span>
                  </div>
                  <div className="support-stat-card__body">
                    <span className="support-stat-card__count">{stats.total}</span>
                    <span className="support-stat-card__label">Total Tickets</span>
                  </div>
                </button>

                <button
                  type="button"
                  className={`support-stat-card tone-peach${filters.status === 'Open' ? ' is-selected' : ''}`}
                  onClick={() => setFilters((prev) => ({ ...prev, status: 'Open' }))}
                >
                  <div className="support-stat-card__icon">
                    <span style={{ fontSize: '20px' }}>⏱</span>
                  </div>
                  <div className="support-stat-card__body">
                    <span className="support-stat-card__count">{stats.open}</span>
                    <span className="support-stat-card__label">Open Tickets</span>
                  </div>
                </button>

                <button
                  type="button"
                  className={`support-stat-card tone-teal${filters.status === 'In Progress' ? ' is-selected' : ''}`}
                  onClick={() => setFilters((prev) => ({ ...prev, status: 'In Progress' }))}
                >
                  <div className="support-stat-card__icon">
                    <span style={{ fontSize: '20px' }}>⚡</span>
                  </div>
                  <div className="support-stat-card__body">
                    <span className="support-stat-card__count">{stats.inProgress}</span>
                    <span className="support-stat-card__label">In Progress</span>
                  </div>
                </button>

                <button
                  type="button"
                  className={`support-stat-card tone-gold${filters.status === 'Waiting for Student' ? ' is-selected' : ''}`}
                  onClick={() => setFilters((prev) => ({ ...prev, status: 'Waiting for Student' }))}
                >
                  <div className="support-stat-card__icon">
                    <span style={{ fontSize: '20px' }}>⏳</span>
                  </div>
                  <div className="support-stat-card__body">
                    <span className="support-stat-card__count">{stats.waiting}</span>
                    <span className="support-stat-card__label">Waiting for Student</span>
                  </div>
                </button>

                <button
                  type="button"
                  className={`support-stat-card tone-mint${filters.status === 'Resolved' ? ' is-selected' : ''}`}
                  onClick={() => setFilters((prev) => ({ ...prev, status: 'Resolved' }))}
                >
                  <div className="support-stat-card__icon">
                    <span style={{ fontSize: '20px' }}>✓</span>
                  </div>
                  <div className="support-stat-card__body">
                    <span className="support-stat-card__count">{stats.resolved}</span>
                    <span className="support-stat-card__label">Resolved / Closed</span>
                  </div>
                </button>
              </div>
            )}

            <div className="admin-support__filters">
              <label className="admin-support__search">
                Search {isComplaintsTab ? 'complaints' : 'tickets'}
                <input
                  type="search"
                  value={ticketSearch}
                  onChange={(event) => setTicketSearch(event.currentTarget.value)}
                  placeholder="ID, subject, requester or category"
                />
              </label>
              {isComplaintsTab ? (
                <label>
                  Filter
                  <select value={complaintFilter} onChange={(event) => setComplaintFilter(event.currentTarget.value)}>
                    <option value="all">All Complaints</option>
                    <option value="unsolved">Unsolved</option>
                    <option value="solved">Solved</option>
                  </select>
                </label>
              ) : (
                <>
                  <label>
                    Status
                    <select
                      value={filters.status}
                      onChange={(event) => setFilters((current) => ({ ...current, status: event.currentTarget.value }))}
                    >
                      <option value="">All statuses</option>
                      {(isMainAdminView ? mainAdminStatuses : statuses).map((status) => (
                        <option key={status}>{status}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Category
                    <select
                      value={filters.category}
                      onChange={(event) => setFilters((current) => ({ ...current, category: event.currentTarget.value }))}
                    >
                      <option value="">All categories</option>
                      {categories.map((category) => (
                        <option key={category}>{category}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Priority
                    <select
                      value={filters.priority}
                      onChange={(event) => setFilters((current) => ({ ...current, priority: event.currentTarget.value }))}
                    >
                      <option value="">All priorities</option>
                      {priorities.map((priority) => (
                        <option key={priority}>{priority}</option>
                      ))}
                    </select>
                  </label>
                  {(filters.status || filters.category || filters.priority || search) && (
                    <button type="button" className="student-button student-button--secondary" onClick={resetFilters} style={{ alignSelf: 'flex-end', height: '42px' }}>
                      Reset filters
                    </button>
                  )}
                </>
              )}
            </div>

            {loading ? (
              <div className="support-loading-container" role="status">
                <div className="support-loading-spinner" />
                <p className="support-loading">Loading {isComplaintsTab ? 'complaints' : 'support tickets'}…</p>
              </div>
            ) : visibleRecords.length ? (
              isMainAdminView ? (
                <div className="admin-support__table-wrap">
                  <table className="admin-support__table">
                    <thead>
                      <tr>
                        <th>{isComplaintsTab ? 'Complaint ID' : 'Ticket ID'}</th>
                        <th>Subject</th>
                        <th>Submitted By</th>
                        <th>Student ID</th>
                        <th>Email</th>
                        <th>Category</th>
                        {!isComplaintsTab && <th>Priority</th>}
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
                        const status = isComplaintsTab ? item.status : displayedStatus(item.status)
                        return (
                          <tr key={detailId}>
                            <td><Link to={detailPath}>{displayId}</Link></td>
                            <td><Link to={detailPath}>{item.subject}</Link></td>
                            <td>{item.requester?.fullName || 'Student'}</td>
                            <td>{item.requester?.studentId || item.requester?.id || item.userId}</td>
                            <td>{item.requester?.email || 'Email unavailable'}</td>
                            <td>{item.category}</td>
                            {!isComplaintsTab && <td>{item.priority}</td>}
                            <td>{new Date(item.createdAt).toLocaleDateString()}</td>
                            <td><span className={`support-status is-${status.toLowerCase().replaceAll(' ', '-')}`}>{status}</span></td>
                            <td><Link to={detailPath}>View Details</Link></td>
                          </tr>
                        )
                      })}
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
            ) : !error ? (
              <div className="support-empty-state">
                <h3>
                  {ticketSearch
                    ? `No matching ${isComplaintsTab ? 'complaints' : 'support tickets'}`
                    : `No ${isComplaintsTab ? 'complaints' : 'support tickets'} found`}
                </h3>
                <p>
                  {ticketSearch
                    ? 'Try another search or adjust the filters.'
                    : `${isComplaintsTab ? 'Complaints' : 'Tickets'} matching these filters will appear here.`}
                </p>
                {(filters.status || filters.category || filters.priority || search) && (
                  <button type="button" className="student-button student-button--secondary" onClick={resetFilters} style={{ marginTop: '12px' }}>
                    Reset all filters
                  </button>
                )}
              </div>
            ) : null}
          </>
        )}
        </div>
      </main>
      </div>
    </div>
  )
}

export default AdminSupport
