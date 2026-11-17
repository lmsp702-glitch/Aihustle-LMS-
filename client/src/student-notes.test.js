import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  formatTimestamp,
  parseTimestamp,
  stripHtmlTags,
  sanitizeRichHtml,
  filterAndSortNotes,
  calculateNotesSummary,
} from './student-notes-utils.js'

test('Student Notes Client Logic Suite', async (t) => {
  await t.test('formatTimestamp formats seconds accurately', () => {
    assert.equal(formatTimestamp(0), '00:00')
    assert.equal(formatTimestamp(65), '01:05')
    assert.equal(formatTimestamp(3599), '59:59')
    assert.equal(formatTimestamp(3665), '1:01:05')
    assert.equal(formatTimestamp(null), '')
    assert.equal(formatTimestamp(undefined), '')
    assert.equal(formatTimestamp(-10), '')
    assert.equal(formatTimestamp(NaN), '')
  })

  await t.test('parseTimestamp parses mm:ss and hh:mm:ss into total seconds', () => {
    assert.equal(parseTimestamp('00:00'), 0)
    assert.equal(parseTimestamp('01:05'), 65)
    assert.equal(parseTimestamp('10:30'), 630)
    assert.equal(parseTimestamp('1:01:05'), 3665)
    assert.equal(parseTimestamp('   02:45   '), 165)
    assert.equal(parseTimestamp(''), null)
    assert.equal(parseTimestamp('invalid:time'), null)
    assert.equal(parseTimestamp('abc'), null)
  })

  await t.test('stripHtmlTags strips HTML tags and normalizes spaces for previews', () => {
    const html = '<p>Hello <b>World</b>!</p><br/><ul><li>Point 1</li><li>Point 2</li></ul>'
    const stripped = stripHtmlTags(html)
    assert.equal(stripped, 'Hello World! Point 1 Point 2')
    assert.equal(stripHtmlTags(''), '')
  })

  await t.test('sanitizeRichHtml neutralizes script, iframe, and inline event handlers', () => {
    const malicious = '<p>Good text</p><script>alert("hacked")</script><iframe src="evil.com"></iframe><img src="x" onerror="steal()" />'
    const sanitized = sanitizeRichHtml(malicious)
    assert.ok(!sanitized.includes('<script>'))
    assert.ok(!sanitized.includes('<iframe>'))
    assert.ok(!sanitized.includes('onerror='))
    assert.ok(sanitized.includes('<p>Good text</p>'))
  })

  const sampleNotes = [
    {
      _id: 'n1',
      title: 'Neural Networks Architecture',
      content: '<p>Backpropagation and gradient descent</p>',
      lessonId: 'l1',
      lessonTitle: 'Intro to Deep Learning',
      videoTimestamp: 120,
      isPinned: false,
      createdAt: '2026-11-10T10:00:00Z',
      updatedAt: '2026-11-10T10:00:00Z',
    },
    {
      _id: 'n2',
      title: 'Convolutional Kernels',
      content: '<p>Feature maps and pooling layers</p>',
      lessonId: 'l2',
      lessonTitle: 'CNN Foundations',
      videoTimestamp: 250,
      isPinned: true, // Pinned!
      createdAt: '2026-11-12T10:00:00Z',
      updatedAt: '2026-11-14T10:00:00Z',
    },
    {
      _id: 'n3',
      title: 'Transformer Attention',
      content: '<p>Self-attention mechanism and query-key-value vectors</p>',
      lessonId: 'l1',
      lessonTitle: 'Intro to Deep Learning',
      videoTimestamp: 300,
      isPinned: false,
      createdAt: '2026-11-15T10:00:00Z',
      updatedAt: '2026-11-15T10:00:00Z',
    },
  ]

  await t.test('calculateNotesSummary returns accurate metrics', () => {
    const summary = calculateNotesSummary(sampleNotes)
    assert.equal(summary.totalCount, 3)
    assert.equal(summary.lessonsCoveredCount, 2) // l1 and l2
    assert.equal(summary.pinnedCount, 1)
  })

  await t.test('filterAndSortNotes places pinned notes first regardless of sort mode', () => {
    const newest = filterAndSortNotes(sampleNotes, { sort: 'newest' })
    // n2 is pinned, so it must be first even though n3 was created later!
    assert.equal(newest[0]._id, 'n2')
    assert.equal(newest[1]._id, 'n3')
    assert.equal(newest[2]._id, 'n1')

    const oldest = filterAndSortNotes(sampleNotes, { sort: 'oldest' })
    // n2 pinned is still first!
    assert.equal(oldest[0]._id, 'n2')
    assert.equal(oldest[1]._id, 'n1')
    assert.equal(oldest[2]._id, 'n3')
  })

  await t.test('filterAndSortNotes filters by search query and lessonId', () => {
    const searchResult = filterAndSortNotes(sampleNotes, { search: 'Pooling' })
    assert.equal(searchResult.length, 1)
    assert.equal(searchResult[0]._id, 'n2')

    const lessonResult = filterAndSortNotes(sampleNotes, { lessonId: 'l1' })
    assert.equal(lessonResult.length, 2)
    assert.ok(lessonResult.every((n) => n.lessonId === 'l1'))

    const pinnedOnly = filterAndSortNotes(sampleNotes, { pinnedOnly: true })
    assert.equal(pinnedOnly.length, 1)
    assert.equal(pinnedOnly[0]._id, 'n2')
  })
})
