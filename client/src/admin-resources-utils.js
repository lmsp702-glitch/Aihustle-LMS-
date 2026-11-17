export const MAX_RESOURCE_FILE_SIZE_BYTES = 50 * 1024 * 1024 // 50MB

export function formatFileSize(bytes) {
  if (!bytes || Number.isNaN(Number(bytes)) || Number(bytes) <= 0) return '0 B'
  const num = Number(bytes)
  const kb = 1024
  const mb = kb * 1024
  const gb = mb * 1024
  if (num >= gb) return `${(num / gb).toFixed(1)} GB`
  if (num >= mb) return `${(num / mb).toFixed(1)} MB`
  if (num >= kb) return `${Math.round(num / kb)} KB`
  return `${num} B`
}

export function validateResourceUploadFile(file) {
  if (!file) {
    return { valid: false, error: 'Please select a PDF file to upload.' }
  }
  const fileName = file.name || ''
  const isPdfExt = /\.pdf$/i.test(fileName)
  if (!isPdfExt) {
    return { valid: false, error: 'Only PDF documents (.pdf) are supported for course resources.' }
  }
  if (file.size > MAX_RESOURCE_FILE_SIZE_BYTES) {
    return { valid: false, error: `The selected file (${formatFileSize(file.size)}) exceeds the maximum allowed upload limit of 50 MB.` }
  }
  return { valid: true, error: null }
}

export function filterResources(resources, { selectedCourseId = '', searchTerm = '' } = {}) {
  if (!Array.isArray(resources)) return []
  const term = searchTerm.trim().toLowerCase()
  return resources.filter((res) => {
    if (selectedCourseId) {
      const cId = typeof res.courseId === 'object' ? res.courseId?._id : res.courseId
      if (String(cId) !== String(selectedCourseId)) return false
    }
    if (term) {
      const titleMatch = (res.title || '').toLowerCase().includes(term)
      const descMatch = (res.description || '').toLowerCase().includes(term)
      const fileMatch = (res.originalFileName || '').toLowerCase().includes(term)
      const courseTitle = (typeof res.courseId === 'object' ? res.courseId?.title : '') || ''
      const courseMatch = courseTitle.toLowerCase().includes(term)
      if (!titleMatch && !descMatch && !fileMatch && !courseMatch) return false
    }
    return true
  })
}

export function getSafeResourceFilename(resource) {
  if (!resource) return 'resource.pdf'
  const raw = resource.originalFileName || resource.title || 'resource'
  const safe = String(raw).trim().replace(/[/\\?%*:|"<>]/g, '_')
  return /\.pdf$/i.test(safe) ? safe : `${safe}.pdf`
}

