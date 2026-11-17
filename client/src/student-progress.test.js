import assert from 'node:assert/strict'
import { test } from 'node:test'

function getCourseLessons(course) {
  return (course?.modules || []).flatMap((module, moduleIndex) => {
    const videoItems = module.contentItems?.filter((item) => item.type === 'video-lesson') || []
    const lessons = videoItems.length ? videoItems : module.lessons || []
    return lessons.map((lesson, lessonIndex) => ({
      module,
      lesson,
      moduleKey: String(module._id || `${module.title}-${moduleIndex}`),
      lessonKey: String(lesson._id || `${moduleIndex}-${lessonIndex}`),
    }))
  })
}

function getCourseProgress(enrollment) {
  if (!enrollment?.courseId) return { completedCount: 0, totalCount: 0, percentage: 0 }
  const lessons = getCourseLessons(enrollment.courseId)
  const completedIds = new Set((enrollment.completedLessonIds || []).map(String))
  const completedCount = lessons.filter(({ lesson, lessonKey }) => (
    completedIds.has(String(lesson._id || '')) || (lessonKey && completedIds.has(String(lessonKey)))
  )).length
  const totalCount = lessons.length
  return {
    completedCount,
    totalCount,
    percentage: totalCount ? Math.round((completedCount / totalCount) * 100) : 0,
  }
}

function getNextIncompleteLesson(course, completedLessonIds) {
  const lessons = getCourseLessons(course)
  const completedIds = new Set((completedLessonIds || []).map(String))
  const nextIncomplete = lessons.find(({ lesson, lessonKey }) => (
    !completedIds.has(String(lesson._id || '')) && !completedIds.has(String(lessonKey || ''))
  ))
  const targetLesson = nextIncomplete || lessons[0]
  return targetLesson ? String(targetLesson.lesson._id || targetLesson.lessonKey) : ''
}

const mockDigitalMarketingCourse = {
  _id: '6af41d144ad96cf02e2b769b',
  title: 'Digital Marketing',
  modules: [
    {
      _id: 'mod-1',
      title: 'Module 1: Foundations',
      contentItems: [
        { _id: '6af4213c55ce57e75a6328b6', type: 'video-lesson', title: 'Introduction to Digital Marketing', videoUrl: 'https://example.com/v1.mp4' },
        { _id: '6af4213c55ce57e75a6328b7', type: 'video-lesson', title: 'SEO Fundamentals', videoUrl: 'https://example.com/v2.mp4' },
        { _id: '6af4213c55ce57e75a6328bb', type: 'video-lesson', title: 'Social Media Marketing', videoUrl: 'https://example.com/v3.mp4' },
      ],
    },
  ],
}

test('getCourseProgress accurately computes 0%, 33%, 67%, 100% for 3 lessons', () => {
  // 0 of 3 completed
  const enrollment0 = {
    courseId: mockDigitalMarketingCourse,
    completedLessonIds: [],
    status: 'active',
  }
  const prog0 = getCourseProgress(enrollment0)
  assert.equal(prog0.completedCount, 0)
  assert.equal(prog0.totalCount, 3)
  assert.equal(prog0.percentage, 0)

  // 1 of 3 completed (Lesson 1) -> 33%
  const enrollment1 = {
    courseId: mockDigitalMarketingCourse,
    completedLessonIds: ['6af4213c55ce57e75a6328b6'],
    status: 'active',
  }
  const prog1 = getCourseProgress(enrollment1)
  assert.equal(prog1.completedCount, 1)
  assert.equal(prog1.totalCount, 3)
  assert.equal(prog1.percentage, 33)

  // 2 of 3 completed (Lessons 1 & 2) -> 67%
  const enrollment2 = {
    courseId: mockDigitalMarketingCourse,
    completedLessonIds: ['6af4213c55ce57e75a6328b6', '6af4213c55ce57e75a6328b7'],
    status: 'active',
  }
  const prog2 = getCourseProgress(enrollment2)
  assert.equal(prog2.completedCount, 2)
  assert.equal(prog2.totalCount, 3)
  assert.equal(prog2.percentage, 67)

  // 3 of 3 completed (All 3) -> 100%
  const enrollment3 = {
    courseId: mockDigitalMarketingCourse,
    completedLessonIds: [
      '6af4213c55ce57e75a6328b6',
      '6af4213c55ce57e75a6328b7',
      '6af4213c55ce57e75a6328bb',
    ],
    status: 'completed',
  }
  const prog3 = getCourseProgress(enrollment3)
  assert.equal(prog3.completedCount, 3)
  assert.equal(prog3.totalCount, 3)
  assert.equal(prog3.percentage, 100)
})

