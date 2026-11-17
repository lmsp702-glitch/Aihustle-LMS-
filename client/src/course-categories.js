export function normalizeCourseCategory(value) {
  return typeof value === 'string'
    ? value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase()
    : ''
}

export function getCourseCategoryName(course) {
  if (!course || typeof course !== 'object') return ''
  return typeof course.category === 'string' && course.category.trim()
    ? course.category.trim()
    : 'Other'
}

export function filterCoursesByCategory(courses, selectedCategory) {
  if (!Array.isArray(courses)) return []
  const selectedKey = normalizeCourseCategory(selectedCategory)
  if (!selectedKey) return courses
  return courses.filter((course) => (
    normalizeCourseCategory(getCourseCategoryName(course)) === selectedKey
  ))
}

export function getCourseCategoryNames(courses) {
  if (!Array.isArray(courses)) return []
  const namesByKey = new Map()
  for (const course of courses) {
    const name = getCourseCategoryName(course)
    const key = normalizeCourseCategory(name)
    if (key && !namesByKey.has(key)) namesByKey.set(key, name)
  }
  return [...namesByKey.values()]
}
