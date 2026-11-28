import React, { useEffect, useRef, useState } from 'react'
import { API_BASE_URL } from './api-base-url.js'
import AdminCertificateTemplateSettings from './AdminCertificateTemplateSettings.jsx'
import './AdminSettingsPage.css'

const usernamePattern = /^[a-zA-Z0-9._-]{3,30}$/

function getToken() {
  let token
  try {
    token = JSON.parse(sessionStorage.getItem('lms.auth') || '{}').token
  } catch {
    throw new Error('Your saved session is invalid. Please sign in again.')
  }
  if (typeof token !== 'string' || !token) throw new Error('Your session has expired. Please sign in again.')
  return token
}

function getErrorMessage(result) {
  if (typeof result?.message === 'string') return result.message
  if (typeof result?.detail === 'string') return result.detail
  const collectMessages = (value) => {
    if (typeof value === 'string') return [value]
    if (Array.isArray(value)) return value.flatMap(collectMessages)
    if (value && typeof value === 'object') return Object.values(value).flatMap(collectMessages)
    return []
  }
  return collectMessages(result).join(' ')
}

async function adminSettingsRequest(path, options = {}) {
  const headers = new Headers(options.headers)
  headers.set('Authorization', `Bearer ${getToken()}`)
  if (options.body && !(options.body instanceof FormData)) headers.set('Content-Type', 'application/json')
  const response = await fetch(`${API_BASE_URL}/admin/settings${path}`, { ...options, headers })
  const result = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error = new Error(getErrorMessage(result) || 'The settings request could not be completed.')
    error.status = response.status
    throw error
  }
  return result
}

function getInitials(name) {
  return String(name || 'Admin')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0] || '')
    .join('')
    .toUpperCase()
}

