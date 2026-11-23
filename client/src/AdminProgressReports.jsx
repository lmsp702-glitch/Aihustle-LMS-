import React, { useCallback, useEffect, useState } from 'react'
import { API_BASE_URL } from './api-base-url.js'
import './AdminProgressReports.css'

const STUDENT_PAGE_SIZE = 100

async function requestAdminJson(path, onLogout, signal, { method = 'GET', body: requestBody } = {}) {
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
      ...(requestBody ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(requestBody ? { body: JSON.stringify(requestBody) } : {}),
    signal,
  })
  const text = await response.text()
  let body
  try {
    body = text ? JSON.parse(text) : {}
  } catch {
    throw new Error('The server returned an invalid report response.')
  }
  if (response.status === 401 || response.status === 403) {
    onLogout()
    throw new Error(body.message || 'Your admin session has expired. Sign in again.')
  }
  if (!response.ok) throw new Error(body.message || 'The report could not be loaded.')
  return body
}

async function requestAdminFile(path, onLogout) {
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
    headers: { Authorization: `Bearer ${auth.token}` },
  })
  if (response.status === 401 || response.status === 403) {
    let message
    try {
      message = (await response.json()).message
    } catch {
      message = ''
    }
    onLogout()
    throw new Error(message || 'Your admin session has expired. Sign in again.')
  }
  if (!response.ok) {
    let message
    try {
      message = (await response.json()).message
    } catch {
      message = ''
    }
    throw new Error(message || 'The file could not be loaded.')
  }
  return response.blob()
}

