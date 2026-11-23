import React, { useState } from 'react'
import { isInvalidSessionResponse } from './auth-session.js'
import AdminAssignmentReviews from './AdminAssignmentReviews.jsx'
import './AdminCertificateManagement.css'

const API_BASE_URL = (
  import.meta.env.VITE_API_URL ||
  import.meta.env.VITE_API_BASE_URL ||
  'http://localhost:5000/api'
).replace(/\/+$/, '')

async function adminCertificateRequest(path, onLogout, { method = 'GET', body } = {}) {
  let auth
  try {
    auth = JSON.parse(sessionStorage.getItem('lms.auth') || 'null')
  } catch {
    onLogout()
    throw new Error('Your saved administrator session is invalid. Please sign in again.')
  }
  if (auth?.user?.role !== 'main_admin' || typeof auth.token !== 'string') {
    onLogout()
    throw new Error('Your administrator session has ended.')
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${auth.token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const text = await response.text()
  let result
  try {
    result = text ? JSON.parse(text) : {}
  } catch {
    throw new Error('The server returned an invalid response.')
  }
  if (isInvalidSessionResponse(response, result)) onLogout()
  if (!response.ok) throw new Error(result.message || 'The assignment review request could not be completed.')
  return result
}

export default function AdminCertificateManagement({ onBack, onLogout }) {
  const [recentAssignments, setRecentAssignments] = useState([])
  const [isLoadingRecentAssignments, setIsLoadingRecentAssignments] = useState(false)
  const [showRecentAssignments, setShowRecentAssignments] = useState(false)
  const [recentAssignmentsError, setRecentAssignmentsError] = useState('')

  async function toggleRecentAssignments() {
    if (showRecentAssignments) {
      setShowRecentAssignments(false)
      return
    }

    setShowRecentAssignments(true)
    setIsLoadingRecentAssignments(true)
    setRecentAssignmentsError('')
    try {
      const result = await adminCertificateRequest('/admin/assignment-submissions?scope=all', onLogout)
      setRecentAssignments(result.submissions || [])
    } catch (loadError) {
      setRecentAssignmentsError(loadError instanceof Error ? loadError.message : 'Recent assignments could not be loaded.')
    } finally {
      setIsLoadingRecentAssignments(false)
    }
  }

  return (
    <div className="admin-course-workspace">
      <div className="ac-library admin-certificate-management">
        <div className="ac-page-heading">
          <div>
            <p className="ac-eyebrow">COURSE MANAGEMENT</p>
            <h1>Assignment reviews</h1>
            <p>AI grades submissions automatically. Admin action is needed only for student-requested human re-evaluations.</p>
          </div>
          <button type="button" className="ac-button ac-button--gold" onClick={onBack}>← Course management</button>
        </div>
        <AdminAssignmentReviews onLogout={onLogout} />
        <section className="ac-certificate-panel" aria-label="Assignment submission history">
          {showRecentAssignments && (
            <section className="ac-recent-assignments" aria-labelledby="ac-recent-assignments-title">
              <div className="ac-recent-assignments__heading">
                <div>
                  <p className="ac-eyebrow">SUBMISSION HISTORY</p>
                  <h3 id="ac-recent-assignments-title">All submitted assignments</h3>
                </div>
                {!isLoadingRecentAssignments && !recentAssignmentsError && (
                  <span>{recentAssignments.length} submissions</span>
                )}
              </div>
              {recentAssignmentsError
                ? <p className="ac-inline-error" role="alert">{recentAssignmentsError}</p>
                : isLoadingRecentAssignments
                  ? <div className="ac-empty-state"><span className="ac-spinner" />Loading submitted assignments…</div>
                  : recentAssignments.length
                    ? (
                      <div className="ac-recent-assignments__list">
                        {recentAssignments.map((submission) => (
                          <article className="ac-recent-assignment" key={submission.id}>
                            <strong>{submission.assignmentName}</strong>
                            <span>{submission.studentName}{submission.studentEmail ? ` · ${submission.studentEmail}` : ''}</span>
                            <span>{submission.courseName}</span>
                            <span>Submitted {new Date(submission.submittedAt).toLocaleString()}</span>
                            <span>Attempt {submission.attemptNumber || '—'} of {submission.attemptState?.maxAttempts || 3}</span>
                            <span className={`ac-recent-assignment__status is-${(submission.gradingStatus || submission.reviewStatus || 'pending').toLowerCase().replace(/[^a-z0-9]+/g, '-')}`}>
                              {submission.gradingStatus || submission.reviewStatus || 'pending'}
                            </span>
                            {submission.academicStatus && <strong>Academic result: {submission.academicStatus}</strong>}
                            {submission.attemptState && (
                              <span>
                                {submission.attemptState.remainingAttempts} attempts remaining
                                {submission.attemptState.lockoutUntil
                                  ? ` · next submission ${new Date(submission.attemptState.lockoutUntil).toLocaleString()}`
                                  : ''}
                              </span>
                            )}
                            {submission.finalMarks !== undefined && submission.finalMarks !== null
                              ? <span>Final result: {submission.finalMarks} / {submission.aiEvaluation?.maximumMarks ?? '—'}</span>
                              : submission.aiEvaluation && <span>AI result: {submission.aiEvaluation.totalMarks} / {submission.aiEvaluation.maximumMarks}</span>}
                            {submission.aiEvaluation?.overallFeedback && <span>AI feedback: {submission.aiEvaluation.overallFeedback}</span>}
                            {submission.humanReviewRequest?.reasons?.length > 0 && (
                              <span>Human review reasons: {submission.humanReviewRequest.reasons.join(' · ')}</span>
                            )}
                            {submission.humanReviewRequest?.otherExplanation && (
                              <span>Other explanation: {submission.humanReviewRequest.otherExplanation}</span>
                            )}
                            {submission.humanReviewRequest?.comments && (
                              <span>Student comments: {submission.humanReviewRequest.comments}</span>
                            )}
                            {submission.attemptHistory?.length > 1 && (
                              <details>
                                <summary>Attempt history ({submission.attemptHistory.length})</summary>
                                {submission.attemptHistory.map((attempt) => (
                                  <span key={attempt._id || attempt.id}>
                                    Attempt {attempt.attemptNumber || '—'} · {attempt.academicStatus || attempt.gradingStatus}
                                    {' · '}{attempt.finalMarks ?? attempt.aiEvaluation?.totalMarks ?? attempt.marksObtained ?? 'No marks'}
                                    {attempt.aiEvaluation?.overallFeedback ? ` · ${attempt.aiEvaluation.overallFeedback}` : ''}
                                  </span>
                                ))}
                              </details>
                            )}
                          </article>
                        ))}
                      </div>
                    )
                    : <p className="ac-recent-assignments__empty">No assignment submissions have been recorded.</p>}
            </section>
          )}
          <div className="ac-recent-assignments__action">
            <button type="button" className="ac-button ac-button--outline" onClick={toggleRecentAssignments}>
              {showRecentAssignments ? 'Hide Recent Assignments' : 'Recent Assignments'}
            </button>
          </div>
        </section>
      </div>
    </div>
  )
}
