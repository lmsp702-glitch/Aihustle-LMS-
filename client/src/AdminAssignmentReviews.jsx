import React, { useEffect, useState } from 'react'
import { API_BASE_URL } from './api-base-url.js'
import './AdminAssignmentReviews.css'

async function adminRequest(path, onLogout, { method = 'GET', body, signal } = {}) {
  let auth
  try {
    const storedAuth = sessionStorage.getItem('lms.auth')
    auth = storedAuth ? JSON.parse(storedAuth) : null
  } catch {
    onLogout()
    throw new Error('Your admin session could not be verified. Sign in again.')
  }
  if (auth?.user?.role !== 'main_admin' || typeof auth.token !== 'string') {
    onLogout()
    throw new Error('Your admin session has expired. Sign in again.')
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
  const text = await response.text()
  let result
  try {
    result = text ? JSON.parse(text) : {}
  } catch {
    throw new Error('The server returned an invalid assignment review response.')
  }
  if (response.status === 401 || response.status === 403) {
    onLogout()
    throw new Error(result.message || 'Your admin session has expired. Sign in again.')
  }
  if (!response.ok) throw new Error(result.message || 'The assignment review could not be completed.')
  return result
}

async function downloadSubmission(review, onLogout) {
  let auth
  try {
    auth = JSON.parse(sessionStorage.getItem('lms.auth') || 'null')
  } catch {
    onLogout()
    throw new Error('Your admin session could not be verified. Sign in again.')
  }
  if (auth?.user?.role !== 'main_admin' || typeof auth.token !== 'string') {
    onLogout()
    throw new Error('Your admin session has expired. Sign in again.')
  }
  const response = await fetch(
    `${API_BASE_URL}/admin/assignment-reviews/${encodeURIComponent(review.id)}/file`,
    { headers: { Authorization: `Bearer ${auth.token}` } },
  )
  if (response.status === 401 || response.status === 403) {
    onLogout()
    throw new Error('Your admin session has expired. Sign in again.')
  }
  if (!response.ok) {
    const result = await response.json().catch(() => null)
    throw new Error(result?.message || 'The submitted file could not be opened.')
  }
  const url = URL.createObjectURL(await response.blob())
  const link = document.createElement('a')
  link.href = url
  link.download = review.fileName || 'assignment-submission'
  document.body.append(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000)
}

function AssignmentReviewCard({ review, onLogout, onSave, saving }) {
  const [marks, setMarks] = useState(review.marks ?? '')
  const [feedback, setFeedback] = useState(review.feedback || '')
  const [error, setError] = useState('')
  const reviewed = ['approved', 'rejected'].includes(String(review.status).toLowerCase())
  const numericMarks = marks === '' ? Number.NaN : Number(marks)
  const totalMarks = Number(review.maximumMarks)
  const passingMarks = Number(review.passingMarks)
  const totalMarksAreValid = Number.isFinite(totalMarks) && totalMarks > 0
  const passingMarksAreValid = totalMarksAreValid
    && Number.isFinite(passingMarks)
    && passingMarks > 0
    && passingMarks <= totalMarks
  const marksAreValid = Number.isFinite(numericMarks)
    && numericMarks >= 0
    && totalMarksAreValid
    && numericMarks <= totalMarks
  const canApprove = marksAreValid && passingMarksAreValid && numericMarks >= passingMarks
  const canReject = marksAreValid && passingMarksAreValid && numericMarks < passingMarks

  async function submitReview(event, decision) {
    event.preventDefault()
    setError('')
    try {
      await onSave(review, { decision, marks, feedback })
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'The review could not be saved.')
    }
  }

  async function openFile() {
    setError('')
    try {
      await downloadSubmission(review, onLogout)
    } catch (fileError) {
      setError(fileError instanceof Error ? fileError.message : 'The submitted file could not be opened.')
    }
  }

  return (
    <article className="admin-human-review">
      <header className="admin-human-review__header">
        <div>
          <h3>{review.assignmentTitle}</h3>
          <p>{review.courseName} · {review.studentName}{review.studentEmail ? ` · ${review.studentEmail}` : ''}</p>
        </div>
        <span className={`admin-human-review__status ${reviewed ? 'is-active' : 'is-requested'}`}>
          {String(review.status || 'submitted').replaceAll('-', ' ')}
        </span>
      </header>
      {review.instructions && <p className="admin-human-review__instructions">{review.instructions}</p>}
      <p className="admin-human-review__meta">
        Submitted {review.submittedAt ? new Date(review.submittedAt).toLocaleString() : 'date unavailable'}
        {' · '}{review.fileName}
      </p>
      <p className="admin-human-review__meta">
        Total marks: {totalMarksAreValid ? totalMarks : 'Not configured'}
        {' · '}Passing marks: {passingMarksAreValid ? passingMarks : 'Not configured'}
        {review.attemptNumber ? ` · Attempt ${review.attemptNumber} of 3` : ''}
      </p>
      <div className="admin-human-review__actions">
        <button type="button" className="admin-button admin-button--secondary" onClick={openFile}>
          View / download submission
        </button>
      </div>
      <form className="admin-human-review__form" onSubmit={(event) => submitReview(event, 'approved')}>
        <h4>Manual review</h4>
        <label>
          Marks (out of {review.maximumMarks})
          <input
            type="number"
            min="0"
            max={review.maximumMarks}
            step="any"
            required
            value={marks}
            onChange={(event) => setMarks(event.target.value)}
          />
        </label>
        {!passingMarksAreValid && (
          <p className="admin-human-review__error">
            Configure passing marks above zero and no higher than the total marks in Course Management before reviewing this submission.
          </p>
        )}
        <label>
          Feedback for student
          <textarea
            rows="4"
            maxLength="5000"
            required
            value={feedback}
            onChange={(event) => setFeedback(event.target.value)}
          />
        </label>
        {error && <p className="admin-human-review__error" role="alert">{error}</p>}
        <div className="admin-human-review__actions">
          <button className="admin-button admin-button--primary" type="submit" disabled={saving || reviewed || !canApprove}>
            {saving ? 'Saving…' : 'Approve · Pass'}
          </button>
          <button
            className="admin-button admin-button--secondary"
            type="button"
            disabled={saving || reviewed || !canReject}
            onClick={(event) => submitReview(event, 'rejected')}
          >
            {saving ? 'Saving…' : 'Reject · Fail'}
          </button>
        </div>
      </form>
      {reviewed && (
        <p className="admin-human-review__meta">
          Saved result: {review.marks} / {review.maximumMarks}
          {review.reviewedAt ? ` · Reviewed ${new Date(review.reviewedAt).toLocaleString()}` : ''}
          {review.attemptNumber ? ` · Attempt ${review.attemptNumber} of 3` : ''}
          {review.feedback ? ` · ${review.feedback}` : ''}
        </p>
      )}
    </article>
  )
}

