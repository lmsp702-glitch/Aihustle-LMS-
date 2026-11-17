import React, { useEffect, useMemo, useRef, useState } from 'react'
import { API_BASE_URL } from './api-base-url.js'
import { fetchWithAuth, isInvalidSessionResponse } from './auth-session.js'
import { formatFileSize } from './admin-resources-utils.js'
import './StudentLearningResourcesPage.css'

export default function StudentLearningResourcesPage({ user, onLogout }) {
  const [courses, setCourses] = useState([])
  const [resources, setResources] = useState([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState('')
  const [selectedCourseId, setSelectedCourseId] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [previewingResource, setPreviewingResource] = useState(null)
  const [previewBlobUrl, setPreviewBlobUrl] = useState('')
  const [isPreviewLoading, setIsPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState('')
  const [downloadingResourceId, setDownloadingResourceId] = useState(null)
  const blobUrlRef = useRef('')

  useEffect(() => {
    return () => {
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current)
      }
    }
  }, [])

  const closePreview = () => {
    setPreviewingResource(null)
    setPreviewError('')
    setIsPreviewLoading(false)
    if (blobUrlRef.current) {
      URL.revokeObjectURL(blobUrlRef.current)
      blobUrlRef.current = ''
    }
    setPreviewBlobUrl('')
  }

  const getAuthToken = () => {
    try {
      const auth = JSON.parse(sessionStorage.getItem('lms.auth') || 'null')
      return typeof auth?.token === 'string' ? auth.token : ''
    } catch {
      return ''
    }
  }

  const loadResources = async () => {
    setIsLoading(true)
    setError('')
    try {
      let auth
      try {
        auth = JSON.parse(sessionStorage.getItem('lms.auth') || 'null')
      } catch {
        if (typeof onLogout === 'function') onLogout()
        throw new Error('Your student session is invalid. Please sign in again.')
      }
      if (typeof auth?.token !== 'string') {
        if (typeof onLogout === 'function') onLogout()
        throw new Error('Your session has ended. Please sign in again.')
      }

      const response = await fetchWithAuth(
        `${API_BASE_URL}/student/resources`,
        { headers: { Authorization: `Bearer ${auth.token}` } },
        API_BASE_URL,
        auth.token,
      )

      const result = await response.json().catch(() => ({}))
      if (isInvalidSessionResponse(response, result)) {
        if (typeof onLogout === 'function') onLogout()
        throw new Error('Your session has ended. Please sign in again.')
      }
      if (!response.ok) {
        throw new Error(result.message || 'Could not load learning resources.')
      }

      setResources(Array.isArray(result.resources) ? result.resources : [])
      setCourses(Array.isArray(result.courses) ? result.courses : [])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load resources.')
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    loadResources()
  }, [])

  const handleOpenPreview = async (resource) => {
    if (!resource?._id) return
    setPreviewingResource(resource)
    setIsPreviewLoading(true)
    setPreviewError('')
    if (blobUrlRef.current) {
      URL.revokeObjectURL(blobUrlRef.current)
      blobUrlRef.current = ''
    }
    setPreviewBlobUrl('')

    const token = getAuthToken()
    if (!token) {
      if (typeof onLogout === 'function') onLogout()
      setIsPreviewLoading(false)
      setPreviewError('Your session has ended. Please sign in again.')
      return
    }

    try {
      const response = await fetchWithAuth(
        `${API_BASE_URL}/resources/${resource._id}/file`,
        { headers: { Authorization: `Bearer ${token}` } },
        API_BASE_URL,
        token,
      )

      if (response.status === 401 || response.status === 403) {
        const errorJson = await response.json().catch(() => ({}))
        if (isInvalidSessionResponse(response, errorJson)) {
          if (typeof onLogout === 'function') onLogout()
          throw new Error('Your session has ended. Please sign in again.')
        }
        throw new Error(errorJson.message || 'You do not have permission to access this resource.')
      }

      if (!response.ok) {
        const errorJson = await response.json().catch(() => ({}))
        throw new Error(errorJson.message || 'Could not load the PDF document.')
      }

      const contentType = response.headers.get('content-type') || ''
      if (contentType.includes('application/json')) {
        const json = await response.json().catch(() => ({}))
        throw new Error(json.message || 'Server returned an invalid file format.')
      }

      const blob = await response.blob()
      const pdfBlob = new Blob([blob], { type: 'application/pdf' })
      const objectUrl = URL.createObjectURL(pdfBlob)
      blobUrlRef.current = objectUrl
      setPreviewBlobUrl(objectUrl)
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : 'Failed to preview resource.')
    } finally {
      setIsPreviewLoading(false)
    }
  }

  const handleDownload = async (resource) => {
    if (!resource?._id) return
    setDownloadingResourceId(resource._id)
    const token = getAuthToken()

    try {
      if (token) {
        const response = await fetchWithAuth(
          `${API_BASE_URL}/resources/${resource._id}/file?download=true`,
          { headers: { Authorization: `Bearer ${token}` } },
          API_BASE_URL,
          token,
        )

        if (response.ok) {
          const blob = await response.blob()
          const objectUrl = URL.createObjectURL(new Blob([blob], { type: 'application/pdf' }))
          const link = document.createElement('a')
          link.href = objectUrl
          link.download = resource.originalFileName || `${resource.title || 'resource'}.pdf`
          document.body.appendChild(link)
          link.click()
          link.remove()
          window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000)
          return
        }
      }

      // Fallback using direct signed link
      const fallbackUrl = resource.downloadUrl || resource.signedUrl || resource.url
      if (fallbackUrl) {
        const link = document.createElement('a')
        link.href = fallbackUrl
        link.download = resource.originalFileName || `${resource.title || 'resource'}.pdf`
        link.target = '_blank'
        link.rel = 'noopener noreferrer'
        document.body.appendChild(link)
        link.click()
        link.remove()
      }
    } catch {
      const fallbackUrl = resource.downloadUrl || resource.signedUrl || resource.url
      if (fallbackUrl) {
        window.open(fallbackUrl, '_blank')
      }
    } finally {
      setDownloadingResourceId(null)
    }
  }

  const filteredResources = useMemo(() => {
    const term = searchQuery.trim().toLowerCase()
    return resources.filter((res) => {
      if (selectedCourseId) {
        const cId = typeof res.courseId === 'object' ? res.courseId?._id : res.courseId
        if (String(cId) !== String(selectedCourseId)) return false
      }
      if (term) {
        const titleMatch = (res.title || '').toLowerCase().includes(term)
        const descMatch = (res.description || '').toLowerCase().includes(term)
        const fileNameMatch = (res.originalFileName || '').toLowerCase().includes(term)
        const courseTitle = (typeof res.courseId === 'object' ? res.courseId?.title : '') || ''
        const courseMatch = courseTitle.toLowerCase().includes(term)
        if (!titleMatch && !descMatch && !fileNameMatch && !courseMatch) return false
      }
      return true
    })
  }, [resources, selectedCourseId, searchQuery])

  return (
    <div className="student-learning-resources">
      {/* Top Banner / Heading */}
      <section className="student-learning-resources__header">
        <div className="student-learning-resources__header-text">
          <span className="student-eyebrow">KEEP EXPLORING</span>
          <h1>Learning Resources</h1>
          <p>
            Explore study materials and learning resources for your enrolled courses.
          </p>
        </div>
      </section>

      {/* Filter and Search Bar */}
      <section className="student-learning-resources__controls">
        <div className="student-learning-resources__search">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            type="search"
            placeholder="Search resources by title or topic..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
          {searchQuery && (
            <button
              type="button"
              className="student-learning-resources__search-clear"
              onClick={() => setSearchQuery('')}
              aria-label="Clear search"
            >
              &times;
            </button>
          )}
        </div>

        {courses.length > 0 && (
          <div className="student-learning-resources__course-filter">
            <label htmlFor="student-course-select" className="sr-only">Filter by Course</label>
            <select
              id="student-course-select"
              value={selectedCourseId}
              onChange={(e) => setSelectedCourseId(e.target.value)}
            >
              <option value="">All Enrolled Courses ({courses.length})</option>
              {courses.map((course) => (
                <option key={course._id} value={course._id}>
                  {course.title}
                </option>
              ))}
            </select>
          </div>
        )}
      </section>

      {/* Main State Handling */}
      {isLoading ? (
        <div className="student-learning-resources__loading">
          <div className="student-learning-resources__spinner" aria-hidden="true" />
          <p>Loading course resources...</p>
        </div>
      ) : error ? (
        <div className="student-learning-resources__alert-error" role="alert">
          <p>{error}</p>
          <button type="button" onClick={loadResources}>Try Again</button>
        </div>
      ) : filteredResources.length === 0 ? (
        <div className="student-learning-resources__empty">
          <div className="student-learning-resources__empty-icon" aria-hidden="true">
            <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
              <line x1="16" y1="13" x2="8" y2="13" />
              <line x1="16" y1="17" x2="8" y2="17" />
              <line x1="10" y1="9" x2="8" y2="9" />
            </svg>
          </div>
          <h3>{searchQuery || selectedCourseId ? 'No matching resources' : 'No resources available yet'}</h3>
          <p>
            {searchQuery || selectedCourseId
              ? 'Try modifying your search query or selecting a different course filter.'
              : 'Learning materials uploaded by administrators will appear here.'}
          </p>
          {(searchQuery || selectedCourseId) && (
            <button
              type="button"
              className="student-learning-resources__reset-btn"
              onClick={() => {
                setSearchQuery('')
                setSelectedCourseId('')
              }}
            >
              Reset Filters
            </button>
          )}
        </div>
      ) : (
        <div className="student-learning-resources__grid">
          {filteredResources.map((resource) => {
            const courseTitle = typeof resource.courseId === 'object' ? resource.courseId?.title : 'Enrolled Course'
            const formattedDate = resource.createdAt
              ? new Date(resource.createdAt).toLocaleDateString('en-US', {
                  year: 'numeric',
                  month: 'short',
                  day: 'numeric',
                })
              : ''

            return (
              <article key={resource._id} className="student-resource-card">
                <div className="student-resource-card__header">
                  <span className="student-resource-card__badge">PDF</span>
                  <span className="student-resource-card__size">{formatFileSize(resource.fileSize)}</span>
                </div>

                <div className="student-resource-card__body">
                  <h3 className="student-resource-card__title" title={resource.title}>
                    {resource.title}
                  </h3>
                  <p className="student-resource-card__course" title={courseTitle}>
                    {courseTitle}
                  </p>
                  {resource.description && (
                    <p className="student-resource-card__description">
                      {resource.description}
                    </p>
                  )}
                </div>

                <div className="student-resource-card__footer">
                  {formattedDate && <span className="student-resource-card__date">{formattedDate}</span>}

                  <div className="student-resource-card__actions">
                    <button
                      type="button"
                      className="student-resource-btn student-resource-btn--preview"
                      onClick={() => handleOpenPreview(resource)}
                      title="Preview PDF"
                    >
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                        <circle cx="12" cy="12" r="3" />
                      </svg>
                      <span>Preview</span>
                    </button>
                    <button
                      type="button"
                      className="student-resource-btn student-resource-btn--download"
                      onClick={() => handleDownload(resource)}
                      disabled={downloadingResourceId === resource._id}
                      title="Download PDF"
                    >
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                        <polyline points="7 10 12 15 17 10" />
                        <line x1="12" y1="15" x2="12" y2="3" />
                      </svg>
                      <span>{downloadingResourceId === resource._id ? 'Downloading...' : 'Download'}</span>
                    </button>
                  </div>
                </div>
              </article>
            )
          })}
        </div>
      )}

      {/* PDF PREVIEW MODAL */}
      {previewingResource && (
        <div className="student-resource-modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="student-preview-title">
          <div className="student-resource-modal">
            <div className="student-resource-modal__header">
              <div>
                <h2 id="student-preview-title">{previewingResource.title}</h2>
                <p>
                  {typeof previewingResource.courseId === 'object' ? previewingResource.courseId?.title : 'Course'} &bull; {formatFileSize(previewingResource.fileSize)}
                </p>
              </div>
              <div className="student-resource-modal__header-actions">
                <button
                  type="button"
                  className="student-resource-btn student-resource-btn--download"
                  onClick={() => handleDownload(previewingResource)}
                  disabled={downloadingResourceId === previewingResource._id}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="7 10 12 15 17 10" />
                    <line x1="12" y1="15" x2="12" y2="3" />
                  </svg>
                  <span>{downloadingResourceId === previewingResource._id ? 'Downloading...' : 'Download'}</span>
                </button>
                <button
                  type="button"
                  className="student-resource-modal__close-btn"
                  onClick={closePreview}
                  aria-label="Close Preview"
                >
                  &times;
                </button>
              </div>
            </div>

            <div className="student-resource-modal__body">
              {isPreviewLoading ? (
                <div className="student-resource-modal__loading">
                  <div className="student-learning-resources__spinner" aria-hidden="true" />
                  <p>Loading secure PDF preview...</p>
                </div>
              ) : previewError ? (
                <div className="student-resource-modal__error" role="alert">
                  <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="12" cy="12" r="10" />
                    <line x1="12" y1="8" x2="12" y2="12" />
                    <line x1="12" y1="16" x2="12.01" y2="16" />
                  </svg>
                  <h4>Unable to load PDF preview</h4>
                  <p>{previewError}</p>
                  <div className="student-resource-modal__error-actions">
                    <button
                      type="button"
                      className="student-resource-btn student-resource-btn--primary"
                      onClick={() => handleOpenPreview(previewingResource)}
                    >
                      Try Again
                    </button>
                    <button
                      type="button"
                      className="student-resource-btn student-resource-btn--download"
                      onClick={() => handleDownload(previewingResource)}
                    >
                      Download File
                    </button>
                  </div>
                </div>
              ) : previewBlobUrl ? (
                <>
                  <iframe
                    src={`${previewBlobUrl}#toolbar=1`}
                    title={previewingResource.title}
                    className="student-resource-modal__iframe"
                  />
                  <div className="student-resource-modal__fallback">
                    <p>Having trouble previewing this document?</p>
                    <a
                      href={previewBlobUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="student-resource-btn student-resource-btn--primary"
                    >
                      Open in New Tab
                    </a>
                  </div>
                </>
              ) : null}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
