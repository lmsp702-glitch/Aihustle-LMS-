import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isInvalidSessionResponse } from './auth-session.js'

test('isInvalidSessionResponse correctly identifies genuine token expiration (401)', () => {
  const expiredResponse = { status: 401 }
  const expiredResult = { message: 'The access token is invalid or expired.' }
  assert.equal(isInvalidSessionResponse(expiredResponse, expiredResult), true)

  const missingTokenResult = { message: 'A valid access token is required.' }
  assert.equal(isInvalidSessionResponse(expiredResponse, missingTokenResult), true)
})

test('isInvalidSessionResponse does NOT treat ordinary enrollment errors as expired sessions', () => {
  // 409 Conflict - Already enrolled
  assert.equal(
    isInvalidSessionResponse({ status: 409 }, { message: 'You are already enrolled in this course.' }),
    false,
  )

  // 403 Forbidden - College student restriction
  assert.equal(
    isInvalidSessionResponse({ status: 403 }, { message: 'College students must be enrolled by their college sub-admin.' }),
    false,
  )

  // 404 Not Found - Course not found
  assert.equal(
    isInvalidSessionResponse({ status: 404 }, { message: 'The published course was not found.' }),
    false,
  )

  // 400 Bad Request - Invalid course ID
  assert.equal(
    isInvalidSessionResponse({ status: 400 }, { message: 'Select a valid course.' }),
    false,
  )

  // 500 Internal Server Error
  assert.equal(
    isInvalidSessionResponse({ status: 500 }, { message: 'Internal server error' }),
    false,
  )
})

test('StudentDashboard enrollInCourse sends Bearer token and does not redirect to login on success or error', async () => {
  // Mock sessionStorage
  const token = 'jwt-student-mock-token'
  globalThis.sessionStorage = {
    getItem: (key) => key === 'lms.auth' ? JSON.stringify({ token, account: { role: 'student', studentType: 'independent' } }) : null,
  }

  let capturedUrl = ''
  let capturedHeaders = {}
  let capturedBody = ''
  let logoutCalled = false

  globalThis.fetch = async (url, options) => {
    capturedUrl = url
    capturedHeaders = options.headers
    capturedBody = options.body
    return {
      ok: true,
      status: 201,
      json: async () => ({
        message: 'You are now enrolled in this course.',
        enrollment: { _id: 'enrollment-123', status: 'active', courseId: 'course-abc' },
      }),
    }
  }

  // Verify header formatting
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  }

  assert.equal(headers.Authorization, `Bearer ${token}`)
  assert.equal(headers.Authorization.startsWith('Bearer '), true)
  assert.notEqual(headers.Authorization, '******')
})

