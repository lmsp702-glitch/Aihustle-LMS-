import mongoose from 'mongoose'
import { pathToFileURL } from 'node:url'
import { config } from '../config/env.js'
import AccountIdentity from '../models/AccountIdentity.js'
import { accountModelsByCollection, CollegeStudent } from '../models/account-models.js'

const expectedDatabaseName = 'LMS'
const collegeCollection = CollegeStudent.collection.name
const confirmationFlag = '--confirm=SYNC-COLLEGE-STUDENT-USERNAMES'

function normalizedUsername(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

export function buildCollegeUsernameSyncPlan(students, identities, accountMatches) {
  const targetCounts = new Map()
  for (const student of students) {
    const target = normalizedUsername(student.studentId)
    if (target) targetCounts.set(target, (targetCounts.get(target) || 0) + 1)
  }

  return students.map((student) => {
    const accountId = String(student._id)
    const targetUsername = normalizedUsername(student.studentId)
    const matchingIdentities = identities.filter((identity) =>
      identity.accountCollection === collegeCollection
      && String(identity.accountId) === accountId)
    let reason = ''

    if (!targetUsername) {
      reason = 'missing_student_id'
    } else if (targetCounts.get(targetUsername) > 1) {
      reason = 'duplicate_student_id'
    } else if (matchingIdentities.length !== 1) {
      reason = 'missing_or_duplicate_identity'
    } else {
      const identityCollision = identities.some((identity) =>
        normalizedUsername(identity.username) === targetUsername
        && !(identity.accountCollection === collegeCollection && String(identity.accountId) === accountId))
      const accountCollision = accountMatches.some((account) =>
        normalizedUsername(account.username) === targetUsername
        && !(account.collection === collegeCollection && String(account._id) === accountId))
      if (identityCollision || accountCollision) reason = 'username_already_in_use'
    }

    if (reason) return { accountId, targetUsername, status: 'conflict', reason }

    const identity = matchingIdentities[0]
    const isAlreadySynced = normalizedUsername(student.username) === targetUsername
      && normalizedUsername(identity.username) === targetUsername
    return {
      accountId,
      targetUsername,
      identityId: String(identity._id),
      status: isAlreadySynced ? 'unchanged' : 'update',
      reason: '',
    }
  })
}

async function loadPlan() {
  const students = await CollegeStudent.find({
    role: 'student',
    studentType: 'college',
  }).select('_id studentId username').lean()
  const accountIds = students.map((student) => student._id)
  const targetUsernames = [...new Set(students.map((student) => normalizedUsername(student.studentId)).filter(Boolean))]
  const [identities, accountMatchesByCollection] = await Promise.all([
    AccountIdentity.find({
      $or: [
        { accountCollection: collegeCollection, accountId: { $in: accountIds } },
        { username: { $in: targetUsernames } },
      ],
    })
      .collation({ locale: 'en', strength: 2 })
      .select('_id accountCollection accountId username')
      .lean(),
    Promise.all(Object.entries(accountModelsByCollection).map(async ([collection, AccountModel]) => {
      if (!targetUsernames.length) return []
      const accounts = await AccountModel.find({ username: { $in: targetUsernames } })
        .collation({ locale: 'en', strength: 2 })
        .select('_id username')
        .lean()
      return accounts.map((account) => ({ ...account, collection }))
    })),
  ])
  return buildCollegeUsernameSyncPlan(students, identities, accountMatchesByCollection.flat())
}

function printPlan(plan) {
  const counts = {
    total: plan.length,
    update: plan.filter((item) => item.status === 'update').length,
    unchanged: plan.filter((item) => item.status === 'unchanged').length,
    conflict: plan.filter((item) => item.status === 'conflict').length,
  }
  console.log(`Database: ${expectedDatabaseName}`)
  console.log(`College student accounts: ${counts.total}`)
  console.log(`To synchronize: ${counts.update}`)
  console.log(`Already synchronized: ${counts.unchanged}`)
  console.log(`Skipped due to conflicts or missing data: ${counts.conflict}`)
  for (const item of plan) {
    if (item.status === 'conflict') {
      console.log(`Skipped account ${item.accountId}: ${item.reason}`)
    }
  }
  return counts
}

async function synchronizeAccount(item) {
  const session = await mongoose.startSession()
  const accountId = new mongoose.Types.ObjectId(item.accountId)
  try {
    await session.withTransaction(async () => {
      const student = await CollegeStudent.findOne({
        _id: accountId,
        role: 'student',
        studentType: 'college',
      }).session(session)
      const identity = await AccountIdentity.findOne({
        accountCollection: collegeCollection,
        accountId,
      }).session(session)
      if (
        !student
        || normalizedUsername(student.studentId) !== item.targetUsername
        || !identity
      ) {
        throw new Error('account_changed_after_plan')
      }

      const conflictingIdentity = await AccountIdentity.findOne({
        username: item.targetUsername,
        $nor: [{ accountCollection: collegeCollection, accountId }],
      })
        .collation({ locale: 'en', strength: 2 })
        .session(session)
      if (conflictingIdentity) throw new Error('username_collision')

      student.username = item.targetUsername
      identity.username = item.targetUsername
      await student.save({ session })
      await identity.save({ session })
    })
  } finally {
    await session.endSession()
  }
}

async function run() {
  const args = process.argv.slice(2)
  const planOnly = args.length === 1 && args[0] === '--plan'
  const execute = args.length === 2 && args[0] === '--execute' && args[1] === confirmationFlag
  if (!planOnly && !execute) {
    throw new Error(`Use --plan, or --execute ${confirmationFlag} after reviewing the plan.`)
  }
  if (!config.mongoUri) throw new Error('MONGO_URI is not configured in Server/.env.')

  await mongoose.connect(config.mongoUri, config.mongoDbName ? { dbName: config.mongoDbName } : {})
  if (mongoose.connection.db.databaseName !== expectedDatabaseName) {
    throw new Error(`Refusing to update database "${mongoose.connection.db.databaseName}". Expected "${expectedDatabaseName}".`)
  }

  const plan = await loadPlan()
  const counts = printPlan(plan)
  if (planOnly || !counts.update) return

  let updated = 0
  let failed = 0
  for (const item of plan) {
    if (item.status !== 'update') continue
    try {
      await synchronizeAccount(item)
      updated += 1
    } catch (error) {
      failed += 1
      const code = error?.code ? ` (code ${error.code})` : ''
      console.error(`Could not synchronize account ${item.accountId}${code}.`)
    }
  }
  console.log(`Synchronized: ${updated}; failed: ${failed}.`)
  if (failed) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await run()
  } catch (error) {
    const errorMessage = error instanceof Error
      ? error.message
        .replace(/mongodb(?:\+srv)?:\/\/[^\s"']+/gi, '[MongoDB URI redacted]')
        .replace(config.mongoUri || '\u0000', '[MongoDB URI redacted]')
      : 'Unknown error'
    console.error(`College username synchronization failed: ${errorMessage}`)
    process.exitCode = 1
  } finally {
    await mongoose.disconnect()
  }
}
