import React, { useEffect, useId, useMemo, useRef, useState } from 'react'
import { API_BASE_URL } from './api-base-url.js'
import { isInvalidSessionResponse } from './auth-session.js'
import {
  MAX_RESOURCE_FILE_SIZE_BYTES,
  formatFileSize,
  validateResourceUploadFile,
  filterResources,
} from './admin-resources-utils.js'
import './AdminResourcesManagement.css'

export {
  MAX_RESOURCE_FILE_SIZE_BYTES,
  formatFileSize,
  validateResourceUploadFile,
  filterResources,
}

async function requestAdminApi(path, onLogout, { method = 'GET', body, isFormData = false } = {}) {
  let auth
  try {
    auth = JSON.parse(sessionStorage.getItem('lms.auth') || 'null')
  } catch {
    if (typeof onLogout === 'function') onLogout()
    throw new Error('Your administrator session is invalid. Please sign in again.')
  }
  if (auth?.user?.role !== 'main_admin' || typeof auth.token !== 'string') {
    if (typeof onLogout === 'function') onLogout()
    throw new Error('Your administrator session has ended. Please sign in again.')
  }

  const headers = {
    Authorization: `Bearer ${auth.token}`,
  }
  if (!isFormData && body) {
    headers['Content-Type'] = 'application/json'
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
    method,
    headers,
    body: isFormData ? body : body ? JSON.stringify(body) : undefined,
  })

  const text = await response.text()
  let result
  try {
    result = text ? JSON.parse(text) : {}
  } catch {
    throw new Error('The server returned an unexpected response format.')
  }

  if (isInvalidSessionResponse(response, result)) {
    if (typeof onLogout === 'function') onLogout()
  }

  if (!response.ok) {
    throw new Error(result.message || `Request failed with status ${response.status}`)
  }

  return result
}

