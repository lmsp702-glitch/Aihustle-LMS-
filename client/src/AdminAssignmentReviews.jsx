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
    throw new Error('The server returned an invalid human review response.')
  }
  if (response.status === 401 || response.status === 403) {
    onLogout()
    throw new Error(result.message || 'Your admin session has expired. Sign in again.')
  }
  if (!response.ok) throw new Error(result.message || 'The human review could not be completed.')
  return result
}

async function openSubmissionFile(submission, onLogout) {
  let auth
  try {
    const storedAuth = sessionStorage.getItem('lms.auth')
    auth = storedAuth ? JSON.parse(storedAuth) : null
  } catch {
    onLogout()
    throw new Error('Your admin session could not be verified. Sign in again.')
  }
  if (typeof auth?.token !== 'string') {
    onLogout()
    throw new Error('Your admin session has expired. Sign in again.')
  }
  const response = await fetch(`${API_BASE_URL}${submission.fileUrl}`, {
    headers: { Authorization: `Bearer ${auth.token}` },
  })
  if (response.status === 401 || response.status === 403) {
    onLogout()
    throw new Error('Your admin session has expired. Sign in again.')
  }
  if (!response.ok) throw new Error('The original submission could not be downloaded.')
  const blob = await response.blob()
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = submission.fileName
  link.click()
  URL.revokeObjectURL(url)
}

function HumanEvaluationForm({ review, saving, onSave }) {
  const [criteria, setCriteria] = useState(() => (
    (review.aiEvaluation?.criteria || []).map((criterion) => ({ ...criterion }))
  ))
  const [feedback, setFeedback] = useState(review.aiEvaluation?.overallFeedback || '')
  const [error, setError] = useState('')
  const marks = criteria.reduce((sum, criterion) => sum + Number(criterion.marks || 0), 0)

  async function submit(event) {
    event.preventDefault()
    setError('')
    try {
      await onSave(review, { marks, feedback, criteria })
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'The final result could not be saved.')
    }
  }

  return (
    <form className="admin-human-review__form" onSubmit={submit}>
      <h4>Human evaluation</h4>
      {criteria.map((criterion, index) => (
        <fieldset className="admin-human-review__criterion" key={`${criterion.name}-${index}`}>
          <legend>{criterion.name} · max {criterion.maximumMarks}</legend>
          <label>
            Marks
            <input
              type="number"
              min="0"
              max={criterion.maximumMarks}
              step="any"
              required
              value={criterion.marks}
              onChange={(event) => setCriteria((current) => current.map((item, itemIndex) => (
                itemIndex === index ? { ...item, marks: event.target.value === '' ? '' : Number(event.target.value) } : item
              )))}
            />
          </label>
          <label>
            Criterion feedback
            <textarea
              rows="2"
              maxLength="2000"
              required
              value={criterion.feedback}
              onChange={(event) => setCriteria((current) => current.map((item, itemIndex) => (
                itemIndex === index ? { ...item, feedback: event.target.value } : item
              )))}
            />
          </label>
        </fieldset>
      ))}
      <p className="admin-human-review__total">Final marks: <strong>{marks}</strong> / {review.maximumMarks}</p>
      <label>
        Final feedback to the student
        <textarea rows="4" maxLength="5000" required value={feedback} onChange={(event) => setFeedback(event.target.value)} />
      </label>
      {error && <p className="admin-human-review__error" role="alert">{error}</p>}
      <button className="admin-button admin-button--primary" type="submit" disabled={saving || !criteria.length}>
        {saving ? 'Publishing…' : 'Publish final result'}
      </button>
    </form>
  )
}