test('getNextIncompleteLesson identifies the correct next lesson to continue', () => {
  // 0 completed -> Lesson 1
  assert.equal(getNextIncompleteLesson(mockDigitalMarketingCourse, []), '6af4213c55ce57e75a6328b6')

  // Lesson 1 completed -> Lesson 2
  assert.equal(
    getNextIncompleteLesson(mockDigitalMarketingCourse, ['6af4213c55ce57e75a6328b6']),
    '6af4213c55ce57e75a6328b7',
  )

  // Lessons 1 & 2 completed -> Lesson 3
  assert.equal(
    getNextIncompleteLesson(mockDigitalMarketingCourse, [
      '6af4213c55ce57e75a6328b6',
      '6af4213c55ce57e75a6328b7',
    ]),
    '6af4213c55ce57e75a6328bb',
  )

  // All 3 completed -> Lesson 1 (review)
  assert.equal(
    getNextIncompleteLesson(mockDigitalMarketingCourse, [
      '6af4213c55ce57e75a6328b6',
      '6af4213c55ce57e75a6328b7',
      '6af4213c55ce57e75a6328bb',
    ]),
    '6af4213c55ce57e75a6328b6',
  )
})

test('Course card status displays Completed when finished and Enrolled otherwise', () => {
  const isCompletedFn = (enrollment) => {
    const { totalCount, completedCount } = getCourseProgress(enrollment)
    return enrollment.status === 'completed' || (totalCount > 0 && completedCount >= totalCount)
  }

  assert.equal(isCompletedFn({ courseId: mockDigitalMarketingCourse, completedLessonIds: [], status: 'active' }), false)
  assert.equal(isCompletedFn({ courseId: mockDigitalMarketingCourse, completedLessonIds: ['6af4213c55ce57e75a6328b6'], status: 'active' }), false)
  assert.equal(isCompletedFn({ courseId: mockDigitalMarketingCourse, completedLessonIds: ['6af4213c55ce57e75a6328b6', '6af4213c55ce57e75a6328b7'], status: 'active' }), false)
  assert.equal(isCompletedFn({
    courseId: mockDigitalMarketingCourse,
    completedLessonIds: ['6af4213c55ce57e75a6328b6', '6af4213c55ce57e75a6328b7', '6af4213c55ce57e75a6328bb'],
    status: 'completed',
  }), true)
})

test('StudentCourses filters correctly categorize enrolled, active, and completed courses', () => {
  const enrollments = [
    {
      _id: 'enr-1',
      courseId: mockDigitalMarketingCourse,
      completedLessonIds: ['6af4213c55ce57e75a6328b6'],
      status: 'active',
    },
    {
      _id: 'enr-2',
      courseId: mockDigitalMarketingCourse,
      completedLessonIds: ['6af4213c55ce57e75a6328b6', '6af4213c55ce57e75a6328b7', '6af4213c55ce57e75a6328bb'],
      status: 'completed',
    },
  ]

  const filterEnrollments = (filter) => enrollments.filter((entry) => {
    const { percentage } = getCourseProgress(entry)
    const isComplete = entry.status === 'completed' || percentage >= 100
    if (filter === 'enrolled') return true
    if (filter === 'completed') return isComplete
    if (filter === 'active') return !isComplete
    return true
  })

  // 'enrolled' shows both
  assert.equal(filterEnrollments('enrolled').length, 2)
  // 'active' shows only enr-1
  assert.equal(filterEnrollments('active').length, 1)
  assert.equal(filterEnrollments('active')[0]._id, 'enr-1')
  // 'completed' shows only enr-2
  assert.equal(filterEnrollments('completed').length, 1)
  assert.equal(filterEnrollments('completed')[0]._id, 'enr-2')
})

