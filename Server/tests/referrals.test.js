import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import express from 'express'
import jwt from 'jsonwebtoken'
import mongoose from 'mongoose'

process.env.JWT_SECRET = 'test-only-referral-secret'

const [
  { default: authRouter, createReferralRedemptionFilter },
  { default: referralsRouter, maxLifetimeReferralCodes, maxActiveReferralCodes, dailyGenerationLimit, getUtcDayStart },
  { default: ReferralCode },
  { default: ReferralCodeDailyLimit },
  { default: Notification },
  { Student, CollegeStudent, Admin, CollegeAdmin },
  { default: AccountIdentity },
  { default: RegistrationEmailVerification },
  { createRegistrationEmailVerificationToken },
] = await Promise.all([
  import('../routes/auth.js'),
  import('../routes/referrals.js'),
  import('../models/ReferralCode.js'),
  import('../models/ReferralCodeDailyLimit.js'),
  import('../models/Notification.js'),
  import('../models/account-models.js'),
  import('../models/AccountIdentity.js'),
  import('../models/RegistrationEmailVerification.js'),
  import('../utils/registration-email-verification.js'),
])

const app = express()
app.use(express.json())
app.use('/api/auth', authRouter)
app.use('/api/referrals', referralsRouter)

function mockRequest(expressApp, { method = 'GET', url = '/', headers = {}, body = null }) {
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

    expressApp(req, res, (err) => {
      if (err) {
        if (err.statusCode || err.status) {
          const code = err.statusCode || err.status
          return resolve({
            status: code,
            headers: resHeaders,
            json: async () => ({ message: err.message }),
            text: async () => JSON.stringify({ message: err.message }),
          })
        }
        reject(err)
      } else {
        resolve({
          status: 404,
          headers: {},
          json: async () => ({ message: 'Not Found' }),
          text: async () => 'Not Found',
        })
      }
    })
  })
}

const originalDate = globalThis.Date
let currentTime = originalDate.parse('2026-11-08T23:59:59.000Z')
class ControlledDate extends originalDate {
  constructor(...args) {
    super(...(args.length ? args : [currentTime]))
  }

  static now() {
    return currentTime
  }
}

const ownerId = new mongoose.Types.ObjectId()
const secondOwnerId = new mongoose.Types.ObjectId()
const thirdOwnerId = new mongoose.Types.ObjectId()
const collegeStudentId = new mongoose.Types.ObjectId()
const students = new Map([
  [String(ownerId), {
    _id: ownerId,
    role: 'student',
    studentType: 'independent',
    status: 'active',
    isActive: true,
    approvalStatus: 'approved',
  }],
  [String(secondOwnerId), {
    _id: secondOwnerId,
    role: 'student',
    studentType: 'independent',
    status: 'active',
    isActive: true,
    approvalStatus: 'approved',
  }],
  [String(thirdOwnerId), {
    _id: thirdOwnerId,
    role: 'student',
    studentType: 'independent',
    status: 'active',
    isActive: true,
    approvalStatus: 'approved',
  }],
])
const collegeStudents = new Map([
  [String(collegeStudentId), {
    _id: collegeStudentId,
    role: 'student',
    studentType: 'college',
    status: 'active',
    isActive: true,
  }],
])
const referralCodes = []
const dailyLimits = []
const savedAccounts = []
const savedIdentities = []

function valueMatches(actual, expected) {
  if (expected && typeof expected === 'object' && !(expected instanceof Date) && !mongoose.isValidObjectId(expected)) {
    if ('$gt' in expected && !(actual > expected.$gt)) return false
    if ('$gte' in expected && !(actual >= expected.$gte)) return false
    if ('$lt' in expected && !(actual < expected.$lt)) return false
    if ('$lte' in expected && !(actual <= expected.$lte)) return false
    if ('$ne' in expected && String(actual) === String(expected.$ne)) return false
    if ('$in' in expected && !expected.$in.some((item) => String(item) === String(actual))) return false
    if ('$regex' in expected) {
      const reg = expected.$regex instanceof RegExp ? expected.$regex : new RegExp(expected.$regex)
      if (!reg.test(String(actual))) return false
    }
    return true
  }
  if (expected === null) return actual == null
  if (actual instanceof originalDate && expected instanceof originalDate) {
    return actual.getTime() === expected.getTime()
  }
  return String(actual) === String(expected)
}

