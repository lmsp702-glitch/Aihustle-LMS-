import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  formatFileSize,
  validateResourceUploadFile,
  filterResources,
  getSafeResourceFilename,
} from './admin-resources-utils.js'

test('Admin Resources Client Logic Suite', async (t) => {
  await t.test('1. formatFileSize handles byte magnitudes accurately', () => {
    assert.equal(formatFileSize(0), '0 B')
    assert.equal(formatFileSize(null), '0 B')
    assert.equal(formatFileSize(undefined), '0 B')
    assert.equal(formatFileSize(500), '500 B')
    assert.equal(formatFileSize(1024), '1 KB')
    assert.equal(formatFileSize(2048), '2 KB')
    assert.equal(formatFileSize(1024 * 1024), '1.0 MB')
    assert.equal(formatFileSize(1.5 * 1024 * 1024), '1.5 MB')
    assert.equal(formatFileSize(1024 * 1024 * 1024), '1.0 GB')
  })

  await t.test('2. validateResourceUploadFile enforces PDF format & size limit', () => {
    // Missing file
    const resNoFile = validateResourceUploadFile(null)
    assert.equal(resNoFile.valid, false)
    assert.match(resNoFile.error, /please select a pdf/i)

    // Non-PDF extension
    const resDocx = validateResourceUploadFile({
      name: 'notes.docx',
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      size: 5000,
    })
    assert.equal(resDocx.valid, false)
    assert.match(resDocx.error, /only pdf documents/i)

    // Valid PDF within size limit
    const resValid = validateResourceUploadFile({
      name: 'Python-Cheatsheet.pdf',
      type: 'application/pdf',
      size: 2 * 1024 * 1024,
    })
    assert.equal(resValid.valid, true)
    assert.equal(resValid.error, null)

    // PDF exceeding 50 MB
    const resTooLarge = validateResourceUploadFile({
      name: 'Huge-Textbook.pdf',
      type: 'application/pdf',
      size: 55 * 1024 * 1024,
    })
    assert.equal(resTooLarge.valid, false)
    assert.match(resTooLarge.error, /exceeds the maximum allowed upload limit/i)
  })

  await t.test('3. filterResources filters by courseId and keyword correctly', () => {
    const mockResources = [
      {
        _id: 'r1',
        title: 'Python Syntax & Data Structures Cheat Sheet',
        description: 'Comprehensive quick guide to dictionaries and sets.',
        originalFileName: 'python_structures.pdf',
        courseId: { _id: 'c1', title: 'Python for Beginners' },
      },
      {
        _id: 'r2',
        title: 'Docker Commands & Containers Guide',
        description: 'Common docker run and build commands.',
        originalFileName: 'docker_guide.pdf',
        courseId: { _id: 'c2', title: 'DevOps & Containers' },
      },
      {
        _id: 'r3',
        title: 'Machine Learning Algorithms Reference',
        description: 'Formulas and architectures for regression & classification.',
        originalFileName: 'ml_cheatsheet.pdf',
        courseId: { _id: 'c1', title: 'Python for Beginners' },
      },
    ]

    // No filters
    assert.equal(filterResources(mockResources).length, 3)

    // Filter by course c1
    const course1Filtered = filterResources(mockResources, { selectedCourseId: 'c1' })
    assert.equal(course1Filtered.length, 2)
    assert.ok(course1Filtered.every((r) => r.courseId._id === 'c1'))

    // Filter by course c2
    const course2Filtered = filterResources(mockResources, { selectedCourseId: 'c2' })
    assert.equal(course2Filtered.length, 1)
    assert.equal(course2Filtered[0].title, 'Docker Commands & Containers Guide')

    // Search keyword 'docker'
    const searchDocker = filterResources(mockResources, { searchTerm: 'docker' })
    assert.equal(searchDocker.length, 1)
    assert.equal(searchDocker[0]._id, 'r2')

    // Search keyword 'dictionaries' (in description)
    const searchDesc = filterResources(mockResources, { searchTerm: 'dictionaries' })
    assert.equal(searchDesc.length, 1)
    assert.equal(searchDesc[0]._id, 'r1')

    // Search keyword 'ml_cheatsheet' (in originalFileName)
    const searchFilename = filterResources(mockResources, { searchTerm: 'ml_cheatsheet' })
    assert.equal(searchFilename.length, 1)
    assert.equal(searchFilename[0]._id, 'r3')

    // Combined filter: course c1 AND searchTerm 'formulas'
    const combined = filterResources(mockResources, {
      selectedCourseId: 'c1',
      searchTerm: 'formulas',
    })
    assert.equal(combined.length, 1)
    assert.equal(combined[0]._id, 'r3')

    // Combined filter with no matches
    const noMatch = filterResources(mockResources, {
      selectedCourseId: 'c2',
      searchTerm: 'python',
    })
    assert.equal(noMatch.length, 0)
  })

  await t.test('4. getSafeResourceFilename sanitizes and ensures .pdf extension', () => {
    assert.equal(getSafeResourceFilename(null), 'resource.pdf')
    assert.equal(getSafeResourceFilename({ originalFileName: 'notes.pdf' }), 'notes.pdf')
    assert.equal(getSafeResourceFilename({ title: 'My Cheat Sheet' }), 'My Cheat Sheet.pdf')
    assert.equal(getSafeResourceFilename({ originalFileName: 'invalid/file:name?.pdf' }), 'invalid_file_name_.pdf')
  })
})