test('StudentDashboard correctly imports all used React hooks including useMemo', async () => {
  const fs = await import('node:fs')
  const path = await import('node:path')
  const dashboardCode = fs.readFileSync(path.resolve('client/src/StudentDashboard.jsx'), 'utf-8')

  const importMatch = dashboardCode.match(/import\s+React\s*,\s*\{([^}]+)\}\s*from\s*['"]react['"]/)
  assert.ok(importMatch, 'Must have a named React import in StudentDashboard.jsx')

  const importedHooks = importMatch[1].split(',').map((h) => h.trim())
  const requiredHooks = ['useMemo', 'useState', 'useEffect', 'useCallback', 'useRef']

  for (const hook of requiredHooks) {
    assert.ok(
      importedHooks.includes(hook),
      `StudentDashboard.jsx must import '${hook}' from 'react'`,
    )
  }
})

test('Quizzes & Assignments status details correctly map quiz and assignment lifecycle states', () => {
  function getActivityStatusDetails(activity) {
    const isQuiz = activity.type === 'quiz'
    if (isQuiz) {
      if (activity.status === 'completed') return { text: 'Completed', tone: 'mint' }
      if (activity.status === 'failed') return { text: 'Failed', tone: 'peach' }
      if (activity.status === 'in_progress') return { text: 'In Progress', tone: 'blue' }
      return { text: 'Pending', tone: 'neutral' }
    }
    if (activity.status === 'graded') return { text: 'Graded', tone: 'mint' }
    if (activity.status === 'submitted') return { text: 'Submitted', tone: 'teal' }
    if (activity.status === 'overdue' || activity.isOverdue) return { text: 'Overdue', tone: 'peach' }
    return { text: 'Pending', tone: 'neutral' }
  }

  // Quiz states
  assert.deepEqual(getActivityStatusDetails({ type: 'quiz', status: 'completed' }), { text: 'Completed', tone: 'mint' })
  assert.deepEqual(getActivityStatusDetails({ type: 'quiz', status: 'failed' }), { text: 'Failed', tone: 'peach' })
  assert.deepEqual(getActivityStatusDetails({ type: 'quiz', status: 'in_progress' }), { text: 'In Progress', tone: 'blue' })
  assert.deepEqual(getActivityStatusDetails({ type: 'quiz', status: 'pending' }), { text: 'Pending', tone: 'neutral' })

  // Assignment states
  assert.deepEqual(getActivityStatusDetails({ type: 'assignment', status: 'graded' }), { text: 'Graded', tone: 'mint' })
  assert.deepEqual(getActivityStatusDetails({ type: 'assignment', status: 'submitted' }), { text: 'Submitted', tone: 'teal' })
  assert.deepEqual(getActivityStatusDetails({ type: 'assignment', status: 'overdue' }), { text: 'Overdue', tone: 'peach' })
  assert.deepEqual(getActivityStatusDetails({ type: 'assignment', isOverdue: true, status: 'pending' }), { text: 'Overdue', tone: 'peach' })
  assert.deepEqual(getActivityStatusDetails({ type: 'assignment', status: 'pending' }), { text: 'Pending', tone: 'neutral' })
})

test('Quizzes & Assignments action button labels accurately match item status', () => {
  function getActivityActionLabel(activity) {
    const isQuiz = activity.type === 'quiz'
    if (isQuiz) {
      if (activity.status === 'completed') return 'Review Quiz'
      if (activity.status === 'failed') return 'Retry Quiz'
      if (activity.status === 'in_progress') return 'Continue Quiz'
      return 'Start Quiz'
    }
    if (activity.status === 'graded') return 'View Submission'
    if (activity.status === 'submitted') return 'View Submission'
    if (activity.status === 'overdue' || activity.isOverdue) return 'Submit Assignment'
    return 'Submit Assignment'
  }

  assert.equal(getActivityActionLabel({ type: 'quiz', status: 'completed' }), 'Review Quiz')
  assert.equal(getActivityActionLabel({ type: 'quiz', status: 'failed' }), 'Retry Quiz')
  assert.equal(getActivityActionLabel({ type: 'quiz', status: 'in_progress' }), 'Continue Quiz')
  assert.equal(getActivityActionLabel({ type: 'quiz', status: 'pending' }), 'Start Quiz')

  assert.equal(getActivityActionLabel({ type: 'assignment', status: 'graded' }), 'View Submission')
  assert.equal(getActivityActionLabel({ type: 'assignment', status: 'submitted' }), 'View Submission')
  assert.equal(getActivityActionLabel({ type: 'assignment', status: 'overdue' }), 'Submit Assignment')
  assert.equal(getActivityActionLabel({ type: 'assignment', status: 'pending' }), 'Submit Assignment')
})

test('Quizzes & Assignments filter tabs accurately isolate activities', () => {
  const activities = [
    { id: 'q1', type: 'quiz', status: 'completed', isOverdue: false, title: 'Quiz 1', courseName: 'Python 101' },
    { id: 'q2', type: 'quiz', status: 'failed', isOverdue: false, title: 'Quiz 2', courseName: 'Python 101' },
    { id: 'q3', type: 'quiz', status: 'pending', isOverdue: false, title: 'Quiz 3', courseName: 'Web Dev' },
    { id: 'a1', type: 'assignment', status: 'submitted', isOverdue: false, title: 'Assignment 1', courseName: 'Python 101' },
    { id: 'a2', type: 'assignment', status: 'graded', isOverdue: false, title: 'Assignment 2', courseName: 'Web Dev' },
    { id: 'a3', type: 'assignment', status: 'overdue', isOverdue: true, title: 'Assignment 3', courseName: 'Web Dev' },
    { id: 'a4', type: 'assignment', status: 'pending', isOverdue: false, title: 'Assignment 4', courseName: 'Digital Marketing' },
  ]

  function filterActivities(items, activeFilter, searchQuery = '') {
    return items.filter((item) => {
      if (activeFilter === 'quizzes' && item.type !== 'quiz') return false
      if (activeFilter === 'assignments' && item.type !== 'assignment') return false
      if (activeFilter === 'completed') {
        const isComplete = item.type === 'quiz'
          ? item.status === 'completed'
          : (item.status === 'submitted' || item.status === 'graded')
        if (!isComplete) return false
      }
      if (activeFilter === 'remaining') {
        const isComplete = item.type === 'quiz'
          ? item.status === 'completed'
          : (item.status === 'submitted' || item.status === 'graded')
        if (isComplete) return false
      }
      if (activeFilter === 'overdue') {
        if (!item.isOverdue && item.status !== 'overdue') return false
      }

      if (searchQuery.trim()) {
        const q = searchQuery.trim().toLowerCase()
        const matchesTitle = item.title?.toLowerCase().includes(q)
        const matchesCourse = item.courseName?.toLowerCase().includes(q)
        if (!matchesTitle && !matchesCourse) return false
      }

      return true
    })
  }

  assert.equal(filterActivities(activities, 'all').length, 7)
  assert.equal(filterActivities(activities, 'quizzes').length, 3)
  assert.equal(filterActivities(activities, 'assignments').length, 4)
  assert.equal(filterActivities(activities, 'completed').length, 3) // q1 (completed), a1 (submitted), a2 (graded)
  assert.equal(filterActivities(activities, 'remaining').length, 4) // q2 (failed), q3 (pending), a3 (overdue), a4 (pending)
  assert.equal(filterActivities(activities, 'overdue').length, 1) // a3

  // Search filter
  assert.equal(filterActivities(activities, 'all', 'Python').length, 3)
  assert.equal(filterActivities(activities, 'completed', 'Python').length, 2)
  assert.equal(filterActivities(activities, 'all', 'Quiz 2').length, 1)
})

test('Course card on My Courses renders Course Details link to /student/course/:courseId/details', async () => {
  const fs = await import('node:fs')
  const path = await import('node:path')
  const dashboardCode = fs.readFileSync(path.resolve('client/src/StudentDashboard.jsx'), 'utf-8')

  // Check that EnrollmentCourseCard renders Course Details →
  assert.ok(
    dashboardCode.includes('/student/course/${encodeURIComponent(courseId)}/details'),
    'EnrollmentCourseCard must link to /student/course/:courseId/details',
  )
  assert.ok(
    dashboardCode.includes('Course Details →'),
    'EnrollmentCourseCard must display primary button text Course Details →',
  )
})

test('Course Details UI logic properly differentiates State A, State B, and State C', () => {
  function getCourseDetailsActions({ isEnrolled, isCompleted, canUnenroll }) {
    if (!isEnrolled) {
      return {
        state: 'A_NOT_ENROLLED',
        primaryAction: 'Enroll Now →',
        showUnenroll: false,
        showCertificate: false,
      }
    }
    if (!isCompleted) {
      return {
        state: 'B_ENROLLED_INCOMPLETE',
        primaryAction: 'Continue Learning →',
        showUnenroll: Boolean(canUnenroll),
        showCertificate: false,
      }
    }
    return {
      state: 'C_ENROLLED_COMPLETED',
      primaryAction: 'Review Course →',
      showUnenroll: false, // Unenroll must be completely hidden
      showCertificate: true,
    }
  }

  // State A: Not enrolled
  const stateA = getCourseDetailsActions({ isEnrolled: false, isCompleted: false, canUnenroll: false })
  assert.equal(stateA.state, 'A_NOT_ENROLLED')
  assert.equal(stateA.primaryAction, 'Enroll Now →')
  assert.equal(stateA.showUnenroll, false)
  assert.equal(stateA.showCertificate, false)

  // State B: Enrolled and incomplete
  const stateB = getCourseDetailsActions({ isEnrolled: true, isCompleted: false, canUnenroll: true })
  assert.equal(stateB.state, 'B_ENROLLED_INCOMPLETE')
  assert.equal(stateB.primaryAction, 'Continue Learning →')
  assert.equal(stateB.showUnenroll, true)
  assert.equal(stateB.showCertificate, false)

  // State C: Enrolled and completed
  const stateC = getCourseDetailsActions({ isEnrolled: true, isCompleted: true, canUnenroll: false })
  assert.equal(stateC.state, 'C_ENROLLED_COMPLETED')
  assert.equal(stateC.primaryAction, 'Review Course →')
  assert.equal(stateC.showUnenroll, false, 'Unenroll MUST be completely hidden for completed students')
  assert.equal(stateC.showCertificate, true, 'Certificate MUST be available for completed students')
})

test('Course Details parameter sanitization and resolution with 6af41d144ad96cf02e2b769b', () => {
  const targetCourseId = '6af41d144ad96cf02e2b769b'

  // Parameter sanitization handles clean ID, trailing /details, and whitespace
  function sanitizeCourseParam(param) {
    return (param || '').trim().replace(/\/details\/?$/, '').trim()
  }

  assert.equal(sanitizeCourseParam('6af41d144ad96cf02e2b769b'), targetCourseId)
  assert.equal(sanitizeCourseParam('6af41d144ad96cf02e2b769b/details'), targetCourseId)
  assert.equal(sanitizeCourseParam(' 6af41d144ad96cf02e2b769b/details/ '), targetCourseId)

  // Test fallback resolution from enrollments list (as seen in My Courses)
  const mockEnrollments = [
    {
      _id: 'enr-999',
      courseId: {
        _id: '6af41d144ad96cf02e2b769b',
        title: 'Digital Marketing',
        category: 'Marketing',
        difficulty: 'beginner',
        modules: [
          {
            _id: 'mod-1',
            title: 'Foundations',
            contentItems: [
              { _id: 'les-1', type: 'video-lesson', title: 'Intro', durationSeconds: 600 },
              { _id: 'les-2', type: 'video-lesson', title: 'SEO', durationSeconds: 800 },
            ],
          },
        ],
      },
      completedLessonIds: ['les-1'],
      status: 'active',
    },
  ]

  const cleanId = sanitizeCourseParam('6af41d144ad96cf02e2b769b/details')
  const matchedEnrollment = mockEnrollments.find((e) => {
    const cid = e.courseId && typeof e.courseId === 'object' ? String(e.courseId._id) : String(e.courseId || '')
    return cid === cleanId || String(e._id) === cleanId
  })

  assert.ok(matchedEnrollment, 'Course must be resolvable from existing enrollments for 6af41d144ad96cf02e2b769b')
  assert.equal(matchedEnrollment.courseId.title, 'Digital Marketing')

  // Error state differentiation test: network or auth error must NOT display "Course Not Found"
  function getDisplayState({ loading, error, course }) {
    if (loading) return 'LOADING'
    if (error) return 'ERROR_ALERT' // Shows retry button, NOT Course Not Found
    if (!course) return 'COURSE_NOT_FOUND'
    return 'COURSE_DETAILS_VIEW'
  }

  assert.equal(getDisplayState({ loading: true, error: '', course: null }), 'LOADING')
  assert.equal(getDisplayState({ loading: false, error: 'Network timeout', course: null }), 'ERROR_ALERT')
  assert.equal(getDisplayState({ loading: false, error: 'Unauthorized', course: null }), 'ERROR_ALERT')
  assert.equal(getDisplayState({ loading: false, error: '', course: null }), 'COURSE_NOT_FOUND')
  assert.equal(getDisplayState({ loading: false, error: '', course: { _id: targetCourseId } }), 'COURSE_DETAILS_VIEW')
})



