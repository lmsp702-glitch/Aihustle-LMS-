import { courseLearningPaths } from '../config/course-learning-paths.js'

function documentId(value) {
  const id = value && typeof value === 'object' ? value._id : value
  return id === undefined || id === null ? '' : String(id)
}

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z\d]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

function textList(value) {
  return Array.isArray(value)
    ? value.filter((entry) => typeof entry === 'string').map((entry) => entry.trim()).filter(Boolean)
    : []
}

function courseIdentity(course) {
  return normalizeText([
    course?.title,
    course?.category,
    ...textList(course?.tags),
  ].join(' '))
}

function matchesLearningPath(source, candidate) {
  const sourceIdentity = courseIdentity(source)
  const candidateIdentity = courseIdentity(candidate)
  return courseLearningPaths.find((path) => (
    path.source.some((term) => sourceIdentity.includes(normalizeText(term)))
    && path.target.some((term) => candidateIdentity.includes(normalizeText(term)))
  ))
}

function uniqueText(values) {
  const seen = new Set()
  return values.filter((value) => {
    const key = normalizeText(value)
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function courseSkills(course, matches) {
  const metadataSkills = uniqueText([
    ...textList(course?.skills),
    ...textList(course?.learningObjectives),
  ])
  if (metadataSkills.length) return metadataSkills.slice(0, 6)
  return uniqueText(matches.flatMap(({ path }) => path.skills)).slice(0, 6)
}

function courseBenefits(course, matches, skills) {
  const metadataBenefits = textList(course?.practicalBenefits)
  if (metadataBenefits.length) return uniqueText(metadataBenefits).slice(0, 4)
  const configuredBenefits = uniqueText(matches.flatMap(({ path }) => path.benefits))
  if (configuredBenefits.length) return configuredBenefits.slice(0, 4)
  if (skills.length) {
    return skills.slice(0, 3).map((skill) => (
      `Develop ${skill} through the learning outcomes in "${course.title}".`
    ))
  }
  return [`Build foundational ${course.category || course.title} knowledge through this course.`]
}

function interpolate(template, values) {
  return template
    .replaceAll('{completedCourse}', values.completedCourse || 'your completed course')
    .replaceAll('{recommendedCourse}', values.recommendedCourse || 'this course')
}

function recommendation(candidate, matches = [], fallbackWhy = '') {
  const skills = courseSkills(candidate, matches)
  const basedOnCourses = matches.map(({ source, path }) => ({
    id: documentId(source),
    title: source.title,
    complements: interpolate(path.complements, {
      completedCourse: source.title,
      recommendedCourse: candidate.title,
    }),
  }))
  const why = matches.length
    ? matches.map(({ source, path }) => interpolate(path.reason, {
      completedCourse: source.title,
      recommendedCourse: candidate.title,
    })).join(' ')
    : fallbackWhy

  return {
    id: documentId(candidate),
    title: candidate.title,
    thumbnailUrl: candidate.thumbnailUrl || '',
    description: candidate.description || candidate.detailedDescription || '',
    category: candidate.category || 'Other',
    difficulty: candidate.difficulty || '',
    estimatedDurationMinutes: Number(candidate.estimatedDurationMinutes) || 0,
    basedOnCourses,
    why,
    combinationBenefits: uniqueText(matches.flatMap(({ path }) => path.combinationBenefits || [])).slice(0, 6),
    skills,
    benefits: courseBenefits(candidate, matches, skills),
  }
}

export function isAvailableCourse(course) {
  return course?.status === 'published'
    && course.isDeleted !== true
    && !course.deletedAt
    && course.isAvailable !== false
    && course.available !== false
}

export function generateCourseRecommendations({
  completedCourses = [],
  enrolledCourseIds = [],
  catalog = [],
} = {}) {
  const enrolledIds = new Set(enrolledCourseIds.map(documentId).filter(Boolean))
  const completedById = new Map(
    completedCourses
      .filter((course) => course?.title && documentId(course))
      .map((course) => [documentId(course), course]),
  )
  const completed = [...completedById.values()]
  const completedIds = new Set(completedById.keys())
  const candidatesById = new Map()
  for (const course of catalog) {
    const id = documentId(course)
    if (
      isAvailableCourse(course)
      && course?.title
      && id
      && !completedIds.has(id)
      && !enrolledIds.has(id)
    ) {
      candidatesById.set(id, course)
    }
  }
  const candidates = [...candidatesById.values()]
    .sort((left, right) => left.title.localeCompare(right.title))

  if (!completed.length) {
    return candidates
      .filter((course) => ['beginner', 'all-levels'].includes(course.difficulty || 'beginner'))
      .map((course) => recommendation(
        course,
        [],
        course.difficulty === 'all-levels'
          ? `An all-levels starting point in ${course.category || course.title}.`
          : `A beginner-friendly starting point in ${course.category || course.title}.`,
      ))
  }

  return candidates.flatMap((candidate) => {
    const matches = completed.flatMap((source) => {
      const path = matchesLearningPath(source, candidate)
      return path ? [{ source, path }] : []
    })
    return matches.length ? [recommendation(candidate, matches)] : []
  })
}
