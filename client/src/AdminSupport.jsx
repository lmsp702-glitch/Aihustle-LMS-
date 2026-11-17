import React, { useEffect, useMemo, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import WorkspaceTopbar from './WorkspaceTopbar.jsx'
import './AdminSupport.css'
import './SupportCenter.css'

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || 'http://localhost:5000/api').replace(/\/+$/, '')

const statuses = [
  'Open',
  'In Progress',
  'Waiting for Student',
  'Resolved',
  'Closed',
]

const categories = [
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

function AdminSupport({
  onLogout,
  isDark,
  onToggleTheme,
  dashboardPath = '/admin/dashboard',
  supportPath = '/admin/support',
  settingsPath = '/admin/settings',
  user,
  roleLabel = 'Main Admin',
}) {
  const location = useLocation()
  const navigate = useNavigate()
  const ticketId = useMemo(() => {
    const parts = location.pathname.split('/').filter(Boolean)
    return parts.length > 2 ? decodeURIComponent(parts[2]) : ''
  }, [location.pathname])

  const [filters, setFilters] = useState({ status: '', category: '', priority: '' })
  const [search, setSearch] = useState('')
  const [tickets, setTickets] = useState([])
  const [ticket, setTicket] = useState(null)
  const [handlers, setHandlers] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [isSessionExpired, setIsSessionExpired] = useState(false)
  const [reply, setReply] = useState('')
  const [notice, setNotice] = useState('')
  const [isSaving, setIsSaving] = useState(false)

  // Fetch ticket list
  useEffect(() => {
    let active = true
    setLoading(true)
    setError('')
    setIsSessionExpired(false)
    adminSupportRequest(`/admin/tickets${getTicketQuery(filters)}`, {}, onLogout)
      .then((result) => {
        if (active) setTickets(result.tickets || [])
      })
      .catch((requestError) => {
        if (!active) return
        if (requestError?.isSessionExpired) {
          setIsSessionExpired(true)
        }
        setError(requestError instanceof Error ? requestError.message : 'Support tickets could not be loaded.')
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => { active = false }
  }, [filters, onLogout])

  // Fetch single ticket details
  useEffect(() => {
    if (!ticketId) {
      setTicket(null)
      return undefined
    }
    let active = true
    setLoading(true)
    setError('')
    setIsSessionExpired(false)
    Promise.all([
      adminSupportRequest(`/admin/tickets/${encodeURIComponent(ticketId)}`, {}, onLogout),
      adminSupportRequest('/admin/tickets/handlers', {}, onLogout).catch(() => ({ handlers: [] })),
    ])
      .then(([ticketResult, handlerResult]) => {
        if (active) {
          setTicket(ticketResult.ticket)
          setHandlers(handlerResult.handlers || [])
        }
      })
      .catch((requestError) => {
        if (!active) return
        if (requestError?.isSessionExpired) {
          setIsSessionExpired(true)
        }
        setError(requestError instanceof Error ? requestError.message : 'Support ticket details could not be loaded.')
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => { active = false }
  }, [ticketId, onLogout])

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
    <div className={`admin-support${isDark ? ' is-dark' : ''}`}>
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
      <main className="admin-support__main">
        <div className="admin-support__heading">
          <div>
            <span className="student-eyebrow">SUPPORT MANAGEMENT</span>
            <h1>{ticketId ? 'Review Support Request' : 'Support Tickets'}</h1>
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
        </div>

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
              <p className="support-loading">Loading support request…</p>
            </div>
          ) : ticket ? (
            <section className="student-panel admin-support__detail">
              <div className="admin-support__ticket-title">
                <div>
                  <div className="admin-support__badges-row">
                    <span className="support-ticket-id-badge">{ticket.ticketId}</span>
                    <span className="support-ticket-category-tag">{ticket.category}</span>
                    <span className={`support-priority-tag is-${ticket.priority?.toLowerCase() || 'medium'}`}>
                      {ticket.priority || 'Medium'}
                    </span>
                  </div>
                  <h2>{ticket.subject}</h2>
                </div>
                <span className={`support-status is-${ticket.status.toLowerCase().replaceAll(' ', '-')}`}>
                  {ticket.status}
                </span>
              </div>

              {/* Requester Info Card */}
              <div className="admin-support__requester">
                <div>
                  <strong>Requester:</strong> {ticket.requester?.fullName || 'Student'} ({ticket.requester?.email || 'No email'})
                </div>
                <div>
                  <strong>Account Type:</strong> {ticket.accountType === 'college' ? 'College Student' : 'Independent Student'}
                </div>
                <div>
                  <strong>Submitted:</strong> {new Date(ticket.createdAt).toLocaleString()}
                </div>
                {ticket.resolvedAt && (
                  <div>
                    <strong>Resolved:</strong> {new Date(ticket.resolvedAt).toLocaleString()}
                  </div>
                )}
              </div>

              {/* Quick Status Action Controls */}
              <div className="admin-support__quick-actions-bar">
                <span className="admin-support__quick-actions-label">Quick Actions:</span>
                {ticket.status !== 'In Progress' && ticket.status !== 'Resolved' && ticket.status !== 'Closed' && (
                  <button
                    type="button"
                    className="admin-support__quick-btn is-teal"
                    disabled={isSaving}
                    onClick={() => updateTicket('/status', { status: 'In Progress' }, 'Status updated to In Progress.')}
                  >
                    Mark In Progress
                  </button>
                )}
                {ticket.status !== 'Waiting for Student' && ticket.status !== 'Resolved' && ticket.status !== 'Closed' && (
                  <button
                    type="button"
                    className="admin-support__quick-btn is-amber"
                    disabled={isSaving}
                    onClick={() => updateTicket('/status', { status: 'Waiting for Student' }, 'Status updated to Waiting for Student.')}
                  >
                    Waiting for Student
                  </button>
                )}
                {ticket.status !== 'Resolved' && (
                  <button
                    type="button"
                    className="admin-support__quick-btn is-green"
                    disabled={isSaving}
                    onClick={() => updateTicket('/status', { status: 'Resolved' }, 'Ticket resolved successfully.')}
                  >
                    Mark as Resolved
                  </button>
                )}
                {ticket.status !== 'Closed' && (
                  <button
                    type="button"
                    className="admin-support__quick-btn is-slate"
                    disabled={isSaving}
                    onClick={() => updateTicket('/status', { status: 'Closed' }, 'Ticket closed.')}
                  >
                    Close Ticket
                  </button>
                )}
                {(ticket.status === 'Resolved' || ticket.status === 'Closed') && (
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

              {/* Request Details */}
              <section className="support-ticket-description">
                <h3>Original Request</h3>
                <p>{ticket.description}</p>
                {ticket.attachment && (
                  <button className="support-text-button" type="button" onClick={downloadAttachment}>
                    Download Attachment: {ticket.attachment.fileName}
                  </button>
                )}
              </section>

              {/* Management Controls */}
              <div className="admin-support__controls">
                <label>
                  Change Status
                  <select
                    value={ticket.status}
                    disabled={isSaving}
                    onChange={(event) =>
                      updateTicket('/status', { status: event.currentTarget.value }, 'Ticket status updated.')
                    }
                  >
                    {statuses.map((status) => (
                      <option key={status} value={status}>
                        {status}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Assigned Support Handler
                  <select
                    value={ticket.assignedTo || ''}
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

              {/* Conversation History */}
              <section className="support-conversation">
                <h3>Conversation History</h3>
                {(ticket.messages || ticket.replies)?.length ? (
                  <div className="support-messages-stream">
                    {(ticket.messages || ticket.replies).map((item) => {
                      const isAdmin = item.authorRole === 'admin'
                      return (
                        <article className={`support-message is-${item.authorRole}`} key={item._id}>
                          <div className="support-message__header">
                            <span className={`support-author-pill is-${item.authorRole}`}>
                              {isAdmin ? 'Support Team (Admin)' : `${ticket.requester?.fullName || 'Student'}`}
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
                  <p className="support-muted">No replies in this ticket yet.</p>
                )}
              </section>

              {/* Status History */}
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

              {/* Admin Reply Form */}
              <form
                className="support-form support-reply-form"
                onSubmit={(event) => {
                  event.preventDefault()
                  if (!reply.trim()) return
                  updateTicket('/messages', { message: reply }, 'Reply sent to student.')
                  setReply('')
                }}
              >
                <label>
                  Reply to Student
                  <textarea
                    value={reply}
                    onChange={(event) => setReply(event.currentTarget.value)}
                    required
                    minLength={1}
                    maxLength={5000}
                    rows={4}
                    placeholder="Type your response to the student. Sending a reply will update the ticket status to Waiting for Student..."
                  />
                </label>
                <button className="student-button" type="submit" disabled={isSaving || !reply.trim()}>
                  {isSaving ? 'Sending…' : 'Send Reply to Student'}
                </button>
              </form>
            </section>
          ) : null
        ) : (
          <>
            {/* Summary Stat Cards */}
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

            {/* Filter and Search Bar */}
            <div className="support-requests-toolbar">
              <div className="support-search-wrapper">
                <input
                  type="search"
                  className="support-search-input"
                  style={{ paddingLeft: '14px' }}
                  placeholder="Search by ticket ID, subject, student name, or email..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  aria-label="Search support tickets"
                />
              </div>

              <div className="support-filter-controls">
                <select
                  value={filters.status}
                  onChange={(event) => setFilters((current) => ({ ...current, status: event.currentTarget.value }))}
                  className="support-select-filter"
                  aria-label="Filter by status"
                >
                  <option value="">All Statuses</option>
                  {statuses.map((status) => (
                    <option key={status} value={status}>
                      {status}
                    </option>
                  ))}
                </select>

                <select
                  value={filters.category}
                  onChange={(event) => setFilters((current) => ({ ...current, category: event.currentTarget.value }))}
                  className="support-select-filter"
                  aria-label="Filter by category"
                >
                  <option value="">All Categories</option>
                  {categories.map((category) => (
                    <option key={category} value={category}>
                      {category}
                    </option>
                  ))}
                </select>

                <select
                  value={filters.priority}
                  onChange={(event) => setFilters((current) => ({ ...current, priority: event.currentTarget.value }))}
                  className="support-select-filter"
                  aria-label="Filter by priority"
                >
                  <option value="">All Priorities</option>
                  {priorities.map((priority) => (
                    <option key={priority} value={priority}>
                      {priority}
                    </option>
                  ))}
                </select>

                {(filters.status || filters.category || filters.priority || search) && (
                  <button type="button" className="support-reset-filters-btn" onClick={resetFilters}>
                    Reset Filters
                  </button>
                )}
              </div>
            </div>

            {loading ? (
              <div className="support-loading-container" role="status">
                <div className="support-loading-spinner" />
                <p className="support-loading">Loading support tickets…</p>
              </div>
            ) : filteredTickets.length ? (
              <div className="support-ticket-table-wrap">
                <div className="support-ticket-list-header">
                  <span>Showing {filteredTickets.length} of {tickets.length} support tickets</span>
                </div>

                <div className="support-ticket-cards">
                  {filteredTickets.map((item) => (
                    <article className="support-ticket-card" key={item.ticketId}>
                      <div className="support-ticket-card__header">
                        <div className="support-ticket-card__id-group">
                          <span className="support-ticket-id-badge">{item.ticketId}</span>
                          <span className="support-ticket-category-tag">{item.category}</span>
                          <span className={`support-priority-tag is-${item.priority?.toLowerCase() || 'medium'}`}>
                            {item.priority || 'Medium'}
                          </span>
                        </div>
                        <span className={`support-status is-${item.status.toLowerCase().replaceAll(' ', '-')}`}>
                          {item.status}
                        </span>
                      </div>

                      <h3 className="support-ticket-card__subject">{item.subject}</h3>

                      <div className="support-ticket-card__footer">
                        <div className="support-ticket-card__dates">
                          <span>Student: <strong>{item.requester?.fullName || 'Student'}</strong> ({item.requester?.email || 'N/A'})</span>
                          <span>Updated: {new Date(item.updatedAt).toLocaleDateString()}</span>
                        </div>

                        <Link
                          className="support-details-link"
                          to={`${supportPath}/${encodeURIComponent(item.ticketId)}`}
                        >
                          <span>Review Ticket →</span>
                        </Link>
                      </div>
                    </article>
                  ))}
                </div>
              </div>
            ) : !error ? (
              <div className="support-empty-state">
                <h3>No support tickets found</h3>
                <p>Tickets matching these filters will appear here.</p>
                {(filters.status || filters.category || filters.priority || search) && (
                  <button type="button" className="student-button student-button--secondary" onClick={resetFilters} style={{ marginTop: '12px' }}>
                    Reset all filters
                  </button>
                )}
              </div>
            ) : null}
          </>
        )}
      </main>
    </div>
  )
}

export default AdminSupport
