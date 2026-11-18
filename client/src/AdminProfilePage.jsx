import React, { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { API_BASE_URL } from './api-base-url.js'
import './AdminProfilePage.css'

const usernamePattern = /^[a-zA-Z0-9._-]{3,30}$/

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

async function profileRequest(path, options = {}) {
  const headers = new Headers(options.headers)
  headers.set('Authorization', `Bearer ${getToken()}`)
  if (options.body && !(options.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json')
  }
  const response = await fetch(`${API_BASE_URL}/settings${path}`, { ...options, headers })
  if (!response.ok) {
    const result = await response.json().catch(() => ({}))
    const error = new Error(result.message || 'The request could not be completed.')
    error.status = response.status
    throw error
  }
  return response
}

export default function AdminProfilePage({
  user,
  onAccountUpdated,
  onLogout,
  isDark = false,
  standalone = false,
  onBack,
}) {
  const [account, setAccount] = useState(() => user || null)
  const [isLoading, setIsLoading] = useState(!user?.email)
  const [loadError, setLoadError] = useState('')
  const [isEditing, setIsEditing] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [isUploadingAvatar, setIsUploadingAvatar] = useState(false)
  const [formError, setFormError] = useState('')
  const [formNotice, setFormNotice] = useState('')
  const [avatarError, setAvatarError] = useState('')
  const [avatarNotice, setAvatarNotice] = useState('')

  const fileInputRef = useRef(null)

  const [formData, setFormData] = useState({
    fullName: user?.fullName || '',
    username: user?.username || '',
    phone: user?.phone || '',
  })

  useEffect(() => {
    let active = true
    profileRequest('/')
      .then((res) => res.json())
      .then((data) => {
        if (active && data?.account) {
          setAccount(data.account)
          setFormData({
            fullName: data.account.fullName || '',
            username: data.account.username || '',
            phone: data.account.phone || '',
          })
          if (typeof onAccountUpdated === 'function') {
            onAccountUpdated({
              ...user,
              ...data.account,
            })
          }
        }
      })
      .catch((err) => {
        if (active) {
          setLoadError(err instanceof Error ? err.message : 'Could not load profile details.')
        }
      })
      .finally(() => {
        if (active) setIsLoading(false)
      })
    return () => { active = false }
  }, [])

  function startEditing() {
    setFormData({
      fullName: account?.fullName || '',
      username: account?.username || '',
      phone: account?.phone || '',
    })
    setFormError('')
    setFormNotice('')
    setIsEditing(true)
  }

  function cancelEditing() {
    setFormData({
      fullName: account?.fullName || '',
      username: account?.username || '',
      phone: account?.phone || '',
    })
    setFormError('')
    setIsEditing(false)
  }

  async function handleSaveProfile(e) {
    e.preventDefault()
    setFormError('')
    setFormNotice('')

    const trimmedName = formData.fullName.trim()
    const trimmedUsername = formData.username.trim().toLowerCase()
    const trimmedPhone = formData.phone.trim()

    if (trimmedName.length < 2 || trimmedName.length > 120) {
      setFormError('Display name must be between 2 and 120 characters.')
      return
    }

    if (!usernamePattern.test(trimmedUsername)) {
      setFormError('Username must be 3–30 characters and use only letters, numbers, dots, underscores, or hyphens.')
      return
    }

    if (trimmedPhone.length > 40) {
      setFormError('Phone number cannot exceed 40 characters.')
      return
    }

    setIsSaving(true)
    try {
      const response = await profileRequest('/profile', {
        method: 'PATCH',
        body: JSON.stringify({
          fullName: trimmedName,
          username: trimmedUsername,
          phone: trimmedPhone,
        }),
      })
      const data = await response.json()
      const updatedAccount = data?.account || {
        ...account,
        fullName: trimmedName,
        username: trimmedUsername,
        phone: trimmedPhone,
      }
      setAccount(updatedAccount)
      if (typeof onAccountUpdated === 'function') {
        onAccountUpdated({
          ...user,
          ...updatedAccount,
        })
      }
      setIsEditing(false)
      setFormNotice('Profile updated successfully.')
      setTimeout(() => setFormNotice(''), 4000)
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to save profile changes. Please try again.')
    } finally {
      setIsSaving(false)
    }
  }

  async function handleAvatarChange(e) {
    const file = e.target.files?.[0]
    if (!file) return

    setAvatarError('')
    setAvatarNotice('')

    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif']
    if (!allowedTypes.includes(file.type)) {
      setAvatarError('Please upload a valid image file (JPEG, PNG, or WebP).')
      return
    }

    if (file.size > 5 * 1024 * 1024) {
      setAvatarError('Profile picture must be 5 MB or smaller.')
      return
    }

    const uploadData = new FormData()
    uploadData.append('avatar', file)

    setIsUploadingAvatar(true)
    try {
      const response = await profileRequest('/avatar', {
        method: 'POST',
        body: uploadData,
      })
      const data = await response.json()
      const newAvatarUrl = data?.avatarUrl || ''
      setAccount((prev) => ({ ...prev, avatarUrl: newAvatarUrl }))
      if (typeof onAccountUpdated === 'function') {
        onAccountUpdated({
          ...user,
          avatarUrl: newAvatarUrl,
        })
      }
      setAvatarNotice('Profile picture updated successfully.')
      setTimeout(() => setAvatarNotice(''), 4000)
    } catch (err) {
      setAvatarError(err instanceof Error ? err.message : 'Failed to upload profile picture. Please try again.')
    } finally {
      setIsUploadingAvatar(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  async function handleRemoveAvatar() {
    if (!window.confirm('Are you sure you want to remove your profile picture?')) return

    setAvatarError('')
    setAvatarNotice('')
    setIsUploadingAvatar(true)

    try {
      await profileRequest('/avatar', { method: 'DELETE' })
      setAccount((prev) => ({ ...prev, avatarUrl: '' }))
      if (typeof onAccountUpdated === 'function') {
        onAccountUpdated({
          ...user,
          avatarUrl: '',
        })
      }
      setAvatarNotice('Profile picture removed.')
      setTimeout(() => setAvatarNotice(''), 4000)
    } catch (err) {
      setAvatarError(err instanceof Error ? err.message : 'Failed to remove profile picture.')
    } finally {
      setIsUploadingAvatar(false)
    }
  }

  const initials = ((account?.fullName || user?.fullName || account?.email || 'A')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase()) || 'AD'

  return (
    <div className={`admin-profile-page${standalone ? ' admin-profile-page--standalone' : ''}`}>
      <div className="admin-profile-page__nav">
        {onBack ? (
          <button type="button" className="admin-back-dashboard-btn" onClick={onBack}>
            <span aria-hidden="true">←</span> Back to Dashboard
          </button>
        ) : (
          <Link className="admin-back-dashboard" to="/admin/dashboard">
            <span aria-hidden="true">←</span> Back to Dashboard
          </Link>
        )}
      </div>

      <header className="admin-profile-page__header">
        <span className="admin-profile-eyebrow">ADMINISTRATOR PROFILE</span>
        <div className="admin-profile-header__row">
          <div>
            <h1>My Profile</h1>
            <p>Manage your personal details, profile picture, and administrative account information.</p>
          </div>
          {!isEditing && (
            <button
              type="button"
              className="admin-profile-edit-btn"
              onClick={startEditing}
              disabled={isLoading}
            >
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
              </svg>
              <span>Edit Profile</span>
            </button>
          )}
        </div>
      </header>

      {formNotice && <p className="admin-profile-notice is-success" role="status">{formNotice}</p>}
      {formError && <p className="admin-profile-notice is-error" role="alert">{formError}</p>}
      {avatarNotice && <p className="admin-profile-notice is-success" role="status">{avatarNotice}</p>}
      {avatarError && <p className="admin-profile-notice is-error" role="alert">{avatarError}</p>}
      {loadError && <p className="admin-profile-notice is-error" role="alert">{loadError}</p>}

      <div className="admin-profile-grid">
        {/* Profile Hero Card */}
        <div className="admin-profile-hero-card">
          <div className="admin-profile-hero__avatar-wrapper">
            <div className="admin-profile-hero__avatar">
              {account?.avatarUrl ? (
                <img
                  src={account.avatarUrl}
                  alt={`${account.fullName || 'Administrator'}'s profile picture`}
                  className="admin-profile-hero__img"
                />
              ) : (
                <span className="admin-profile-hero__initials" aria-hidden="true">{initials}</span>
              )}
            </div>

            <div className="admin-profile-hero__avatar-actions">
              <input
                ref={fileInputRef}
                type="file"
                id="admin-avatar-upload"
                className="admin-profile-file-input"
                accept="image/png,image/jpeg,image/webp,image/gif"
                onChange={handleAvatarChange}
                disabled={isUploadingAvatar}
              />
              <label
                htmlFor="admin-avatar-upload"
                className="admin-profile-upload-btn"
                title="Upload new profile picture"
              >
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                  <circle cx="12" cy="13" r="4" />
                </svg>
                <span>{isUploadingAvatar ? 'Uploading…' : account?.avatarUrl ? 'Change Picture' : 'Upload Picture'}</span>
              </label>

              {account?.avatarUrl && (
                <button
                  type="button"
                  className="admin-profile-remove-btn"
                  onClick={handleRemoveAvatar}
                  disabled={isUploadingAvatar}
                  title="Remove custom profile picture"
                >
                  Remove
                </button>
              )}
            </div>
            <p className="admin-profile-avatar-hint">PNG, JPEG, or WebP. Max size: 5 MB.</p>
          </div>

          <div className="admin-profile-hero__info">
            <div className="admin-profile-hero__title-row">
              <h2>{account?.fullName || 'Platform Administrator'}</h2>
              <span className="admin-profile-badge">
                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                </svg>
                Platform Administrator
              </span>
            </div>
            <p className="admin-profile-hero__email">{account?.email || 'admin@aihustle.internal'}</p>

            <div className="admin-profile-hero__tags">
              <span className="admin-profile-tag is-active">
                <span className="admin-profile-tag__dot" />
                Active Account
              </span>
              <span className="admin-profile-tag">Superadmin Privileges</span>
              {account?.username && (
                <span className="admin-profile-tag">@{account.username}</span>
              )}
            </div>
          </div>
        </div>

        {/* Profile Information & Edit Section */}
        <div className="admin-profile-content-card">
          {isEditing ? (
            <form className="admin-profile-edit-form" onSubmit={handleSaveProfile} noValidate>
              <div className="admin-profile-section-heading">
                <h3>Edit Profile Information</h3>
                <p>Update your display name, username, and contact phone number.</p>
              </div>

              <div className="admin-profile-fields-grid">
                <div className="admin-profile-field">
                  <label htmlFor="admin-full-name">
                    Full Name <span className="admin-required">*</span>
                  </label>
                  <input
                    id="admin-full-name"
                    type="text"
                    value={formData.fullName}
                    onChange={(e) => setFormData((prev) => ({ ...prev, fullName: e.target.value }))}
                    placeholder="Enter your full name"
                    required
                    minLength={2}
                    maxLength={120}
                    disabled={isSaving}
                  />
                  <small>Your full name as displayed in LMS dashboards and administrative records.</small>
                </div>

                <div className="admin-profile-field">
                  <label htmlFor="admin-username">
                    Username <span className="admin-required">*</span>
                  </label>
                  <input
                    id="admin-username"
                    type="text"
                    value={formData.username}
                    onChange={(e) => setFormData((prev) => ({ ...prev, username: e.target.value }))}
                    placeholder="admin_username"
                    required
                    maxLength={30}
                    disabled={isSaving}
                  />
                  <small>3–30 letters, numbers, dots, underscores, or hyphens.</small>
                </div>

                <div className="admin-profile-field">
                  <label htmlFor="admin-phone">Phone Number</label>
                  <input
                    id="admin-phone"
                    type="tel"
                    value={formData.phone}
                    onChange={(e) => setFormData((prev) => ({ ...prev, phone: e.target.value }))}
                    placeholder="e.g. +1 (555) 234-5678"
                    maxLength={40}
                    disabled={isSaving}
                  />
                  <small>Optional phone number for platform and administrative contact.</small>
                </div>

                <div className="admin-profile-field is-disabled">
                  <label htmlFor="admin-email">Email Address</label>
                  <input
                    id="admin-email"
                    type="email"
                    value={account?.email || ''}
                    disabled
                    readOnly
                  />
                  <small>Email address is managed securely via platform settings.</small>
                </div>
              </div>

              <div className="admin-profile-form-actions">
                <button
                  type="submit"
                  className="admin-profile-save-btn"
                  disabled={isSaving}
                >
                  {isSaving ? 'Saving Changes…' : 'Save Changes'}
                </button>
                <button
                  type="button"
                  className="admin-profile-cancel-btn"
                  onClick={cancelEditing}
                  disabled={isSaving}
                >
                  Cancel
                </button>
              </div>
            </form>
          ) : (
            <div className="admin-profile-view-details">
              <div className="admin-profile-section-heading">
                <h3>Account Information</h3>
                <p>Personal and authentication details associated with this administrator account.</p>
              </div>

              <div className="admin-profile-details-grid">
                <div className="admin-profile-detail-card">
                  <span className="admin-profile-detail__label">Full Name</span>
                  <strong className="admin-profile-detail__value">{account?.fullName || 'Not recorded'}</strong>
                </div>

                <div className="admin-profile-detail-card">
                  <span className="admin-profile-detail__label">Email Address</span>
                  <div className="admin-profile-detail__email-row">
                    <strong className="admin-profile-detail__value">{account?.email || 'Unavailable'}</strong>
                    <span className="admin-profile-verified-badge">Primary Email</span>
                  </div>
                </div>

                <div className="admin-profile-detail-card">
                  <span className="admin-profile-detail__label">Phone Number</span>
                  <strong className="admin-profile-detail__value">
                    {account?.phone || <span className="admin-profile-detail__empty">Not provided</span>}
                  </strong>
                </div>

                <div className="admin-profile-detail-card">
                  <span className="admin-profile-detail__label">Username</span>
                  <strong className="admin-profile-detail__value">@{account?.username || 'admin'}</strong>
                </div>

                <div className="admin-profile-detail-card">
                  <span className="admin-profile-detail__label">Admin Role</span>
                  <div className="admin-profile-detail__role-row">
                    <strong className="admin-profile-detail__value">Platform Administrator</strong>
                    <span className="admin-profile-role-pill">Superadmin</span>
                  </div>
                  <p className="admin-profile-detail__subtext">Full system access, course management, student approvals, and security control.</p>
                </div>

                <div className="admin-profile-detail-card">
                  <span className="admin-profile-detail__label">Security & Authentication</span>
                  <strong className="admin-profile-detail__value">
                    {account?.hasPassword ? 'Password Protected' : 'Single Sign-On'}
                  </strong>
                  <p className="admin-profile-detail__subtext">
                    Passwords and security settings can be updated in{' '}
                    <Link to="/admin/settings" className="admin-profile-link">Settings</Link>.
                  </p>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Quick Links Card */}
        <div className="admin-profile-sidebar-card">
          <h4>Administrative Quick Links</h4>
          <ul className="admin-profile-quick-links">
            <li>
              <Link to="/admin/dashboard" className="admin-profile-quick-link">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <rect x="3" y="3" width="7" height="9" />
                  <rect x="14" y="3" width="7" height="5" />
                  <rect x="14" y="12" width="7" height="9" />
                  <rect x="3" y="16" width="7" height="5" />
                </svg>
                <span>Dashboard Overview</span>
              </Link>
            </li>
            <li>
              <Link to="/admin/settings" className="admin-profile-quick-link">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <circle cx="12" cy="12" r="3" />
                  <path d="m19.4 15 .1.1a1.8 1.8 0 1 1-2.5 2.5l-.1-.1a1.8 1.8 0 0 0-3 .9v.2a1.8 1.8 0 1 1-3.6 0v-.2a1.8 1.8 0 0 0-3-.9l-.1.1a1.8 1.8 0 1 1-2.5-2.5l.1-.1a1.8 1.8 0 0 0-.9-3h-.2a1.8 1.8 0 1 1 0-3.6h.2a1.8 1.8 0 0 0 .9-3l-.1-.1a1.8 1.8 0 1 1 2.5-2.5l.1.1a1.8 1.8 0 0 0 3-.9v-.2a1.8 1.8 0 1 1 3.6 0v.2a1.8 1.8 0 0 0 3 .9l.1-.1a1.8 1.8 0 1 1 2.5 2.5l-.1.1a1.8 1.8 0 0 0 .9 3h.2a1.8 1.8 0 1 1 0 3.6h-.2a1.8 1.8 0 0 0-.9 3Z" />
                </svg>
                <span>Account & Password Settings</span>
              </Link>
            </li>
            <li>
              <Link to="/admin/support" className="admin-profile-quick-link">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                </svg>
                <span>Help & Support Center</span>
              </Link>
            </li>
          </ul>

          <div className="admin-profile-sidebar-logout">
            <button
              type="button"
              className="admin-profile-logout-action-btn"
              onClick={onLogout}
            >
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                <polyline points="16 17 21 12 16 7" />
                <line x1="21" y1="12" x2="9" y2="12" />
              </svg>
              <span>Log out of Administrator</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