export default function AdminSettingsPage({ user, onAccountUpdated, onLogout }) {
  const [account, setAccount] = useState(null)
  const [profile, setProfile] = useState({ displayName: '', username: '' })
  const [isLoading, setIsLoading] = useState(true)
  const [isSavingProfile, setIsSavingProfile] = useState(false)
  const [isUploadingPhoto, setIsUploadingPhoto] = useState(false)
  const [profileError, setProfileError] = useState('')
  const [profileNotice, setProfileNotice] = useState('')
  const [accountError, setAccountError] = useState('')
  const [accountNotice, setAccountNotice] = useState('')
  const [password, setPassword] = useState({ current: '', next: '', confirm: '' })
  const [showPasswords, setShowPasswords] = useState(false)
  const [passwordError, setPasswordError] = useState('')
  const [passwordNotice, setPasswordNotice] = useState('')
  const [isChangingPassword, setIsChangingPassword] = useState(false)
  const avatarInputRef = useRef(null)

  useEffect(() => {
    let active = true
    adminSettingsRequest('')
      .then((result) => {
        if (!active) return
        const nextAccount = result.account || {
          name: user?.fullName || user?.name || '',
          username: user?.username || '',
          email: user?.email || '',
          accountType: 'Platform Admin',
          avatarUrl: user?.avatarUrl || '',
          hasPassword: false,
        }
        setAccount(nextAccount)
        setProfile({
          displayName: nextAccount.name || '',
          username: nextAccount.username || '',
        })
        onAccountUpdated?.({
          ...user,
          name: nextAccount.name,
          fullName: nextAccount.name,
          username: nextAccount.username,
          email: nextAccount.email,
          accountType: nextAccount.accountType,
          avatarUrl: nextAccount.avatarUrl,
        })
      })
      .catch((error) => {
        if (!active) return
        setProfileError(error instanceof Error ? error.message : 'Account information could not be loaded.')
        if (error.status === 401) onLogout?.()
      })
      .finally(() => {
        if (active) setIsLoading(false)
      })
    return () => { active = false }
  }, [])

  async function saveProfile(event) {
    event.preventDefault()
    setProfileError('')
    setProfileNotice('')
    const displayName = profile.displayName.trim()
    const username = profile.username.trim().toLowerCase()
    if (displayName.length < 2 || displayName.length > 120) {
      setProfileError('Display name must be between 2 and 120 characters.')
      return
    }
    if (!usernamePattern.test(username)) {
      setProfileError('Username must be 3-30 characters and use only letters, numbers, dots, underscores, or hyphens.')
      return
    }

    setIsSavingProfile(true)
    try {
      const result = await adminSettingsRequest('/profile', {
        method: 'PATCH',
        body: JSON.stringify({ displayName, username }),
      })
      setAccount(result.account)
      setProfile({
        displayName: result.account.name,
        username: result.account.username,
      })
      onAccountUpdated?.({
        ...user,
        name: result.account.name,
        fullName: result.account.name,
        username: result.account.username,
        email: result.account.email,
        accountType: result.account.accountType,
        avatarUrl: result.account.avatarUrl,
      })
      setProfileNotice('Account information saved.')
    } catch (error) {
      setProfileError(error instanceof Error ? error.message : 'Account information could not be saved.')
      if (error.status === 401) onLogout?.()
    } finally {
      setIsSavingProfile(false)
    }
  }

  async function changePassword(event) {
    event.preventDefault()
    setPasswordError('')
    setPasswordNotice('')
    if (password.next.length < 8 || new TextEncoder().encode(password.next).length > 72) {
      setPasswordError('New password must be at least 8 characters and no more than 72 UTF-8 bytes.')
      return
    }
    if (password.next !== password.confirm) {
      setPasswordError('The new passwords do not match.')
      return
    }
    if (!password.current) {
      setPasswordError('Enter your current password.')
      return
    }

    setIsChangingPassword(true)
    try {
      const result = await adminSettingsRequest('/password', {
        method: 'POST',
        body: JSON.stringify({ currentPassword: password.current, newPassword: password.next }),
      })
      setPassword({ current: '', next: '', confirm: '' })
      setPasswordNotice(result.message || 'Password changed.')
    } catch (error) {
      setPasswordError(error instanceof Error ? error.message : 'Password could not be changed.')
      if (error.status === 401) onLogout?.()
    } finally {
      setIsChangingPassword(false)
    }
  }

  async function uploadProfilePhoto(event) {
    const input = event.currentTarget
    const file = input.files?.[0]
    if (!file) return
    setAccountError('')
    setAccountNotice('')
    if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.type)) {
      setAccountError('Choose a JPEG, PNG, WebP, or GIF image.')
      input.value = ''
      return
    }
    if (file.size > 5 * 1024 * 1024) {
      setAccountError('Profile photos must be 5 MB or smaller.')
      input.value = ''
      return
    }

    const formData = new FormData()
    formData.append('avatar', file)
    setIsUploadingPhoto(true)
    try {
      const result = await adminSettingsRequest('/avatar', { method: 'POST', body: formData })
      const avatarUrl = result.avatarUrl || ''
      setAccount((current) => ({ ...current, avatarUrl }))
      onAccountUpdated?.({
        ...user,
        name: account?.name,
        fullName: account?.name,
        username: account?.username,
        email: account?.email,
        accountType: account?.accountType,
        avatarUrl,
      })
      setAccountNotice(result.cleanupWarning
        ? 'Profile photo updated. The previous image could not be removed.'
        : 'Profile photo updated.')
    } catch (error) {
      setAccountError(error instanceof Error ? error.message : 'Profile photo could not be uploaded.')
      if (error.status === 401) onLogout?.()
    } finally {
      setIsUploadingPhoto(false)
      input.value = ''
    }
  }

  async function removeProfilePhoto() {
    if (!account?.avatarUrl || !window.confirm('Remove your profile photo?')) return
    setIsUploadingPhoto(true)
    setAccountError('')
    setAccountNotice('')
    try {
      const result = await adminSettingsRequest('/avatar', { method: 'DELETE' })
      setAccount((current) => ({ ...current, avatarUrl: '' }))
      onAccountUpdated?.({
        ...user,
        name: account.name,
        fullName: account.name,
        username: account.username,
        email: account.email,
        accountType: account.accountType,
        avatarUrl: '',
      })
      setAccountNotice(result.cleanupWarning
        ? 'Profile photo removed. The stored image could not be deleted.'
        : 'Profile photo removed.')
    } catch (error) {
      setAccountError(error instanceof Error ? error.message : 'Profile photo could not be removed.')
      if (error.status === 401) onLogout?.()
    } finally {
      setIsUploadingPhoto(false)
    }
  }

  const accountType = account?.accountType || 'Platform Admin'

  return (
    <div className="admin-settings">
      <header className="admin-settings__hero">
        <div>
          <p>SYSTEM</p>
          <h1>SETTINGS</h1>
        </div>
        <img src="/admin-settings-illustration.svg" alt="" />
      </header>

      <section className="admin-settings__card" aria-labelledby="admin-settings-account-title">
        <header className="admin-settings__card-heading">
          <h2 id="admin-settings-account-title">Account Information</h2>
          <p>Review and update your account details. Your email and account permissions are managed by the platform.</p>
        </header>
        {isLoading ? (
          <p className="admin-settings__status" role="status">Loading account information...</p>
        ) : (
          <>
            {profileError && !account && <p className="admin-settings__message is-error" role="alert">{profileError}</p>}
            {account && (
              <>
                <div className="admin-settings__account-summary">
                  <div className="admin-settings__avatar" aria-hidden="true">
                    {account.avatarUrl
                      ? <img src={account.avatarUrl} alt="" />
                      : <span>{getInitials(account.name || profile.displayName)}</span>}
                  </div>
                  <div className="admin-settings__account-summary-copy">
                    <strong>{profile.username ? `@${profile.username}` : 'Admin'}</strong>
                    <span>{account.email || 'Email unavailable'}</span>
                  </div>
                  <span className="admin-settings__account-badge">{accountType}</span>
                </div>

                <form className="admin-settings__profile-form" onSubmit={saveProfile}>
                  <div className="admin-settings__fields">
                    <label className="admin-settings__field">
                      <span>Display name</span>
                      <input
                        autoComplete="name"
                        value={profile.displayName}
                        maxLength={120}
                        onChange={(event) => {
                          setProfile((current) => ({ ...current, displayName: event.currentTarget.value }))
                          setProfileError('')
                          setProfileNotice('')
                        }}
                        required
                      />
                    </label>
                    <label className="admin-settings__field">
                      <span>Username</span>
                      <input
                        autoComplete="username"
                        value={profile.username}
                        maxLength={30}
                        pattern="[A-Za-z0-9._-]{3,30}"
                        onChange={(event) => {
                          setProfile((current) => ({ ...current, username: event.currentTarget.value }))
                          setProfileError('')
                          setProfileNotice('')
                        }}
                        required
                      />
                    </label>
                    <label className="admin-settings__field">
                      <span>Email</span>
                      <input value={account.email || ''} readOnly />
                    </label>
                    <label className="admin-settings__field">
                      <span>Account type</span>
                      <input value={accountType} readOnly />
                    </label>
                  </div>

                  <div className="admin-settings__profile-photo">
                    <strong>Profile photo</strong>
                    <span>JPEG, PNG, WebP, or GIF. Up to 5 MB.</span>
                    <div className="admin-settings__photo-actions">
                      <button
                        type="button"
                        className="admin-settings__secondary-button"
                        onClick={() => avatarInputRef.current?.click()}
                        disabled={isUploadingPhoto}
                      >
                        {isUploadingPhoto ? 'Uploading...' : account.avatarUrl ? 'Change photo' : 'Upload photo'}
                      </button>
                      {account.avatarUrl && (
                        <button
                          type="button"
                          className="admin-settings__text-button"
                          onClick={removeProfilePhoto}
                          disabled={isUploadingPhoto}
                        >
                          Remove photo
                        </button>
                      )}
                      <input
                        ref={avatarInputRef}
                        className="admin-settings__file-input"
                        type="file"
                        accept="image/jpeg,image/png,image/webp,image/gif"
                        onChange={uploadProfilePhoto}
                      />
                    </div>
                  </div>

                  {profileError && account && <p className="admin-settings__message is-error" role="alert">{profileError}</p>}
                  {profileNotice && <p className="admin-settings__message is-success" role="status">{profileNotice}</p>}
                  {accountError && <p className="admin-settings__message is-error" role="alert">{accountError}</p>}
                  {accountNotice && <p className="admin-settings__message is-success" role="status">{accountNotice}</p>}
                  <div className="admin-settings__actions">
                    <button className="admin-settings__save-button" type="submit" disabled={isSavingProfile || isUploadingPhoto}>
                      {isSavingProfile ? 'Saving...' : 'Save account information'}
                    </button>
                  </div>
                </form>
              </>
            )}
          </>
        )}
      </section>

      <section className="admin-settings__card" aria-labelledby="admin-settings-certificate-title">
        <header className="admin-settings__card-heading">
          <h2 id="admin-settings-certificate-title">Certificate Management</h2>
          <p>Upload, preview, and replace the background used on automatically generated student certificates.</p>
        </header>
        <AdminCertificateTemplateSettings onLogout={onLogout} />
      </section>

      <section className="admin-settings__card" aria-labelledby="admin-settings-password-title">
        <header className="admin-settings__card-heading">
          <h2 id="admin-settings-password-title">Change Password</h2>
          <p>Use a unique password. Passwords must be at least 8 characters and are securely hashed.</p>
        </header>
        {account && !account.hasPassword ? (
          <p className="admin-settings__status">This administrator account does not have a password set.</p>
        ) : (
          <form className="admin-settings__password-form" onSubmit={changePassword}>
            <label className="admin-settings__field">
              <span>Current password</span>
              <input
                type={showPasswords ? 'text' : 'password'}
                autoComplete="current-password"
                value={password.current}
                onChange={(event) => setPassword((current) => ({ ...current, current: event.currentTarget.value }))}
                required
              />
            </label>
            <label className="admin-settings__field">
              <span>New password</span>
              <input
                type={showPasswords ? 'text' : 'password'}
                autoComplete="new-password"
                value={password.next}
                onChange={(event) => setPassword((current) => ({ ...current, next: event.currentTarget.value }))}
                minLength={8}
                maxLength={128}
                required
              />
            </label>
            <label className="admin-settings__field">
              <span>Confirm new password</span>
              <input
                type={showPasswords ? 'text' : 'password'}
                autoComplete="new-password"
                value={password.confirm}
                onChange={(event) => setPassword((current) => ({ ...current, confirm: event.currentTarget.value }))}
                minLength={8}
                maxLength={128}
                required
              />
            </label>
            <label className="admin-settings__show-passwords">
              <input
                type="checkbox"
                checked={showPasswords}
                onChange={(event) => setShowPasswords(event.currentTarget.checked)}
              />
              <span>Show passwords</span>
            </label>
            {passwordError && <p className="admin-settings__message is-error" role="alert">{passwordError}</p>}
            {passwordNotice && <p className="admin-settings__message is-success" role="status">{passwordNotice}</p>}
            <ul className="admin-settings__password-hints">
              <li>At least 8 characters</li>
              <li>New passwords must match</li>
              <li>Maximum 72 UTF-8 bytes</li>
            </ul>
            <div className="admin-settings__actions">
              <button className="admin-settings__save-button" type="submit" disabled={isChangingPassword || isLoading}>
                {isChangingPassword ? 'Changing password...' : 'Change password'}
              </button>
            </div>
          </form>
        )}
      </section>

      <section className="admin-settings__card" aria-labelledby="admin-settings-delete-title">
        <header className="admin-settings__card-heading">
          <h2 id="admin-settings-delete-title">Delete Account</h2>
          <p>Platform administrator accounts cannot be deleted.</p>
        </header>
        <div className="admin-settings__delete-warning" role="note">
          <strong>Platform administrator account</strong>
          <p>Root platform administrator accounts cannot be deleted from self-service settings.</p>
        </div>
      </section>
    </div>
  )
}
