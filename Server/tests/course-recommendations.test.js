import assert from 'node:assert/strict'
import { test } from 'node:test'
import { normalizeCourseDetails } from '../utils/course-validation.js'
import { generateCourseRecommendations } from '../utils/course-recommendations.js'

function course(_id, details = {}) {
  return {
    _id,
    title: 'Course',
    category: 'Other',
    difficulty: 'beginner',
    status: 'published',
    ...details,
  }
}

const fiveCourses = [
  course('uiux-id', {
    title: 'UI/UX Design',
    category: 'Design',
    skills: ['User research'],
  }),
  course('web-id', {
    title: 'Web Development',
    category: 'Development',
  }),
  course('python-id', {
    title: 'Python Programming',
    category: 'Programming',
  }),
  course('genai-id', {
    title: 'Generative AI',
    category: 'Artificial Intelligence',
    thumbnailUrl: 'https://example.invalid/generative-ai.png',
    estimatedDurationMinutes: 90,
  }),
  course('marketing-id', {
    title: 'Digital Marketing',
    category: 'Marketing',
  }),
]

function recommend(completedIds) {
  const completedCourses = fiveCourses.filter(({ _id }) => completedIds.includes(_id))
  return generateCourseRecommendations({
    completedCourses,
    enrolledCourseIds: completedIds,
    catalog: fiveCourses,
  })
}

test('all ten configured course pairings produce only their specified next courses', () => {
  const pairings = [
    ['UI/UX Design', 'Web Development'],
    ['UI/UX Design', 'Digital Marketing'],
    ['Web Development', 'Python Programming'],
    ['Web Development', 'Generative AI'],
    ['Python Programming', 'Generative AI'],
    ['Python Programming', 'Web Development'],
    ['Generative AI', 'Python Programming'],
    ['Generative AI', 'Digital Marketing'],
    ['Digital Marketing', 'UI/UX Design'],
    ['Digital Marketing', 'Generative AI'],
  ]

  for (const [sourceTitle, targetTitle] of pairings) {
    const source = course(`source-${sourceTitle}`, { title: sourceTitle })
    const target = course(`target-${targetTitle}`, { title: targetTitle })
    const recommendations = generateCourseRecommendations({
      completedCourses: [source],
      enrolledCourseIds: [source._id],
      catalog: [source, target],
    })

    assert.deepEqual(recommendations.map(({ title }) => title), [targetTitle])
    assert.deepEqual(recommendations[0].basedOnCourses.map(({ title }) => title), [sourceTitle])
  }
})

test('UI/UX Design recommends Web Development and Digital Marketing', () => {
  const recommendations = recommend(['uiux-id'])

  assert.deepEqual(recommendations.map(({ title }) => title), ['Digital Marketing', 'Web Development'])
  assert.ok(recommendations.every(({ basedOnCourses }) => basedOnCourses[0].title === 'UI/UX Design'))
  assert.match(recommendations.find(({ title }) => title === 'Web Development').why, /UI\/UX Design/)
})

test('Python Programming recommends Generative AI and Web Development', () => {
  const recommendations = recommend(['python-id'])
  const generativeAi = recommendations.find(({ title }) => title === 'Generative AI')

  assert.deepEqual(recommendations.map(({ title }) => title), ['Generative AI', 'Web Development'])
  assert.deepEqual(generativeAi.skills, [
    'AI application development',
    'Generative AI integration',
    'AI-powered automation',
    'Working with AI models',
  ])
  assert.deepEqual(generativeAi.combinationBenefits, [
    'Move from programming fundamentals to AI application development.',
    'Build practical AI-powered projects.',
    'Develop skills relevant to emerging technology roles.',
  ])
  assert.match(generativeAi.why, /intelligent applications/)
  assert.equal(generativeAi.thumbnailUrl, 'https://example.invalid/generative-ai.png')
  assert.equal(generativeAi.estimatedDurationMinutes, 90)
})

test('recommendations aggregate every completed course for shared next steps', () => {
  const recommendations = recommend(['web-id', 'python-id'])
  const generativeAi = recommendations.find(({ title }) => title === 'Generative AI')

  assert.deepEqual(recommendations.map(({ title }) => title), ['Generative AI'])
  assert.deepEqual(
    generativeAi.basedOnCourses.map(({ title }) => title),
    ['Web Development', 'Python Programming'],
  )
  assert.equal(generativeAi.basedOnCourses.length, 2)
})

test('Generative AI and Digital Marketing completions produce distinct next steps', () => {
  const recommendations = recommend(['genai-id', 'marketing-id'])

  assert.deepEqual(recommendations.map(({ title }) => title), ['Python Programming', 'UI/UX Design'])
  assert.ok(recommendations.every(({ basedOnCourses }) => basedOnCourses.length === 1))
})

test('students without completions receive only published beginner-friendly suggestions', () => {
  const recommendations = generateCourseRecommendations({
    catalog: [
      ...fiveCourses,
      course('intermediate-id', { title: 'Intermediate Course', difficulty: 'intermediate' }),
      course('draft-id', { title: 'Draft Course', status: 'draft' }),
      course('deleted-id', { title: 'Deleted Course', isDeleted: true }),
      course('unavailable-id', { title: 'Unavailable Course', available: false }),
    ],
  })

  assert.deepEqual(
    recommendations.map(({ title }) => title),
    ['Digital Marketing', 'Generative AI', 'Python Programming', 'UI/UX Design', 'Web Development'],
  )
  assert.ok(recommendations.every(({ basedOnCourses, why }) => !basedOnCourses.length && /beginner-friendly/.test(why)))
})

test('completing all five courses leaves no duplicate or already-completed recommendations', () => {
  assert.deepEqual(recommend(fiveCourses.map(({ _id }) => _id)), [])
})

test('available recommendations exclude enrolled courses and prefer actual course metadata', () => {
  const completed = course('python-id', { title: 'Python Programming' })
  const target = course('genai-id', {
    title: 'Generative AI',
    skills: ['AI application building'],
    practicalBenefits: ['Develop an AI-powered project.'],
  })
  const recommendations = generateCourseRecommendations({
    completedCourses: [completed],
    enrolledCourseIds: ['python-id'],
    catalog: [target, { ...target }],
  })

  assert.equal(recommendations.length, 1)
  assert.deepEqual(recommendations[0].skills, ['AI application building'])
  assert.deepEqual(recommendations[0].benefits, ['Develop an AI-powered project.'])
})

test('course validation preserves optional recommendation metadata', () => {
  const result = normalizeCourseDetails({
    title: 'Personalized Learning Course',
    description: 'A course description.',
    tags: ['data science', 'python'],
    skills: ['Data analysis'],
    practicalBenefits: ['Build a data project.'],
  })

  assert.equal(result.error, undefined)
  assert.deepEqual(result.value.tags, ['data science', 'python'])
  assert.deepEqual(result.value.skills, ['Data analysis'])
  assert.deepEqual(result.value.practicalBenefits, ['Build a data project.'])
})