function matches(document, filter) {
  return Object.entries(filter).every(([key, expected]) => valueMatches(document[key], expected))
}

function queryResult(getValue) {
  let sortSpec = null
  const query = {
    select() { return this },
    lean() { return this },
    session() { return this },
    sort(value) { sortSpec = value; return this },
    then(resolve, reject) {
      let value
      try {
        value = getValue()
        if (sortSpec && Array.isArray(value)) {
          const [[field, direction]] = Object.entries(sortSpec)
          value.sort((left, right) => (left[field] - right[field]) * direction)
        }
      } catch (error) {
        return Promise.reject(error).then(resolve, reject)
      }
      return Promise.resolve(value).then(resolve, reject)
    },
  }
  return query
}

const originals = []
function stub(target, name, implementation) {
  const original = target[name]
  target[name] = implementation
  originals.push(() => { target[name] = original })
}

const originalDb = mongoose.connection.db
mongoose.connection.db = {
  collection: () => ({ find: () => ({ toArray: async () => [] }) }),
}

stub(Student, 'findById', async (id) => students.get(String(id)) || null)
stub(Student, 'find', (filter) => queryResult(() => [...students.values()].filter((student) => matches(student, filter))))
stub(CollegeStudent, 'findById', async (id) => collegeStudents.get(String(id)) || null)
stub(ReferralCode, 'findOne', (filter) => queryResult(() => referralCodes.find((code) => matches(code, filter)) || null))
stub(ReferralCode, 'find', (filter) => queryResult(() => referralCodes.filter((code) => matches(code, filter))))
stub(ReferralCode, 'countDocuments', (filter) => queryResult(() => referralCodes.filter((code) => matches(code, filter)).length))
stub(ReferralCode, 'create', async (documents) => {
  const list = Array.isArray(documents) ? documents : [documents]
  return list.map((document) => {
    const saved = { _id: new mongoose.Types.ObjectId(), usedBy: null, usedAt: null, registrationStatus: null, ...document }
    saved.toObject = () => ({ ...saved, toObject: undefined })
    referralCodes.push(saved)
    return saved
  })
})
stub(ReferralCode, 'findOneAndUpdate', (filter, update) => queryResult(() => {
  const document = referralCodes.find((code) => matches(code, filter))
  if (!document) return null
  Object.assign(document, update.$set || {})
  return document
}))
stub(ReferralCode, 'updateMany', async (filter, update) => {
  const documents = referralCodes.filter((code) => matches(code, filter))
  for (const document of documents) Object.assign(document, update.$set || {})
  return { modifiedCount: documents.length }
})
stub(ReferralCode, 'updateOne', async (filter, update) => {
  const document = referralCodes.find((code) => matches(code, filter))
  if (!document) return { matchedCount: 0 }
  Object.assign(document, update.$set || {})
  return { matchedCount: 1 }
})
stub(ReferralCodeDailyLimit, 'updateOne', async (filter, update) => {
  let document = dailyLimits.find((limit) => matches(limit, filter))
  if (!document && update.$setOnInsert) {
    document = { ...update.$setOnInsert }
    dailyLimits.push(document)
  }
  return { matchedCount: document ? 1 : 0 }
})
stub(ReferralCodeDailyLimit, 'findOneAndUpdate', (filter, update) => queryResult(() => {
  const document = dailyLimits.find((limit) => matches(limit, filter))
  if (!document) return null
  for (const [field, amount] of Object.entries(update.$inc || {})) document[field] += amount
  return document
}))
stub(AccountIdentity, 'find', () => queryResult(() => []))
stub(AccountIdentity, 'findOne', () => queryResult(() => null))
stub(AccountIdentity, 'create', async (documents) => {
  savedIdentities.push(...documents)
  return documents
})
stub(Student, 'findOne', () => queryResult(() => null))
stub(Student, 'create', async (documents) => {
  savedAccounts.push(...documents)
  for (const account of documents) students.set(String(account._id), account)
  return documents
})
stub(Student, 'updateOne', async (filter, update) => {
  const student = [...students.values()].find((s) => matches(s, filter))
  if (!student) return { matchedCount: 0 }
  Object.assign(student, update.$set || {})
  return { matchedCount: 1 }
})
stub(Notification, 'create', async (documents) => documents)
stub(Admin, 'findOne', () => queryResult(() => null))
stub(CollegeAdmin, 'findOne', () => queryResult(() => null))
stub(CollegeStudent, 'findOne', () => queryResult(() => null))
stub(mongoose, 'startSession', async () => ({
  withTransaction: async (callback) => callback(),
  endSession: async () => {},
}))