function formatDate(value) {
  if (!value) return 'Date unavailable'
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? 'Date unavailable'
    : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

function formatMarks(obtained, maximum) {
  if (!Number.isFinite(obtained) || !Number.isFinite(maximum)) return 'Not recorded'
  return `${obtained} / ${maximum}`
}

function formatMarkSummary(summary) {
  if (!summary) return 'Not recorded'
  const marks = formatMarks(summary.marksObtained, summary.maximumMarks)
  return Number.isFinite(summary.percentage) ? `${marks} · ${summary.percentage}%` : marks
}

function formatEvaluationStatus(value) {
  if (value === 'evaluated') return 'Evaluated'
  if (value === 're_evaluation_required') return 'Re-evaluation Required'
  return 'Pending'
}

function formatLessonStatus(value) {
  if (value === 'completed') return 'Completed'
  if (value === 'in_progress') return 'In progress'
  if (value === 'pending') return 'Pending'
  return 'Not started'
}

function getQuizQuestion(attempt, answer, index) {
  const questions = attempt.questions || attempt.questionSnapshot || []
  return questions.find((question) => String(question.id || question._id || question.questionId) === String(answer.questionId))
    || questions[index]
    || null
}

function answerText(question, answer, answerKey) {
  const direct = answer[answerKey]
  if (typeof direct === 'string') return direct
  if (Array.isArray(direct)) return direct.join(', ')
  const indices = answerKey === 'selectedAnswers'
    ? answer.selectedOptionIndices
    : answer.correctOptionIndices
  if (Array.isArray(indices) && question?.options) {
    return indices.map((optionIndex) => {
      const option = question.options[optionIndex]
      return typeof option === 'string' ? option : option?.text || option?.label || ''
    }).filter(Boolean).join(', ')
  }
  return Array.isArray(indices) ? indices.map((value) => `Option ${Number(value) + 1}`).join(', ') : 'Not recorded'
}

function getCourseLessons(course) {
  if (Array.isArray(course.lessons)) return course.lessons
  return [
    ...(course.completedLessons || []).map((lesson) => ({ ...lesson, status: 'completed' })),
    ...(course.pendingLessons || []).map((lesson) => ({ ...lesson, status: 'pending' })),
  ]
}

function getCourseCertificates(certificates, courseId) {
  if (courseId == null) return []
  return (certificates || []).filter((certificate) => (
    certificate.courseId != null && String(certificate.courseId) === String(courseId)
  ))
}

function getUnassignedCertificates(certificates, courses) {
  return (certificates || []).filter((certificate) => !courses.some((course) => (
    course.courseId != null
      && certificate.courseId != null
      && String(course.courseId) === String(certificate.courseId)
  )))
}

function CourseCertificateCard({ certificate, onView, onDownload }) {
  return (
    <article className="admin-progress-course-certificate">
      <div>
        <span className="admin-progress-certificate-badge">Earned</span>
        <strong>{certificate.name}</strong>
        {certificate.courseName && <span>{certificate.courseName}</span>}
        <span>Issued {formatDate(certificate.issuedAt)}</span>
        <code>{certificate.certificateId}</code>
      </div>
      <div className="admin-progress-course-certificate__actions">
        <button type="button" className="admin-progress-link" onClick={() => onView(certificate)}>View</button>
        <button type="button" className="admin-progress-link" onClick={() => onDownload(certificate)}>Download</button>
      </div>
    </article>
  )
}

function AssignmentSubmissionCard({ submission, onOpenFile }) {
  const supportsInlinePreview = ['application/pdf', 'text/plain'].includes(submission.contentType)
  return (
    <article className="admin-progress-submission">
      <div className="admin-progress-submission__header">
        <div>
          <h5>{submission.assignmentName || 'Assignment or practical submission'}</h5>
          <span>Submitted {formatDate(submission.submittedAt)}</span>
        </div>
        <span className={`admin-progress-status admin-progress-status--${submission.evaluationStatus || 'pending'}`}>
          {formatEvaluationStatus(submission.evaluationStatus)}
        </span>
      </div>
      {submission.instructions && <p className="admin-progress-submission__instructions">{submission.instructions}</p>}
      {submission.answer && (
        <div className="admin-progress-submission__answer">
          <strong>Written answer</strong>
          <p>{submission.answer}</p>
        </div>
      )}
      {submission.fileName && (
        <div className="admin-progress-submission__file">
          <span>{submission.fileName}{submission.fileSize ? ` · ${(submission.fileSize / 1024).toFixed(1)} KB` : ''}</span>
          {supportsInlinePreview && (
            <button type="button" className="admin-progress-link" onClick={() => onOpenFile(submission, 'view')}>Preview</button>
          )}
          <button type="button" className="admin-progress-link" onClick={() => onOpenFile(submission, 'download')}>Download</button>
        </div>
      )}
      <div className="admin-progress-submission__result">
        <span>Marks: <strong>{formatMarks(submission.marksObtained, submission.maximumMarks)}</strong></span>
        {['Passed', 'Failed'].includes(submission.academicStatus) && (
          <span className={`admin-progress-academic-result is-${submission.academicStatus.toLowerCase()}`}>
            <span aria-hidden="true">{submission.academicStatus === 'Passed' ? '✓' : '!'}</span>
            Academic result: <strong>{submission.academicStatus}</strong>
          </span>
        )}
        {submission.correctness && <span>Result: <strong>{submission.correctness.replace(/_/g, ' ')}</strong></span>}
        {submission.feedback && <p><strong>Feedback:</strong> {submission.feedback}</p>}
      </div>
      {submission.gradingStatus && (
        <p className="admin-progress-empty">
          AI evaluation status: {submission.gradingStatus}.
          {submission.humanReviewRequest?.reason
            ? ` Student’s reason for human re-evaluation: ${submission.humanReviewRequest.reason}`
            : submission.aiEvaluation
              ? ' Human evaluation is available only in the student-requested review queue.'
              : ' No AI marks are available; retry AI grading from the student assignment page.'}
        </p>
      )}
      {submission.attemptState && (
        <div className="admin-progress-attempt-state">
          <strong>Attempt {submission.attemptNumber || submission.attemptState.currentAttemptNumber || '—'} of {submission.attemptState.maxAttempts || 3}</strong>
          <span>Academic failures in the current 24-hour window: {submission.attemptState.failedAttempts}</span>
          <span>Remaining attempts: {submission.attemptState.remainingAttempts}</span>
          {submission.attemptState.lockoutUntil && (
            <span>Submissions unlock: {formatDate(submission.attemptState.lockoutUntil)}</span>
          )}
        </div>
      )}
      {submission.humanReviewRequest && (
        <div className="admin-progress-human-review-request">
          <strong>Student-requested human re-evaluation</strong>
          {submission.humanReviewRequest.reasons?.length > 0
            ? <ul>{submission.humanReviewRequest.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
            : <p>{submission.humanReviewRequest.reason || 'No disagreement reason recorded.'}</p>}
          {submission.humanReviewRequest.otherExplanation && (
            <p><strong>Other explanation:</strong> {submission.humanReviewRequest.otherExplanation}</p>
          )}
          {submission.humanReviewRequest.comments && (
            <p><strong>Additional comments:</strong> {submission.humanReviewRequest.comments}</p>
          )}
        </div>
      )}
      {submission.attemptHistory?.length > 0 && (
        <details className="admin-progress-attempt-history">
          <summary>Assignment attempt history ({submission.attemptHistory.length})</summary>
          <ol>
            {submission.attemptHistory.map((attempt, index) => {
              const evaluation = attempt.humanEvaluation || attempt.aiEvaluation
              const marks = attempt.finalMarks ?? attempt.marksObtained ?? attempt.aiEvaluation?.totalMarks
              const maximumMarks = attempt.aiEvaluation?.maximumMarks ?? evaluation?.maximumMarks
              return (
                <li key={attempt.id || `${attempt.submittedAt}-${index}`}>
                  <strong>Attempt {attempt.attemptNumber || '—'} · {formatMarks(marks, maximumMarks)}</strong>
                  {['Passed', 'Failed'].includes(attempt.academicStatus) && (
                    <span className={`admin-progress-academic-result is-${attempt.academicStatus.toLowerCase()}`}>
                      <span aria-hidden="true">{attempt.academicStatus === 'Passed' ? '✓' : '!'}</span>
                      {attempt.academicStatus}
                    </span>
                  )}
                  <span>{attempt.gradingStatus || 'Submitted'} · {formatDate(attempt.submittedAt)}</span>
                  {attempt.aiEvaluation?.criteria?.length > 0 && (
                    <ul>
                      {attempt.aiEvaluation.criteria.map((criterion, criterionIndex) => (
                        <li key={`${attempt.id}-${criterion.name}-${criterionIndex}`}>
                          <strong>{criterion.name}: {criterion.marks} / {criterion.maximumMarks}</strong>
                          {criterion.feedback && <p>{criterion.feedback}</p>}
                        </li>
                      ))}
                    </ul>
                  )}
                  {attempt.aiEvaluation?.overallFeedback && <p><strong>AI feedback:</strong> {attempt.aiEvaluation.overallFeedback}</p>}
                  {attempt.finalFeedback && <p><strong>Human feedback:</strong> {attempt.finalFeedback}</p>}
                </li>
              )
            })}
          </ol>
        </details>
      )}
      {submission.evaluationHistory?.length > 0 && (
        <details className="admin-progress-evaluation-history">
          <summary>Evaluation history ({submission.evaluationHistory.length})</summary>
          <ol>
            {submission.evaluationHistory.map((entry, index) => (
              <li key={entry.id || `${entry.evaluatedAt}-${index}`}>
                <strong>{formatMarks(entry.marksObtained, entry.maximumMarks)}</strong>
                <span>{entry.correctness ? entry.correctness.replace(/_/g, ' ') : ''}</span>
                <time>{formatDate(entry.evaluatedAt)}</time>
                {entry.evaluatorId && <code>Evaluator {entry.evaluatorId}</code>}
                {entry.feedback && <p>{entry.feedback}</p>}
              </li>
            ))}
          </ol>
        </details>
      )}
    </article>
  )
}

function groupVideoAttentionResponses(responses) {
  const grouped = new Map()
  responses.forEach((entry) => {
    const courseId = String(entry.courseId?._id || entry.courseId || '')
    const group = grouped.get(courseId) || {
      courseId,
      courseName: entry.courseId?.title || 'Unknown course',
      responses: [],
    }
    group.responses.push(entry)
    grouped.set(courseId, group)
  })
  return [...grouped.values()]
}

function VideoAttentionResponseList({ responses }) {
  const [expandedResponseIds, setExpandedResponseIds] = useState(() => new Set())
  const allExpanded = responses.length > 0 && responses.every((entry) => expandedResponseIds.has(String(entry._id)))

  const toggleAllResponses = () => {
    setExpandedResponseIds(
      allExpanded
        ? new Set()
        : new Set(responses.map((entry) => String(entry._id))),
    )
  }

  const toggleResponse = (responseId) => {
    setExpandedResponseIds((current) => {
      const next = new Set(current)
      if (next.has(responseId)) next.delete(responseId)
      else next.add(responseId)
      return next
    })
  }

  return (
    <div className="admin-attention-responses">
      <div className="admin-attention-responses__toolbar">
        <button type="button" onClick={toggleAllResponses}>
          {allExpanded ? 'Hide all' : 'View all'}
        </button>
      </div>
      {responses.map((entry) => {
        const responseId = String(entry._id)
        const isExpanded = expandedResponseIds.has(responseId)
        const answer = (entry.selectedOptionIndices || [])
          .map((index) => entry.options?.[index])
          .filter(Boolean)
          .join(', ') || (entry.status === 'presented' ? 'Not answered' : 'No response')
        const hasResponded = entry.status === 'answered'
        const correctness = entry.isCorrect === true ? 'Correct' : 'Incorrect'
        const presentedAt = entry.presentedAt ? new Date(entry.presentedAt) : null
        const presentedLabel = presentedAt && !Number.isNaN(presentedAt.getTime())
          ? presentedAt.toLocaleString()
          : '—'

        return (
          <article className="admin-attention-response" key={responseId}>
            <button
              type="button"
              className="admin-attention-response__toggle"
              aria-expanded={isExpanded}
              aria-controls={`attention-response-${responseId}`}
              onClick={() => toggleResponse(responseId)}
            >
              <div className="admin-attention-response__course">
                <strong>{entry.lessonTitle || 'Lesson not available'}</strong>
              </div>
              <div className="admin-attention-response__outcome">
                <span className={`admin-attention-response__result ${hasResponded ? 'is-responded' : 'is-not-responded'}`}>
                  {hasResponded ? 'Responded' : 'Not responded'}
                </span>
                {hasResponded && (
                  <span className={`admin-attention-response__correctness is-${correctness.toLowerCase()}`}>
                    {correctness}
                  </span>
                )}
              </div>
              <span className="admin-attention-response__chevron" aria-hidden="true" />
            </button>
            <div
              className="admin-attention-response__content"
              id={`attention-response-${responseId}`}
              hidden={!isExpanded}
            >
              <div className="admin-attention-response__answers">
                <section>
                  <h4>Question</h4>
                  <p>{entry.questionPrompt || 'Not available'}</p>
                </section>
                <section>
                  <h4>Response</h4>
                  <p>{answer}</p>
                </section>
              </div>
              <dl className="admin-attention-response__details">
                <div>
                  <dt>Response time</dt>
                  <dd>{Number.isFinite(entry.responseTimeMs) ? `${(entry.responseTimeMs / 1000).toFixed(1)} s` : '—'}</dd>
                </div>
                <div>
                  <dt>Video position</dt>
                  <dd>{Number.isFinite(entry.videoPositionSeconds) ? `${Math.floor(entry.videoPositionSeconds)} s` : '—'}</dd>
                </div>
                <div>
                  <dt>Presented</dt>
                  <dd>{presentedLabel}</dd>
                </div>
              </dl>
            </div>
          </article>
        )
      })}
    </div>
  )
}

function VideoAttentionResponseSection({ responses }) {
  return (
    <section className="admin-progress-course-section">
      <h5>Video attention responses</h5>
      {responses.length
        ? <VideoAttentionResponseList responses={responses} />
        : <p className="admin-progress-empty">No video attention responses are recorded for this course.</p>}
    </section>
  )
}

function StudentProgressDialog({
  student,
  report,
  videoAttentionResponses,
  videoAttentionLoading,
  videoAttentionError,
  loading,
  error,
  onClose,
  onPrint,
  onOpenSubmissionFile,
  onViewCertificate,
  onDownloadCertificate,
}) {
  const unassignedCertificates = report
    ? getUnassignedCertificates(report.certificates, report.courseProgress)
    : []
  const groupedAttentionResponses = groupVideoAttentionResponses(videoAttentionResponses)
  const attentionResponsesByCourseId = new Map(
    groupedAttentionResponses.map((group) => [group.courseId, group.responses]),
  )
  const activeCourseIds = new Set((report?.courseProgress || []).map((course) => String(course.courseId || '')))
  const otherCourseAttentionResponses = groupedAttentionResponses.filter(
    (group) => !activeCourseIds.has(group.courseId),
  )

  return (
    <div className="admin-progress-dialog-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose()
    }}>
      <section className="admin-progress-dialog" role="dialog" aria-modal="true" aria-labelledby="admin-progress-dialog-title">
        <header className="admin-progress-dialog__header">
          <div>
            <p className="admin-eyebrow">INDIVIDUAL STUDENT REPORT</p>
            <h2 id="admin-progress-dialog-title">{report?.student?.name || student?.fullName || 'Student progress'}</h2>
            {(report?.student || student) && <p>{report?.student?.email || student?.email} · {report?.student?.id || student?._id}</p>}
          </div>
          <button type="button" className="admin-button admin-button--secondary admin-progress-print" onClick={onPrint}>Print / Save as PDF</button>
          <button type="button" className="admin-progress-dialog__close" aria-label="Close progress report" onClick={onClose}>×</button>
        </header>

        {loading && <p className="admin-progress-empty" role="status">Loading progress records…</p>}
        {error && <p className="admin-progress-error" role="alert">{error}</p>}
        {!loading && report && (
          <div className="admin-progress-dialog__body">
            {videoAttentionLoading && <p className="admin-progress-empty" role="status">Loading video attention responses…</p>}
            {videoAttentionError && <p className="admin-progress-error" role="alert">{videoAttentionError}</p>}
            <section className="admin-progress-detail-summary" aria-label="Course progress summary">
              <div><span>Enrolled courses</span><strong>{report.summary.enrolledCourses}</strong></div>
              <div><span>Completed</span><strong>{report.summary.completedCourses}</strong></div>
              <div><span>In progress</span><strong>{report.summary.inProgressCourses}</strong></div>
              <div><span>Overall completion</span><strong>{report.summary.overallCompletionPercent === null ? 'Not tracked' : `${report.summary.overallCompletionPercent}%`}</strong></div>
              <div><span>Total marks</span><strong>{formatMarkSummary(report.overallPerformance)}</strong></div>
            </section>

            <section className="admin-progress-detail-section">
              <h3>Course-wise performance</h3>
              {report.courseProgress.length ? (
                <div className="admin-progress-course-list">
                  {report.courseProgress.map((course) => {
                    const lessons = getCourseLessons(course)
                    const courseCertificates = getCourseCertificates(report.certificates, course.courseId)
                    const courseAttentionResponses = attentionResponsesByCourseId.get(String(course.courseId || '')) || []
                    const completionPercent = Number.isFinite(course.completionPercent)
                      ? Math.min(100, Math.max(0, course.completionPercent))
                      : null
                    return (
                    <details className="admin-progress-course" key={course.enrollmentId}>
                      <summary className="admin-progress-course__summary">
                        <div className="admin-progress-course__header">
                          <div>
                            <h4>{course.courseName}</h4>
                            <span>Course ID: {course.courseId} · Enrolled {formatDate(course.enrolledAt)}</span>
                            {!videoAttentionLoading && !videoAttentionError && (
                              <span>
                                {courseAttentionResponses.length
                                  ? `${courseAttentionResponses.length} video attention response${courseAttentionResponses.length === 1 ? '' : 's'}`
                                  : 'No video attention responses'}
                              </span>
                            )}
                          </div>
                          <span className="admin-progress-course__view">View Details</span>
                        </div>
                        <div className="admin-progress-course__summary-progress">
                          {completionPercent === null
                            ? <span>Progress not tracked</span>
                            : (
                              <>
                                <div
                                  className="admin-progress-course__progress-track"
                                  role="progressbar"
                                  aria-label={`${course.courseName} completion`}
                                  aria-valuemin="0"
                                  aria-valuemax="100"
                                  aria-valuenow={completionPercent}
                                >
                                  <span style={{ width: `${completionPercent}%` }} />
                                </div>
                                <strong>{completionPercent}%</strong>
                              </>
                            )}
                        </div>
                      </summary>
                      <div className="admin-progress-course__details">
                        <section className="admin-progress-course-section">
                          <h5>Course overview</h5>
                          <div className="admin-progress-course__metrics">
                            <span>Progress <strong>{course.completionPercent === null ? 'Not tracked' : `${course.completionPercent}%`}</strong></span>
                            <span>Activities <strong>{course.completedActivityCount} of {course.totalActivityCount} completed</strong></span>
                            <span>Marks <strong>{formatMarkSummary(course.marksSummary)}</strong></span>
                            <span>Status <strong>{String(course.status || 'not_started').replace(/_/g, ' ')}</strong></span>
                            <span>Assignments <strong>{course.assignmentSummary
                              ? `${course.assignmentSummary.submittedCount} of ${course.assignmentSummary.totalCount} submitted`
                              : 'Not tracked'}</strong></span>
                          </div>
                        </section>

                        <section className="admin-progress-course-section">
                          <h5>Lessons and learning progress</h5>
                          {lessons.length ? (
                            <ul className="admin-progress-lessons">
                              {lessons.map((lesson) => (
                                <li key={lesson.id}>
                                  <span>{lesson.title}</span>
                                  <span className={`admin-progress-status admin-progress-status--${lesson.status}`}>{formatLessonStatus(lesson.status)}</span>
                                  <time>{lesson.status === 'completed' ? formatDate(lesson.completedAt) : '—'}</time>
                                </li>
                              ))}
                            </ul>
                          ) : <p className="admin-progress-empty">No lesson progress is recorded.</p>}
                        </section>

                        {!videoAttentionLoading && !videoAttentionError && (
                          <VideoAttentionResponseSection
                            responses={courseAttentionResponses}
                          />
                        )}

                        <section className="admin-progress-course-section">
                          <h5>Quizzes and marks</h5>
                          {course.quizAttempts?.length ? course.quizAttempts.map((attempt) => (
                            <article className="admin-progress-quiz" key={attempt.id}>
                              <div className="admin-progress-quiz__header">
                                <div><strong>{attempt.quizName || 'Quiz'}</strong><span>{formatDate(attempt.submittedAt || attempt.startedAt)}</span></div>
                                <strong>{formatMarks(attempt.earnedPoints, attempt.totalPoints)}</strong>
                              </div>
                              <p>
                                {attempt.questionCount ?? attempt.questions?.length ?? 0} questions · {attempt.correctAnswers ?? '—'} correct · {attempt.scorePercentage === null ? 'Not scored' : `${attempt.scorePercentage}%`}
                                {attempt.passed === null || attempt.passed === undefined ? ` · ${attempt.status}` : ` · ${attempt.passed ? 'Passed' : 'Failed'}`}
                              </p>
                              {attempt.answers?.length > 0 && (
                                <details className="admin-progress-quiz__answers">
                                  <summary>Inspect recorded answers ({attempt.answers.length})</summary>
                                  <ol>
                                    {attempt.answers.map((answer, index) => {
                                      const question = getQuizQuestion(attempt, answer, index)
                                      return (
                                        <li key={answer.questionId || index}>
                                          <strong>{question?.question || question?.text || question?.prompt || `Question ${index + 1}`}</strong>
                                          <span>Your answer: {answerText(question, answer, 'selectedAnswers')}</span>
                                          <span>Correct answer: {answerText(question, answer, 'correctAnswers')}</span>
                                        </li>
                                      )
                                    })}
                                  </ol>
                                </details>
                              )}
                            </article>
                          )) : <p className="admin-progress-empty">No quiz attempts are recorded for this course.</p>}
                        </section>

                        <section className="admin-progress-course-section">
                          <h5>Assignments and practical submissions</h5>
                          {course.assignmentSummary && (
                            <p className="admin-progress-assignment-summary">
                              {course.assignmentSummary.totalCount === null
                                ? 'Assignment completion is not tracked for this course.'
                                : `${course.assignmentSummary.submittedCount} of ${course.assignmentSummary.totalCount} assignments submitted`}
                            </p>
                          )}
                          {course.submissions?.length ? course.submissions.map((submission) => (
                            <AssignmentSubmissionCard
                              key={submission.id}
                              submission={submission}
                              onOpenFile={onOpenSubmissionFile}
                            />
                          )) : <p className="admin-progress-empty">No assignment or practical submissions are recorded for this course.</p>}
                        </section>

                        <section className="admin-progress-course-section">
                          <h5>Earned certificates</h5>
                          {!report.certificateRecordsAvailable
                            ? <p className="admin-progress-empty">Certificate records are unavailable.</p>
                            : courseCertificates.length
                              ? (
                                <div className="admin-progress-course-certificates">
                                  {courseCertificates.map((certificate) => (
                                    <CourseCertificateCard
                                      key={certificate.id}
                                      certificate={certificate}
                                      onView={onViewCertificate}
                                      onDownload={onDownloadCertificate}
                                    />
                                  ))}
                                </div>
                              )
                              : <p className="admin-progress-empty">No earned certificates for this course.</p>}
                        </section>
                      </div>
                    </details>
                    )
                  })}
                </div>
              ) : <p className="admin-progress-empty">No active course enrollments are recorded for this student.</p>}
            </section>

            {!videoAttentionLoading && !videoAttentionError && otherCourseAttentionResponses.length > 0 && (
              <section className="admin-progress-detail-section">
                <h3>Video attention responses for other courses</h3>
                <div className="admin-progress-course-list">
                  {otherCourseAttentionResponses.map((group) => (
                    <details className="admin-progress-course" key={group.courseId || group.courseName}>
                      <summary className="admin-progress-course__summary">
                        <div className="admin-progress-course__header">
                          <div>
                            <h4>{group.courseName}</h4>
                            <span>
                              {group.responses.length} video attention response{group.responses.length === 1 ? '' : 's'}
                            </span>
                          </div>
                          <span className="admin-progress-course__view">View Details</span>
                        </div>
                      </summary>
                      <div className="admin-progress-course__details">
                        <VideoAttentionResponseSection responses={group.responses} />
                      </div>
                    </details>
                  ))}
                </div>
              </section>
            )}

            {report.certificateRecordsAvailable && unassignedCertificates.length > 0 && (
              <section className="admin-progress-detail-section">
                <h3>Certificates from courses not currently enrolled</h3>
                <div className="admin-progress-course-certificates">
                  {unassignedCertificates.map((certificate) => (
                    <CourseCertificateCard
                      key={certificate.id}
                      certificate={certificate}
                      onView={onViewCertificate}
                      onDownload={onDownloadCertificate}
                    />
                  ))}
                </div>
              </section>
            )}

          </div>
        )}
      </section>
    </div>
  )
}

