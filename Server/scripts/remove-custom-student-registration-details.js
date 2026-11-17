import mongoose from 'mongoose'
import { pathToFileURL } from 'node:url'
import { config } from '../config/env.js'

const expectedDatabaseName = 'LMS'
const collections = ['students', 'clg_students']
export const removedRegistrationFieldNames = Object.freeze([
  'customQualification',
  'custom_qualification',
  'otherQualification',
  'qualificationOther',
  'customLivingArrangement',
  'custom_living_arrangement',
  'otherLivingArrangement',
])
export const removedRegistrationFieldPaths = Object.freeze([
  ...removedRegistrationFieldNames,
  ...removedRegistrationFieldNames.map((field) => `registrationDetails.${field}`),
])
const confirmationFlag = '--confirm=REMOVE-CUSTOM-STUDENT-REGISTRATION-DETAILS'

export function buildCleanupFilter() {
  return {
    $or: removedRegistrationFieldPaths.map((field) => ({ [field]: { $exists: true } })),
  }
}

export function buildCleanupUpdate() {
  return {
    $unset: Object.fromEntries(removedRegistrationFieldPaths.map((field) => [field, ''])),
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
  const database = mongoose.connection.db
  if (database.databaseName !== expectedDatabaseName) {
    throw new Error(`Refusing to update database "${database.databaseName}". Expected "${expectedDatabaseName}".`)
  }

  const filter = buildCleanupFilter()
  const update = buildCleanupUpdate()
  let totalMatches = 0
  for (const collectionName of collections) {
    const collection = database.collection(collectionName)
    const matches = await collection.countDocuments(filter)
    totalMatches += matches
    console.log(`${collectionName}: ${matches} student records contain custom fields.`)
    if (execute && matches) {
      const result = await collection.updateMany(filter, update)
      console.log(`${collectionName}: removed custom fields from ${result.modifiedCount} records.`)
    }
  }
  if (planOnly) {
    console.log(`Read-only plan: ${totalMatches} records would be cleaned.`)
    return
  }

  let remainingMatches = 0
  for (const collectionName of collections) {
    remainingMatches += await database.collection(collectionName).countDocuments(filter)
  }
  console.log(`Remaining records with custom fields: ${remainingMatches}.`)
  if (remainingMatches) process.exitCode = 1
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
    console.error(`Custom registration data cleanup failed: ${errorMessage}`)
    process.exitCode = 1
  } finally {
    await mongoose.disconnect()
  }
}