export default function AdminAssignmentReviews({ onLogout }) {
  const [reviews, setReviews] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [savingIds, setSavingIds] = useState({})
  const [refresh, setRefresh] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    let active = true
    setLoading(true)
    setError('')
    adminRequest('/admin/assignment-reviews', onLogout, { signal: controller.signal })
      .then((result) => {
        if (active) setReviews(Array.isArray(result.reviews) ? result.reviews : [])
      })
      .catch((loadError) => {
        if (active && loadError?.name !== 'AbortError') {
          setError(loadError instanceof Error ? loadError.message : 'Assignment submissions could not be loaded.')
        }
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
      controller.abort()
    }
  }, [onLogout, refresh])

  async function saveReview(review, result) {
    setSavingIds((current) => ({ ...current, [review.id]: true }))
    try {
      const response = await adminRequest(
        `/admin/assignment-reviews/${encodeURIComponent(review.id)}`,
        onLogout,
        { method: 'PUT', body: result },
      )
      setReviews((current) => current.map((entry) => (
        entry.id === review.id ? response.review : entry
      )))
    } finally {
      setSavingIds((current) => ({ ...current, [review.id]: false }))
    }
  }

  return (
    <section className="admin-human-reviews" aria-labelledby="admin-human-reviews-title">
      <header className="admin-human-reviews__heading">
        <div>
          <span className="admin-human-reviews__eyebrow">Manual grading</span>
          <h2 id="admin-human-reviews-title">Assignment Reviews</h2>
          <p>Review Hustler student submissions, enter marks and feedback, then approve or reject.</p>
        </div>
        <button type="button" className="admin-button admin-button--secondary" onClick={() => setRefresh((value) => value + 1)}>
          Refresh
        </button>
      </header>
      {error && <p className="admin-human-review__error" role="alert">{error}</p>}
      {loading ? <p className="admin-progress-empty">Loading assignment submissions…</p>
        : reviews.length === 0 ? <p className="admin-progress-empty">No Hustler assignment submissions are available to review.</p>
          : <div className="admin-human-reviews__list">
            {reviews.map((review) => (
              <AssignmentReviewCard
                key={review.id}
                review={review}
                onLogout={onLogout}
                onSave={saveReview}
                saving={Boolean(savingIds[review.id])}
              />
            ))}
          </div>}
    </section>
  )
}