export default function AdminProgressReports({ onLogout }) {
  const [students, setStudents] = useState([])
  const [studentTotal, setStudentTotal] = useState(0)
  const [studentPage, setStudentPage] = useState(1)
  const [studentError, setStudentError] = useState('')
  const [isLoadingStudents, setIsLoadingStudents] = useState(false)
  const [summary, setSummary] = useState(null)
  const [summaryError, setSummaryError] = useState('')
  const [isLoadingSummary, setIsLoadingSummary] = useState(false)
  const [selectedStudent, setSelectedStudent] = useState(null)
  const [progressReport, setProgressReport] = useState(null)
  const [videoAttentionResponses, setVideoAttentionResponses] = useState([])
  const [videoAttentionError, setVideoAttentionError] = useState('')
  const [isLoadingVideoAttention, setIsLoadingVideoAttention] = useState(false)
  const [progressError, setProgressError] = useState('')
  const [isLoadingProgress, setIsLoadingProgress] = useState(false)

  const loadStudents = useCallback(async (page, append = false, signal) => {
    setIsLoadingStudents(true)
    setStudentError('')
    try {
      const params = new URLSearchParams({
        page: String(page),
        pageSize: String(STUDENT_PAGE_SIZE),
        tab: 'all',
        filterType: 'all',
        approvalStatus: 'all',
      })
      const result = await requestAdminJson(`/admin/students?${params}`, onLogout, signal)
      if (!Array.isArray(result.students) || !Number.isInteger(result.total)) {
        throw new Error('The server returned invalid student report data.')
      }
      setStudents((current) => append ? [...current, ...result.students] : result.students)
      setStudentTotal(result.total)
      setStudentPage(result.page)
    } catch (error) {
      if (error.name !== 'AbortError') setStudentError(error instanceof Error ? error.message : 'Unable to load students.')
    } finally {
      if (!signal?.aborted) setIsLoadingStudents(false)
    }
  }, [onLogout])

  const loadSummary = useCallback(async (signal) => {
    setIsLoadingSummary(true)
    setSummaryError('')
    try {
      const result = await requestAdminJson('/admin/reports/progress/summary', onLogout, signal)
      if (typeof result.certificateRecordsAvailable !== 'boolean') {
        throw new Error('The server returned an invalid progress summary.')
      }
      setSummary(result)
    } catch (error) {
      if (error.name !== 'AbortError') setSummaryError(error instanceof Error ? error.message : 'Unable to load progress summary.')
    } finally {
      if (!signal?.aborted) setIsLoadingSummary(false)
    }
  }, [onLogout])

  useEffect(() => {
    const controller = new AbortController()
    loadStudents(1, false, controller.signal)
    loadSummary(controller.signal)
    return () => controller.abort()
  }, [loadStudents, loadSummary])

  const openProgressReport = async (student) => {
    setSelectedStudent(student)
    setProgressReport(null)
    setVideoAttentionResponses([])
    setProgressError('')
    setVideoAttentionError('')
    setIsLoadingProgress(true)
    setIsLoadingVideoAttention(true)
    const reportRequest = requestAdminJson(
      `/admin/reports/progress/${encodeURIComponent(student.studentType)}/${encodeURIComponent(student._id)}`,
      onLogout,
    )
      .then(setProgressReport)
      .catch((error) => {
        setProgressError(error instanceof Error ? error.message : 'Unable to load student progress.')
      })
      .finally(() => setIsLoadingProgress(false))
    const attentionParams = new URLSearchParams({
      studentId: String(student._id),
      studentType: String(student.studentType),
    })
    const attentionRequest = requestAdminJson(
      `/admin/video-attention-responses?${attentionParams}`,
      onLogout,
    )
      .then((result) => {
        if (!Array.isArray(result.responses)) {
          throw new Error('The server returned invalid video attention response data.')
        }
        setVideoAttentionResponses(result.responses)
      })
      .catch((error) => {
        setVideoAttentionError(error instanceof Error
          ? error.message
          : 'Unable to load video attention responses.')
      })
      .finally(() => setIsLoadingVideoAttention(false))
    await Promise.all([reportRequest, attentionRequest])
  }

  const openCertificate = async (certificate, action) => {
    const download = action === 'download'
    const certificateUrl = download ? certificate.downloadUrl : certificate.viewUrl
    if (typeof certificateUrl !== 'string' || !certificateUrl.startsWith('/certificates/')) {
      setProgressError('This certificate does not have a valid file URL.')
      return
    }

    const viewWindow = download ? null : window.open('about:blank', '_blank')
    if (!download && !viewWindow) {
      setProgressError('Allow pop-ups to view the certificate.')
      return
    }

    try {
      const file = await requestAdminFile(certificateUrl, onLogout)
      const fileUrl = URL.createObjectURL(file)
      if (download) {
        const link = document.createElement('a')
        link.href = fileUrl
        link.download = `${certificate.certificateId}.svg`
        document.body.appendChild(link)
        link.click()
        link.remove()
      } else {
        viewWindow.opener = null
        viewWindow.location.href = fileUrl
      }
      window.setTimeout(() => URL.revokeObjectURL(fileUrl), 60_000)
    } catch (error) {
      viewWindow?.close()
      setProgressError(error instanceof Error ? error.message : 'The certificate could not be loaded.')
    }
  }

  const openSubmissionFile = async (submission, action) => {
    const download = action === 'download'
    if (typeof submission.fileUrl !== 'string' || !submission.fileUrl.startsWith('/admin/reports/progress/submissions/')) {
      setProgressError('This submission does not have a valid file URL.')
      return
    }

    const viewWindow = download ? null : window.open('about:blank', '_blank')
    if (!download && !viewWindow) {
      setProgressError('Allow pop-ups to preview this submission.')
      return
    }
    if (viewWindow) viewWindow.opener = null
    try {
      const file = await requestAdminFile(submission.fileUrl, onLogout)
      const fileUrl = URL.createObjectURL(file)
      if (download) {
        const link = document.createElement('a')
        link.href = fileUrl
        link.download = submission.fileName || `submission-${submission.id}`
        document.body.appendChild(link)
        link.click()
        link.remove()
      } else {
        viewWindow.location.href = fileUrl
      }
      window.setTimeout(() => URL.revokeObjectURL(fileUrl), 60_000)
    } catch (error) {
      viewWindow?.close()
      setProgressError(error instanceof Error ? error.message : 'The submission file could not be loaded.')
    }
  }

  return (
    <div className="admin-progress-reports">
      <div className="admin-progress-reports__toolbar admin-progress-reports__toolbar--actions-only">
        <button
          type="button"
          className="admin-button admin-button--secondary"
          onClick={() => {
            loadStudents(1)
            loadSummary()
          }}
          disabled={isLoadingStudents || isLoadingSummary}
        >
          {isLoadingStudents || isLoadingSummary ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {summaryError && <p className="admin-progress-error" role="alert">{summaryError}</p>}

      {summary && !summary.certificateRecordsAvailable && (
        <section className="admin-progress-chart">
          <h3>Earned certificates</h3>
          <p className="admin-progress-empty">Certificate issuance records are not stored in the current database schema. No certificate names, issue dates, or download links can be verified.</p>
        </section>
      )}

      <section className="admin-progress-students">
        <div className="admin-progress-students__heading">
          <div><h3>Student progress reports</h3><span>{studentTotal} students</span></div>
        </div>
        {studentError && <p className="admin-progress-error" role="alert">{studentError}</p>}
        {isLoadingStudents && students.length === 0
          ? <p className="admin-progress-empty" role="status">Loading student records…</p>
          : !studentError && students.length === 0
            ? <p className="admin-progress-empty">No student records are available.</p>
            : (
              <>
                <div className="admin-progress-table-wrap">
                  <table className="admin-progress-table">
                    <thead><tr><th>Student name</th><th>User ID</th><th>Email</th><th>Progress</th></tr></thead>
                    <tbody>
                      {students.map((student) => (
                        <tr key={`${student.studentType}-${student._id}`}>
                          <td>
                            <strong>{student.fullName || student.username || 'Name unavailable'}</strong>
                            <span className="admin-progress-student-type">{student.studentType === 'college' ? 'College student' : 'Hustler'}</span>
                          </td>
                          <td><code>{student._id}</code></td>
                          <td>{student.email || 'Email unavailable'}</td>
                          <td><button type="button" className="admin-progress-link" onClick={() => openProgressReport(student)}>View Progress</button></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {students.length < studentTotal && (
                  <div className="admin-progress-load-more">
                    <button
                      type="button"
                      className="admin-button admin-button--secondary"
                      onClick={() => loadStudents(studentPage + 1, true)}
                      disabled={isLoadingStudents}
                    >
                      {isLoadingStudents ? 'Loading…' : 'Load more students'}
                    </button>
                  </div>
                )}
              </>
            )}
      </section>

      {selectedStudent && (
        <StudentProgressDialog
          student={selectedStudent}
          report={progressReport}
          videoAttentionResponses={videoAttentionResponses}
          videoAttentionLoading={isLoadingVideoAttention}
          videoAttentionError={videoAttentionError}
          loading={isLoadingProgress}
          error={progressError}
          onPrint={() => window.print()}
          onOpenSubmissionFile={openSubmissionFile}
          onViewCertificate={(certificate) => openCertificate(certificate, 'view')}
          onDownloadCertificate={(certificate) => openCertificate(certificate, 'download')}
          onClose={() => {
            setSelectedStudent(null)
            setProgressReport(null)
            setVideoAttentionResponses([])
            setProgressError('')
            setVideoAttentionError('')
          }}
        />
      )}
    </div>
  )
}
