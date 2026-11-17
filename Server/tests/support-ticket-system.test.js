import assert from 'node:assert/strict'
import { test } from 'node:test'
import express from 'express'
import jwt from 'jsonwebtoken'
import mongoose from 'mongoose'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const resolveClient = (rel) => (fs.existsSync(path.resolve(rel)) ? path.resolve(rel) : path.join(repoRoot, rel))

const [
  { config },
  { Student, Admin },
  { default: SupportTicket, ticketCategories, ticketStatuses, priorities, ticketPriorities },
  { default: supportRouter, computeTicketStats },
  { default: Notification },
] = await Promise.all([
  import('../config/env.js'),
  import('../models/account-models.js'),
  import('../models/SupportTicket.js'),
  import('../routes/support.js'),
  import('../models/Notification.js'),
])

const app = express()
app.use(express.json({ limit: '10mb' }))
app.use('/api/support', supportRouter)

function mockRequest(app, { method = 'GET', url = '/', headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const reqHeaders = Object.fromEntries(
      Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])
    )
    if (body && !reqHeaders['content-type']) {
      reqHeaders['content-type'] = 'application/json'
    }

    const req = {
      method,
      url,
      headers: reqHeaders,
      get(name) {
        return this.headers[name.toLowerCase()]
      },
      header(name) {
        return this.headers[name.toLowerCase()]
      },
      body: body || {},
      _body: Boolean(body),
    }

    const resHeaders = {}
    let statusCode = 200
    let resBody = ''

    const res = {
      statusCode: 200,
      setHeader(k, v) { resHeaders[k.toLowerCase()] = v },
      getHeader(k) { return resHeaders[k.toLowerCase()] },
      status(code) {
        statusCode = code
        this.statusCode = code
        return this
      },
      json(data) {
        resBody = JSON.stringify(data)
        resolve({
          status: statusCode,
          headers: resHeaders,
          json: async () => data,
          text: async () => resBody,
        })
        return this
      },
      send(data) {
        resBody = typeof data === 'string' ? data : JSON.stringify(data)
        resolve({
          status: statusCode,
          headers: resHeaders,
          json: async () => JSON.parse(resBody),
          text: async () => resBody,
        })
        return this
      },
      end(data) {
        if (data) resBody = data.toString()
        resolve({
          status: statusCode,
          headers: resHeaders,
          json: async () => (resBody ? JSON.parse(resBody) : {}),
          text: async () => resBody,
        })
      },
    }

    app(req, res, (err) => {
      if (err) reject(err)
      else resolve({ status: 404, headers: {}, json: async () => ({ message: 'Not Found' }) })
    })
  })
}

// In-memory accounts and tickets for test
const student1Id = new mongoose.Types.ObjectId()
const student2Id = new mongoose.Types.ObjectId()
const adminId = new mongoose.Types.ObjectId()

const student1 = {
  _id: student1Id,
  role: 'student',
  status: 'active',
  isActive: true,
  fullName: 'Alice Student',
  email: 'alice@test.com',
}

const student2 = {
  _id: student2Id,
  role: 'student',
  status: 'active',
  isActive: true,
  fullName: 'Bob Student',
  email: 'bob@test.com',
}

const adminUser = {
  _id: adminId,
  role: 'main_admin',
  status: 'active',
  isActive: true,
  fullName: 'Admin User',
  email: 'admin@test.com',
  permissions: ['*'],
}

// Stub Student.findById and Admin.findById
Student.findById = async (id) => {
  if (String(id) === String(student1Id)) return student1
  if (String(id) === String(student2Id)) return student2
  return null
}

Admin.findById = async (id) => {
  if (String(id) === String(adminId)) return adminUser
  return null
}

const student1Token = jwt.sign(
  { sub: student1Id.toString(), role: 'student', accountCollection: 'students' },
  config.jwtSecret,
  { expiresIn: '1h' },
)
const student2Token = jwt.sign(
  { sub: student2Id.toString(), role: 'student', accountCollection: 'students' },
  config.jwtSecret,
  { expiresIn: '1h' },
)
const adminToken = jwt.sign(
  { sub: adminId.toString(), role: 'main_admin', accountCollection: 'admin' },
  config.jwtSecret,
  { expiresIn: '1h' },
)
const expiredToken = jwt.sign(
  { sub: student1Id.toString(), role: 'student', accountCollection: 'students' },
  config.jwtSecret,
  { expiresIn: -10 },
)

