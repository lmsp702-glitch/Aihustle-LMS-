export function formatTimestamp(seconds) {
  if (seconds == null || isNaN(seconds) || seconds < 0) return ''
  const totalSecs = Math.floor(seconds)
  const mins = Math.floor(totalSecs / 60)
  const secs = totalSecs % 60
  const hrs = Math.floor(mins / 60)
  if (hrs > 0) {
    const remMins = mins % 60
    return `${hrs}:${String(remMins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
  }
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
}

export function parseTimestamp(timeString) {
  if (!timeString || typeof timeString !== 'string') return null
  const cleaned = timeString.trim()
  if (!cleaned) return null
  const parts = cleaned.split(':').map((p) => Number(p))
  if (parts.some((p) => isNaN(p) || p < 0)) return null
  if (parts.length === 2) {
    return parts[0] * 60 + parts[1]
  }
  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2]
  }
  return null
}

export function stripHtmlTags(html = '') {
  if (typeof html !== 'string') return ''
  return html
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/(p|div|li|h[1-6])>/gi, ' ')
    .replace(/<(p|div|li|h[1-6])[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim()
}

export function sanitizeRichHtml(html = '') {
  if (typeof html !== 'string') return ''
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
    .replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, '')
    .replace(/on\w+="[^"]*"/gi, '')
    .replace(/on\w+='[^']*'/gi, '')
}

export function filterAndSortNotes(notes = [], { search = '', lessonId = 'all', pinnedOnly = false, sort = 'newest' } = {}) {
  let result = [...notes]

  if (search && search.trim()) {
    const term = search.trim().toLowerCase()
    result = result.filter((n) => {
      const titleMatch = n.title && n.title.toLowerCase().includes(term)
      const contentMatch = n.content && stripHtmlTags(n.content).toLowerCase().includes(term)
      const lessonMatch = n.lessonTitle && n.lessonTitle.toLowerCase().includes(term)
      return titleMatch || contentMatch || lessonMatch
    })
  }

  if (lessonId && lessonId !== 'all') {
    result = result.filter((n) => String(n.lessonId || '') === String(lessonId))
  }

  if (pinnedOnly) {
    result = result.filter((n) => Boolean(n.isPinned))
  }

  // Pinned notes always appear first
  result.sort((a, b) => {
    const aPin = Boolean(a.isPinned)
    const bPin = Boolean(b.isPinned)
    if (aPin !== bPin) return aPin ? -1 : 1

    if (sort === 'oldest') {
      return new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime()
    }
    if (sort === 'recently_edited') {
      return new Date(b.updatedAt || b.createdAt || 0).getTime() - new Date(a.updatedAt || a.createdAt || 0).getTime()
    }
    if (sort === 'lesson') {
      const comp = (a.lessonTitle || '').localeCompare(b.lessonTitle || '')
      if (comp !== 0) return comp
      return (a.videoTimestamp || 0) - (b.videoTimestamp || 0)
    }
    // Default newest
    return new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime()
  })

  return result
}

export function calculateNotesSummary(notes = []) {
  const totalCount = notes.length
  const distinctLessons = new Set(notes.map((n) => n.lessonId).filter(Boolean))
  const lessonsCoveredCount = distinctLessons.size
  const pinnedCount = notes.filter((n) => Boolean(n.isPinned)).length
  return { totalCount, lessonsCoveredCount, pinnedCount }
}