stub(RegistrationEmailVerification, 'findOneAndUpdate', async () => ({
  _id: new mongoose.Types.ObjectId(),
}))

function tokenFor(id, role = 'student', accountCollection = 'students') {
  return jwt.sign({ role, accountCollection }, process.env.JWT_SECRET, { subject: String(id), expiresIn: '20d' })
}

async function request(path, { method, token, body } = {}) {
  const fullUrl = path.startsWith('/api') ? path : `/api${path}`
  if (path === '/auth/register' && body?.email && !body.emailVerificationToken) {
    body = {
      ...body,
      emailVerificationToken: createRegistrationEmailVerificationToken({
        _id: new mongoose.Types.ObjectId(),
        email: body.email.trim().toLowerCase(),
      }),
    }
  }
  const response = await mockRequest(app, {
    method: method || (body ? 'POST' : 'GET'),
    url: fullUrl,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body,
  })
  return { response, result: await response.json() }
}

after(async () => {
  globalThis.Date = originalDate
  mongoose.connection.db = originalDb
  for (const restore of originals.reverse()) restore()
})

test('referral lifetime generation limit (20 max), attribution tracking, redemption, and privacy', async () => {
  globalThis.Date = ControlledDate
  const ownerToken = tokenFor(ownerId)
  const secondOwnerToken = tokenFor(secondOwnerId)
  const thirdOwnerToken = tokenFor(thirdOwnerId)
  const collegeToken = tokenFor(collegeStudentId, 'student', 'clg_students')

  assert.equal(ReferralCode.collection.name, 'referralCodes')
  assert.ok(ReferralCode.schema.indexes().some(([keys, options]) => keys.code === 1 && options.unique))
  assert.ok(ReferralCode.schema.indexes().some(([keys]) => keys.generatedBy === 1 && keys.createdAt === -1))
  assert.ok(ReferralCode.schema.indexes().some(([keys]) => keys.expiresAt === 1))
  assert.ok(ReferralCode.schema.indexes().some(([keys, options]) =>
    keys.generatedBy === 1 && keys.requestId === 1 && options.unique,
  ))
  assert.ok(!ReferralCode.schema.indexes().some(([, options]) => options.expireAfterSeconds !== undefined))

  // 1. Lifetime Limit assertions: exactly 20 lifetime codes max
  assert.equal(maxLifetimeReferralCodes, 20)
  assert.equal(maxActiveReferralCodes, 20)
  assert.equal(dailyGenerationLimit, 20)
  assert.equal(
    getUtcDayStart(new originalDate('2026-11-08T23:59:59.999Z')).toISOString(),
    '2026-11-08T00:00:00.000Z',
  )

  // 2. Test generating 1 code when none exist
  const gen1 = await request('/referrals/generate', {
    token: ownerToken,
    body: { quantity: 1, requestId: 'owner-req-qty-1' },
  })
  assert.equal(gen1.response.status, 201)
  assert.equal(gen1.result.count, 1)
  assert.equal(gen1.result.totalGenerated, 1)
  assert.equal(gen1.result.remainingSlots, 19)
  assert.equal(gen1.result.remainingGenerations, 19)
  assert.equal(gen1.result.maxLifetimeLimit, 20)
  assert.ok(/^LMS-[A-F0-9]{32}$/.test(gen1.result.code.code))
  assert.equal(
    new originalDate(gen1.result.code.expiresAt).getTime() - new originalDate(gen1.result.code.createdAt).getTime(),
    15 * 24 * 60 * 60 * 1000,
  )

  // Test idempotency on single code generation
  const gen1Repeat = await request('/referrals/generate', {
    token: ownerToken,
    body: { quantity: 1, requestId: 'owner-req-qty-1' },
  })
  assert.equal(gen1Repeat.response.status, 200)
  assert.equal(gen1Repeat.result.repeated, true)
  assert.equal(gen1Repeat.result.code.code, gen1.result.code.code)
  assert.equal(gen1Repeat.result.totalGenerated, 1)
  assert.equal(referralCodes.filter((c) => String(c.generatedBy) === String(ownerId)).length, 1)

  // 3. Test generating 2 codes when 1 already exists
  const gen2 = await request('/referrals/generate', {
    token: ownerToken,
    body: { quantity: 2, requestId: 'owner-req-qty-2' },
  })
  assert.equal(gen2.response.status, 201)
  assert.equal(gen2.result.count, 2)
  assert.equal(gen2.result.totalGenerated, 3)
  assert.equal(gen2.result.remainingSlots, 17)
  assert.equal(referralCodes.filter((c) => String(c.generatedBy) === String(ownerId)).length, 3)

  // 4. Test generating 5 codes when 3 already exist
  const gen5 = await request('/referrals/generate', {
    token: ownerToken,
    body: { quantity: 5, requestId: 'owner-req-qty-5' },
  })
  assert.equal(gen5.response.status, 201)
  assert.equal(gen5.result.count, 5)
  assert.equal(gen5.result.totalGenerated, 8)
  assert.equal(gen5.result.remainingSlots, 12)
  assert.equal(referralCodes.filter((c) => String(c.generatedBy) === String(ownerId)).length, 8)

  // 5. Quantity validation: requesting more than remaining lifetime slots (e.g. 13 when 12 remain)
  const overLimitRequest = await request('/referrals/generate', {
    token: ownerToken,
    body: { quantity: 13 },
  })
  assert.equal(overLimitRequest.response.status, 400)

  // 6. Generate remaining 12 codes to reach exactly 20 lifetime codes
  const gen12 = await request('/referrals/generate', {
    token: ownerToken,
    body: { quantity: 12, requestId: 'owner-req-qty-12' },
  })
  assert.equal(gen12.response.status, 201)
  assert.equal(gen12.result.count, 12)
  assert.equal(gen12.result.totalGenerated, 20)
  assert.equal(gen12.result.remainingSlots, 0)
  assert.equal(gen12.result.remainingGenerations, 0)
  assert.equal(referralCodes.filter((c) => String(c.generatedBy) === String(ownerId)).length, 20)

  // 7. User reaches 20 lifetime codes: attempting a 21st code returns 429
  const maxedOut = await request('/referrals/generate', {
    token: ownerToken,
    body: { quantity: 1 },
  })
  assert.equal(maxedOut.response.status, 429)
  assert.equal(maxedOut.result.message, 'You have reached your lifetime limit of 20 referral codes.')

  // Check stats via GET /referrals/me
  const fullStats = await request('/referrals/me', { token: ownerToken })
  assert.equal(fullStats.response.status, 200)
  assert.equal(fullStats.result.stats.totalGenerated, 20)
  assert.equal(fullStats.result.stats.remainingSlots, 0)
  assert.equal(fullStats.result.stats.remainingGenerations, 0)
  assert.equal(fullStats.result.stats.active, 20)

  // 8. Test second user generating across multiple days (10 today, 10 tomorrow)
  const secondUserDay1 = await request('/referrals/generate', {
    token: secondOwnerToken,
    body: { quantity: 10, requestId: 'second-user-day1' },
  })
  assert.equal(secondUserDay1.response.status, 201)
  assert.equal(secondUserDay1.result.count, 10)
  assert.equal(secondUserDay1.result.remainingSlots, 10)

  // Advance time to next day
  currentTime += 24 * 60 * 60 * 1000
  const secondUserDay2 = await request('/referrals/generate', {
    token: secondOwnerToken,
    body: { quantity: 10, requestId: 'second-user-day2' },
  })
  assert.equal(secondUserDay2.response.status, 201)
  assert.equal(secondUserDay2.result.count, 10)
  assert.equal(secondUserDay2.result.remainingSlots, 0)

  // Second user attempts 21st code across days -> rejected with 429
  const secondUser21st = await request('/referrals/generate', {
    token: secondOwnerToken,
    body: { quantity: 1 },
  })
  assert.equal(secondUser21st.response.status, 429)

  // 9. Test third user generating all 20 codes at once in a single batch
  const thirdUserBatch20 = await request('/referrals/generate', {
    token: thirdOwnerToken,
    body: { quantity: 20, requestId: 'third-user-batch-20' },
  })
  assert.equal(thirdUserBatch20.response.status, 201)
  assert.equal(thirdUserBatch20.result.count, 20)
  assert.equal(thirdUserBatch20.result.codes.length, 20)
  assert.equal(thirdUserBatch20.result.remainingSlots, 0)
  assert.equal(new Set(thirdUserBatch20.result.codes.map((c) => c.code)).size, 20)

  // Third user attempts 21st code -> 429
  const thirdUser21st = await request('/referrals/generate', {
    token: thirdOwnerToken,
    body: { quantity: 1 },
  })
  assert.equal(thirdUser21st.response.status, 429)

  // 10. Access control checks
  const unauthenticated = await request('/referrals/me')
  assert.equal(unauthenticated.response.status, 401)
  const collegeDenied = await request('/referrals/me', { token: collegeToken })
  assert.equal(collegeDenied.response.status, 403)

  // 11. Validate active code
  const codeToRedeem = gen1.result.code.code
  const validation = await request('/referrals/validate', { body: { code: codeToRedeem.toLowerCase() } })
  assert.equal(validation.response.status, 200)
  assert.equal(validation.result.valid, true)

  const ownerRedemptionFilter = createReferralRedemptionFilter(
    codeToRedeem,
    ownerId,
    new ControlledDate(),
  )
  assert.equal(matches(referralCodes.find((code) => code.code === codeToRedeem), ownerRedemptionFilter), false)

  // 12. Redeem code during registration & verify full attribution
  const registration = await request('/auth/register', {
    body: {
      fullName: 'Rahul Sharma',
      email: 'rahul.sharma@example.invalid',
      username: 'rahulsharma',
      password: 'a-strong-password',
      confirmPassword: 'a-strong-password',
      role: 'student',
      accountType: 'independent',
      referralCode: codeToRedeem,
      hearAboutUs: 'Friend / Student Referral',
    },
  })
  assert.equal(registration.response.status, 201)
  const registeredAccountId = registration.result.user.id
  const redeemedDocument = referralCodes.find((code) => code.code === codeToRedeem)
  assert.equal(String(redeemedDocument.usedBy), registeredAccountId)
  assert.equal(redeemedDocument.status, 'used')
  assert.ok(redeemedDocument.usedAt instanceof originalDate)
  assert.equal(redeemedDocument.registrationStatus, 'awaiting_approval')

  // Verify Student document stored the attribution
  const registeredStudent = students.get(registeredAccountId)
  assert.equal(String(registeredStudent.referredBy), String(ownerId))
  assert.equal(registeredStudent.referredByCode, codeToRedeem)

  // Verify referrer's My Referrals displays referred student's name and message
  let history = await request('/referrals/me', { token: ownerToken })
  const usedEntry = history.result.codes.find((entry) => entry.code === codeToRedeem)
  assert.equal(usedEntry.status, 'used')
  assert.equal(usedEntry.referredStudentName, 'Rahul Sharma')
  assert.equal(usedEntry.referralMessage, 'Rahul Sharma joined aiHustle using your referral code.')
  assert.ok(usedEntry.referredStudentRegistrationDate)
  assert.ok(usedEntry.usedAt)
  // Ensure no sensitive data is leaked
  assert.equal('email' in usedEntry, false)
  assert.equal('passwordHash' in usedEntry, false)

  // Cannot validate or reuse already-redeemed code
  const repeatedValidation = await request('/referrals/validate', { body: { code: codeToRedeem } })
  assert.equal(repeatedValidation.response.status, 400)
  const secondRedemption = await request('/auth/register', {
    body: {
      fullName: 'Another Friend',
      email: 'another-friend@example.invalid',
      username: 'another-friend',
      password: 'a-strong-password',
      confirmPassword: 'a-strong-password',
      role: 'student',
      accountType: 'independent',
      referralCode: codeToRedeem,
      hearAboutUs: 'Friend / Student Referral',
    },
  })
  assert.equal(secondRedemption.response.status, 400)

  // 13. LIFETIME LIMIT RULE: Using a code DOES NOT free a slot!
  assert.equal(history.result.stats.totalGenerated, 20)
  assert.equal(history.result.stats.remainingSlots, 0)
  assert.equal(history.result.stats.remainingGenerations, 0)
  assert.equal(history.result.stats.successfullyUsed, 1)

  const attemptAfterUse = await request('/referrals/generate', {
    token: ownerToken,
    body: { quantity: 1, requestId: 'attempt-after-use-001' },
  })
  assert.equal(attemptAfterUse.response.status, 429)
  assert.equal(attemptAfterUse.result.message, 'You have reached your lifetime limit of 20 referral codes.')

  // Check registration status transitions
  registeredStudent.status = 'active'
  registeredStudent.approvalStatus = 'approved'
  registeredStudent.isActive = true
  history = await request('/referrals/me', { token: ownerToken })
  assert.equal(history.result.codes.find((entry) => entry.code === codeToRedeem).registrationStatus, 'approved')

  // Verify referred student (Rahul Sharma) can log in and view My Referrals with clean initial stats
  const referredStudentToken = tokenFor(registeredAccountId)
  const referredStudentHistory = await request('/referrals/me', { token: referredStudentToken })
  assert.equal(referredStudentHistory.response.status, 200)
  assert.equal(referredStudentHistory.result.codes.length, 0)
  assert.equal(referredStudentHistory.result.stats.totalGenerated, 0)
  assert.equal(referredStudentHistory.result.stats.remainingSlots, 20)
  assert.equal(referredStudentHistory.result.stats.remainingGenerations, 20)
  assert.equal(referredStudentHistory.result.stats.active, 0)
  assert.equal(referredStudentHistory.result.stats.successfullyUsed, 0)
  assert.equal(referredStudentHistory.result.stats.expired, 0)
  registeredStudent.status = 'rejected'
  registeredStudent.approvalStatus = 'rejected'
  history = await request('/referrals/me', { token: ownerToken })
  assert.equal(history.result.codes.find((entry) => entry.code === codeToRedeem).registrationStatus, 'rejected')

  // 14. LIFETIME LIMIT RULE: Expiring codes DOES NOT free a slot!
  // Advance time by 16 days so unused codes expire
  currentTime += 16 * 24 * 60 * 60 * 1000
  history = await request('/referrals/me', { token: ownerToken })
  const expiredCodes = history.result.codes.filter((entry) => entry.status === 'expired')
  assert.ok(expiredCodes.length >= 19)
  assert.equal(history.result.stats.totalGenerated, 20)
  assert.equal(history.result.stats.remainingSlots, 0)
  assert.equal(history.result.stats.remainingGenerations, 0)

  // Attempting to generate a code after expiry MUST STILL FAIL with 429
  const attemptAfterExpiry = await request('/referrals/generate', {
    token: ownerToken,
    body: { quantity: 1, requestId: 'attempt-after-expiry-001' },
  })
  assert.equal(attemptAfterExpiry.response.status, 429)
  assert.equal(attemptAfterExpiry.result.message, 'You have reached your lifetime limit of 20 referral codes.')

  // Expired code cannot be validated
  const sampleExpiredCode = expiredCodes[0].code
  const expiredValidation = await request('/referrals/validate', { body: { code: sampleExpiredCode } })
  assert.equal(expiredValidation.response.status, 400)

  // Expired code cannot be redeemed in registration
  const expiredRegistration = await request('/auth/register', {
    body: {
      fullName: 'Expired Attempt',
      email: 'expired-attempt@example.invalid',
      username: 'expired-attempt',
      password: 'a-strong-password',
      confirmPassword: 'a-strong-password',
      role: 'student',
      accountType: 'independent',
      referralCode: sampleExpiredCode,
      hearAboutUs: 'Friend / Student Referral',
    },
  })
  assert.equal(expiredRegistration.response.status, 400)

  // 15. Privacy & User Isolation
  const ownerHistory = await request('/referrals/me?userId=' + secondOwnerId, { token: ownerToken })
  const ownerCodes = new Set(referralCodes
    .filter((entry) => String(entry.generatedBy) === String(ownerId))
    .map((entry) => entry.code))
  assert.ok(ownerHistory.result.codes.every((entry) => ownerCodes.has(entry.code)))
})
