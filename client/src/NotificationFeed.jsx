import React, { useEffect, useState } from 'react'
import { API_BASE_URL } from './api-base-url.js'
import { fetchWithAuth } from './auth-session.js'
import { STUDENT_NOTIFICATIONS_UPDATED_EVENT } from './student-notifications-events.js'
import './NotificationFeed.css'
function formatNotificationDate(value) {
  if (!value) return 'Date unavailable'
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? 'Date unavailable'
    : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

export default function NotificationFeed({ role, onLogout, onOpenApprovals }) {
  const [notifications, setNotifications] = useState([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [refreshToken, setRefreshToken] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    async function loadNotifications() {
      setLoading(true)
      setError('')
      try {
        const savedAuth = sessionStorage.getItem('lms.auth')
        const auth = savedAuth ? JSON.parse(savedAuth) : null
        if (auth?.user?.role !== role || typeof auth.token !== 'string') {
          onLogout()
          return
        }
        const requestOptions = {
          headers: { Authorization: `Bearer ${auth.token}` },
          signal: controller.signal,
        }
        const response = role === 'student'
          ? await fetchWithAuth(`${API_BASE_URL}/notifications/me`, requestOptions, API_BASE_URL, auth.token)
          : await fetch(`${API_BASE_URL}/notifications/me`, requestOptions)
        const result = await response.json()
        if (response.status === 401 || response.status === 403) {
          onLogout()
          return
        }
        if (!response.ok) throw new Error(result.message || 'Unable to load notifications.')
        if (!Array.isArray(result.notifications)) {
          throw new Error('The server returned invalid notifications.')
        }
        setNotifications(result.notifications)
      } catch (loadError) {
        if (loadError.name !== 'AbortError') {
          setError(loadError instanceof Error ? loadError.message : 'Unable to load notifications.')
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false)
      }
    }

    loadNotifications()
    const refresh = () => setRefreshToken((current) => current + 1)
    if (role === 'student') window.addEventListener(STUDENT_NOTIFICATIONS_UPDATED_EVENT, refresh)
    return () => {
      controller.abort()
      if (role === 'student') window.removeEventListener(STUDENT_NOTIFICATIONS_UPDATED_EVENT, refresh)
    }
  }, [onLogout, role, refreshToken])

  if (loading) return <p className="notification-feed__message" role="status">Loading notifications…</p>
  if (error) return <p className="notification-feed__message is-error" role="alert">{error}</p>
  if (!notifications.length) {
    return <p className="notification-feed__message">{role === 'student' ? 'No notifications yet.' : 'You’re all caught up. There are no notifications yet.'}</p>
  }

  const visibleNotifications = role === 'student' ? notifications.slice(0, 2) : notifications

  return (
    <div className={`notification-feed${role === 'student' ? ' notification-feed--student' : ''}`}>
      {visibleNotifications.map((notification) => (
        <article
          className={`notification-feed__item${role === 'student' ? ` is-${notification.isRead ? 'read' : 'unread'}` : ''}`}
          key={notification.id}
        >
          {role === 'student' && (
            <span className="notification-feed__student-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none">
                <path d="M3 10v4h4l10 5V5L7 10H3Z" />
                <path d="M7 14 9 20h4l-3-7m9-4a5 5 0 0 1 0 8m2-11a9 9 0 0 1 0 14" />
              </svg>
            </span>
          )}
          <div className="notification-feed__copy">
            {role === 'student' ? (
              <div className="notification-feed__student-heading">
                <h3>{notification.title}</h3>
                <span className={`notification-feed__read-status${notification.isRead ? ' is-read' : ' is-unread'}`}>
                  {notification.isRead ? 'Read' : 'Unread'}
                </span>
              </div>
            ) : <h3>{notification.title}</h3>}
            <p>{notification.message}</p>
            <time dateTime={notification.createdAt || undefined}>{formatNotificationDate(notification.createdAt)}</time>
          </div>
          {role === 'main_admin' && notification.type === 'independent_student_registered' && (
            <button type="button" className="notification-feed__action" onClick={onOpenApprovals}>
              Review application
            </button>
          )}
        </article>
      ))}
    </div>
  )
}