export default function AdminResourcesManagement({ onLogout }) {
  const [courses, setCourses] = useState([])
  const [resources, setResources] = useState([])
  const [isLoading, setIsLoading] = useState(true)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [errorMessage, setErrorMessage] = useState('')
  const [successMessage, setSuccessMessage] = useState('')

  // Filters & display
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedCourseFilter, setSelectedCourseFilter] = useState('')
  const [viewMode, setViewMode] = useState('grid') // 'grid' | 'table'

  // Modals state
  const [isUploadModalOpen, setIsUploadModalOpen] = useState(false)
  const [editingResource, setEditingResource] = useState(null)
  const [deletingResource, setDeletingResource] = useState(null)
  const [previewingResource, setPreviewingResource] = useState(null)
  const [previewBlobUrl, setPreviewBlobUrl] = useState('')
  const [isPreviewLoading, setIsPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState('')
  const [downloadingResourceId, setDownloadingResourceId] = useState(null)
  const previewBlobRef = useRef('')

  useEffect(() => {
    return () => {
      if (previewBlobRef.current) {
        URL.revokeObjectURL(previewBlobRef.current)
      }
    }
  }, [])

  const getAdminToken = () => {
    try {
      const auth = JSON.parse(sessionStorage.getItem('lms.auth') || 'null')
      return typeof auth?.token === 'string' ? auth.token : ''
    } catch {
      return ''
    }
  }

  const closePreview = () => {
    setPreviewingResource(null)
    setPreviewError('')
    setIsPreviewLoading(false)
    if (previewBlobRef.current) {
      URL.revokeObjectURL(previewBlobRef.current)
      previewBlobRef.current = ''
    }
    setPreviewBlobUrl('')
  }

  const handleOpenPreview = async (resource) => {
    if (!resource?._id) return
    setPreviewingResource(resource)
    setIsPreviewLoading(true)
    setPreviewError('')
    if (previewBlobRef.current) {
      URL.revokeObjectURL(previewBlobRef.current)
      previewBlobRef.current = ''
    }
    setPreviewBlobUrl('')

    const token = getAdminToken()
    if (!token) {
      if (typeof onLogout === 'function') onLogout()
      setIsPreviewLoading(false)
      setPreviewError('Your administrator session has ended. Please sign in again.')
      return
    }

    try {
      const response = await fetch(`${API_BASE_URL}/admin/resources/${resource._id}/file`, {
        headers: { Authorization: `Bearer ${token}` },
      })

      if (response.status === 401 || response.status === 403) {
        const errorJson = await response.json().catch(() => ({}))
        if (isInvalidSessionResponse(response, errorJson)) {
          if (typeof onLogout === 'function') onLogout()
          throw new Error('Your administrator session has ended. Please sign in again.')
        }
        throw new Error(errorJson.message || 'You do not have permission to access this resource.')
      }

      if (!response.ok) {
        const errorJson = await response.json().catch(() => ({}))
        throw new Error(errorJson.message || 'Could not load the PDF preview.')
      }

      const contentType = response.headers.get('content-type') || ''
      if (contentType.includes('application/json')) {
        const json = await response.json().catch(() => ({}))
        throw new Error(json.message || 'Server returned an invalid file format.')
      }

      const blob = await response.blob()
      const pdfBlob = new Blob([blob], { type: 'application/pdf' })
      const objectUrl = URL.createObjectURL(pdfBlob)
      previewBlobRef.current = objectUrl
      setPreviewBlobUrl(objectUrl)
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : 'Failed to preview resource.')
    } finally {
      setIsPreviewLoading(false)
    }
  }

  // Upload Form state
  const [uploadCourseId, setUploadCourseId] = useState('')
  const [uploadTitle, setUploadTitle] = useState('')
  const [uploadDescription, setUploadDescription] = useState('')
  const [uploadFile, setUploadFile] = useState(null)
  const [uploadFormError, setUploadFormError] = useState('')
  const [isDragging, setIsDragging] = useState(false)
  const fileInputRef = useRef(null)

  // Edit Form state
  const [editCourseId, setEditCourseId] = useState('')
  const [editTitle, setEditTitle] = useState('')
  const [editDescription, setEditDescription] = useState('')
  const [editFormError, setEditFormError] = useState('')

  const searchInputId = useId()
  const courseFilterId = useId()

  const loadData = async () => {
    setIsLoading(true)
    setErrorMessage('')
    try {
      const [coursesRes, resourcesRes] = await Promise.all([
        requestAdminApi('/admin/courses', onLogout),
        requestAdminApi('/admin/resources', onLogout),
      ])
      setCourses(coursesRes.courses || [])
      setResources(resourcesRes.resources || [])
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Failed to load resources.')
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    loadData()
  }, [])

  // Auto-dismiss success notice
  useEffect(() => {
    if (!successMessage) return
    const timer = setTimeout(() => setSuccessMessage(''), 4500)
    return () => clearTimeout(timer)
  }, [successMessage])

  // Reset upload form
  const resetUploadForm = () => {
    setUploadCourseId(courses[0]?._id || '')
    setUploadTitle('')
    setUploadDescription('')
    setUploadFile(null)
    setUploadFormError('')
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const handleOpenUploadModal = () => {
    resetUploadForm()
    setIsUploadModalOpen(true)
  }

  const handleFileSelection = (file) => {
    if (!file) return
    const validation = validateResourceUploadFile(file)
    if (!validation.valid) {
      setUploadFormError(validation.error)
      setUploadFile(null)
      return
    }
    setUploadFormError('')
    setUploadFile(file)
    // Auto-fill title from filename if title is empty
    if (!uploadTitle.trim()) {
      const cleanName = file.name.replace(/\.[^/.]+$/, '').replace(/[-_]+/g, ' ').trim()
      setUploadTitle(cleanName)
    }
  }

  const handleUploadSubmit = async (e) => {
    e.preventDefault()
    if (!uploadCourseId) {
      setUploadFormError('Please select a course for this resource.')
      return
    }
    if (!uploadTitle.trim()) {
      setUploadFormError('Please enter a descriptive title for the resource.')
      return
    }
    if (!uploadFile) {
      setUploadFormError('Please choose a PDF resource file to upload.')
      return
    }

    setIsSubmitting(true)
    setUploadFormError('')
    try {
      const formData = new FormData()
      formData.append('title', uploadTitle.trim())
      formData.append('description', uploadDescription.trim())
      formData.append('courseId', uploadCourseId)
      formData.append('file', uploadFile)

      const result = await requestAdminApi('/admin/resources', onLogout, {
        method: 'POST',
        body: formData,
        isFormData: true,
      })

      setSuccessMessage(`Resource "${uploadTitle.trim()}" uploaded successfully!`)
      setIsUploadModalOpen(false)
      resetUploadForm()
      // Prepend to resource list
      if (result.resource) {
        setResources((prev) => [result.resource, ...prev])
      } else {
        loadData()
      }
    } catch (err) {
      setUploadFormError(err instanceof Error ? err.message : 'Upload failed. Please try again.')
    } finally {
      setIsSubmitting(false)
    }
  }

  // Open Edit Modal
  const handleOpenEditModal = (resource) => {
    const courseId = typeof resource.courseId === 'object' ? resource.courseId?._id : resource.courseId
    setEditingResource(resource)
    setEditCourseId(courseId || '')
    setEditTitle(resource.title || '')
    setEditDescription(resource.description || '')
    setEditFormError('')
  }

  const handleEditSubmit = async (e) => {
    e.preventDefault()
    if (!editTitle.trim()) {
      setEditFormError('Resource title is required.')
      return
    }
    if (!editCourseId) {
      setEditFormError('Please select a course.')
      return
    }

    setIsSubmitting(true)
    setEditFormError('')
    try {
      const result = await requestAdminApi(`/admin/resources/${editingResource._id}`, onLogout, {
        method: 'PUT',
        body: {
          title: editTitle.trim(),
          description: editDescription.trim(),
          courseId: editCourseId,
        },
      })

      setSuccessMessage('Resource details updated successfully.')
      setEditingResource(null)
      // Update local state
      if (result.resource) {
        setResources((prev) => prev.map((r) => (r._id === result.resource._id ? result.resource : r)))
      } else {
        loadData()
      }
    } catch (err) {
      setEditFormError(err instanceof Error ? err.message : 'Failed to update resource.')
    } finally {
      setIsSubmitting(false)
    }
  }

  // Delete Resource
  const handleDeleteConfirm = async () => {
    if (!deletingResource) return
    setIsSubmitting(true)
    try {
      await requestAdminApi(`/admin/resources/${deletingResource._id}`, onLogout, {
        method: 'DELETE',
      })
      setSuccessMessage(`Resource "${deletingResource.title}" has been deleted.`)
      setResources((prev) => prev.filter((r) => r._id !== deletingResource._id))
      setDeletingResource(null)
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Failed to delete resource.')
      setDeletingResource(null)
    } finally {
      setIsSubmitting(false)
    }
  }

  // Download Resource
  const handleDownload = async (resource) => {
    if (!resource?._id) return
    setDownloadingResourceId(resource._id)
    const token = getAdminToken()

    try {
      if (token) {
        const response = await fetch(`${API_BASE_URL}/admin/resources/${resource._id}/file?download=true`, {
          headers: { Authorization: `Bearer ${token}` },
        })

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

  // Filtered list
  const filteredResourcesList = useMemo(() => {
    return filterResources(resources, {
      selectedCourseId: selectedCourseFilter,
      searchTerm: searchQuery,
    })
  }, [resources, selectedCourseFilter, searchQuery])

  return (
    <div className="admin-resources-mgmt">
      {/* Page Header */}
      <section className="admin-page-heading admin-resources-heading">
        <div className="admin-resources-heading__content">
          <p className="admin-eyebrow">COURSE MANAGEMENT</p>
          <h1>Resource Management</h1>
          <p>
            Upload, organize, and manage learning materials and supplementary study documents for students.
          </p>
        </div>
        <div className="admin-resources-heading__actions">
          <button
            type="button"
            className="admin-button admin-button--primary admin-resources-upload-btn"
            onClick={handleOpenUploadModal}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" y1="3" x2="12" y2="15" />
            </svg>
            <span>Upload Resource</span>
          </button>
        </div>
      </section>

      {/* Notifications */}
      {successMessage && (
        <div className="admin-resources-alert admin-resources-alert--success" role="status">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
            <polyline points="22 4 12 14.01 9 11.01" />
          </svg>
          <span>{successMessage}</span>
          <button type="button" className="admin-resources-alert__close" onClick={() => setSuccessMessage('')} aria-label="Dismiss">
            &times;
          </button>
        </div>
      )}

      {errorMessage && (
        <div className="admin-resources-alert admin-resources-alert--error" role="alert">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
          <span>{errorMessage}</span>
          <button type="button" className="admin-resources-alert__close" onClick={() => setErrorMessage('')} aria-label="Dismiss">
            &times;
          </button>
        </div>
      )}

      {/* Controls Bar: Search, Course Filter, Layout Switcher */}
      <section className="admin-resources-controls">
        <div className="admin-resources-controls__left">
          {/* Search Box */}
          <div className="admin-resources-search">
            <span className="admin-resources-search-icon" aria-hidden="true">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
            </span>
            <input
              type="search"
              aria-label="Search by title, description or file name..."
              placeholder="Search by title, description or file name..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            {searchQuery && (
              <button
                type="button"
                className="admin-resources-search__clear"
                onClick={() => setSearchQuery('')}
                aria-label="Clear search"
              >
                &times;
              </button>
            )}
          </div>

          {/* Course Selector Dropdown */}
          <div className="admin-resources-filter">
            <select
              aria-label="Filter by course"
              value={selectedCourseFilter}
              onChange={(e) => setSelectedCourseFilter(e.target.value)}
            >
              <option value="">All Courses ({courses.length})</option>
              {courses.map((course) => (
                <option key={course._id} value={course._id}>
                  {course.title}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="admin-resources-controls__right">
          <span className="admin-resources-count">
            Showing <strong>{filteredResourcesList.length}</strong> of {resources.length} resources
          </span>

          {/* View Mode Toggle: Grid vs Table */}
          <div className="admin-resources-layout-toggle" role="group" aria-label="View mode">
            <button
              type="button"
              className={`admin-resources-layout-btn ${viewMode === 'grid' ? 'is-active' : ''}`}
              onClick={() => setViewMode('grid')}
              aria-pressed={viewMode === 'grid'}
              title="Card view"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <rect x="3" y="3" width="7" height="7" />
                <rect x="14" y="3" width="7" height="7" />
                <rect x="14" y="14" width="7" height="7" />
                <rect x="3" y="14" width="7" height="7" />
              </svg>
            </button>
            <button
              type="button"
              className={`admin-resources-layout-btn ${viewMode === 'table' ? 'is-active' : ''}`}
              onClick={() => setViewMode('table')}
              aria-pressed={viewMode === 'table'}
              title="Table view"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <line x1="8" y1="6" x2="21" y2="6" />
                <line x1="8" y1="12" x2="21" y2="12" />
                <line x1="8" y1="18" x2="21" y2="18" />
                <line x1="3" y1="6" x2="3.01" y2="6" />
                <line x1="3" y1="12" x2="3.01" y2="12" />
                <line x1="3" y1="18" x2="3.01" y2="18" />
              </svg>
            </button>
          </div>
        </div>
      </section>

      {/* Main Content Area */}
      {isLoading ? (
        <div className="admin-resources-loading">
          <div className="admin-resources-spinner" aria-hidden="true" />
          <p>Loading course resources...</p>
        </div>
      ) : filteredResourcesList.length === 0 ? (
        <div className="admin-resources-empty">
          <div className="admin-resources-empty__icon" aria-hidden="true">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
              <line x1="16" y1="13" x2="8" y2="13" />
              <line x1="16" y1="17" x2="8" y2="17" />
              <line x1="10" y1="9" x2="8" y2="9" />
            </svg>
          </div>
          <h3>{searchQuery || selectedCourseFilter ? 'No matching resources found' : 'No course resources uploaded yet'}</h3>
          <p>
            {searchQuery || selectedCourseFilter
              ? 'Try modifying your search keywords or clearing course filter selection.'
              : 'Upload learning materials and reference documents to help students master course topics.'}
          </p>
          {searchQuery || selectedCourseFilter ? (
            <button
              type="button"
              className="admin-button admin-button--secondary"
              onClick={() => {
                setSearchQuery('')
                setSelectedCourseFilter('')
              }}
            >
              Reset Filters
            </button>
          ) : (
            <button
              type="button"
              className="admin-button admin-button--primary"
              onClick={handleOpenUploadModal}
            >
              Upload First Resource
            </button>
          )}
        </div>
      ) : viewMode === 'grid' ? (
        /* GRID VIEW */
        <div className="admin-resources-grid">
          {filteredResourcesList.map((resource) => {
            const courseTitle = typeof resource.courseId === 'object' ? resource.courseId?.title : 'Course'
            const courseCategory = typeof resource.courseId === 'object' ? resource.courseId?.category : ''
            const formattedDate = resource.createdAt
              ? new Date(resource.createdAt).toLocaleDateString('en-US', {
                  year: 'numeric',
                  month: 'short',
                  day: 'numeric',
                })
              : 'Recently added'

            return (
              <article key={resource._id} className="admin-resource-card">
                <div className="admin-resource-card__header">
                  <div className="admin-resource-card__file-badge">
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                      <polyline points="14 2 14 8 20 8" />
                    </svg>
                    <span>PDF</span>
                  </div>
                  <div className="admin-resource-card__meta-top">
                    {courseCategory && <span className="admin-resource-card__category">{courseCategory}</span>}
                    <span className="admin-resource-card__size">{formatFileSize(resource.fileSize)}</span>
                  </div>
                </div>

                <div className="admin-resource-card__body">
                  <h3 className="admin-resource-card__title" title={resource.title}>
                    {resource.title}
                  </h3>
                  <p className="admin-resource-card__course-name" title={courseTitle}>
                    {courseTitle}
                  </p>
                  {resource.description ? (
                    <p className="admin-resource-card__description" title={resource.description}>
                      {resource.description}
                    </p>
                  ) : (
                    <p className="admin-resource-card__description is-empty">
                      No additional description provided.
                    </p>
                  )}
                </div>

                <div className="admin-resource-card__footer">
                  <span className="admin-resource-card__date">{formattedDate}</span>

                  <div className="admin-resource-card__actions">
                    <button
                      type="button"
                      className="admin-resource-action-btn"
                      title="Preview PDF"
                      onClick={() => handleOpenPreview(resource)}
                    >
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                        <circle cx="12" cy="12" r="3" />
                      </svg>
                    </button>
                    <button
                      type="button"
                      className="admin-resource-action-btn"
                      title="Download PDF"
                      onClick={() => handleDownload(resource)}
                      disabled={downloadingResourceId === resource._id}
                    >
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                        <polyline points="7 10 12 15 17 10" />
                        <line x1="12" y1="15" x2="12" y2="3" />
                      </svg>
                    </button>
                    <button
                      type="button"
                      className="admin-resource-action-btn"
                      title="Edit resource details"
                      onClick={() => handleOpenEditModal(resource)}
                    >
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                        <path d="M12 20h9" />
                        <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
                      </svg>
                    </button>
                    <button
                      type="button"
                      className="admin-resource-action-btn is-danger"
                      title="Delete resource"
                      onClick={() => setDeletingResource(resource)}
                    >
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                        <polyline points="3 6 5 6 21 6" />
                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                      </svg>
                    </button>
                  </div>
                </div>
              </article>
            )
          })}
        </div>
      ) : (
        /* TABLE VIEW */
        <div className="admin-resources-table-container">
          <table className="admin-resources-table">
            <thead>
              <tr>
                <th>Resource Name</th>
                <th>Course</th>
                <th>Format & Size</th>
                <th>Date Uploaded</th>
                <th className="text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredResourcesList.map((resource) => {
                const courseTitle = typeof resource.courseId === 'object' ? resource.courseId?.title : 'Course'
                const formattedDate = resource.createdAt
                  ? new Date(resource.createdAt).toLocaleDateString('en-US', {
                      year: 'numeric',
                      month: 'short',
                      day: 'numeric',
                    })
                  : 'Recent'

                return (
                  <tr key={resource._id}>
                    <td>
                      <div className="admin-resources-table__title-cell">
                        <span className="admin-resources-table__file-icon">PDF</span>
                        <div>
                          <strong>{resource.title}</strong>
                          {resource.description && <small>{resource.description}</small>}
                        </div>
                      </div>
                    </td>
                    <td>
                      <span className="admin-resources-table__course-badge">{courseTitle}</span>
                    </td>
                    <td>
                      <span className="admin-resources-table__size-badge">
                        {formatFileSize(resource.fileSize)}
                      </span>
                    </td>
                    <td>{formattedDate}</td>
                    <td className="text-right">
                      <div className="admin-resources-table__action-group">
                        <button
                          type="button"
                          className="admin-resource-action-btn"
                          title="Preview"
                          onClick={() => handleOpenPreview(resource)}
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                            <circle cx="12" cy="12" r="3" />
                          </svg>
                        </button>
                        <button
                          type="button"
                          className="admin-resource-action-btn"
                          title="Download"
                          onClick={() => handleDownload(resource)}
                          disabled={downloadingResourceId === resource._id}
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                            <polyline points="7 10 12 15 17 10" />
                            <line x1="12" y1="15" x2="12" y2="3" />
                          </svg>
                        </button>
                        <button
                          type="button"
                          className="admin-resource-action-btn"
                          title="Edit"
                          onClick={() => handleOpenEditModal(resource)}
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M12 20h9" />
                            <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
                          </svg>
                        </button>
                        <button
                          type="button"
                          className="admin-resource-action-btn is-danger"
                          title="Delete"
                          onClick={() => setDeletingResource(resource)}
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <polyline points="3 6 5 6 21 6" />
                            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                          </svg>
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* UPLOAD MODAL */}
      {isUploadModalOpen && (
        <div className="admin-resources-modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="upload-modal-title">
          <div className="admin-resources-modal">
            <div className="admin-resources-modal__header">
              <div>
                <h2 id="upload-modal-title">Upload Course Resource</h2>
                <p>Upload supplementary learning materials or reference documents for a course.</p>
              </div>
              <button
                type="button"
                className="admin-resources-modal__close-btn"
                onClick={() => !isSubmitting && setIsUploadModalOpen(false)}
                disabled={isSubmitting}
                aria-label="Close dialog"
              >
                &times;
              </button>
            </div>

            <form onSubmit={handleUploadSubmit} className="admin-resources-modal__form">
              {uploadFormError && (
                <div className="admin-resources-form-error" role="alert">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="12" cy="12" r="10" />
                    <line x1="12" y1="8" x2="12" y2="12" />
                    <line x1="12" y1="16" x2="12.01" y2="16" />
                  </svg>
                  <span>{uploadFormError}</span>
                </div>
              )}

              {/* Course Selector */}
              <div className="admin-resources-form-group">
                <label htmlFor="upload-course">Select Course <span className="required">*</span></label>
                <select
                  id="upload-course"
                  value={uploadCourseId}
                  onChange={(e) => setUploadCourseId(e.target.value)}
                  disabled={isSubmitting}
                  required
                >
                  <option value="" disabled>-- Select Course --</option>
                  {courses.map((course) => (
                    <option key={course._id} value={course._id}>
                      {course.title}
                    </option>
                  ))}
                </select>
              </div>

              {/* Title Input */}
              <div className="admin-resources-form-group">
                <label htmlFor="upload-title">Resource Title <span className="required">*</span></label>
                <input
                  id="upload-title"
                  type="text"
                  placeholder="e.g. Python Data Structures Reference Guide"
                  value={uploadTitle}
                  onChange={(e) => setUploadTitle(e.target.value)}
                  disabled={isSubmitting}
                  maxLength={150}
                  required
                />
              </div>

              {/* Description Input */}
              <div className="admin-resources-form-group">
                <label htmlFor="upload-desc">Description <span className="optional">(optional)</span></label>
                <textarea
                  id="upload-desc"
                  rows="3"
                  placeholder="Summary of what this resource covers, recommended lessons, or tips..."
                  value={uploadDescription}
                  onChange={(e) => setUploadDescription(e.target.value)}
                  disabled={isSubmitting}
                  maxLength={500}
                />
              </div>

              {/* File Dropzone */}
              <div className="admin-resources-form-group">
                <label>PDF Resource File <span className="required">*</span></label>
                <div
                  className={`admin-resources-dropzone ${isDragging ? 'is-dragging' : ''} ${uploadFile ? 'has-file' : ''}`}
                  onDragOver={(e) => {
                    e.preventDefault()
                    setIsDragging(true)
                  }}
                  onDragLeave={() => setIsDragging(false)}
                  onDrop={(e) => {
                    e.preventDefault()
                    setIsDragging(false)
                    if (e.dataTransfer.files?.[0]) {
                      handleFileSelection(e.dataTransfer.files[0])
                    }
                  }}
                  onClick={() => fileInputRef.current?.click()}
                  role="button"
                  tabIndex="0"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      fileInputRef.current?.click()
                    }
                  }}
                >
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".pdf,application/pdf"
                    className="sr-only"
                    onChange={(e) => {
                      if (e.target.files?.[0]) {
                        handleFileSelection(e.target.files[0])
                      }
                    }}
                  />
                  {uploadFile ? (
                    <div className="admin-resources-dropzone__selected">
                      <div className="admin-resources-dropzone__file-icon">PDF</div>
                      <div className="admin-resources-dropzone__info">
                        <strong>{uploadFile.name}</strong>
                        <span>{formatFileSize(uploadFile.size)}</span>
                      </div>
                      <button
                        type="button"
                        className="admin-resources-dropzone__remove-btn"
                        onClick={(e) => {
                          e.stopPropagation()
                          setUploadFile(null)
                          if (fileInputRef.current) fileInputRef.current.value = ''
                        }}
                      >
                        Change File
                      </button>
                    </div>
                  ) : (
                    <div className="admin-resources-dropzone__prompt">
                      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                        <polyline points="17 8 12 3 7 8" />
                        <line x1="12" y1="3" x2="12" y2="15" />
                      </svg>
                      <p><strong>Click to browse</strong> or drag & drop your PDF file here</p>
                      <small>Supports PDF format up to 50 MB.</small>
                    </div>
                  )}
                </div>
              </div>

              {/* Action Buttons */}
              <div className="admin-resources-modal__footer">
                <button
                  type="button"
                  className="admin-button admin-button--secondary"
                  onClick={() => setIsUploadModalOpen(false)}
                  disabled={isSubmitting}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="admin-button admin-button--primary"
                  disabled={isSubmitting || !uploadFile}
                >
                  {isSubmitting ? (
                    <>
                      <span className="admin-resources-btn-spinner" aria-hidden="true" />
                      <span>Uploading PDF...</span>
                    </>
                  ) : (
                    'Upload & Publish'
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* EDIT MODAL */}
      {editingResource && (
        <div className="admin-resources-modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="edit-modal-title">
          <div className="admin-resources-modal">
            <div className="admin-resources-modal__header">
              <div>
                <h2 id="edit-modal-title">Edit Resource Details</h2>
                <p>Update title, description, or change course assignment.</p>
              </div>
              <button
                type="button"
                className="admin-resources-modal__close-btn"
                onClick={() => !isSubmitting && setEditingResource(null)}
                disabled={isSubmitting}
                aria-label="Close dialog"
              >
                &times;
              </button>
            </div>

            <form onSubmit={handleEditSubmit} className="admin-resources-modal__form">
              {editFormError && (
                <div className="admin-resources-form-error" role="alert">
                  <span>{editFormError}</span>
                </div>
              )}

              <div className="admin-resources-form-group">
                <label htmlFor="edit-course">Course</label>
                <select
                  id="edit-course"
                  value={editCourseId}
                  onChange={(e) => setEditCourseId(e.target.value)}
                  disabled={isSubmitting}
                  required
                >
                  {courses.map((course) => (
                    <option key={course._id} value={course._id}>
                      {course.title}
                    </option>
                  ))}
                </select>
              </div>

              <div className="admin-resources-form-group">
                <label htmlFor="edit-title">Resource Title</label>
                <input
                  id="edit-title"
                  type="text"
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  disabled={isSubmitting}
                  maxLength={150}
                  required
                />
              </div>

              <div className="admin-resources-form-group">
                <label htmlFor="edit-desc">Description</label>
                <textarea
                  id="edit-desc"
                  rows="3"
                  value={editDescription}
                  onChange={(e) => setEditDescription(e.target.value)}
                  disabled={isSubmitting}
                  maxLength={500}
                />
              </div>

              <div className="admin-resources-edit-fileinfo">
                <span>File: <strong>{editingResource.originalFileName || `${editingResource.title}.pdf`}</strong> ({formatFileSize(editingResource.fileSize)})</span>
              </div>

              <div className="admin-resources-modal__footer">
                <button
                  type="button"
                  className="admin-button admin-button--secondary"
                  onClick={() => setEditingResource(null)}
                  disabled={isSubmitting}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="admin-button admin-button--primary"
                  disabled={isSubmitting}
                >
                  {isSubmitting ? 'Saving...' : 'Save Changes'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* DELETE CONFIRMATION DIALOG */}
      {deletingResource && (
        <div className="admin-resources-modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="delete-dialog-title">
          <div className="admin-resources-modal admin-resources-modal--compact">
            <div className="admin-resources-modal__header">
              <div className="admin-resources-delete-warning-icon">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                  <line x1="12" y1="9" x2="12" y2="13" />
                  <line x1="12" y1="17" x2="12.01" y2="17" />
                </svg>
              </div>
              <div>
                <h2 id="delete-dialog-title">Delete Resource?</h2>
                <p>Are you sure you want to permanently remove this resource?</p>
              </div>
            </div>

            <div className="admin-resources-delete-details">
              <p><strong>Title:</strong> {deletingResource.title}</p>
              <p><strong>Course:</strong> {typeof deletingResource.courseId === 'object' ? deletingResource.courseId?.title : 'Course'}</p>
              <small>This will remove the file from cloud storage. Enrolled students will no longer be able to access or download it.</small>
            </div>

            <div className="admin-resources-modal__footer">
              <button
                type="button"
                className="admin-button admin-button--secondary"
                onClick={() => setDeletingResource(null)}
                disabled={isSubmitting}
              >
                Cancel
              </button>
              <button
                type="button"
                className="admin-button admin-button--danger"
                onClick={handleDeleteConfirm}
                disabled={isSubmitting}
              >
                {isSubmitting ? 'Deleting...' : 'Yes, Delete Resource'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* PREVIEW MODAL */}
      {previewingResource && (
        <div className="admin-resources-modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="preview-dialog-title">
          <div className="admin-resources-modal admin-resources-modal--preview">
            <div className="admin-resources-modal__header">
              <div>
                <h2 id="preview-dialog-title">{previewingResource.title}</h2>
                <p>
                  {typeof previewingResource.courseId === 'object' ? previewingResource.courseId?.title : 'Course'} &bull; {formatFileSize(previewingResource.fileSize)}
                </p>
              </div>
              <div className="admin-resources-preview-header-actions">
                <button
                  type="button"
                  className="admin-button admin-button--secondary"
                  onClick={() => handleDownload(previewingResource)}
                  disabled={downloadingResourceId === previewingResource._id}
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="7 10 12 15 17 10" />
                    <line x1="12" y1="15" x2="12" y2="3" />
                  </svg>
                  <span>{downloadingResourceId === previewingResource._id ? 'Downloading...' : 'Download'}</span>
                </button>
                <button
                  type="button"
                  className="admin-resources-modal__close-btn"
                  onClick={closePreview}
                  aria-label="Close preview"
                >
                  &times;
                </button>
              </div>
            </div>

            <div className="admin-resources-preview-body">
              {isPreviewLoading ? (
                <div className="admin-resources-modal__loading">
                  <div className="admin-resources-spinner" aria-hidden="true" />
                  <p>Loading secure PDF preview...</p>
                </div>
              ) : previewError ? (
                <div className="admin-resources-modal__error" role="alert">
                  <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="12" cy="12" r="10" />
                    <line x1="12" y1="8" x2="12" y2="12" />
                    <line x1="12" y1="16" x2="12.01" y2="16" />
                  </svg>
                  <h4>Unable to load PDF preview</h4>
                  <p>{previewError}</p>
                  <div className="admin-resources-modal__error-actions">
                    <button
                      type="button"
                      className="admin-button admin-button--primary"
                      onClick={() => handleOpenPreview(previewingResource)}
                    >
                      Try Again
                    </button>
                    <button
                      type="button"
                      className="admin-button admin-button--secondary"
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
                    className="admin-resources-preview-iframe"
                  />
                  <div className="admin-resources-preview-fallback">
                    <p>If the preview does not display in your browser, you can open or download it directly:</p>
                    <a
                      href={previewBlobUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="admin-button admin-button--primary"
                    >
                      Open in New Window
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