function AssignmentHumanReviewCard({ review, onLogout, onStarted, onSave, saving }) {
  const [error, setError] = useState('')
  const evaluation = review.aiEvaluation

  async function download() {
    setError('')
    try {
      await openSubmissionFile(review, onLogout)
    } catch (fileError) {
      setError(fileError instanceof Error ? fileError.message : 'The original submission could not be opened.')
    }
  }

  async function beginReview() {
    setError('')
    try {
      await onStarted(review)
    } catch (startError) {
      setError(startError instanceof Error ? startError.message : 'The human review could not be started.')
    }
  }

  return (
    <article className="admin-human-review">
      <header className="admin-human-review__header">
        <div>
          <h3>{review.assignmentName}</h3>
          <p>{review.courseName} · {review.studentName}{review.studentEmail ? ` · ${review.studentEmail}` : ''}</p>
        </div>
        <span className={`admin-human-review__status is-${review.gradingStatus === 'Human Review' ? 'active' : 'requested'}`}>
          {review.gradingStatus}
        </span>
      </header>
      {review.instructions && <p className="admin-human-review__instructions">{review.instructions}</p>}
      <p className="admin-human-review__meta">
        Submitted {review.submittedAt ? new Date(review.submittedAt).toLocaleString() : 'date unavailable'}
        {' · '}{review.fileName}
        {' · '}Attempt {review.attemptNumber || '—'} of {review.attemptState?.maxAttempts || 3}
      </p>
      <div className="admin-human-review__request">
        <strong>Student’s reason for disagreement</strong>
        {review.humanReviewRequest?.reasons?.length
          ? <ul>{review.humanReviewRequest.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
          : <p>{review.humanReviewRequest?.reason || 'No reason recorded.'}</p>}
        {review.humanReviewRequest?.otherExplanation && (
          <p><strong>Other explanation:</strong> {review.humanReviewRequest.otherExplanation}</p>
        )}
        {review.humanReviewRequest?.comments && (
          <p><strong>Additional comments:</strong> {review.humanReviewRequest.comments}</p>
        )}
      </div>
      <div className="admin-human-review__attempt-state">
        <span>Failed attempts in the current 24-hour window: {review.attemptState?.failedAttempts ?? '—'}</span>
        <span>Remaining attempts: {review.attemptState?.remainingAttempts ?? '—'}</span>
        {review.attemptState?.lockoutUntil && (
          <span>Next submission available: {new Date(review.attemptState.lockoutUntil).toLocaleString()}</span>
        )}
      </div>
      {review.attemptHistory?.length > 1 && (
        <details className="admin-human-review__history">
          <summary>Previous attempt evaluations ({review.attemptHistory.length})</summary>
          {review.attemptHistory.map((attempt) => {
            const evaluation = attempt.humanEvaluation || attempt.aiEvaluation
            const marks = attempt.finalMarks ?? attempt.marksObtained ?? evaluation?.totalMarks
            const feedback = attempt.humanEvaluation?.overallFeedback || attempt.aiEvaluation?.overallFeedback
            return (
              <article key={attempt.id}>
                <strong>Attempt {attempt.attemptNumber || '—'} · {marks ?? '—'} / {evaluation?.maximumMarks ?? review.maximumMarks ?? '—'} · {attempt.academicStatus || attempt.gradingStatus}</strong>
                {feedback && <p>{feedback}</p>}
              </article>
            )
          })}
        </details>
      )}
      <section className="admin-human-review__ai">
        <div className="admin-human-review__ai-heading">
          <h4>Original AI evaluation</h4>
          <strong>{evaluation?.totalMarks ?? '—'} / {evaluation?.maximumMarks ?? review.maximumMarks ?? '—'}</strong>
        </div>
        {(evaluation?.criteria || []).map((criterion, index) => (
          <div className="admin-human-review__ai-criterion" key={`${criterion.name}-${index}`}>
            <strong>{criterion.name}: {criterion.marks} / {criterion.maximumMarks}</strong>
            <p>{criterion.feedback}</p>
          </div>
        ))}
        {evaluation?.strengths?.length > 0 && <p><strong>Strengths:</strong> {evaluation.strengths.join(' · ')}</p>}
        {evaluation?.improvements?.length > 0 && <p><strong>Improvements:</strong> {evaluation.improvements.join(' · ')}</p>}
        <p><strong>Feedback:</strong> {evaluation?.overallFeedback}</p>
      </section>
      {error && <p className="admin-human-review__error" role="alert">{error}</p>}
      <div className="admin-human-review__actions">
        <button type="button" className="admin-button admin-button--secondary" onClick={download}>Download original submission</button>
        {review.gradingStatus === 'Re-evaluation Requested' && (
          <button type="button" className="admin-button admin-button--primary" onClick={beginReview}>Begin human review</button>
        )}
      </div>
      {review.gradingStatus === 'Human Review' && (
        <HumanEvaluationForm review={review} saving={saving} onSave={onSave} />
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
    adminRequest('/admin/assignment-human-reviews', onLogout, { signal: controller.signal })
      .then((result) => {
        if (active) setReviews(Array.isArray(result.reviews) ? result.reviews : [])
      })
      .catch((loadError) => {
        if (active && loadError?.name !== 'AbortError') {
          setError(loadError instanceof Error ? loadError.message : 'Human review requests could not be loaded.')
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

  async function startReview(review) {
    await adminRequest(`/admin/assignment-human-reviews/${encodeURIComponent(review.id)}/start`, onLogout, { method: 'PATCH' })
    setRefresh((value) => value + 1)
  }

  async function publishResult(review, result) {
    setSavingIds((current) => ({ ...current, [review.id]: true }))
    try {
      await adminRequest(
        `/admin/assignment-human-reviews/${encodeURIComponent(review.id)}/result`,
        onLogout,
        { method: 'PUT', body: result },
      )
      setReviews((current) => current.filter((entry) => entry.id !== review.id))
    } finally {
      setSavingIds((current) => ({ ...current, [review.id]: false }))
    }
  }

  return (
    <section className="admin-human-reviews" aria-labelledby="admin-human-reviews-title">
      <header className="admin-human-reviews__heading">
        <div>
          <span className="admin-human-reviews__eyebrow">Student-requested only</span>
          <h2 id="admin-human-reviews-title">Human re-evaluation requests</h2>
          <p>Only AI-graded submissions whose students requested a re-evaluation appear here.</p>
        </div>
        <button type="button" className="admin-button admin-button--secondary" onClick={() => setRefresh((value) => value + 1)}>
          Refresh
        </button>
      </header>
      {error && <p className="admin-human-review__error" role="alert">{error}</p>}
      {loading ? <p className="admin-progress-empty">Loading human review requests…</p>
        : reviews.length === 0 ? <p className="admin-progress-empty">No student-requested human reviews are waiting.</p>
          : <div className="admin-human-reviews__list">
            {reviews.map((review) => (
              <AssignmentHumanReviewCard
                key={review.id}
                review={review}
                onLogout={onLogout}
                onStarted={startReview}
                onSave={publishResult}
                saving={Boolean(savingIds[review.id])}
              />
            ))}
          </div>}
    </section>
  )
}
