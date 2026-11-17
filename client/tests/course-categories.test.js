import assert from 'node:assert/strict'
import test from 'node:test'
import {
  filterCoursesByCategory,
  getCourseCategoryNames,
  normalizeCourseCategory,
} from '../src/course-categories.js'

test('category filtering matches backend category strings independent of case and spacing', () => {
  const courses = [
    { title: 'Python Basics', category: 'Python' },
    { title: 'Prompting', category: '  Prompt   Engineering ' },
    { title: 'Advanced Python', category: 'python' },
  ]

  assert.deepEqual(
    filterCoursesByCategory(courses, 'Prompt Engineering').map((course) => course.title),
    ['Prompting'],
  )
  assert.deepEqual(
    filterCoursesByCategory(courses, 'PYTHON').map((course) => course.title),
    ['Python Basics', 'Advanced Python'],
  )
})

test('an empty category restores all courses and category options include backend categories', () => {
  const courses = [
    { category: 'Python' },
    { category: 'Custom Category' },
    { category: 'python' },
  ]

  assert.equal(filterCoursesByCategory(courses, '').length, courses.length)
  assert.deepEqual(getCourseCategoryNames(courses), ['Python', 'Custom Category'])
  assert.equal(normalizeCourseCategory(' Full   Stack Development '), 'full stack development')
})
