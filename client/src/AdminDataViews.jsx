import React, { useEffect, useState } from 'react'
import { isInvalidSessionResponse } from './auth-session.js'

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:5000/api'

async function adminRequest(path, onLogout, options = {}) {
  const savedAuth = sessionStorage.getItem('lms.auth')
  const auth = savedAuth ? JSON.parse(savedAuth) : null
  if (auth?.user?.role !== 'main_admin' || typeof auth.token !== 'string') {
    onLogout()
    throw new Error('Your administrator session has ended.')
  }
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${auth.token}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  })
  const text = await response.text()
  let result
  try {
    result = text ? JSON.parse(text) : {}
  } catch {
    throw new Error('The server returned an invalid response.')
  }
  if (isInvalidSessionResponse(response, result)) onLogout()
  return { response, result }
}

function AdminDataPanel({ eyebrow, title, description, children }) {
  return (
    <section className="admin-panel admin-view-panel">
      <div className="admin-page-heading admin-page-heading--compact">
        <div><p className="admin-eyebrow">{eyebrow}</p><h1>{title}</h1><p>{description}</p></div>
      </div>
      {children}
    </section>
  )
}

export function CollegesManagement({ onLogout }) {
  const [colleges, setColleges] = useState([])
  const [loadError, setLoadError] = useState('')
  const [formError, setFormError] = useState('')
  const [message, setMessage] = useState('')
  const [pendingAccountId, setPendingAccountId] = useState('')
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [search, setSearch] = useState('')
  const [editingCollege, setEditingCollege] = useState(null)
  const [credentialsModal, setCredentialsModal] = useState(null)
  const [credPassword, setCredPassword] = useState('')

  async function loadColleges() {
    setLoadError('')
    try {
      const { response, result } = await adminRequest('/admin/colleges', onLogout)
      if (!response.ok) throw new Error(result.message || 'Unable to load colleges.')
      setColleges(result.colleges || [])
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Unable to load colleges.')
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => { loadColleges() }, [])

  async function submitCollege(event) {
    event.preventDefault()
    setIsSaving(true)
    setFormError('')
    setMessage('')
    try {
      const form = event.currentTarget
      const payload = Object.fromEntries(new FormData(form).entries())
      const { response, result } = await adminRequest('/admin/colleges', onLogout, {
        method: 'POST',
        body: JSON.stringify(payload),
      })
      if (!response.ok) throw new Error(result.message || 'Unable to create the college.')
      form.reset()
      setMessage(`College created with ID ${result.college.id}. You can now create a sub-admin account for this college.`)
      await loadColleges()
    } catch (error) {
      setFormError(error instanceof Error ? error.message : 'Unable to create the college.')
    } finally {
      setIsSaving(false)
    }
  }

  async function sendSubAdmin(event) {
    event.preventDefault()
    setIsSaving(true)
    setFormError('')
    setMessage('')
    setPendingAccountId('')
    try {
      const form = event.currentTarget
      const data = Object.fromEntries(new FormData(form).entries())
      const { response, result } = await adminRequest(
        `/admin/colleges/${encodeURIComponent(data.collegeId)}/sub-admins`,
        onLogout,
        { method: 'POST', body: JSON.stringify(data) },
      )
      if (!response.ok) {
        if (result.accountId) setPendingAccountId(result.accountId)
        throw new Error(result.message || 'Unable to create the sub-admin account.')
      }
      form.reset()
      setMessage(result.message)
      await loadColleges()
    } catch (error) {
      setFormError(error instanceof Error ? error.message : 'Unable to create the sub-admin account.')
    } finally {
      setIsSaving(false)
    }
  }

  async function toggleCollegeStatus(college) {
    const nextStatus = college.status === 'active' ? 'inactive' : 'active'
    setIsSaving(true)
    setMessage('')
    setFormError('')
    try {
      const { response, result } = await adminRequest(
        `/admin/colleges/${encodeURIComponent(college.id)}/status`,
        onLogout,
        { method: 'PATCH', body: JSON.stringify({ status: nextStatus }) },
      )
      if (!response.ok) throw new Error(result.message || 'Unable to update status.')
      setMessage(result.message)
      await loadColleges()
    } catch (error) {
      setFormError(error instanceof Error ? error.message : 'Unable to update status.')
    } finally {
      setIsSaving(false)
    }
  }

  async function handleSaveEdit(event) {
    event.preventDefault()
    if (!editingCollege) return
    setIsSaving(true)
    setFormError('')
    setMessage('')
    try {
      const form = event.currentTarget
      const payload = Object.fromEntries(new FormData(form).entries())
      const { response, result } = await adminRequest(
        `/admin/colleges/${encodeURIComponent(editingCollege.id)}`,
        onLogout,
        { method: 'PUT', body: JSON.stringify(payload) },
      )
      if (!response.ok) throw new Error(result.message || 'Unable to update college.')
      setMessage('College details updated successfully.')
      setEditingCollege(null)
      await loadColleges()
    } catch (error) {
      setFormError(error instanceof Error ? error.message : 'Unable to update college.')
    } finally {
      setIsSaving(false)
    }
  }

  async function handleSetCredentials(event) {
    event.preventDefault()
    if (!credentialsModal) return
    setIsSaving(true)
    setFormError('')
    setMessage('')
    try {
      const form = event.currentTarget
      const payload = Object.fromEntries(new FormData(form).entries())
      const { response, result } = await adminRequest(
        `/admin/colleges/${encodeURIComponent(credentialsModal.id)}/credentials`,
        onLogout,
        { method: 'POST', body: JSON.stringify(payload) },
      )
      if (!response.ok) throw new Error(result.message || 'Unable to update credentials.')
      setMessage(result.message)
      setCredentialsModal(null)
      setCredPassword('')
      await loadColleges()
    } catch (error) {
      setFormError(error instanceof Error ? error.message : 'Unable to update credentials.')
    } finally {
      setIsSaving(false)
    }
  }

  async function resendActivation() {
    setIsSaving(true)
    setFormError('')
    setMessage('')
    try {
      const { response, result } = await adminRequest(
        `/admin/college-admins/${encodeURIComponent(pendingAccountId)}/activation`,
        onLogout,
        { method: 'POST' },
      )
      if (!response.ok) throw new Error(result.message || 'Unable to send the activation email.')
      setMessage(result.message)
      setPendingAccountId('')
    } catch (error) {
      setFormError(error instanceof Error ? error.message : 'Unable to send the activation email.')
    } finally {
      setIsSaving(false)
    }
  }

  const filteredColleges = colleges.filter((c) => {
    if (!search.trim()) return true
    const term = search.toLowerCase()
    return (
      (c.name || '').toLowerCase().includes(term) ||
      (c.code || '').toLowerCase().includes(term) ||
      (c.city || '').toLowerCase().includes(term) ||
      (c.contactName || '').toLowerCase().includes(term) ||
      (c.contactEmail || '').toLowerCase().includes(term) ||
      (c.subAdmin?.username || '').toLowerCase().includes(term)
    )
  })

  return (
    <AdminDataPanel
      eyebrow="COLLEGE MANAGEMENT"
      title="Colleges & College Accounts"
      description="Create and manage colleges and college accounts, monitor enrollment, configure sub-admin credentials, and manage account statuses."
    >
      <div className="admin-data-grid">
        <form className="admin-data-form" onSubmit={submitCollege}>
          <h2>Create a college</h2>
          <label><span>College name *</span><input name="name" maxLength="200" required placeholder="e.g. Stanford Institute of Tech" /></label>
          <label><span>College code *</span><input name="code" minLength="2" maxLength="40" pattern="[A-Za-z0-9-]{2,40}" required placeholder="e.g. SIT-2026" /></label>
          <label><span>Address</span><input name="address" maxLength="500" placeholder="Campus street address" /></label>
          <div className="admin-data-form__columns">
            <label><span>City</span><input name="city" maxLength="120" /></label>
            <label><span>State / region</span><input name="state" maxLength="120" /></label>
          </div>
          <div className="admin-data-form__columns">
            <label><span>Country</span><input name="country" maxLength="120" /></label>
            <label><span>Contact email</span><input name="contactEmail" type="email" maxLength="254" /></label>
          </div>
          <div className="admin-data-form__columns">
            <label><span>Contact name</span><input name="contactName" maxLength="120" /></label>
            <label><span>Contact phone</span><input name="contactPhone" maxLength="40" /></label>
          </div>
          <button className="admin-button admin-button--primary" disabled={isSaving}>Create college</button>
        </form>

        <form className="admin-data-form" onSubmit={sendSubAdmin}>
          <h2>Create College Account / Sub-Admin</h2>
          <p>Assign login credentials to a college administrator so they can log in via the common login page.</p>
          <label>
            <span>College *</span>
            <select name="collegeId" required disabled={isLoading || colleges.length === 0}>
              <option value="">Select a college</option>
              {colleges.map((college) => (
                <option key={college.id} value={college.id}>
                  {college.name} ({college.code})
                </option>
              ))}
            </select>
          </label>
          <label><span>Administrator full name *</span><input name="fullName" maxLength="120" required placeholder="Dr. John Doe" /></label>
          <label><span>Administrator email *</span><input name="email" type="email" maxLength="254" required placeholder="admin@college.edu" /></label>
          <label><span>Username *</span><input name="username" minLength="3" maxLength="30" pattern="[A-Za-z0-9._-]{3,30}" required placeholder="college_admin" /></label>
          <label>
            <span>Direct password (optional, min 8 chars)</span>
            <input name="password" type="password" minLength="8" maxLength="72" placeholder="Leave blank to send email activation link" />
          </label>
          <button className="admin-button admin-button--primary" disabled={isSaving || isLoading || !colleges.length}>
            Create College Account
          </button>
        </form>
      </div>

      {loadError && <p className="admin-inline-error" role="alert">{loadError}</p>}
      {formError && <p className="admin-inline-error" role="alert">{formError}</p>}
      {pendingAccountId && (
        <div className="admin-import-result" role="status">
          <p>Account {pendingAccountId} is pending email activation. If SMTP is not configured, set direct password credentials above.</p>
          <button className="admin-button admin-button--secondary" type="button" onClick={resendActivation} disabled={isSaving}>
            Retry activation email
          </button>
        </div>
      )}
      {message && <p className="admin-import-result" role="status">{message}</p>}

      {/* Edit College Modal / Panel */}
      {editingCollege && (
        <div className="admin-panel admin-view-panel" style={{ marginTop: '20px', border: '2px solid #657f68' }}>
          <h2>Edit College: {editingCollege.name}</h2>
          <form onSubmit={handleSaveEdit} className="admin-data-form">
            <div className="admin-data-form__columns">
              <label><span>College Name *</span><input name="name" defaultValue={editingCollege.name} required /></label>
              <label><span>College Code *</span><input name="code" defaultValue={editingCollege.code} required /></label>
            </div>
            <div className="admin-data-form__columns">
              <label><span>Contact Name</span><input name="contactName" defaultValue={editingCollege.contactName || ''} /></label>
              <label><span>Contact Email</span><input name="contactEmail" type="email" defaultValue={editingCollege.contactEmail || ''} /></label>
            </div>
            <div className="admin-data-form__columns">
              <label><span>Contact Phone</span><input name="contactPhone" defaultValue={editingCollege.contactPhone || ''} /></label>
              <label><span>City</span><input name="city" defaultValue={editingCollege.city || ''} /></label>
            </div>
            <label><span>Address</span><input name="address" defaultValue={editingCollege.address || ''} /></label>
            <div style={{ display: 'flex', gap: '10px', marginTop: '12px' }}>
              <button className="admin-button admin-button--primary" type="submit" disabled={isSaving}>Save Changes</button>
              <button className="admin-button admin-button--secondary" type="button" onClick={() => setEditingCollege(null)}>Cancel</button>
            </div>
          </form>
        </div>
      )}

      {/* Set / Reset Credentials Modal */}
      {credentialsModal && (
        <div className="admin-panel admin-view-panel" style={{ marginTop: '20px', border: '2px solid #e8c460' }}>
          <h2>Manage Credentials: {credentialsModal.name}</h2>
          <p>Set a new password for the college administrator. The account will be activated immediately.</p>
          <form onSubmit={handleSetCredentials} className="admin-data-form">
            {!credentialsModal.subAdmin && (
              <>
                <label><span>Admin Full Name *</span><input name="fullName" defaultValue={credentialsModal.contactName || credentialsModal.name} required /></label>
                <div className="admin-data-form__columns">
                  <label><span>Admin Email *</span><input name="email" type="email" defaultValue={credentialsModal.contactEmail || ''} required /></label>
                  <label><span>Username *</span><input name="username" defaultValue={`admin_${credentialsModal.code.toLowerCase()}`} required /></label>
                </div>
              </>
            )}
            <label><span>New Password (min 8 characters) *</span><input name="password" type="password" minLength="8" required value={credPassword} onChange={(e) => setCredPassword(e.target.value)} placeholder="Enter new password" /></label>
            <div style={{ display: 'flex', gap: '10px', marginTop: '12px' }}>
              <button className="admin-button admin-button--primary" type="submit" disabled={isSaving || credPassword.length < 8}>Set Password & Activate</button>
              <button className="admin-button admin-button--secondary" type="button" onClick={() => setCredentialsModal(null)}>Cancel</button>
            </div>
          </form>
        </div>
      )}

      {/* College List with search and controls */}
      <div className="admin-college-list" style={{ marginTop: '24px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px', flexWrap: 'wrap', gap: '10px' }}>
          <h2>Registered Colleges ({colleges.length})</h2>
          <input
            type="search"
            placeholder="Search colleges, code, contact..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ padding: '8px 12px', borderRadius: '6px', border: '1px solid #dcd7c9', minWidth: '240px' }}
          />
        </div>

        {isLoading ? (
          <p className="admin-loading">Loading colleges…</p>
        ) : filteredColleges.length === 0 ? (
          <p>No colleges found.</p>
        ) : (
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>College Name & Code</th>
                  <th>Contact Info</th>
                  <th>Students</th>
                  <th>Sub-Admin Account</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredColleges.map((college) => (
                  <tr key={college.id}>
                    <td>
                      <strong style={{ display: 'block', fontSize: '13px' }}>{college.name}</strong>
                      <span style={{ fontSize: '11px', color: '#666' }}>Code: <code>{college.code}</code></span>
                      {college.city && <span style={{ fontSize: '11px', color: '#888', marginLeft: '6px' }}>• {college.city}{college.state ? `, ${college.state}` : ''}</span>}
                    </td>
                    <td>
                      <span style={{ display: 'block', fontSize: '12px' }}>{college.contactName || '—'}</span>
                      <span style={{ fontSize: '11px', color: '#666' }}>{college.contactEmail || 'No email'}</span>
                    </td>
                    <td>
                      <strong>{college.studentCount ?? 0}</strong> total
                      {college.activeStudentCount !== undefined && (
                        <span style={{ display: 'block', fontSize: '11px', color: '#49624e' }}>
                          {college.activeStudentCount} active
                        </span>
                      )}
                    </td>
                    <td>
                      {college.subAdmin ? (
                        <>
                          <span style={{ display: 'block', fontSize: '12px' }}>
                            <strong>@{college.subAdmin.username}</strong>
                          </span>
                          <span style={{ fontSize: '11px', color: '#666' }}>{college.subAdmin.email}</span>
                          <span className={`admin-status admin-status--${college.subAdmin.status === 'active' ? 'active' : 'pending'}`} style={{ display: 'inline-block', marginTop: '3px' }}>
                            {college.subAdmin.status}
                          </span>
                        </>
                      ) : (
                        <span style={{ color: '#d97706', fontSize: '11px' }}>No sub-admin account</span>
                      )}
                    </td>
                    <td>
                      <span className={`admin-status admin-status--${college.status === 'active' ? 'active' : 'inactive'}`}>
                        {college.status || 'active'}
                      </span>
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                        <button
                          type="button"
                          className="admin-button admin-button--secondary"
                          style={{ padding: '4px 8px', fontSize: '11px' }}
                          onClick={() => setEditingCollege(college)}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className="admin-button admin-button--secondary"
                          style={{ padding: '4px 8px', fontSize: '11px' }}
                          onClick={() => setCredentialsModal(college)}
                        >
                          {college.subAdmin ? 'Set Password' : 'Create Login'}
                        </button>
                        <button
                          type="button"
                          className={`admin-button admin-button--${college.status === 'active' ? 'secondary' : 'primary'}`}
                          style={{ padding: '4px 8px', fontSize: '11px' }}
                          onClick={() => toggleCollegeStatus(college)}
                          disabled={isSaving}
                        >
                          {college.status === 'active' ? 'Deactivate' : 'Activate'}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </AdminDataPanel>
  )
}

function emptyModule() {
  return { title: '', description: '', lessons: [{ title: '', content: '', videoUrl: '' }] }
}

function emptyAssignment() {
  return { title: '', description: '', dueDate: '', points: 0 }
}

function emptyQuiz() {
  return {
    title: '',
    description: '',
    questions: [{ prompt: '', optionsText: '\n', correctOptionIndex: 0 }],
  }
}

export function CourseManagement({ onLogout }) {
  const [courses, setCourses] = useState([])
  const [modules, setModules] = useState([emptyModule()])
  const [assignments, setAssignments] = useState([])
  const [quizzes, setQuizzes] = useState([])
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [isSaving, setIsSaving] = useState(false)

  async function loadCourses() {
    const { response, result } = await adminRequest('/admin/courses', onLogout)
    if (!response.ok) throw new Error(result.message || 'Unable to load courses.')
    setCourses(result.courses || [])
  }

  useEffect(() => {
    loadCourses().catch((loadError) => setError(loadError.message))
  }, [])

  function updateModule(moduleIndex, field, value) {
    setModules((current) => current.map((module, index) => (
      index === moduleIndex ? { ...module, [field]: value } : module
    )))
  }

  function updateLesson(moduleIndex, lessonIndex, field, value) {
    setModules((current) => current.map((module, index) => index !== moduleIndex ? module : {
      ...module,
      lessons: module.lessons.map((lesson, lessonPosition) => (
        lessonPosition === lessonIndex ? { ...lesson, [field]: value } : lesson
      )),
    }))
  }

  function updateAssignment(assignmentIndex, field, value) {
    setAssignments((current) => current.map((assignment, index) => (
      index === assignmentIndex ? { ...assignment, [field]: value } : assignment
    )))
  }

  function updateQuiz(quizIndex, field, value) {
    setQuizzes((current) => current.map((quiz, index) => (
      index === quizIndex ? { ...quiz, [field]: value } : quiz
    )))
  }

  function updateQuizQuestion(quizIndex, questionIndex, field, value) {
    setQuizzes((current) => current.map((quiz, index) => index !== quizIndex ? quiz : {
      ...quiz,
      questions: quiz.questions.map((question, position) => (
        position === questionIndex ? { ...question, [field]: value } : question
      )),
    }))
  }

  async function saveCourse(event) {
    event.preventDefault()
    setError('')
    setMessage('')
    setIsSaving(true)
    try {
      const form = event.currentTarget
      const values = new FormData(form)
      const payload = {
        title: values.get('title'),
        description: values.get('description'),
        status: values.get('status'),
        modules: modules.map((module) => ({
          ...module,
          lessons: module.lessons.filter((lesson) => lesson.title.trim()),
        })).filter((module) => module.title.trim()),
        assignments: assignments.filter((assignment) => assignment.title.trim()),
        quizzes: quizzes.filter((quiz) => quiz.title.trim()).map((quiz) => ({
          title: quiz.title,
          description: quiz.description,
          questions: quiz.questions.filter((question) => question.prompt.trim()).map((question) => ({
            prompt: question.prompt,
            options: question.optionsText.split(/\r?\n/).map((option) => option.trim()).filter(Boolean),
            correctOptionIndex: Number(question.correctOptionIndex),
          })),
        })),
      }
      const { response, result } = await adminRequest('/admin/courses', onLogout, {
        method: 'POST',
        body: JSON.stringify(payload),
      })
      if (!response.ok) throw new Error(result.message || 'Unable to save the course.')
      form.reset()
      setModules([emptyModule()])
      setAssignments([])
      setQuizzes([])
      setMessage(result.message)
      await loadCourses()
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Unable to save the course.')
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <AdminDataPanel eyebrow="COURSE MANAGEMENT" title="Courses" description="Create courses with modules and lessons. Published courses are available for enrollment.">
      <form className="admin-data-form admin-course-form" onSubmit={saveCourse}>
        <h2>Create a course</h2>
        <label><span>Title</span><input name="title" maxLength="200" required /></label>
        <label><span>Description</span><textarea name="description" rows="3" maxLength="10000" /></label>
        <label><span>Status</span><select name="status"><option value="draft">Draft</option><option value="published">Published</option></select></label>
        {modules.map((module, moduleIndex) => (
          <fieldset className="admin-course-module" key={moduleIndex}>
            <legend>Module {moduleIndex + 1}</legend>
            <label><span>Module title</span><input value={module.title} maxLength="200" onChange={(event) => updateModule(moduleIndex, 'title', event.target.value)} /></label>
            <label><span>Module description</span><input value={module.description} maxLength="2000" onChange={(event) => updateModule(moduleIndex, 'description', event.target.value)} /></label>
            {module.lessons.map((lesson, lessonIndex) => (
              <div className="admin-course-lesson" key={lessonIndex}>
                <label><span>Lesson title</span><input value={lesson.title} maxLength="200" onChange={(event) => updateLesson(moduleIndex, lessonIndex, 'title', event.target.value)} /></label>
                <label><span>Lesson content</span><textarea rows="2" maxLength="20000" value={lesson.content} onChange={(event) => updateLesson(moduleIndex, lessonIndex, 'content', event.target.value)} /></label>
                <label><span>Video URL</span><input type="url" maxLength="2048" value={lesson.videoUrl} onChange={(event) => updateLesson(moduleIndex, lessonIndex, 'videoUrl', event.target.value)} /></label>
                {module.lessons.length > 1 && <button className="admin-text-button" type="button" onClick={() => updateModule(moduleIndex, 'lessons', module.lessons.filter((_, index) => index !== lessonIndex))}>Remove lesson</button>}
              </div>
            ))}
            <div className="admin-data-form__actions">
              <button className="admin-button admin-button--secondary" type="button" onClick={() => updateModule(moduleIndex, 'lessons', [...module.lessons, { title: '', content: '', videoUrl: '' }])}>Add lesson</button>
              {modules.length > 1 && <button className="admin-text-button" type="button" onClick={() => setModules((current) => current.filter((_, index) => index !== moduleIndex))}>Remove module</button>}
            </div>
          </fieldset>
        ))}
        <fieldset className="admin-course-module">
          <legend>Assignments</legend>
          {assignments.map((assignment, assignmentIndex) => (
            <div className="admin-course-lesson" key={assignmentIndex}>
              <label><span>Assignment title</span><input value={assignment.title} maxLength="200" onChange={(event) => updateAssignment(assignmentIndex, 'title', event.target.value)} /></label>
              <label><span>Description</span><textarea rows="2" maxLength="10000" value={assignment.description} onChange={(event) => updateAssignment(assignmentIndex, 'description', event.target.value)} /></label>
              <div className="admin-data-form__columns">
                <label><span>Due date</span><input type="date" value={assignment.dueDate} onChange={(event) => updateAssignment(assignmentIndex, 'dueDate', event.target.value)} /></label>
                <label><span>Points</span><input type="number" min="0" value={assignment.points} onChange={(event) => updateAssignment(assignmentIndex, 'points', event.target.value)} /></label>
              </div>
              <button className="admin-text-button" type="button" onClick={() => setAssignments((current) => current.filter((_, index) => index !== assignmentIndex))}>Remove assignment</button>
            </div>
          ))}
          <button className="admin-button admin-button--secondary" type="button" onClick={() => setAssignments((current) => [...current, emptyAssignment()])}>Add assignment</button>
        </fieldset>
        <fieldset className="admin-course-module">
          <legend>Quizzes</legend>
          {quizzes.map((quiz, quizIndex) => (
            <div className="admin-course-lesson" key={quizIndex}>
              <label><span>Quiz title</span><input value={quiz.title} maxLength="200" onChange={(event) => updateQuiz(quizIndex, 'title', event.target.value)} /></label>
              <label><span>Description</span><textarea rows="2" maxLength="10000" value={quiz.description} onChange={(event) => updateQuiz(quizIndex, 'description', event.target.value)} /></label>
              {quiz.questions.map((question, questionIndex) => (
                <div className="admin-course-lesson" key={questionIndex}>
                  <label><span>Question</span><input value={question.prompt} maxLength="2000" onChange={(event) => updateQuizQuestion(quizIndex, questionIndex, 'prompt', event.target.value)} /></label>
                  <label><span>Options (one per line)</span><textarea rows="3" maxLength="5000" value={question.optionsText} onChange={(event) => updateQuizQuestion(quizIndex, questionIndex, 'optionsText', event.target.value)} /></label>
                  <label><span>Correct option number (starting at 0)</span><input type="number" min="0" max="9" value={question.correctOptionIndex} onChange={(event) => updateQuizQuestion(quizIndex, questionIndex, 'correctOptionIndex', event.target.value)} /></label>
                  {quiz.questions.length > 1 && <button className="admin-text-button" type="button" onClick={() => updateQuiz(quizIndex, 'questions', quiz.questions.filter((_, index) => index !== questionIndex))}>Remove question</button>}
                </div>
              ))}
              <button className="admin-button admin-button--secondary" type="button" onClick={() => updateQuiz(quizIndex, 'questions', [...quiz.questions, { prompt: '', optionsText: '\n', correctOptionIndex: 0 }])}>Add question</button>
              <button className="admin-text-button" type="button" onClick={() => setQuizzes((current) => current.filter((_, index) => index !== quizIndex))}>Remove quiz</button>
            </div>
          ))}
          <button className="admin-button admin-button--secondary" type="button" onClick={() => setQuizzes((current) => [...current, emptyQuiz()])}>Add quiz</button>
        </fieldset>
        <div className="admin-data-form__actions">
          <button className="admin-button admin-button--secondary" type="button" onClick={() => setModules((current) => [...current, emptyModule()])}>Add module</button>
          <button className="admin-button admin-button--primary" type="submit" disabled={isSaving}>{isSaving ? 'Saving…' : 'Save course'}</button>
        </div>
      </form>
      {error && <p className="admin-inline-error" role="alert">{error}</p>}
      {message && <p className="admin-import-result" role="status">{message}</p>}
      <div className="admin-college-list">
        <h2>Saved courses</h2>
        {courses.length === 0 ? <p>No courses have been created.</p> : courses.map((course) => (
          <div className="admin-college-list__item" key={course._id}>
            <strong>{course.title}</strong>
            <span>{course.modules?.length || 0} modules · {course.modules?.reduce((total, module) => total + (module.lessons?.length || 0), 0) || 0} lessons · {course.status}</span>
          </div>
        ))}
      </div>
    </AdminDataPanel>
  )
}

export { EnrollmentManagement } from './AdminEnrollmentManagement.jsx'

