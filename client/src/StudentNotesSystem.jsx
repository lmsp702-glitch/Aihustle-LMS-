import React, { useState, useEffect, useRef, useCallback } from 'react'
import { fetchWithAuth, isInvalidSessionResponse } from './auth-session.js'
import {
  formatTimestamp,
  parseTimestamp,
  stripHtmlTags,
  sanitizeRichHtml,
  filterAndSortNotes,
  calculateNotesSummary,
} from './student-notes-utils.js'

export {
  formatTimestamp,
  parseTimestamp,
  stripHtmlTags,
  sanitizeRichHtml,
  filterAndSortNotes,
  calculateNotesSummary,
}

export default function StudentNotesSection({
  course,
  lessons = [],
  activeEntry,
  videoPlayerRef,
  onSeekToLessonTimestamp,
  onLogout,
  apiBaseUrl = '/api',
  onRequestOpenEditorRef,
}) {
  const courseId = course?._id || course?.id

  const [notes, setNotes] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [feedbackMessage, setFeedbackMessage] = useState('')

  // Search & Filters
  const [search, setSearch] = useState('')
  const [lessonFilter, setLessonFilter] = useState('all')
  const [pinnedOnlyFilter, setPinnedOnlyFilter] = useState(false)
  const [sortBy, setSortBy] = useState('newest')

  // Editor State
  const [isEditorOpen, setIsEditorOpen] = useState(false)
  const [editingNoteId, setEditingNoteId] = useState(null)
  const [draftTitle, setDraftTitle] = useState('')
  const [draftContent, setDraftContent] = useState('')
  const [draftLessonId, setDraftLessonId] = useState('')
  const [draftLessonTitle, setDraftLessonTitle] = useState('')
  const [draftTimestamp, setDraftTimestamp] = useState('')
  const [draftIsPinned, setDraftIsPinned] = useState(false)
  const [autosaveStatus, setAutosaveStatus] = useState('idle') // 'idle' | 'unsaved' | 'saving' | 'saved' | 'error'
  const [isSavingManual, setIsSavingManual] = useState(false)

  // Actions
  const [deleteConfirmId, setDeleteConfirmId] = useState(null)
  const [isExporting, setIsExporting] = useState(false)

  const contentEditableRef = useRef(null)
  const autosaveTimerRef = useRef(null)
  const activeDraftRef = useRef({
    id: null,
    title: '',
    content: '',
    lessonId: '',
    lessonTitle: '',
    timestamp: '',
    isPinned: false,
  })

  // Sync ref with state
  useEffect(() => {
    activeDraftRef.current = {
      id: editingNoteId,
      title: draftTitle,
      content: draftContent,
      lessonId: draftLessonId,
      lessonTitle: draftLessonTitle,
      timestamp: draftTimestamp,
      isPinned: draftIsPinned,
    }
  }, [editingNoteId, draftTitle, draftContent, draftLessonId, draftLessonTitle, draftTimestamp, draftIsPinned])

  const getAuthToken = useCallback(() => {
    try {
      const savedAuth = sessionStorage.getItem('lms.auth')
      const auth = savedAuth ? JSON.parse(savedAuth) : null
      return auth?.token || ''
    } catch {
      return ''
    }
  }, [])

  // Load course notes
  const loadNotes = useCallback(async (signal) => {
    if (!courseId) return
    const token = getAuthToken()
    if (!token) {
      if (typeof onLogout === 'function') onLogout()
      return
    }

    setLoading(true)
    setError('')
    try {
      const response = await fetchWithAuth(
        `${apiBaseUrl}/courses/${encodeURIComponent(courseId)}/notes`,
        { headers: { Authorization: `Bearer ${token}` }, signal },
        apiBaseUrl,
        token,
      )
      const result = await response.json()
      if (isInvalidSessionResponse(response, result)) {
        if (typeof onLogout === 'function') onLogout()
        return
      }
      if (!response.ok) {
        throw new Error(result.message || 'Failed to load course notes.')
      }
      setNotes(Array.isArray(result.notes) ? result.notes : [])
    } catch (err) {
      if (err.name !== 'AbortError') {
        setError(err instanceof Error ? err.message : 'Could not fetch your notes.')
      }
    } finally {
      setLoading(false)
    }
  }, [courseId, apiBaseUrl, getAuthToken, onLogout])

  useEffect(() => {
    const controller = new AbortController()
    loadNotes(controller.signal)
    return () => controller.abort()
  }, [loadNotes])

  // Perform backend save for autosave or manual save
  const persistNote = useCallback(async (draftData, isAuto = false) => {
    const token = getAuthToken()
    if (!token) {
      if (typeof onLogout === 'function') onLogout()
      return null
    }

    const titleToSave = (draftData.title || '').trim()
    if (!titleToSave) return null

    const seconds = parseTimestamp(draftData.timestamp)
    const payload = {
      title: titleToSave,
      content: draftData.content || '',
      lessonId: draftData.lessonId || '',
      lessonTitle: draftData.lessonTitle || '',
      videoTimestamp: seconds,
      videoTimestampDisplay: draftData.timestamp ? draftData.timestamp.trim() : (seconds != null ? formatTimestamp(seconds) : ''),
      isPinned: Boolean(draftData.isPinned),
    }

    try {
      if (isAuto) setAutosaveStatus('saving')
      let response
      let result

      if (draftData.id) {
        // Update existing note
        response = await fetchWithAuth(
          `${apiBaseUrl}/notes/${encodeURIComponent(draftData.id)}`,
          {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify(payload),
          },
          apiBaseUrl,
          token,
        )
      } else {
        // Create new note
        response = await fetchWithAuth(
          `${apiBaseUrl}/courses/${encodeURIComponent(courseId)}/notes`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify(payload),
          },
          apiBaseUrl,
          token,
        )
      }

      result = await response.json()
      if (isInvalidSessionResponse(response, result)) {
        if (typeof onLogout === 'function') onLogout()
        return null
      }
      if (!response.ok) {
        throw new Error(result.message || 'Failed to save note.')
      }

      const savedNote = result.note
      if (savedNote?._id) {
        setEditingNoteId(savedNote._id)
        activeDraftRef.current.id = savedNote._id
        setNotes((current) => {
          const exists = current.some((n) => String(n._id) === String(savedNote._id))
          if (exists) {
            return current.map((n) => (String(n._id) === String(savedNote._id) ? savedNote : n))
          }
          return [savedNote, ...current]
        })
        if (isAuto) {
          setAutosaveStatus('saved')
        }
      }
      return savedNote
    } catch (err) {
      if (isAuto) {
        setAutosaveStatus('error')
      }
      throw err
    }
  }, [courseId, apiBaseUrl, getAuthToken, onLogout])

  // Debounced Autosave trigger
  const triggerAutosaveDebounce = useCallback(() => {
    if (autosaveTimerRef.current) {
      clearTimeout(autosaveTimerRef.current)
    }
    setAutosaveStatus('unsaved')
    autosaveTimerRef.current = setTimeout(() => {
      const draft = activeDraftRef.current
      if (draft.title && draft.title.trim()) {
        persistNote(draft, true).catch(() => {})
      }
    }, 1200)
  }, [persistNote])

  // Open Editor Helper
  const openNewNoteEditor = useCallback((initialData = {}) => {
    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current)

    // Check if video is currently playing or has currentTime
    let currentTimeStr = ''
    let defaultLessonId = ''
    let defaultLessonTitle = ''

    if (activeEntry?.lesson) {
      defaultLessonId = String(activeEntry.lesson._id || activeEntry.lessonKey || '')
      defaultLessonTitle = activeEntry.lesson.title || ''
    }

    if (videoPlayerRef?.current && !isNaN(videoPlayerRef.current.currentTime) && videoPlayerRef.current.currentTime > 0) {
      currentTimeStr = formatTimestamp(videoPlayerRef.current.currentTime)
    }

    setEditingNoteId(null)
    setDraftTitle(initialData.title || '')
    setDraftContent(initialData.content || '')
    setDraftLessonId(initialData.lessonId != null ? initialData.lessonId : defaultLessonId)
    setDraftLessonTitle(initialData.lessonTitle != null ? initialData.lessonTitle : defaultLessonTitle)
    setDraftTimestamp(initialData.timestamp != null ? initialData.timestamp : currentTimeStr)
    setDraftIsPinned(Boolean(initialData.isPinned))
    setAutosaveStatus('idle')
    setIsEditorOpen(true)

    setTimeout(() => {
      if (contentEditableRef.current) {
        contentEditableRef.current.innerHTML = initialData.content || ''
      }
    }, 50)
  }, [activeEntry, videoPlayerRef])

  // Expose open editor to parent ref
  useEffect(() => {
    if (onRequestOpenEditorRef) {
      onRequestOpenEditorRef.current = openNewNoteEditor
    }
  }, [onRequestOpenEditorRef, openNewNoteEditor])

  const openEditNote = (note) => {
    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current)
    setEditingNoteId(note._id)
    setDraftTitle(note.title || '')
    setDraftContent(note.content || '')
    setDraftLessonId(note.lessonId || '')
    setDraftLessonTitle(note.lessonTitle || '')
    setDraftTimestamp(note.videoTimestampDisplay || (note.videoTimestamp != null ? formatTimestamp(note.videoTimestamp) : ''))
    setDraftIsPinned(Boolean(note.isPinned))
    setAutosaveStatus('idle')
    setIsEditorOpen(true)

    setTimeout(() => {
      if (contentEditableRef.current) {
        contentEditableRef.current.innerHTML = note.content || ''
      }
    }, 50)
  }

  const closeEditor = () => {
    if (autosaveTimerRef.current) {
      clearTimeout(autosaveTimerRef.current)
      // Flush save if unsaved
      if (autosaveStatus === 'unsaved' && draftTitle.trim()) {
        persistNote(activeDraftRef.current, true).catch(() => {})
      }
    }
    setIsEditorOpen(false)
    setEditingNoteId(null)
    setAutosaveStatus('idle')
  }

  // Handle Manual Save
  const handleManualSave = async (e) => {
    if (e) e.preventDefault()
    if (!draftTitle.trim()) {
      alert('Please enter a note title.')
      return
    }

    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current)
    setIsSavingManual(true)
    try {
      await persistNote(activeDraftRef.current, false)
      setFeedbackMessage('Note saved successfully.')
      setTimeout(() => setFeedbackMessage(''), 3000)
      closeEditor()
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to save note.')
    } finally {
      setIsSavingManual(false)
    }
  }

  // Handle Delete
  const handleDeleteNote = async (noteId) => {
    const token = getAuthToken()
    if (!token) return
    try {
      const response = await fetchWithAuth(
        `${apiBaseUrl}/notes/${encodeURIComponent(noteId)}`,
        { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
        apiBaseUrl,
        token,
      )
      const result = await response.json()
      if (!response.ok) throw new Error(result.message || 'Failed to delete note.')

      setNotes((current) => current.filter((n) => String(n._id) !== String(noteId)))
      setDeleteConfirmId(null)
      setFeedbackMessage('Note deleted.')
      setTimeout(() => setFeedbackMessage(''), 3000)
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Could not delete note.')
    }
  }

  // Handle Pin Toggle
  const handleTogglePin = async (note) => {
    const token = getAuthToken()
    if (!token) return
    const newPinned = !note.isPinned
    try {
      const response = await fetchWithAuth(
        `${apiBaseUrl}/notes/${encodeURIComponent(note._id)}/pin`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ isPinned: newPinned }),
        },
        apiBaseUrl,
        token,
      )
      const result = await response.json()
      if (!response.ok) throw new Error(result.message || 'Failed to update pin.')

      setNotes((current) =>
        current.map((n) => (String(n._id) === String(note._id) ? { ...n, isPinned: newPinned } : n)),
      )
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Could not update pin.')
    }
  }

  // Handle Export PDF
  const handleExportNotes = async () => {
    const token = getAuthToken()
    if (!token) return
    setIsExporting(true)
    try {
      const response = await fetchWithAuth(
        `${apiBaseUrl}/courses/${encodeURIComponent(courseId)}/notes/export`,
        { headers: { Authorization: `Bearer ${token}` } },
        apiBaseUrl,
        token,
      )
      if (!response.ok) {
        const result = await response.json().catch(() => ({}))
        throw new Error(result.message || 'Failed to export notes.')
      }

      const blob = await response.blob()
      const url = window.URL.createObjectURL(blob)
      const a = document.createElement('a')
      const courseTitleSlug = (course?.title || 'Course').replace(/[^a-zA-Z0-9_-]/g, '_')
      a.href = url
      a.download = `aiHustle_${courseTitleSlug}_Notes.pdf`
      document.body.appendChild(a)
      a.click()
      a.remove()
      window.URL.revokeObjectURL(url)
      setFeedbackMessage('Notes PDF downloaded successfully.')
      setTimeout(() => setFeedbackMessage(''), 3000)
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Could not export notes PDF.')
    } finally {
      setIsExporting(false)
    }
  }

  // Rich Text Commands
  const executeCommand = (command, value = null) => {
    if (contentEditableRef.current) {
      contentEditableRef.current.focus()
      document.execCommand(command, false, value)
      const newHtml = contentEditableRef.current.innerHTML
      setDraftContent(newHtml)
      triggerAutosaveDebounce()
    }
  }

  const handleInsertLink = () => {
    const url = window.prompt('Enter link URL (e.g. https://...):')
    if (url && url.trim()) {
      executeCommand('createLink', url.trim())
    }
  }

  const handleCaptureCurrentTimestamp = () => {
    if (videoPlayerRef?.current && !isNaN(videoPlayerRef.current.currentTime)) {
      const formatted = formatTimestamp(videoPlayerRef.current.currentTime)
      setDraftTimestamp(formatted)
      triggerAutosaveDebounce()
    }
  }

  // Filtered and sorted notes
  const displayedNotes = filterAndSortNotes(notes, {
    search,
    lessonId: lessonFilter,
    pinnedOnly: pinnedOnlyFilter,
    sort: sortBy,
  })

  const { totalCount, lessonsCoveredCount, pinnedCount } = calculateNotesSummary(notes)

  // Current video timestamp for quick banner
  const currentVideoTimeFormatted = videoPlayerRef?.current && !isNaN(videoPlayerRef.current.currentTime) && videoPlayerRef.current.currentTime > 0
    ? formatTimestamp(videoPlayerRef.current.currentTime)
    : ''

  return (
    <div className="student-notes-system" aria-label="Student Notes System">
      {/* Feedback Alert */}
      {feedbackMessage && (
        <div className="student-notes-alert student-notes-alert--success" role="status">
          <span>{feedbackMessage}</span>
        </div>
      )}

      {/* Header */}
      <header className="student-notes-header">
        <div className="student-notes-header__main">
          <div className="student-notes-header__title-group">
            <h2 className="student-notes-header__title">My Notes</h2>
            <p className="student-notes-header__subtitle">Your personal notes for this course.</p>
          </div>
          <div className="student-notes-header__stats">
            <span className="student-notes-stat-pill" title="Total notes saved">
              <strong>{totalCount}</strong> {totalCount === 1 ? 'Note' : 'Notes'}
            </span>
            <span className="student-notes-stat-pill" title="Lessons with notes">
              <strong>{lessonsCoveredCount}</strong> {lessonsCoveredCount === 1 ? 'Lesson' : 'Lessons'} covered
            </span>
            {pinnedCount > 0 && (
              <span className="student-notes-stat-pill student-notes-stat-pill--gold" title="Pinned notes">
                <strong>{pinnedCount}</strong> Pinned
              </span>
            )}
          </div>
        </div>

        <div className="student-notes-header__actions">
          <button
            type="button"
            className="student-notes-btn student-notes-btn--primary"
            onClick={() => openNewNoteEditor()}
          >
            <span className="student-notes-btn__icon">+</span>
            <span>Add New Note</span>
          </button>
          <button
            type="button"
            className="student-notes-btn student-notes-btn--secondary"
            onClick={handleExportNotes}
            disabled={isExporting || totalCount === 0}
            title="Export all course notes as a clean PDF"
          >
            <span>{isExporting ? 'Exporting PDF…' : 'Export Notes (PDF)'}</span>
          </button>
        </div>
      </header>

      {/* Quick Take Note Bar (when watching video) */}
      {activeEntry?.lesson && (
        <div className="student-notes-quick-bar">
          <div className="student-notes-quick-bar__info">
            <span className="student-notes-quick-bar__lesson-label">Currently watching:</span>
            <strong>{activeEntry.lesson.title}</strong>
            {currentVideoTimeFormatted && (
              <span className="student-notes-quick-bar__time">⏱ {currentVideoTimeFormatted}</span>
            )}
          </div>
          <button
            type="button"
            className="student-notes-quick-bar__btn"
            onClick={() => openNewNoteEditor()}
          >
            <span>Take note at {currentVideoTimeFormatted || 'current lesson'}</span>
          </button>
        </div>
      )}

      {/* Note Editor Modal / Card */}
      {isEditorOpen && (
        <section className="student-notes-editor-panel" aria-label="Note Editor">
          <div className="student-notes-editor-header">
            <h3>{editingNoteId ? 'Edit Note' : 'Create New Note'}</h3>
            <div className="student-notes-editor-header__status">
              {autosaveStatus === 'saving' && <span className="student-notes-status is-saving">Saving…</span>}
              {autosaveStatus === 'saved' && <span className="student-notes-status is-saved">✓ Saved</span>}
              {autosaveStatus === 'unsaved' && <span className="student-notes-status is-unsaved">• Unsaved changes</span>}
              {autosaveStatus === 'error' && (
                <button
                  type="button"
                  className="student-notes-status is-error"
                  onClick={() => persistNote(activeDraftRef.current, true)}
                >
                  Save failed. Retry
                </button>
              )}
              <button
                type="button"
                className="student-notes-editor-close"
                onClick={closeEditor}
                aria-label="Close Editor"
              >
                ✕
              </button>
            </div>
          </div>

          <form onSubmit={handleManualSave} className="student-notes-editor-form">
            {/* Title Input */}
            <div className="student-notes-editor-row">
              <label htmlFor="student-note-title" className="student-notes-label">Note Title *</label>
              <input
                id="student-note-title"
                type="text"
                className="student-notes-input"
                placeholder="e.g. Backpropagation steps & formula"
                value={draftTitle}
                maxLength={200}
                onChange={(e) => {
                  setDraftTitle(e.target.value)
                  triggerAutosaveDebounce()
                }}
                required
              />
            </div>

            {/* Association Row: Lesson + Timestamp */}
            <div className="student-notes-editor-grid">
              <div>
                <label htmlFor="student-note-lesson" className="student-notes-label">Associated Lesson</label>
                <select
                  id="student-note-lesson"
                  className="student-notes-select"
                  value={draftLessonId}
                  onChange={(e) => {
                    const selId = e.target.value
                    setDraftLessonId(selId)
                    const found = lessons.find((l) => String(l.lesson._id || l.lessonKey) === selId)
                    setDraftLessonTitle(found?.lesson?.title || '')
                    triggerAutosaveDebounce()
                  }}
                >
                  <option value="">-- General / No Specific Lesson --</option>
                  {lessons.map(({ lesson, lessonKey, module }) => {
                    const key = String(lesson._id || lessonKey)
                    return (
                      <option key={key} value={key}>
                        {module?.title ? `${module.title} — ` : ''}{lesson.title}
                      </option>
                    )
                  })}
                </select>
              </div>

              <div>
                <label htmlFor="student-note-timestamp" className="student-notes-label">
                  Video Timestamp (mm:ss)
                </label>
                <div className="student-notes-timestamp-control">
                  <input
                    id="student-note-timestamp"
                    type="text"
                    className="student-notes-input"
                    placeholder="e.g. 02:45"
                    value={draftTimestamp}
                    onChange={(e) => {
                      setDraftTimestamp(e.target.value)
                      triggerAutosaveDebounce()
                    }}
                  />
                  {videoPlayerRef?.current && (
                    <button
                      type="button"
                      className="student-notes-btn student-notes-btn--tiny"
                      onClick={handleCaptureCurrentTimestamp}
                      title="Capture current position from video player"
                    >
                      Capture Current
                    </button>
                  )}
                  {draftTimestamp && (
                    <button
                      type="button"
                      className="student-notes-btn student-notes-btn--tiny student-notes-btn--ghost"
                      onClick={() => {
                        setDraftTimestamp('')
                        triggerAutosaveDebounce()
                      }}
                      title="Clear timestamp"
                    >
                      Clear
                    </button>
                  )}
                </div>
              </div>
            </div>

            {/* Rich Text Toolbar */}
            <div className="student-notes-editor-toolbar" role="toolbar" aria-label="Rich text formatting">
              <button
                type="button"
                className="student-notes-tool-btn"
                onClick={() => executeCommand('bold')}
                title="Bold (Ctrl+B)"
              >
                <strong>B</strong>
              </button>
              <button
                type="button"
                className="student-notes-tool-btn"
                onClick={() => executeCommand('italic')}
                title="Italic (Ctrl+I)"
              >
                <em>I</em>
              </button>
              <button
                type="button"
                className="student-notes-tool-btn"
                onClick={() => executeCommand('underline')}
                title="Underline (Ctrl+U)"
              >
                <u>U</u>
              </button>
              <span className="student-notes-tool-divider" />
              <button
                type="button"
                className="student-notes-tool-btn"
                onClick={() => executeCommand('formatBlock', '<h3>')}
                title="Heading (H3)"
              >
                H3
              </button>
              <button
                type="button"
                className="student-notes-tool-btn"
                onClick={() => executeCommand('insertUnorderedList')}
                title="Bullet List"
              >
                • List
              </button>
              <button
                type="button"
                className="student-notes-tool-btn"
                onClick={() => executeCommand('insertOrderedList')}
                title="Numbered List"
              >
                1. List
              </button>
              <button
                type="button"
                className="student-notes-tool-btn"
                onClick={handleInsertLink}
                title="Insert Link"
              >
                🔗 Link
              </button>
              <span className="student-notes-tool-divider" />
              <button
                type="button"
                className="student-notes-tool-btn"
                onClick={() => executeCommand('removeFormat')}
                title="Clear Formatting"
              >
                Clear
              </button>
            </div>

            {/* Rich Content Area */}
            <div className="student-notes-editor-row">
              <label className="student-notes-label">Note Content</label>
              <div
                ref={contentEditableRef}
                className="student-notes-editable"
                contentEditable
                role="textbox"
                aria-multiline="true"
                data-placeholder="Write your study notes, insights, key concepts, or formulas here…"
                onInput={(e) => {
                  setDraftContent(e.currentTarget.innerHTML)
                  triggerAutosaveDebounce()
                }}
              />
            </div>

            {/* Pin Toggle & Footer Actions */}
            <div className="student-notes-editor-footer">
              <label className="student-notes-checkbox-label">
                <input
                  type="checkbox"
                  checked={draftIsPinned}
                  onChange={(e) => {
                    setDraftIsPinned(e.target.checked)
                    triggerAutosaveDebounce()
                  }}
                />
                <span>Pin this note to the top</span>
              </label>

              <div className="student-notes-editor-footer__buttons">
                <button
                  type="button"
                  className="student-notes-btn student-notes-btn--ghost"
                  onClick={closeEditor}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="student-notes-btn student-notes-btn--primary"
                  disabled={isSavingManual}
                >
                  {isSavingManual ? 'Saving…' : 'Save Note'}
                </button>
              </div>
            </div>
          </form>
        </section>
      )}

      {/* Search, Filter & Sort Controls */}
      <div className="student-notes-controls">
        <div className="student-notes-search-wrapper">
          <span className="student-notes-search-icon">🔍</span>
          <input
            type="search"
            className="student-notes-search-input"
            placeholder="Search notes by title or content…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {search && (
            <button
              type="button"
              className="student-notes-search-clear"
              onClick={() => setSearch('')}
              title="Clear search"
            >
              ✕
            </button>
          )}
        </div>

        <div className="student-notes-filters-row">
          <div className="student-notes-filter-group">
            <label htmlFor="student-notes-lesson-filter">Lesson:</label>
            <select
              id="student-notes-lesson-filter"
              className="student-notes-select student-notes-select--sm"
              value={lessonFilter}
              onChange={(e) => setLessonFilter(e.target.value)}
            >
              <option value="all">All Lessons ({notes.length})</option>
              {lessons.map(({ lesson, lessonKey }) => {
                const key = String(lesson._id || lessonKey)
                const count = notes.filter((n) => String(n.lessonId || '') === key).length
                return (
                  <option key={key} value={key}>
                    {lesson.title} ({count})
                  </option>
                )
              })}
            </select>
          </div>

          <button
            type="button"
            className={`student-notes-chip${pinnedOnlyFilter ? ' is-active' : ''}`}
            onClick={() => setPinnedOnlyFilter((prev) => !prev)}
          >
            📌 Pinned Only {pinnedCount > 0 ? `(${pinnedCount})` : ''}
          </button>

          <div className="student-notes-filter-group student-notes-filter-group--sort">
            <label htmlFor="student-notes-sort">Sort by:</label>
            <select
              id="student-notes-sort"
              className="student-notes-select student-notes-select--sm"
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value)}
            >
              <option value="newest">Newest first</option>
              <option value="recently_edited">Recently edited</option>
              <option value="oldest">Oldest first</option>
              <option value="lesson">Lesson order</option>
            </select>
          </div>
        </div>
      </div>

      {/* Loading & Error States */}
      {loading && (
        <div className="student-notes-loading" role="status">
          <span>Loading your study notes…</span>
        </div>
      )}

      {error && !loading && (
        <div className="student-notes-alert student-notes-alert--error" role="alert">
          <span>{error}</span>
          <button type="button" onClick={() => loadNotes()}>Retry</button>
        </div>
      )}

      {/* Notes List */}
      {!loading && !error && (
        displayedNotes.length > 0 ? (
          <div className="student-notes-grid" role="list">
            {displayedNotes.map((note) => {
              const formattedDate = note.updatedAt || note.createdAt
                ? new Date(note.updatedAt || note.createdAt).toLocaleDateString(undefined, {
                    month: 'short',
                    day: 'numeric',
                    year: 'numeric',
                  })
                : ''

              const timeStr = note.videoTimestampDisplay || (note.videoTimestamp != null ? formatTimestamp(note.videoTimestamp) : '')
              const isConfirmingDelete = deleteConfirmId === note._id

              return (
                <article
                  key={note._id}
                  className={`student-note-card${note.isPinned ? ' is-pinned' : ''}`}
                  role="listitem"
                >
                  <div className="student-note-card__header">
                    <div className="student-note-card__title-row">
                      {note.isPinned && (
                        <span className="student-note-card__pinned-badge" title="Pinned Note">
                          📌 Pinned
                        </span>
                      )}
                      <h3 className="student-note-card__title">{note.title}</h3>
                    </div>

                    <div className="student-note-card__actions">
                      <button
                        type="button"
                        className={`student-note-action-btn${note.isPinned ? ' is-pinned' : ''}`}
                        onClick={() => handleTogglePin(note)}
                        title={note.isPinned ? 'Unpin note' : 'Pin note to top'}
                      >
                        {note.isPinned ? '📌' : '📍'}
                      </button>
                      <button
                        type="button"
                        className="student-note-action-btn"
                        onClick={() => openEditNote(note)}
                        title="Edit note"
                      >
                        ✎
                      </button>
                      <button
                        type="button"
                        className="student-note-action-btn student-note-action-btn--delete"
                        onClick={() => setDeleteConfirmId(isConfirmingDelete ? null : note._id)}
                        title="Delete note"
                      >
                        🗑
                      </button>
                    </div>
                  </div>

                  {/* Delete Confirmation Banner */}
                  {isConfirmingDelete && (
                    <div className="student-note-delete-confirm">
                      <span>Delete this note permanently?</span>
                      <div className="student-note-delete-confirm__actions">
                        <button
                          type="button"
                          className="student-notes-btn student-notes-btn--danger student-notes-btn--tiny"
                          onClick={() => handleDeleteNote(note._id)}
                        >
                          Confirm Delete
                        </button>
                        <button
                          type="button"
                          className="student-notes-btn student-notes-btn--ghost student-notes-btn--tiny"
                          onClick={() => setDeleteConfirmId(null)}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Metadata Row: Lesson & Timestamp */}
                  <div className="student-note-card__meta">
                    {note.lessonTitle && (
                      <span className="student-note-card__lesson" title={`Associated lesson: ${note.lessonTitle}`}>
                        📖 {note.lessonTitle}
                      </span>
                    )}

                    {timeStr && (
                      <button
                        type="button"
                        className="student-note-card__timestamp-btn"
                        onClick={() => {
                          if (typeof onSeekToLessonTimestamp === 'function') {
                            onSeekToLessonTimestamp(note.lessonId, note.videoTimestamp != null ? note.videoTimestamp : parseTimestamp(timeStr))
                          }
                        }}
                        title="Jump to this video position"
                      >
                        ▶ ⏱ {timeStr}
                      </button>
                    )}

                    {formattedDate && (
                      <span className="student-note-card__date">
                        Edited {formattedDate}
                      </span>
                    )}
                  </div>

                  {/* Content Preview */}
                  {note.content ? (
                    <div
                      className="student-note-card__content"
                      dangerouslySetInnerHTML={{ __html: sanitizeRichHtml(note.content) }}
                    />
                  ) : (
                    <p className="student-note-card__empty-text">(No additional notes written)</p>
                  )}
                </article>
              )
            })}
          </div>
        ) : (
          <div className="student-notes-empty">
            <div className="student-notes-empty__icon">📝</div>
            <h3>
              {search || lessonFilter !== 'all' || pinnedOnlyFilter
                ? 'No notes match your filters'
                : 'No notes yet for this course'}
            </h3>
            <p>
              {search || lessonFilter !== 'all' || pinnedOnlyFilter
                ? 'Try adjusting your search query or clear the filters to see all your saved notes.'
                : 'Capture key formulas, timestamps, and personal study insights as you learn.'}
            </p>
            {search || lessonFilter !== 'all' || pinnedOnlyFilter ? (
              <button
                type="button"
                className="student-notes-btn student-notes-btn--secondary"
                onClick={() => {
                  setSearch('')
                  setLessonFilter('all')
                  setPinnedOnlyFilter(false)
                }}
              >
                Clear Filters
              </button>
            ) : (
              <button
                type="button"
                className="student-notes-btn student-notes-btn--primary"
                onClick={() => openNewNoteEditor()}
              >
                + Create Your First Note
              </button>
            )}
          </div>
        )
      )}
    </div>
  )
}