test('Full Support Ticket System Verification', async (t) => {
  // Test 1: Model validation and schema properties
  await t.test('1. SupportTicket schema and constants', () => {
    assert.ok(ticketCategories.includes('Account and Registration'))
    assert.ok(ticketCategories.includes('Login and Security'))
    assert.ok(ticketCategories.includes('Courses and Learning'))
    assert.ok(ticketCategories.includes('Enrollments'))
    assert.ok(ticketCategories.includes('Assignments and Results'))
    assert.ok(ticketCategories.includes('Certificates'))
    assert.ok(ticketCategories.includes('Payments'))
    assert.ok(ticketCategories.includes('Technical Issues'))
    assert.ok(ticketCategories.includes('Other'))

    assert.ok(ticketStatuses.includes('Open'))
    assert.ok(ticketStatuses.includes('In Progress'))
    assert.ok(ticketStatuses.includes('Waiting for Student'))
    assert.ok(ticketStatuses.includes('Resolved'))
    assert.ok(ticketStatuses.includes('Closed'))

    assert.deepEqual(priorities, ['Low', 'Medium', 'High'])
    assert.deepEqual(ticketPriorities, ['Low', 'Medium', 'High'])
  })

  // Test 2: Auth tokens helper
  await t.test('2. Authentication rejection on expired or invalid token', async () => {
    const resNoToken = await mockRequest(app, {
      method: 'GET',
      url: '/api/support/tickets',
    })
    assert.equal(resNoToken.status, 401)

    const resExpired = await mockRequest(app, {
      method: 'GET',
      url: '/api/support/tickets',
      headers: { Authorization: `Bearer ${expiredToken}` },
    })
    assert.equal(resExpired.status, 401)
    const dataExpired = await resExpired.json()
    assert.match(dataExpired.message, /invalid or expired/i)
  })

  // Test 3: Ticket creation validation
  await t.test('3. Ticket creation input validation', async () => {
    // Missing subject
    const resNoSubject = await mockRequest(app, {
      method: 'POST',
      url: '/api/support/tickets',
      headers: { Authorization: `Bearer ${student1Token}` },
      body: {
        category: 'Courses and Learning',
        priority: 'Medium',
        description: 'This is a detailed description of an issue with course videos.',
      },
    })
    assert.equal(resNoSubject.status, 400)
    assert.match((await resNoSubject.json()).message, /subject/i)

    // Invalid category
    const resBadCategory = await mockRequest(app, {
      method: 'POST',
      url: '/api/support/tickets',
      headers: { Authorization: `Bearer ${student1Token}` },
      body: {
        subject: 'Cannot access video',
        category: 'InvalidCategory123',
        priority: 'Medium',
        description: 'This is a detailed description of an issue with course videos.',
      },
    })
    assert.equal(resBadCategory.status, 400)
    assert.match((await resBadCategory.json()).message, /category/i)

    // Description too short (< 10 chars)
    const resShortDesc = await mockRequest(app, {
      method: 'POST',
      url: '/api/support/tickets',
      headers: { Authorization: `Bearer ${student1Token}` },
      body: {
        subject: 'Cannot access video',
        category: 'Courses and Learning',
        priority: 'Medium',
        description: 'Too short',
      },
    })
    assert.equal(resShortDesc.status, 400)
    assert.match((await resShortDesc.json()).message, /description/i)
  })

  // Test 4: Compute ticket stats calculation helper
  await t.test('4. Compute ticket stats calculation helper exists', () => {
    assert.equal(typeof computeTicketStats, 'function')
  })

  // Test 5: UI component verification in Student and Admin dashboards
  await t.test('5. UI component verification in Student and Admin dashboards', () => {
    const supportCenterJsx = fs.readFileSync(resolveClient('client/src/SupportCenter.jsx'), 'utf8')
    const supportCenterCss = fs.readFileSync(resolveClient('client/src/SupportCenter.css'), 'utf8')
    const adminSupportJsx = fs.readFileSync(resolveClient('client/src/AdminSupport.jsx'), 'utf8')
    const adminSupportCss = fs.readFileSync(resolveClient('client/src/AdminSupport.css'), 'utf8')
    const adminDashboardJsx = fs.readFileSync(resolveClient('client/src/AdminDashboard.jsx'), 'utf8')

    // Student SupportCenter page requirements
    assert.ok(supportCenterJsx.includes('support-stats-grid'), 'Student page includes summary stats grid')
    assert.ok(supportCenterJsx.includes('Total Requests'), 'Summary card: Total Requests')
    assert.ok(supportCenterJsx.includes('Open Requests'), 'Summary card: Open Requests')
    assert.ok(supportCenterJsx.includes('In Progress'), 'Summary card: In Progress')
    assert.ok(supportCenterJsx.includes('Resolved'), 'Summary card: Resolved')
    assert.ok(supportCenterJsx.includes('Create Support Request'), 'Prominent Create Support Request button')
    assert.ok(supportCenterJsx.includes('support-search-input'), 'Live search input is present')
    assert.ok(supportCenterJsx.includes('support-select-filter'), 'Category & Status dropdown filters present')
    assert.ok(supportCenterJsx.includes('support-messages-stream'), 'Conversation message stream is present')
    assert.ok(supportCenterJsx.includes('support-ticket-closed-banner'), 'Resolved/Closed banner preventing replies is present')
    assert.ok(supportCenterJsx.includes('isSessionExpired'), 'Session expiration detection is present')

    // CSS requirements
    assert.ok(supportCenterCss.includes('.support-stats-grid'), 'CSS has .support-stats-grid')
    assert.ok(supportCenterCss.includes('.support-stat-card'), 'CSS has .support-stat-card')
    assert.ok(supportCenterCss.includes('.support-create-box'), 'CSS has .support-create-box')
    assert.ok(supportCenterCss.includes('.support-ticket-card'), 'CSS has .support-ticket-card')
    assert.ok(supportCenterCss.includes('.support-priority-tag'), 'CSS has .support-priority-tag')
    assert.ok(supportCenterCss.includes(':root[data-theme=\'dark\'] .support-stat-card'), 'Dark theme overrides for stat cards')

    // Admin Support requirements
    assert.ok(adminSupportJsx.includes('support-stats-grid'), 'Admin page includes summary stats grid')
    assert.ok(adminSupportJsx.includes('Waiting for Student'), 'Admin handles Waiting for Student')
    assert.ok(adminSupportJsx.includes('admin-support__quick-actions-bar'), 'Admin includes quick status action buttons')
    assert.ok(adminSupportJsx.includes('Mark as Resolved'), 'Admin includes Mark as Resolved action')
    assert.ok(adminSupportJsx.includes('isSessionExpired'), 'Admin handles session expiration')

    // Admin Dashboard badge requirement
    assert.ok(adminDashboardJsx.includes('pendingSupportTickets'), 'Admin dashboard displays pendingSupportTickets count')
  })
})
