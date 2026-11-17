import mongoose from 'mongoose'
import { config } from './env.js'
import { ensureMongoDnsResolution } from './dns.js'
import { Admin, CollegeAdmin, CollegeStudent, Student } from '../models/account-models.js'
import AccountIdentity from '../models/AccountIdentity.js'
import Course from '../models/Course.js'
import College from '../models/College.js'
import Enrollment from '../models/Enrollment.js'
import QuizAttempt from '../models/QuizAttempt.js'
import QuizAttemptState from '../models/QuizAttemptState.js'
import AssignmentSubmission from '../models/AssignmentSubmission.js'
import VideoAttentionResponse from '../models/VideoAttentionResponse.js'
import Certificate from '../models/Certificate.js'
import CertificateTemplate from '../models/CertificateTemplate.js'
import SupportTicket from '../models/SupportTicket.js'
import Notification from '../models/Notification.js'
import Feedback from '../models/Feedback.js'
import Complaint from '../models/Complaint.js'
import EmailOtpChallenge from '../models/EmailOtpChallenge.js'
import RegistrationEmailVerification from '../models/RegistrationEmailVerification.js'
import ReferralCode from '../models/ReferralCode.js'
import ReferralCodeDailyLimit from '../models/ReferralCodeDailyLimit.js'
import RefreshSession from '../models/RefreshSession.js'
import Notification from '../models/Notification.js'
import NotificationPreference from '../models/NotificationPreference.js'
import AcademicEvent from '../models/AcademicEvent.js'
import Attendance from '../models/Attendance.js'
import Batch from '../models/Batch.js'
import CollegeDocument from '../models/CollegeDocument.js'
import Department from '../models/Department.js'
import Examination from '../models/Examination.js'
import Faculty from '../models/Faculty.js'
import LearningActivity from '../models/LearningActivity.js'
import PlacementDrive from '../models/PlacementDrive.js'
import Progress from '../models/Progress.js'
import Semester from '../models/Semester.js'
import StudentNote from '../models/StudentNote.js'
import Resource from '../models/Resource.js'

const requiredModels = [
  Admin,
  CollegeAdmin,
  Student,
  CollegeStudent,
  AccountIdentity,
  Course,
  College,
  Enrollment,
  QuizAttempt,
  QuizAttemptState,
  AssignmentSubmission,
  VideoAttentionResponse,
  Certificate,
  CertificateTemplate,
  SupportTicket,
  Notification,
  Feedback,
  Complaint,
  EmailOtpChallenge,
  RegistrationEmailVerification,
  ReferralCode,
  ReferralCodeDailyLimit,
  RefreshSession,
  Notification,
  NotificationPreference,
  AcademicEvent,
  Attendance,
  Batch,
  CollegeDocument,
  Department,
  Examination,
  Faculty,
  LearningActivity,
  PlacementDrive,
  Progress,
  Semester,
  StudentNote,
  Resource,
]

async function runDatabaseOperation(operation, collection, callback) {
  try {
    return await callback()
  } catch (cause) {
    const collectionContext = collection ? ` for collection "${collection}"` : ''
    const error = new Error(`MongoDB ${operation}${collectionContext} failed.`)
    error.name = 'MongoInitializationError'
    error.cause = cause
    error.operation = operation
    if (collection) error.collection = collection
    throw error
  }
}

export async function connectToDatabase() {
  if (!config.mongoUri) {
    throw new Error('MONGO_URI is not set.')
  }

  await ensureMongoDnsResolution(config.mongoUri)

  await runDatabaseOperation(
    'connect',
    null,
    () => mongoose.connect(
      config.mongoUri,
      config.mongoDbName ? { dbName: config.mongoDbName } : {},
    ),
  )
  const database = mongoose.connection.db
  for (const model of requiredModels) {
    const collectionExists = await runDatabaseOperation(
      'listCollections',
      model.collection.name,
      async () => database.listCollections({ name: model.collection.name }).hasNext(),
    )
    if (!collectionExists) {
      try {
        await runDatabaseOperation(
          'createCollection',
          model.collection.name,
          () => database.createCollection(model.collection.name),
        )
      } catch (error) {
        if (error?.cause?.code !== 48) throw error
      }
    }
    await runDatabaseOperation(
      'createIndexes',
      model.collection.name,
      () => model.createIndexes(),
    )
  }
  const certificateDefaults = await Course.updateMany(
    { generateCertificate: { $exists: false } },
    { $set: { generateCertificate: true } },
  )
  if (certificateDefaults.modifiedCount > 0) {
    console.log(`Enabled certificate generation for ${certificateDefaults.modifiedCount} existing courses.`)
  }
  console.log('Connected to MongoDB Atlas.')
}
