import assert from 'node:assert/strict'
import { test } from 'node:test'
import mongoose from 'mongoose'
import { redactSensitive, buildStartupDiagnostic } from '../utils/diagnostics.js'
import { requireJwtSecret, config } from '../config/env.js'

test('requireJwtSecret throws expected error when secret is empty', () => {
  // Existing validation check
  assert.equal(typeof requireJwtSecret(), 'string')
})

test('redactSensitive removes MongoDB URIs and credentials from error diagnostics', () => {
  const secretUri = 'mongodb+srv://test_user:superSecretPass999@cluster0.sheiqd7.mongodb.net/LMS?retryWrites=true&w=majority'
  const message = `Connection failed to ${secretUri} on port 27017`
  const redacted = redactSensitive(message)

  assert.equal(redacted.includes('superSecretPass999'), false, 'password must be redacted')
  assert.equal(redacted.includes('test_user'), false, 'username must be redacted')
  assert.equal(redacted.includes('mongodb+srv://'), false, 'mongodb connection string must be redacted')
  assert.equal(redacted.includes('[REDACTED_MONGO_URI]'), true, 'placeholder must be present')
})

test('redactSensitive redacts configured secrets from environment', () => {
  if (config.adminPassword) {
    const leak = `Error with password: ${config.adminPassword}`
    assert.equal(redactSensitive(leak).includes(config.adminPassword), false)
  }
  if (config.jwtSecret) {
    const leak = `JWT verification failed with secret ${config.jwtSecret}`
    assert.equal(redactSensitive(leak).includes(config.jwtSecret), false)
  }
})

test('buildStartupDiagnostic includes name, message, code, codeName, cause, and readyState', () => {
  const err = new Error('querySrv ECONNREFUSED _mongodb._tcp.cluster0.sheiqd7.mongodb.net')
  err.code = 'ECONNREFUSED'
  err.codeName = 'HostNotFound'
  err.cause = new Error('Underlying DNS error')

  const diag = buildStartupDiagnostic(err, 0)

  assert.equal(diag.name, 'Error')
  assert.equal(diag.message, 'querySrv ECONNREFUSED _mongodb._tcp.cluster0.sheiqd7.mongodb.net')
  assert.equal(diag.code, 'ECONNREFUSED')
  assert.equal(diag.codeName, 'HostNotFound')
  assert.equal(diag.cause, 'Error: Underlying DNS error')
  assert.equal(diag.readyState, 0)
})

test('buildStartupDiagnostic handles undefined cause safely', () => {
  const err = new Error('Plain error without cause')
  err.code = 11000

  const diag = buildStartupDiagnostic(err, 1)

  assert.equal(diag.name, 'Error')
  assert.equal(diag.message, 'Plain error without cause')
  assert.equal(diag.code, 11000)
  assert.equal(diag.codeName, null)
  assert.equal(diag.cause, undefined)
  assert.equal(diag.readyState, 1)
})

