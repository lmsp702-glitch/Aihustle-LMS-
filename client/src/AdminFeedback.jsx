import React, { useEffect, useMemo, useState } from 'react'
import { API_BASE_URL } from './api-base-url.js'
import './AdminSupport.css'
import './SupportCenter.css'
import './AdminFeedback.css'

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

async function feedbackRequest(path, options = {}) {
  const headers = new Headers(options.headers)
  headers.set('Authorization', `Bearer ${getToken()}`)
  if (options.body) headers.set('Content-Type', 'application/json')
  const response = await fetch(`${API_BASE_URL}/feedback${path}`, { ...options, headers })
  let result
  try {
    result = await response.json()
  } catch {
    throw new Error('The server returned an invalid response.')
  }
  if (!response.ok) throw new Error(result.message || 'The feedback request failed.')
  return result
}

function formatDate(value) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? 'Date unavailable' : date.toLocaleString()
}

export default function AdminFeedback() {
  const [feedback, setFeedback] = useState([])
  const [selectedId, setSelectedId] = useState('')
  const [search, setSearch] = useState('')
  const [reply, setReply] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  useEffect(() => {
    let active = true
    setLoading(true)
    setError('')
    feedbackRequest('/admin')
      .then((result) => {
        if (active) setFeedback(result.feedback)
      })
      .catch((requestError) => {
        if (active) setError(requestError instanceof Error ? requestError.message : 'Feedback could not be loaded.')
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => { active = false }
  }, [])

  const visibleFeedback = useMemo(() => {
    const query = search.trim().toLocaleLowerCase()
    return feedback.filter((item) => !query || [
      item.requester?.fullName,
      item.requester?.id,
      item.requester?.studentId,
      item.requester?.email,
      item.message,
    ].some((value) => String(value || '').toLocaleLowerCase().includes(query)))
  }, [feedback, search])
  const selectedFeedback = feedback.find((item) => item._id === selectedId)

  async function submitReply(event) {
    event.preventDefault()
    if (!selectedFeedback) return
    setSaving(true)
    setError('')
    setNotice('')
    try {
      const result = await feedbackRequest(`/admin/${encodeURIComponent(selectedFeedback._id)}/replies`, {
        method: 'POST',
        body: JSON.stringify({ message: reply }),
      })
      setFeedback((current) => current.map((item) => (
        item._id === result.feedback._id ? result.feedback : item
      )))
      setReply('')
      setNotice('Your reply has been saved.')
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Your reply could not be saved.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="admin-feedback">
      <section className="admin-page-heading admin-page-heading--compact">
        <div>
          <p className="admin-eyebrow">COMMUNICATION &amp; SUPPORT</p>
          <h1>Feedback</h1>
          <p>Read student feedback and reply to each submission.</p>
        </div>
      </section>
      <section className="admin-support__content-card admin-feedback__card">
        {error && <div className="support-notice is-error" role="alert">{error}</div>}
        {notice && <div className="support-notice is-success" role="status">{notice}</div>}
        <label className="admin-feedback__search">
          <svg className="admin-feedback__search-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <circle cx="10.8" cy="10.8" r="6.8" />
            <path d="m16 16 4.5 4.5" />
          </svg>
          <input
            type="search"
            aria-label="Search feedback"
            value={search}
            onChange={(event) => setSearch(event.currentTarget.value)}
            placeholder="Search students, emails or feedback"
          />
        </label>
        {loading ? <p className="support-loading" role="status">Loading feedback…</p> : visibleFeedback.length ? (
          <div className="admin-support__table-wrap">
            <table className="admin-support__table admin-feedback__table">
              <thead><tr>
                <th>Student</th>
                <th>User ID</th>
                <th>Email</th>
                <th>Feedback</th>
                <th>Submitted</th>
                <th>Action</th>
              </tr></thead>
              <tbody>
                {visibleFeedback.map((item) => (
                  <tr key={item._id}>
                    <td>{item.requester?.fullName || 'Student'}</td>
                    <td>{item.requester?.id || item.userId}</td>
                    <td>{item.requester?.email || 'Email unavailable'}</td>
                    <td className="admin-feedback__message-cell">{item.message}</td>
                    <td>{formatDate(item.createdAt)}</td>
                    <td><button className="admin-feedback__view-button" type="button" onClick={() => {
                      setSelectedId(item._id)
                      setReply('')
                      setNotice('')
                    }}>View &amp; reply</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : !error ? <div className="support-empty-state"><h3>{search ? 'No matching feedback' : 'No feedback submitted'}</h3><p>{search ? 'Try another search.' : 'User-submitted feedback will appear here.'}</p></div> : null}
      </section>

      {selectedFeedback && (
        <section className="student-panel admin-support__detail admin-feedback__detail">
          <div className="admin-support__ticket-title">
            <div><small>Feedback from {selectedFeedback.requester?.fullName || 'Student'}</small><h2>Complete feedback</h2></div>
            <button className="admin-feedback__close-button" type="button" onClick={() => setSelectedId('')}>Close</button>
          </div>
          <div className="admin-support__requester">
            <span>User ID: {selectedFeedback.requester?.id || selectedFeedback.userId}</span>
            <span>Email: {selectedFeedback.requester?.email || 'Email unavailable'}</span>
            <span>Submitted: {formatDate(selectedFeedback.createdAt)}</span>
          </div>
          <p className="admin-feedback__full-message">{selectedFeedback.message}</p>
          <section className="support-conversation">
            <h3>Reply history</h3>
            {selectedFeedback.replies?.length ? selectedFeedback.replies.map((item) => (
              <article className="support-message is-main_admin" key={item._id || `${item.createdAt}-${item.message}`}>
                <div><strong>Main Admin</strong><time>{formatDate(item.createdAt)}</time></div>
                <p>{item.message}</p>
              </article>
            )) : <p className="support-muted">No replies yet.</p>}
          </section>
          <form className="support-form support-reply-form" onSubmit={submitReply}>
            <label>Reply to student<textarea value={reply} onChange={(event) => setReply(event.currentTarget.value)} required maxLength={5000} rows={4} /></label>
            <button className="student-button" type="submit" disabled={saving}>{saving ? 'Sending…' : 'Send reply'}</button>
          </form>
        </section>
      )}
    </div>
  )
}
