import bcrypt from 'bcryptjs'
import crypto, { randomBytes } from 'node:crypto'
import mongoose from 'mongoose'
import multer from 'multer'
import path from 'node:path'
import { Router } from 'express'

import QuizAttemptState from '../models/QuizAttemptState.js'
import VideoAttentionResponse from '../models/VideoAttentionResponse.js'
import CertificateTemplate from '../models/CertificateTemplate.js'
import { config } from '../config/env.js'
import {
  evaluateCertificateEligibility,
  generateCertificatePdf,
  getActiveCertificateTemplateId,
  getRequiredCertificateActivities,
  issueCertificateIfEligible,
} from '../utils/certificates.js'
import { parseStudentCsv } from '../utils/student-csv.js'
import {
  assertCollegeStudentCapacity,
  countCollegeStudents,
  getCollegeStudentLimit,
} from '../utils/college-student-capacity.js'
import { toMongoBuffer } from '../utils/mongo-binary.js'

import AccountIdentity from '../models/AccountIdentity.js'
import College from '../models/College.js'
import Course from '../models/Course.js'
import Enrollment from '../models/Enrollment.js'
import Progress from '../models/Progress.js'
import LearningActivity from '../models/LearningActivity.js'
import Certificate from '../models/Certificate.js'
import StudentNote from '../models/StudentNote.js'
import Resource from '../models/Resource.js'
import AssignmentSubmission from '../models/AssignmentSubmission.js'
import QuizAttempt from '../models/QuizAttempt.js'
import { CollegeAdmin, CollegeStudent, Student, accountModelsByCollection } from '../models/account-models.js'
import { authenticate, requireRoles } from '../middleware/auth.js'
import {
  buildCourseActivitySequence,
  calculateCourseProgress,
  findSequencedQuiz,
  findSequencedAssessment,
} from '../utils/course-sequencing.js'
import { generateStudentNotesPdf } from '../utils/notes-export.js'
import {
  getSignedResourceDeliveryUrls,
  fetchResourcePdfBuffer,
} from '../utils/resource-delivery.js'
import { createStudentNotification } from '../utils/student-notifications.js'

const router = Router()

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const usernamePattern = /^[a-zA-Z0-9._-]{3,30}$/
const maxAssignmentSubmissionBytes = 10 * 1024 * 1024
const maxCertificateTemplateBytes = 4 * 1024 * 1024
const quizAttemptLimit = 3
const quizAttemptCooldownMs = 24 * 60 * 60 * 1000
const attentionCheckResponseTimeoutMs = 10 * 1000
const loggedInvalidAttentionConfigurations = new Set()

function isValidObjectId(value) {
  return typeof value === 'string' && mongoose.isValidObjectId(value)
}

async function getAssignedCollegeAdmin(req) {
  const collegeId = req.auth.user.collegeId
  if (!isValidObjectId(collegeId)) return null
  const account = await CollegeAdmin.findById(req.auth.id)
    .select('collegeId studentLimit')
    .lean()
  return account && String(account.collegeId) === collegeId
    ? { ...account, collegeId: new mongoose.Types.ObjectId(collegeId) }
    : null
}

async function accountIdentifierExists(field, value) {
  if (await AccountIdentity.exists({ [field]: value })) return true
  for (const AccountModel of Object.values(accountModelsByCollection)) {
    if (await AccountModel.exists({ [field]: value })) return true
  }
  return false
}

function makeImportUsername(studentId) {
  return String(studentId ?? '').trim().toLowerCase()
}

function isDuplicateStudentId(studentId, model, session) {
  let query = model.findOne({ studentId })
    .collation({ locale: 'en', strength: 2 })
    .select('_id')
  if (session) query = query.session(session)
  return query.lean()
}

function getLessonPlaybackPositions(enrollment) {
  const positions = enrollment?.lessonPlaybackPositions
  if (positions instanceof Map) return Object.fromEntries(positions)
  return positions && typeof positions === 'object' ? { ...positions } : {}
}

function getMapValue(values, key) {
  if (values instanceof Map) return values.get(key)
  return values && typeof values === 'object' ? values[key] : undefined
}

function getCertificateCourseProgress(activities, pendingRequirements = [], earned = false) {
  const totalActivities = Object.values(activities).reduce((total, items) => total + items.length, 0)
  const incompleteActivities = pendingRequirements.filter((requirement) => (
    ['video', 'quiz', 'assignment'].includes(requirement.type)
  )).length
  const completedActivities = earned ? totalActivities : Math.max(0, totalActivities - incompleteActivities)
  return {
    completedActivities,
    totalActivities,
    percentage: earned ? 100 : totalActivities ? Math.round((completedActivities / totalActivities) * 100) : 0,
  }
}

function canonicalObjectId(value) {
  const isBsonObjectId = value instanceof mongoose.Types.ObjectId
    || (value?._bsontype === 'ObjectId' && typeof value.toHexString === 'function')
  if ((!isValidObjectId(value) && !isBsonObjectId) || !mongoose.isValidObjectId(value)) return ''
  return new mongoose.Types.ObjectId(value).toString()
}

async function issueCourseCertificate(req, enrollment) {
  const course = enrollment.courseId
  if (course?.generateCertificate === false) return null
  const lessonIds = [...new Set(getCourseLessonIds(course))]
  const completedIds = new Set((enrollment.completedLessonIds || []).map(String))
  if (!lessonIds.length || !lessonIds.every((lessonId) => completedIds.has(lessonId))) return null

  const studentType = req.auth.accountCollection === 'clg_students' ? 'college' : 'independent'
  const studentName = req.auth.user.fullName || req.auth.user.username || req.auth.user.email
  const courseName = course?.title?.trim()
  if (!studentName || !courseName) {
    throw new Error('A student name and course name are required to issue a certificate.')
  }

  const studentId = new mongoose.Types.ObjectId(req.auth.id)
  const courseId = new mongoose.Types.ObjectId(course._id)
  const legacyCertificate = await Certificate.findOne({
    userId: studentId,
    courseId,
    $or: [{ studentId: { $exists: false } }, { studentId: null }],
  }).lean()
  if (legacyCertificate) {
    const legacyEnrollment = await Enrollment.findOne({
      _id: legacyCertificate.enrollmentId,
      userId: studentId,
      courseId,
      ...(studentType === 'college'
        ? { collegeId: req.auth.user.collegeId }
        : { $or: [{ collegeId: { $exists: false } }, { collegeId: null }] }),
    }).select('_id').lean()
    if (legacyEnrollment) return legacyCertificate
  }

  const certificateId = `AIH-${crypto.randomBytes(16).toString('hex').toUpperCase()}`
  const identity = { studentType, studentId, courseId }
  const certificateData = {
    ...identity,
    userId: studentId,
    ...(studentType === 'college' ? { collegeId: req.auth.user.collegeId } : {}),
    studentName,
    courseName,
    enrollmentId: enrollment._id,
    certificateId,
    name: `${courseName} Certificate of Completion`,
    issuedAt: new Date(),
    viewUrl: `/certificates/${certificateId}/view`,
    downloadUrl: `/certificates/${certificateId}/download`,
  }

  try {
    return await Certificate.findOneAndUpdate(
      identity,
      { $setOnInsert: certificateData },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    ).lean()
  } catch (error) {
    if (error?.code !== 11000) throw error
    return Certificate.findOne(identity).lean()
  }
}

function certificateImageBuffer(imageData) {
  if (Buffer.isBuffer(imageData)) return imageData
  if (imageData instanceof Uint8Array) return Buffer.from(imageData)
  if (imageData?._bsontype === 'Binary' && Buffer.isBuffer(imageData.buffer)) {
    const length = Number.isInteger(imageData.position) ? imageData.position : imageData.buffer.length
    return Buffer.from(imageData.buffer.subarray(0, length))
  }
  return null
}

async function loadCertificateTemplateImage(template) {
  const storedImageData = certificateImageBuffer(template?.imageData)
  if (storedImageData?.length) return storedImageData
  if (typeof template?.secureUrl !== 'string' || !config.cloudinaryCloudName) {
    throw new Error('The certificate background used for this certificate is unavailable.')
  }

  const imageUrl = new URL(template.secureUrl)
  const expectedPath = `/${config.cloudinaryCloudName}/image/upload/`
  if (
    imageUrl.protocol !== 'https:'
    || imageUrl.hostname !== 'res.cloudinary.com'
    || !imageUrl.pathname.startsWith(expectedPath)
  ) {
    throw new Error('The certificate background URL is invalid.')
  }

  const response = await fetch(imageUrl, { redirect: 'error', signal: AbortSignal.timeout(10000) })
  if (!response.ok) throw new Error('The certificate background could not be loaded.')
  const contentLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(contentLength) && contentLength > maxCertificateTemplateBytes) {
    throw new Error('The certificate background exceeds the supported file size.')
  }
  const imageData = Buffer.from(await response.arrayBuffer())
  if (!imageData.length || imageData.length > maxCertificateTemplateBytes) {
    throw new Error('The certificate background could not be loaded.')
  }
  return imageData
}
function sanitizeStudentAttentionCheck(attentionCheck) {
  if (!attentionCheck) return attentionCheck
  return {
    enabled: attentionCheck.enabled === true,
    questionsDuringVideo: attentionCheck.questionsDuringVideo
      ?? Math.max(1, (attentionCheck.questions || []).length),
    minIntervalSeconds: attentionCheck.minIntervalSeconds ?? 120,
    maxIntervalSeconds: attentionCheck.maxIntervalSeconds ?? 300,
  }
}

function logInvalidAttentionCheckConfigurations(course) {
  for (const [moduleIndex, module] of (course.modules || []).entries()) {
    const videoLessons = [
      ...(module.lessons || []).map((lesson) => ({ lesson, source: 'legacy' })),
      ...(module.contentItems || [])
        .filter((item) => item.type === 'video-lesson')
        .map((lesson) => ({ lesson, source: 'contentItem' })),
    ]
    for (const { lesson, source } of videoLessons) {
      const settings = lesson.attentionCheck
      if (settings?.enabled !== true) continue

      const questions = settings.questions || []
      const isLegacy = settings.questionsDuringVideo === undefined
        && questions.every((question) => question.selectedForPlayback === undefined)
      const questionCount = Number(settings.questionsDuringVideo ?? Math.max(1, questions.length))
      const minIntervalSeconds = Number(settings.minIntervalSeconds ?? 120)
      const maxIntervalSeconds = Number(settings.maxIntervalSeconds ?? 300)
      const durationSeconds = Number(lesson.durationSeconds)
      const selectedQuestionCount = isLegacy
        ? questions.length
        : questions.filter((question) => question.selectedForPlayback === true).length
      const reasons = []

      if (!Number.isInteger(questionCount) || questionCount < 1 || questionCount > 100) {
        reasons.push('invalid_question_count')
      }
      if (
        !Number.isInteger(minIntervalSeconds)
        || minIntervalSeconds < 10
        || minIntervalSeconds > 7200
        || !Number.isInteger(maxIntervalSeconds)
        || maxIntervalSeconds < minIntervalSeconds
        || maxIntervalSeconds > 7200
      ) {
        reasons.push('invalid_interval_range')
      }
      if (selectedQuestionCount !== questionCount) reasons.push('selected_question_count_mismatch')
      if (
        Number.isFinite(durationSeconds)
        && durationSeconds > 0
        && Number.isInteger(questionCount)
        && Number.isInteger(minIntervalSeconds)
        && durationSeconds < questionCount * minIntervalSeconds
      ) {
        reasons.push('video_duration_too_short')
      }
      if (!reasons.length) continue

      const diagnostic = {
        event: 'student.video_attention_check.invalid_configuration',
        courseId: String(course._id || ''),
        moduleIndex: moduleIndex + 1,
        lessonId: String(lesson._id || ''),
        lessonSource: source,
        durationSeconds: Number.isFinite(durationSeconds) ? durationSeconds : null,
        questionsDuringVideo: questionCount,
        selectedQuestionCount,
        minIntervalSeconds,
        maxIntervalSeconds,
        reasons,
      }
      const diagnosticKey = JSON.stringify(diagnostic)
      if (loggedInvalidAttentionConfigurations.has(diagnosticKey)) continue
      loggedInvalidAttentionConfigurations.add(diagnosticKey)
      console.warn(JSON.stringify(diagnostic))
    }
  }
}

function findVideoLesson(course, lessonId) {
  for (const module of course?.modules || []) {
    const lessons = [
      ...(module.lessons || []),
      ...(module.contentItems || []).filter((item) => item.type === 'video-lesson'),
    ]
    const lesson = lessons.find((item) => canonicalObjectId(item._id) === lessonId)
    if (lesson) return lesson
  }
  return null
}

function getSelectedAttentionQuestions(attentionCheck) {
  const questions = attentionCheck?.questions || []
  const isLegacy = attentionCheck?.questionsDuringVideo === undefined
    && questions.every((question) => question.selectedForPlayback === undefined)
  return questions.filter((question) => isLegacy || question.selectedForPlayback === true)
}

function isCorrectAttentionAnswer(selectedIndices, correctIndices) {
  const sortedSelected = [...selectedIndices].sort((a, b) => a - b)
  const sortedCorrect = [...correctIndices].sort((a, b) => a - b)
  return sortedSelected.length === sortedCorrect.length
    && sortedSelected.every((index, position) => index === sortedCorrect[position])
}

const requireStudent = [authenticate, requireRoles('student')]
const requireCollegeAdmin = [authenticate, requireRoles('college_admin')]
const assignmentFileTypes = new Map([
  ['.pdf', 'application/pdf'],
  ['.txt', 'text/plain'],
  ['.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
])
const assignmentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: maxAssignmentSubmissionBytes, files: 1, fields: 0, parts: 1 },
  fileFilter(_req, file, callback) {
    const extension = path.extname(file.originalname || '').toLowerCase()
    if (assignmentFileTypes.get(extension) !== file.mimetype) {
      const error = new Error('Upload a PDF, DOCX, or TXT file whose extension matches its file type.')
      error.statusCode = 415
      callback(error)
      return
    }
    callback(null, true)
  },
})

function hideQuizAnswers(course) {
  if (!course) return course
  return {
    ...course,
    quizzes: course.quizzes?.map(({ questions, ...quiz }) => ({
      ...quiz,
      questions: questions?.map(({ correctOptionIndex, ...question }) => question),
    })),
    modules: course.modules?.map(({ quiz, lessons, contentItems, ...module }) => ({
      ...module,
      ...(lessons ? {
        lessons: lessons.map(({ attentionCheck, ...lesson }) => ({
          ...lesson,
          ...(attentionCheck ? { attentionCheck: sanitizeStudentAttentionCheck(attentionCheck) } : {}),
        })),
      } : {}),
      ...(quiz ? {
        quiz: {
          ...quiz,
          questions: quiz.questions?.map(({ correctOptionIndices, ...question }) => question),
        },
      } : {}),
      ...(contentItems ? {
        contentItems: contentItems.map(({ quiz: itemQuiz, attentionCheck, ...item }) => {
          let legacyTranscriptCues
          if (item.type === 'video-lesson') {
            const matchingLegacyLesson = item._id
              ? lessons?.find((lesson) => String(lesson._id) === String(item._id))
              : null
            const titleAndVideoMatches = !matchingLegacyLesson && item.videoUrl
              ? (lessons || []).filter((lesson) => lesson.title === item.title && lesson.videoUrl === item.videoUrl)
              : []
            const transcriptLesson = matchingLegacyLesson
              || (titleAndVideoMatches.length === 1 ? titleAndVideoMatches[0] : null)
            legacyTranscriptCues = transcriptLesson?.transcriptCues
          }
          return {
            ...item,
            ...(item.type === 'video-lesson' && !item.transcriptCues?.length && legacyTranscriptCues?.length
              ? { transcriptCues: legacyTranscriptCues }
              : {}),
            ...(attentionCheck ? { attentionCheck: sanitizeStudentAttentionCheck(attentionCheck) } : {}),
            ...(itemQuiz ? {
              quiz: {
                ...itemQuiz,
                questions: itemQuiz.questions?.map(({ correctOptionIndices, ...question }) => question),
              },
            } : {}),
          }
        }),
      } : {}),
    })),
  }
}

function getCourseAllLessons(course) {
  const allLessons = []
  for (const module of course?.modules || []) {
    const videoItems = module.contentItems?.filter((item) => item.type === 'video-lesson') || []
    const lessons = videoItems.length ? videoItems : module.lessons || []
    for (const lesson of lessons) {
      allLessons.push({
        module,
        moduleId: module._id,
        lesson,
        lessonId: lesson._id,
        title: lesson.title,
        videoUrl: lesson.videoUrl,
      })
    }
  }
  return allLessons
}

function courseHasLesson(course, lessonId) {
  return getCourseAllLessons(course).some((item) => String(item.lessonId) === String(lessonId))
}

function getCourseLessonIds(course) {
  return getCourseAllLessons(course).map((item) => String(item.lessonId)).filter(Boolean)
}

function getCourseAssignmentCount(course) {
  const ids = new Set((course?.assignments || []).map((assignment) => String(assignment._id)))
  for (const module of course?.modules || []) {
    for (const item of module.contentItems || []) {
      if (item.type === 'assignment') ids.add(String(item._id))
    }
  }
  return ids
}

function getLearningStreak(dates, now = new Date()) {
  const activeDays = new Set(dates
    .map((value) => new Date(value))
    .filter((date) => Number.isFinite(date.getTime()))
    .map((date) => date.toISOString().slice(0, 10)))
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  const yesterday = new Date(today)
  yesterday.setUTCDate(yesterday.getUTCDate() - 1)
  const todayKey = today.toISOString().slice(0, 10)
  const yesterdayKey = yesterday.toISOString().slice(0, 10)
  if (!activeDays.has(todayKey) && !activeDays.has(yesterdayKey)) return 0

  const currentDay = new Date(activeDays.has(todayKey) ? today : yesterday)
  let streak = 0
  while (activeDays.has(currentDay.toISOString().slice(0, 10))) {
    streak += 1
    currentDay.setUTCDate(currentDay.getUTCDate() - 1)
  }
  return streak
}

function summarizeStudentLearning(enrollments, assignmentSubmissions, now = new Date()) {
  const enrollmentsByCourse = new Map()
  for (const enrollment of enrollments) {
    const course = enrollment.courseId
    if (!course || typeof course !== 'object') continue
    const courseId = String(course._id)
    if (courseId && !enrollmentsByCourse.has(courseId)) {
      enrollmentsByCourse.set(courseId, enrollment)
    }
  }

  let completedCourses = 0
  let completedLessons = 0
  let inProgressLessons = 0
  let notStartedLessons = 0
  let totalLessons = 0
  let pendingAssignments = 0
  const completionDates = []
  const submittedAssignments = new Map()
  for (const submission of assignmentSubmissions) {
    const key = `${submission.enrollmentId}:${submission.assignmentId}`
    submittedAssignments.set(key, true)
  }

  for (const enrollment of enrollmentsByCourse.values()) {
    const course = enrollment.courseId
    const lessonIds = getCourseLessonIds(course)
    const lessonIdSet = new Set(lessonIds)
    const completedIds = new Set((enrollment.completedLessonIds || []).map(String))
    const startedIds = new Set((enrollment.startedLessonIds || []).map(String))
    let completedInCourse = 0

    for (const lessonId of lessonIdSet) {
      if (completedIds.has(lessonId)) {
        completedInCourse += 1
        completedLessons += 1
      } else if (startedIds.has(lessonId)) {
        inProgressLessons += 1
      } else {
        notStartedLessons += 1
      }
    }

    totalLessons += lessonIdSet.size
    if (lessonIdSet.size > 0 && completedInCourse === lessonIdSet.size) completedCourses += 1
    for (const assignmentId of getCourseAssignmentCount(course)) {
      if (!submittedAssignments.has(`${enrollment._id}:${assignmentId}`)) pendingAssignments += 1
    }

    const savedCompletionDates = enrollment.lessonCompletionDates instanceof Map
      ? [...enrollment.lessonCompletionDates.entries()]
      : Object.entries(enrollment.lessonCompletionDates || {})
    for (const [lessonId, completedAt] of savedCompletionDates) {
      if (lessonIdSet.has(String(lessonId)) && completedIds.has(String(lessonId))) {
        completionDates.push(completedAt)
      }
    }
  }

  return {
    enrolledCourses: enrollmentsByCourse.size,
    pendingAssignments,
    completedCourses,
    learningStreak: getLearningStreak(completionDates, now),
    completedLessons,
    inProgressLessons,
    notStartedLessons,
    totalLessons,
    completionPercentage: totalLessons ? Math.round((completedLessons / totalLessons) * 100) : 0,
  }
}

function getStudentEnrollmentScope(req) {
  return req.auth.user.studentType === 'college'
    ? { collegeId: req.auth.user.collegeId }
    : { collegeId: { $exists: false } }
}

function findQuiz(course, quizId) {
  const requestedQuizId = canonicalObjectId(quizId)
  if (!requestedQuizId) return null
  for (const module of course?.modules || []) {
    for (const item of module.contentItems || []) {
      if (canonicalObjectId(item.quiz?._id) === requestedQuizId) return item.quiz
    }
  }
  for (const module of course?.modules || []) {
    if (canonicalObjectId(module.quiz?._id) === requestedQuizId) return module.quiz
  }
  for (const quiz of course?.quizzes || []) {
    if (canonicalObjectId(quiz._id) === requestedQuizId) return quiz
  }
  return findSequencedQuiz(course, quizId)
}

function getQuizAttemptStatus(state, now = new Date()) {
  const lockedUntil = state.lockedUntil || null
  const remainingLockMs = lockedUntil ? Math.max(0, new Date(lockedUntil).getTime() - now.getTime()) : 0
  return {
    maxAttempts: quizAttemptLimit,
    attemptsUsed: state.attemptsUsed,
    attemptsRemaining: state.passed || remainingLockMs > 0
      ? 0
      : Math.max(0, quizAttemptLimit - state.attemptsUsed),
    cycleNumber: state.cycleNumber,
    passed: state.passed,
    lockedUntil,
    remainingLockMs,
    serverTime: now,
  }
}

async function getQuizAttemptState(key, now = new Date()) {
  let state = await QuizAttemptState.findOne(key).lean()
  if (!state) {
    const history = await QuizAttempt.find(key)
      .select('status passed submittedAt createdAt attemptNumber cycleNumber')
      .sort({ createdAt: 1 })
      .lean()
    const submitted = history.filter((attempt) => attempt.status === 'submitted')
    const passed = submitted.some((attempt) => attempt.passed === true)
    const lastThree = submitted.slice(-quizAttemptLimit)
    const thirdFailure = !passed
      && lastThree.length === quizAttemptLimit
      && lastThree.every((attempt) => attempt.passed === false)
      ? lastThree[lastThree.length - 1]
      : null
    let attemptsUsed = Math.min(history.length, quizAttemptLimit)
    let cycleNumber = 1
    let lockedUntil = null
    if (thirdFailure) {
      const failedAt = thirdFailure.submittedAt || thirdFailure.createdAt
      if (failedAt) lockedUntil = new Date(new Date(failedAt).getTime() + quizAttemptCooldownMs)
      if (lockedUntil && lockedUntil <= now) {
        attemptsUsed = 0
        cycleNumber += 1
        lockedUntil = null
      } else {
        attemptsUsed = quizAttemptLimit
      }
    }

    try {
      state = await QuizAttemptState.findOneAndUpdate(
        key,
        {
          $setOnInsert: {
            ...key,
            attemptsUsed,
            cycleNumber,
            passed,
            lockedUntil,
          },
        },
        { new: true, upsert: true, setDefaultsOnInsert: true },
      ).lean()
    } catch (error) {
      if (error?.code !== 11000) throw error
      state = await QuizAttemptState.findOne(key).lean()
      if (!state) throw error
    }
  }

  if (state.lockedUntil && new Date(state.lockedUntil) <= now && !state.passed) {
    const resetState = await QuizAttemptState.findOneAndUpdate(
      { ...key, cycleNumber: state.cycleNumber, lockedUntil: state.lockedUntil },
      {
        $set: { attemptsUsed: 0, lockedUntil: null },
        $inc: { cycleNumber: 1 },
      },
      { new: true },
    ).lean()
    state = resetState || await QuizAttemptState.findOne(key).lean()
  }
  return state
}

async function reserveQuizAttempt(key, now = new Date()) {
  let state = await getQuizAttemptState(key, now)
  if (state.passed) return { state, reason: 'passed' }
  if (state.lockedUntil && new Date(state.lockedUntil) > now) return { state, reason: 'locked' }
  if (state.attemptsUsed >= quizAttemptLimit) return { state, reason: 'exhausted' }

  const reservedState = await QuizAttemptState.findOneAndUpdate(
    {
      ...key,
      cycleNumber: state.cycleNumber,
      attemptsUsed: { $lt: quizAttemptLimit },
      passed: { $ne: true },
      $or: [
        { lockedUntil: null },
        { lockedUntil: { $exists: false } },
        { lockedUntil: { $lte: now } },
      ],
    },
    { $inc: { attemptsUsed: 1 } },
    { new: true },
  ).lean()
  if (reservedState) return { state: reservedState, attemptNumber: reservedState.attemptsUsed }

  state = await getQuizAttemptState(key, now)
  if (state.passed) return { state, reason: 'passed' }
  if (state.lockedUntil && new Date(state.lockedUntil) > now) return { state, reason: 'locked' }
  return { state, reason: 'exhausted' }
}

function getQuizQuestionSnapshot(quiz) {
  const questionIds = new Set()
  return quiz.questions.map((question, index) => {
    const questionId = canonicalObjectId(question._id)
    if (!questionId) {
      const error = new Error(`Question ${index + 1} is missing a valid saved question ID.`)
      error.statusCode = 400
      throw error
    }
    if (questionIds.has(questionId)) {
      const error = new Error(`Question ${index + 1} has a duplicate saved question ID.`)
      error.statusCode = 400
      throw error
    }
    questionIds.add(questionId)
    const correctOptionIndices = Array.isArray(question.correctOptionIndices) && question.correctOptionIndices.length > 0
      ? question.correctOptionIndices
      : Number.isInteger(question.correctOptionIndex) ? [question.correctOptionIndex] : []
    return {
      questionId,
      prompt: question.prompt,
      type: question.type || 'multiple-choice',
      options: question.options || [],
      correctOptionIndices,
      marks: question.marks,
      explanation: question.explanation || '',
    }
  })
}

function getPublicQuestionSnapshot(questionSnapshot) {
  return questionSnapshot.map(({ questionId, prompt, type, options }) => ({
    _id: questionId,
    prompt,
    type,
    options,
  }))
}

function serializeQuizAttempt(attempt) {
  const { questionSnapshot, ...publicAttempt } = attempt
  return {
    ...publicAttempt,
    ...(questionSnapshot?.length ? { questions: getPublicQuestionSnapshot(questionSnapshot) } : {}),
  }
}

function findAssignment(course, assignmentId) {
  for (const assignment of course?.assignments || []) {
    if (String(assignment._id) === assignmentId) return assignment
  }
  for (const module of course?.modules || []) {
    const assignment = (module.contentItems || []).find((item) => (
      item.type === 'assignment' && String(item._id) === assignmentId
    ))
    if (assignment) return assignment
  }
  return findSequencedAssessment(course, assignmentId)
}

async function safeFindQuizAttempts(query, selectFields) {
  try {
    if (mongoose.connection.readyState === 0 && QuizAttempt.find === mongoose.Model.find) {
      return []
    }
    let q = QuizAttempt.find(query)
    if (selectFields) q = q.select(selectFields)
    return await q.lean()
  } catch {
    return []
  }
}

async function safeFindAssignmentSubmissions(query, selectFields) {
  try {
    if (mongoose.connection.readyState === 0 && AssignmentSubmission.find === mongoose.Model.find) {
      return []
    }
    let q = AssignmentSubmission.find(query)
    if (selectFields) q = q.select(selectFields)
    return await q.lean()
  } catch {
    return []
  }
}

async function safeFindEnrollmentById(id) {
  try {
    if (mongoose.connection.readyState === 0 && Enrollment.findById === mongoose.Model.findById) {
      return null
    }
    if (typeof Enrollment.findById !== 'function') return null
    const res = Enrollment.findById(id)
    if (res && typeof res.select === 'function') {
      const s = res.select('courseId')
      return s && typeof s.lean === 'function' ? await s.lean() : await s
    }
    if (res && typeof res.lean === 'function') return await res.lean()
    return await res
  } catch {
    return null
  }
}

async function safeFindProgressOne(query) {
  try {
    if (mongoose.connection.readyState === 0 && Progress.findOne === mongoose.Model.findOne) {
      return null
    }
    if (typeof Progress.findOne !== 'function') return null
    const res = Progress.findOne(query)
    return res && typeof res.lean === 'function' ? await res.lean() : await res
  } catch {
    return null
  }
}

async function safeFindProgress(query) {
  try {
    if (mongoose.connection.readyState === 0 && Progress.find === mongoose.Model.find) {
      return []
    }
    if (typeof Progress.find !== 'function') return []
    const res = Progress.find(query)
    return res && typeof res.lean === 'function' ? await res.lean() : await res
  } catch {
    return []
  }
}

function sanitizeSubmissionFileName(fileName) {
  return path.basename(fileName).replace(/[^\w.-]/g, '_').slice(0, 180) || 'assignment'
}

function isValidAssignmentFile(file) {
  if (!file?.buffer?.length || file.buffer.length > maxAssignmentSubmissionBytes) return false
  if (file.mimetype === 'application/pdf') return file.buffer.subarray(0, 5).toString('ascii') === '%PDF-'
  if (file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    return file.buffer.length >= 4
      && file.buffer[0] === 0x50
      && file.buffer[1] === 0x4b
      && file.buffer[2] === 0x03
      && file.buffer[3] === 0x04
  }
  if (file.mimetype === 'text/plain') {
    return !file.buffer.includes(0)
      && file.buffer.every((byte) => byte === 9 || byte === 10 || byte === 13 || byte >= 32)
  }
  return false
}

function receiveAssignmentSubmission(req, res, next) {
  assignmentUpload.single('file')(req, res, (error) => {
    if (!error) return next()
    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ message: 'Assignment submissions must be 10 MB or smaller.' })
    }
    if (error instanceof multer.MulterError) {
      return res.status(400).json({ message: 'Choose one assignment file to upload.' })
    }
    if (error.statusCode === 415) return res.status(415).json({ message: error.message })
    return next(error)
  })
}

router.post('/college/students', ...requireCollegeAdmin, async (req, res, next) => {
  try {
    const subAdmin = await getAssignedCollegeAdmin(req)
    if (!subAdmin) {
      return res.status(403).json({ message: 'Your Sub-Admin account is not assigned to a valid college.' })
    }

    const { fullName, email, password, studentId, department, batch } = req.body ?? {}
    if (typeof fullName !== 'string' || !fullName.trim() || fullName.trim().length > 120) {
      return res.status(400).json({ message: 'Enter a student name between 1 and 120 characters.' })
    }
    if (typeof email !== 'string' || email.trim().length > 254 || !emailPattern.test(email.trim())) {
      return res.status(400).json({ message: 'Enter a valid email address.' })
    }
    if (typeof password !== 'string' || password.length < 8 || Buffer.byteLength(password, 'utf8') > 72) {
      return res.status(400).json({ message: 'Use a password of at least 8 characters.' })
    }
    if (typeof studentId !== 'string' || !studentId.trim() || studentId.trim().length > 100) {
      return res.status(400).json({ message: 'Enter a student ID of up to 100 characters.' })
    }
    if (department !== undefined && (typeof department !== 'string' || department.trim().length > 120)) {
      return res.status(400).json({ message: 'Department must be 120 characters or fewer.' })
    }
    if (batch !== undefined && (typeof batch !== 'string' || batch.trim().length > 80)) {
      return res.status(400).json({ message: 'Batch must be 80 characters or fewer.' })
    }

    const normalizedEmail = email.trim().toLowerCase()
    const normalizedStudentId = studentId.trim()
    const normalizedUsername = normalizedStudentId.toLowerCase()
    const [existingEmail, existingUsername, existingStudentId] = await Promise.all([
      accountIdentifierExists('email', normalizedEmail),
      accountIdentifierExists('username', normalizedUsername),
      Promise.all([
        isDuplicateStudentId(normalizedStudentId, Student),
        isDuplicateStudentId(normalizedStudentId, CollegeStudent),
      ]).then((matches) => matches.some(Boolean)),
    ])
    if (existingEmail) return res.status(409).json({ message: 'An account with this email already exists.' })
    if (existingUsername) return res.status(409).json({ message: 'This username is already taken.' })
    if (existingStudentId) return res.status(409).json({ message: 'This student ID already exists.' })

    const accountId = new mongoose.Types.ObjectId()
    const passwordHash = await bcrypt.hash(password, 12)
    const session = await mongoose.startSession()
    let student
    try {
      await session.withTransaction(async () => {
        await assertCollegeStudentCapacity(subAdmin.collegeId, session)
        const duplicate = await AccountIdentity.findOne({
          $or: [{ email: normalizedEmail }, { username: normalizedUsername }],
        }).session(session)
        if (duplicate) {
          const error = new Error('Email or username already belongs to an LMS account.')
          error.statusCode = 409
          throw error
        }
        if ((await Promise.all([
          isDuplicateStudentId(normalizedStudentId, Student, session),
          isDuplicateStudentId(normalizedStudentId, CollegeStudent, session),
        ])).some(Boolean)) {
          const error = new Error('This student ID already exists.')
          error.statusCode = 409
          throw error
        }
        await AccountIdentity.create([{
          email: normalizedEmail,
          username: normalizedUsername,
          accountCollection: CollegeStudent.collection.name,
          accountId,
        }], { session })
        ;[student] = await CollegeStudent.create([{
          _id: accountId,
          fullName: fullName.trim(),
          email: normalizedEmail,
          username: normalizedUsername,
          studentId: normalizedStudentId,
          department: department?.trim() || undefined,
          batch: batch?.trim() || undefined,
          passwordHash,
          role: 'student',
          studentType: 'college',
          collegeId: subAdmin.collegeId,
          status: 'active',
          isActive: true,
          permissions: [],
        }], { session })
      })
    } finally {
      await session.endSession()
    }
    return res.status(201).json({
      message: 'College student created.',
      student: {
        id: String(student._id),
        fullName: student.fullName,
        email: student.email,
        studentId: student.studentId,
        department: student.department || '',
        batch: student.batch || '',
      },
    })
  } catch (error) {
    if (error?.statusCode === 409) {
      return res.status(409).json({ message: error.message })
    }
    return next(error)
  }
})

router.post('/college/students/import', ...requireCollegeAdmin, async (req, res, next) => {
  try {
    const subAdmin = await getAssignedCollegeAdmin(req)
    if (!subAdmin) {
      return res.status(403).json({ message: 'Your Sub-Admin account is not assigned to a valid college.' })
    }
    let rows
    try {
      rows = parseStudentCsv(req.body?.csvText)
    } catch (error) {
      return res.status(400).json({ message: error.message })
    }
    if (rows.length > 500) {
      return res.status(400).json({ message: 'Import is limited to 500 students per CSV.' })
    }

    const imported = []
    const failures = []
    const seenEmails = new Set()
    const seenStudentIds = new Set()
    for (const row of rows) {
      if (row.error) {
        failures.push({ row: row.rowNumber, reason: row.error })
        continue
      }

      const { fullName, studentId, email, department, batch } = row
      const username = makeImportUsername(studentId)
      const normalizedStudentId = String(studentId ?? '').trim().toLowerCase()
      const errors = []
      if (!fullName || fullName.length > 120) errors.push('Full Name is required and must be 120 characters or fewer.')
      if (!studentId?.trim() || studentId.trim().length > 100) errors.push('Student ID is required and must be 100 characters or fewer.')
      if (!emailPattern.test(email) || email.length > 254) errors.push('Enter a valid email address.')
      if (!department || department.length > 120) errors.push('Department is required and must be 120 characters or fewer.')
      if (!batch || batch.length > 80) errors.push('Batch is required and must be 80 characters or fewer.')
      if (seenEmails.has(email)) errors.push('Email is duplicated in this CSV.')
      if (seenStudentIds.has(normalizedStudentId)) errors.push('Student ID is duplicated in this CSV.')
      seenEmails.add(email)
      seenStudentIds.add(normalizedStudentId)
      if (!errors.length) {
        const [existingEmail, existingStudentId, existingUsername] = await Promise.all([
          accountIdentifierExists('email', email),
          isDuplicateStudentId(studentId.trim(), CollegeStudent),
          accountIdentifierExists('username', username),
        ])
        if (existingEmail) errors.push('Email already belongs to an LMS account.')
        if (existingStudentId) errors.push('Student ID already exists.')
        if (existingUsername) errors.push('Username (Student ID) conflicts with an LMS account.')
      }
      if (errors.length) {
        failures.push({ row: row.rowNumber, email, studentId, reason: errors.join(' ') })
        continue
      }

      const accountId = new mongoose.Types.ObjectId()
      const passwordHash = await bcrypt.hash(randomBytes(48).toString('base64url'), 12)
      const session = await mongoose.startSession()
      try {
        await session.withTransaction(async () => {
          await assertCollegeStudentCapacity(subAdmin.collegeId, session)
          await AccountIdentity.create([{
            email,
            username,
            accountCollection: CollegeStudent.collection.name,
            accountId,
          }], { session })
          await CollegeStudent.create([{
            _id: accountId,
            fullName,
            email,
            username,
            studentId: studentId.trim(),
            department,
            batch,
            passwordHash,
            role: 'student',
            studentType: 'college',
            collegeId: subAdmin.collegeId,
            status: 'active',
            isActive: true,
            permissions: [],
          }], { session })
        })
        imported.push({ row: row.rowNumber, email, studentId: studentId.trim() })
      } catch (error) {
        if (error?.statusCode === 409 || error?.code === 11000) {
          failures.push({ row: row.rowNumber, email, studentId, reason: error.message || 'Email, username, or Student ID already exists.' })
        } else {
          throw error
        }
      } finally {
        await session.endSession()
      }
    }
    return res.json({
      message: 'College student import completed. No invitation emails were sent.',
      summary: { total: rows.length, imported: imported.length, failed: failures.length },
      imported,
      failures,
    })
  } catch (error) {
    return next(error)
  }
})

router.get('/courses', ...requireStudent, async (req, res, next) => {
  try {
    const courses = await Course.find({ status: 'published' })
      .select('title description detailedDescription category difficulty thumbnailUrl learningObjectives prerequisites estimatedDurationMinutes modules assignments quizzes status createdAt')
      .sort({ title: 1 })
      .lean()
    return res.json({ courses: courses.map(hideQuizAnswers) })
  } catch (error) {
    return next(error)
  }
})

router.get('/learning/summary', ...requireStudent, async (req, res, next) => {
  try {
    const scope = req.auth.user.studentType === 'college'
      ? { collegeId: req.auth.user.collegeId }
      : { collegeId: { $exists: false } }
    const enrollmentQuery = {
      userId: req.auth.id,
      ...scope,
      status: { $ne: 'cancelled' },
    }
    const enrollments = await Enrollment.find(enrollmentQuery)
      .populate('courseId', 'modules assignments')
      .sort({ createdAt: -1 })
      .lean()
    const assignmentSubmissions = enrollments.length
      ? await AssignmentSubmission.find({
        userId: req.auth.id,
        enrollmentId: { $in: enrollments.map((enrollment) => enrollment._id) },
      }).select('enrollmentId assignmentId').lean()
      : []
    return res.json({ summary: summarizeStudentLearning(enrollments, assignmentSubmissions) })
  } catch (error) {
    return next(error)
  }
})

async function handleGetStudentActivities(req, res, next) {
  try {
    const scope = getStudentEnrollmentScope(req)
    const enrollments = await Enrollment.find({
      userId: req.auth.id,
      ...scope,
      status: { $ne: 'cancelled' },
    })
      .populate('courseId', 'title category difficulty thumbnailUrl modules assignments quizzes status')
      .sort({ createdAt: -1 })
      .lean()

    const validEnrollments = enrollments.filter((e) => e.courseId && typeof e.courseId === 'object')
    const enrollmentIds = validEnrollments.map((e) => e._id)

    // Batch fetch student attempts and submissions
    const [allQuizAttempts, allAssignmentSubmissions] = await Promise.all([
      safeFindQuizAttempts(
        { userId: req.auth.id, enrollmentId: { $in: enrollmentIds } },
        '_id enrollmentId courseId quizId status startedAt scorePercentage earnedPoints totalPoints correctAnswers incorrectAnswers passed submittedAt createdAt',
      ),
      safeFindAssignmentSubmissions(
        { userId: req.auth.id, enrollmentId: { $in: enrollmentIds } },
        '_id enrollmentId courseId assignmentId fileName fileSize contentType status grade feedback submittedAt',
      ),
    ])

    // Group attempts by enrollmentId + quizId
    const attemptsByQuiz = new Map()
    for (const qa of allQuizAttempts || []) {
      const key = `${qa.enrollmentId}:${qa.quizId}`
      const list = attemptsByQuiz.get(key) || []
      list.push(qa)
      attemptsByQuiz.set(key, list)
    }

    // Group submissions by enrollmentId + assignmentId
    const submissionsByAssignment = new Map()
    for (const as of allAssignmentSubmissions || []) {
      const key = `${as.enrollmentId}:${as.assignmentId}`
      const list = submissionsByAssignment.get(key) || []
      list.push(as)
      submissionsByAssignment.set(key, list)
    }

    const now = new Date()
    const activities = []

    for (const enrollment of validEnrollments) {
      const course = enrollment.courseId
      const courseId = String(course._id)
      const courseName = course.title || 'Untitled Course'

      const sequence = buildCourseActivitySequence(course)
      const activityItems = sequence.filter((item) => item.type === 'quiz' || item.type === 'assessment')

      for (const item of activityItems) {
        if (item.type === 'quiz') {
          const quizId = String(item.quizId || item.id)
          const attempts = attemptsByQuiz.get(`${enrollment._id}:${quizId}`) || []
          attempts.sort((a, b) => new Date(b.submittedAt || b.createdAt || b.startedAt) - new Date(a.submittedAt || a.createdAt || a.startedAt))

          const passedAttempt = attempts.find((a) => a.passed === true)
          const latestAttempt = attempts[0] || null
          const isPassed = Boolean(passedAttempt)
          const hasInProgress = attempts.some((a) => a.status === 'started')
          const isFailed = !isPassed && attempts.some((a) => a.status === 'submitted' && a.passed === false)

          let status = 'pending'
          if (isPassed) {
            status = 'completed'
          } else if (hasInProgress) {
            status = 'in_progress'
          } else if (isFailed) {
            status = 'failed'
          }

          const dueDate = item.dueDate ? new Date(item.dueDate) : null
          const isOverdue = !isPassed && Boolean(dueDate && dueDate < now)

          let score = null
          if (isPassed) {
            score = `${passedAttempt.scorePercentage ?? latestAttempt?.scorePercentage ?? 0}%`
          } else if (latestAttempt && latestAttempt.scorePercentage != null) {
            score = `${latestAttempt.scorePercentage}%`
          }

          activities.push({
            id: quizId,
            activityId: quizId,
            type: 'quiz',
            title: item.title || `Quiz ${item.quizIndex || ''}`.trim(),
            courseId,
            courseName,
            enrollmentId: String(enrollment._id),
            moduleId: item.moduleId ? String(item.moduleId) : null,
            moduleTitle: item.moduleTitle || 'Course Checkpoint',
            status,
            score,
            earnedPoints: latestAttempt?.earnedPoints ?? null,
            totalPoints: latestAttempt?.totalPoints ?? (item.questions?.length || null),
            passingPercentage: item.passingPercentage || 70,
            maxAttempts: item.maxAttempts || 3,
            attemptsCount: attempts.filter((a) => a.status === 'submitted').length,
            timeLimitMinutes: item.timeLimitMinutes || 0,
            dueDate: item.dueDate || null,
            isOverdue,
            latestAttempt: latestAttempt ? {
              _id: String(latestAttempt._id),
              status: latestAttempt.status,
              scorePercentage: latestAttempt.scorePercentage,
              passed: latestAttempt.passed,
              submittedAt: latestAttempt.submittedAt,
            } : null,
            navigationUrl: `/student/course/${encodeURIComponent(courseId)}/learn?activity=${encodeURIComponent(quizId)}&type=quiz`,
          })
        } else if (item.type === 'assessment') {
          const assignmentId = String(item.assignmentId || item.id)
          const submissions = submissionsByAssignment.get(`${enrollment._id}:${assignmentId}`) || []
          submissions.sort((a, b) => new Date(b.submittedAt || b.createdAt) - new Date(a.submittedAt || a.createdAt))
          const latestSubmission = submissions[0] || null

          const isSubmitted = Boolean(latestSubmission)
          const dueDate = item.dueDate ? new Date(item.dueDate) : null
          const isOverdue = !isSubmitted && Boolean(dueDate && dueDate < now)

          let status = 'pending'
          if (isSubmitted) {
            status = (latestSubmission.grade != null || latestSubmission.status === 'graded') ? 'graded' : (latestSubmission.status || 'submitted')
          } else if (isOverdue) {
            status = 'overdue'
          }

          let score = null
          if (latestSubmission && (latestSubmission.grade != null || latestSubmission.score != null)) {
            score = `${latestSubmission.grade ?? latestSubmission.score} / ${item.points || 100}`
          }

          activities.push({
            id: assignmentId,
            activityId: assignmentId,
            type: 'assignment',
            title: item.title || `Assignment ${item.assessmentIndex || ''}`.trim(),
            description: item.description || '',
            courseId,
            courseName,
            enrollmentId: String(enrollment._id),
            moduleId: item.moduleId ? String(item.moduleId) : null,
            moduleTitle: item.moduleTitle || 'Practical Milestone',
            status,
            score,
            points: item.points || 100,
            dueDate: item.dueDate || null,
            isOverdue,
            latestSubmission: latestSubmission ? {
              _id: String(latestSubmission._id),
              fileName: latestSubmission.fileName,
              fileSize: latestSubmission.fileSize,
              submittedAt: latestSubmission.submittedAt,
            } : null,
            navigationUrl: `/student/course/${encodeURIComponent(courseId)}/learn?activity=${encodeURIComponent(assignmentId)}&type=assignment`,
          })
        }
      }
    }

    const uniqueActivities = []
    const seen = new Set()
    for (const act of activities) {
      const key = `${act.enrollmentId}:${act.id}`
      if (!seen.has(key)) {
        seen.add(key)
        uniqueActivities.push(act)
      }
    }

    const totalActivities = uniqueActivities.length
    const completedActivities = uniqueActivities.filter((a) => a.status === 'completed' || a.status === 'submitted' || a.status === 'graded').length
    const remainingActivities = totalActivities - completedActivities
    const overdueActivities = uniqueActivities.filter((a) => a.isOverdue || a.status === 'overdue').length

    const quizzes = uniqueActivities.filter((a) => a.type === 'quiz')
    const totalQuizzes = quizzes.length
    const completedQuizzes = quizzes.filter((q) => q.status === 'completed').length
    const remainingQuizzes = totalQuizzes - completedQuizzes
    const quizCompletionPercentage = totalQuizzes > 0 ? Math.round((completedQuizzes / totalQuizzes) * 100) : 0

    const assignments = uniqueActivities.filter((a) => a.type === 'assignment')
    const totalAssignments = assignments.length
    const completedAssignments = assignments.filter((a) => a.status === 'submitted' || a.status === 'graded').length
    const remainingAssignments = totalAssignments - completedAssignments
    const assignmentCompletionPercentage = totalAssignments > 0 ? Math.round((completedAssignments / totalAssignments) * 100) : 0

    return res.json({
      summary: {
        total: totalActivities,
        completed: completedActivities,
        remaining: remainingActivities,
        overdue: overdueActivities,
      },
      quizStats: {
        total: totalQuizzes,
        completed: completedQuizzes,
        remaining: remainingQuizzes,
        percentage: quizCompletionPercentage,
      },
      assignmentStats: {
        total: totalAssignments,
        completed: completedAssignments,
        remaining: remainingAssignments,
        percentage: assignmentCompletionPercentage,
      },
      activities: uniqueActivities,
    })
  } catch (error) {
    return next(error)
  }
}

router.get('/learning/activities', ...requireStudent, handleGetStudentActivities)
router.get('/learning/quizzes-and-assignments', ...requireStudent, handleGetStudentActivities)

function sanitizeCourseOverview(course) {
  if (!course) return null
  let instructorName = 'aiHustle Certified Instructor'
  let instructorEmail = ''
  if (course.instructor && typeof course.instructor === 'object') {
    instructorName = course.instructor.name || instructorName
    instructorEmail = course.instructor.email || instructorEmail
  } else if (course.createdBy && typeof course.createdBy === 'object') {
    instructorName = course.createdBy.fullName || course.createdBy.name || course.createdBy.username || instructorName
    instructorEmail = course.createdBy.email || instructorEmail
  }
  return {
    _id: String(course._id),
    title: course.title || 'Untitled Course',
    description: course.description || '',
    detailedDescription: course.detailedDescription || course.description || '',
    category: course.category || 'Other',
    difficulty: course.difficulty || 'beginner',
    thumbnailUrl: course.thumbnailUrl || '',
    learningObjectives: Array.isArray(course.learningObjectives) ? course.learningObjectives : [],
    prerequisites: Array.isArray(course.prerequisites) ? course.prerequisites : [],
    targetAudience: course.targetAudience || 'Beginners, professionals, and students seeking practical skills.',
    estimatedDurationMinutes: Number(course.estimatedDurationMinutes) || 0,
    instructor: {
      name: instructorName,
      email: instructorEmail,
    },
    status: course.status || 'published',
  }
}

function buildCurriculumOverview(course, sequence = [], isEnrolled = false) {
  const modules = []
  for (let mIdx = 0; mIdx < (course.modules || []).length; mIdx += 1) {
    const mod = course.modules[mIdx]
    const moduleId = String(mod._id || `mod-${mIdx}`)
    const moduleTitle = mod.title || `Module ${mIdx + 1}`
    const moduleDesc = mod.description || ''

    const moduleSequenceItems = sequence.filter((item) => String(item.moduleId) === moduleId)
    
    let items = []
    if (moduleSequenceItems.length > 0) {
      items = moduleSequenceItems.map((seqItem) => ({
        id: String(seqItem.id),
        type: seqItem.type,
        title: seqItem.title || (seqItem.type === 'video-lesson' ? 'Video Lesson' : seqItem.type === 'quiz' ? 'Quiz Checkpoint' : 'Assessment Milestone'),
        description: seqItem.description || '',
        durationSeconds: Number(seqItem.durationSeconds) || 0,
        points: Number(seqItem.points) || 0,
        passingPercentage: seqItem.passingPercentage || null,
        isCompleted: isEnrolled ? Boolean(seqItem.isCompleted) : false,
        isFailed: isEnrolled ? Boolean(seqItem.isFailed) : false,
        isSubmitted: isEnrolled ? Boolean(seqItem.isSubmitted) : false,
      }))
    } else {
      const videoItems = (mod.contentItems || []).filter((i) => i.type === 'video-lesson')
      const lessons = videoItems.length ? videoItems : mod.lessons || []
      items = lessons.map((l) => ({
        id: String(l._id),
        type: 'video-lesson',
        title: l.title || 'Lesson',
        description: l.content ? l.content.slice(0, 150) : '',
        durationSeconds: Number(l.durationSeconds) || 0,
        points: 0,
        isCompleted: false,
        isFailed: false,
        isSubmitted: false,
      }))
    }

    modules.push({
      moduleId,
      title: moduleTitle,
      description: moduleDesc,
      itemCount: items.length,
      items,
    })
  }

  return modules
}

async function handleGetCourseDetails(req, res, next) {
  try {
    let { courseId } = req.params
    if (typeof courseId === 'string') {
      courseId = courseId.trim().replace(/\/details\/?$/, '').trim()
    }
    if (!isValidObjectId(courseId)) {
      return res.status(400).json({ message: 'Select a valid course.' })
    }

    let course = null
    try {
      course = await Course.findById(courseId)
        .populate('createdBy', 'fullName name username email')
        .lean()
    } catch {
      course = await Course.findById(courseId).lean().catch(() => null)
    }

    if (!course && isValidObjectId(courseId)) {
      // If courseId happens to be an enrollment ID, resolve the course from enrollment
      const enr = await safeFindEnrollmentById(courseId)
      if (enr?.courseId) {
        try {
          course = await Course.findById(enr.courseId)
            .populate('createdBy', 'fullName name username email')
            .lean()
        } catch {
          course = await Course.findById(enr.courseId).lean().catch(() => null)
        }
        if (course) {
          courseId = String(course._id)
        }
      }
    }

    if (!course) {
      return res.status(404).json({ message: 'Course not found.' })
    }

    const sequence = buildCourseActivitySequence(course)
    const videoLessons = sequence.filter((item) => item.type === 'video-lesson')
    const quizzes = sequence.filter((item) => item.type === 'quiz')
    const assessments = sequence.filter((item) => item.type === 'assessment')

    let lessonCount = videoLessons.length
    if (lessonCount === 0 && Array.isArray(course.modules)) {
      lessonCount = course.modules.reduce((acc, m) => {
        const items = m.contentItems || []
        const vItems = items.filter((i) => i.type === 'video-lesson')
        return acc + (vItems.length || (m.lessons || []).length)
      }, 0)
    }

    let quizCount = quizzes.length
    if (quizCount === 0) {
      quizCount = (course.quizzes?.length || 0) + (course.modules || []).reduce((acc, m) => acc + (m.quiz ? 1 : 0), 0)
    }

    let assignmentCount = assessments.length
    if (assignmentCount === 0) {
      assignmentCount = (course.assignments?.length || 0) + (course.modules || []).reduce((acc, m) => {
        const aItems = (m.contentItems || []).filter((i) => i.type === 'assignment')
        return acc + aItems.length
      }, 0)
    }

    const counts = {
      modules: course.modules?.length || 0,
      lessons: lessonCount,
      quizzes: quizCount,
      assignments: assignmentCount,
      assessments: assignmentCount,
      durationMinutes: course.estimatedDurationMinutes || 0,
    }

    const enrollmentQuery = {
      userId: req.auth.id,
      courseId: course._id,
      status: { $ne: 'cancelled' },
    }
    if (req.auth?.user?.studentType === 'college' && req.auth.user.collegeId) {
      enrollmentQuery.collegeId = req.auth.user.collegeId
    }
    const enrollment = await Enrollment.findOne(enrollmentQuery).sort({ createdAt: -1 })

    if (enrollment) {
      const [assignmentSubmissions, quizAttempts, progressDoc] = await Promise.all([
        safeFindAssignmentSubmissions({ userId: req.auth.id, enrollmentId: enrollment._id }),
        safeFindQuizAttempts({ userId: req.auth.id, enrollmentId: enrollment._id }),
        safeFindProgressOne({
          $or: [
            { userId: req.auth.id, courseId: course._id },
            { studentId: req.auth.id, courseId: course._id },
          ],
        }),
      ])

      const progress = calculateCourseProgress({
        course,
        enrollment,
        progress: progressDoc,
        quizAttempts,
        assignmentSubmissions,
      })

      if (progress.isCompleted && enrollment.status !== 'completed') {
        enrollment.status = 'completed'
        enrollment.completedAt = enrollment.completedAt || new Date()
        await enrollment.save().catch(() => {})
      }

      let certificate = null
      if (progress.isCompleted || enrollment.status === 'completed') {
        certificate = await Certificate.findOne({
          userId: req.auth.id,
          courseId: course._id,
          status: 'issued',
        }).lean().catch(() => null)

        if (!certificate) {
          try {
            const certId = `AH-${new Date().getFullYear()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`
            const studentName = req.auth?.user?.fullName || req.auth?.user?.name || req.auth?.user?.username || req.auth?.name || 'Student'
            const [createdCert] = await Certificate.create([{
              certificateId: certId,
              userId: req.auth.id,
              collegeId: enrollment.collegeId || null,
              courseId: course._id,
              enrollmentId: enrollment._id,
              studentName,
              studentEmail: req.auth?.user?.email || '',
              courseTitle: course.title,
              courseCategory: course.category || 'Professional Certification',
              issueDate: new Date(),
              completionDate: enrollment.completedAt || new Date(),
              verificationUrl: `/student/certificates/verify/${certId}`,
              status: 'issued',
              metadata: {
                totalLessons: progress.videoStats?.total || lessonCount,
                totalQuizzes: progress.quizStats?.total || quizCount,
                totalAssessments: progress.assessmentStats?.total || assignmentCount,
              },
            }])
            certificate = createdCert?.toObject ? createdCert.toObject() : createdCert
          } catch {
            // non-fatal
          }
        }
      }

      return res.json({
        isEnrolled: true,
        enrollment: {
          _id: String(enrollment._id),
          status: enrollment.status,
          enrolledAt: enrollment.createdAt,
          completedAt: enrollment.completedAt,
          isCompleted: Boolean(progress.isCompleted || enrollment.status === 'completed'),
          progressPercentage: progress.progressPercentage || 0,
        },
        course: sanitizeCourseOverview(course),
        counts,
        curriculum: buildCurriculumOverview(course, progress.sequence, true),
        progress: {
          progressPercentage: progress.progressPercentage || 0,
          totalRequiredActivities: progress.totalRequiredActivities || 0,
          completedActivities: progress.completedActivities || 0,
          isCompleted: Boolean(progress.isCompleted || enrollment.status === 'completed'),
          videoStats: progress.videoStats || { total: lessonCount, completed: 0 },
          quizStats: progress.quizStats || { total: quizCount, completed: 0 },
          assessmentStats: progress.assessmentStats || { total: assignmentCount, completed: 0 },
          nextActivity: progress.nextActivity || null,
        },
        certificate: certificate ? {
          certificateId: certificate.certificateId,
          studentName: certificate.studentName,
          courseTitle: certificate.courseTitle,
          courseCategory: certificate.courseCategory,
          issueDate: certificate.issueDate,
          completionDate: certificate.completionDate,
          verificationUrl: certificate.verificationUrl,
        } : null,
        canUnenroll: Boolean(!progress.isCompleted && enrollment.status !== 'completed'),
      })
    }

    return res.json({
      isEnrolled: false,
      enrollment: null,
      course: sanitizeCourseOverview(course),
      counts,
      curriculum: buildCurriculumOverview(course, sequence, false),
      progress: null,
      certificate: null,
      canUnenroll: false,
    })
  } catch (error) {
    return next(error)
  }
}

async function handleEnrollCourse(req, res, next) {
  try {
    const courseId = req.params.courseId || req.body?.courseId
    if (!isValidObjectId(courseId)) {
      return res.status(400).json({ message: 'Select a valid course.' })
    }

    if (req.auth.user.studentType !== 'independent' || req.auth.user.collegeId) {
      return res.status(403).json({ message: 'College students must be enrolled by their college sub-admin.' })
    }

    const student = await Student.findOne({ _id: req.auth.id, role: 'student', studentType: 'independent' })
      .select('_id fullName username email')
      .lean()
    if (!student) return res.status(404).json({ message: 'The student account was not found.' })

    const course = await Course.findOne({ _id: courseId, status: 'published' }).select('_id title')
    if (!course) return res.status(404).json({ message: 'The published course was not found.' })

    const existing = await Enrollment.findOne({
      userId: student._id,
      courseId: course._id,
    }).sort({ createdAt: -1 })

    if (existing && existing.status !== 'cancelled') {
      return res.status(409).json({ message: 'You are already enrolled in this course.' })
    }

    let enrollment
    if (existing && existing.status === 'cancelled') {
      existing.status = 'active'
      existing.assignedBy = student._id
      await existing.save()
      enrollment = existing
    } else {
      const [created] = await Enrollment.create([{
        userId: student._id,
        courseId: course._id,
        assignedBy: student._id,
        status: 'active',
      }])
      enrollment = created
    }

    return res.status(201).json({ message: 'You are now enrolled in this course.', enrollment })
  } catch (error) {
    return next(error)
  }
}

async function handleUnenrollCourse(req, res, next) {
  try {
    let courseId = req.params.courseId || req.body?.courseId
    if (typeof courseId === 'string') {
      courseId = courseId.trim().replace(/\/details\/?$/, '').trim()
    }
    if (!isValidObjectId(courseId)) {
      return res.status(400).json({ message: 'Select a valid course.' })
    }

    const enrollmentQuery = {
      userId: req.auth.id,
      courseId,
      status: { $ne: 'cancelled' },
    }
    if (req.auth?.user?.studentType === 'college' && req.auth.user.collegeId) {
      enrollmentQuery.collegeId = req.auth.user.collegeId
    }

    let enrollment = await Enrollment.findOne(enrollmentQuery)
    if (!enrollment) {
      // Check if courseId was passed as enrollmentId
      enrollment = await Enrollment.findOne({
        _id: courseId,
        userId: req.auth.id,
        status: { $ne: 'cancelled' },
      })
    }

    if (!enrollment) {
      return res.status(404).json({ message: 'No active enrollment found for this course.' })
    }

    if (enrollment.status === 'completed') {
      return res.status(400).json({ message: 'Completed courses cannot be unenrolled.' })
    }

    const targetCourseId = enrollment.courseId
    const course = await Course.findById(targetCourseId).lean().catch(() => null)
    if (course) {
      const [assignmentSubmissions, quizAttempts, progressDoc] = await Promise.all([
        safeFindAssignmentSubmissions({ userId: req.auth.id, enrollmentId: enrollment._id }),
        safeFindQuizAttempts({ userId: req.auth.id, enrollmentId: enrollment._id }),
        safeFindProgressOne({
          $or: [
            { userId: req.auth.id, courseId: course._id },
            { studentId: req.auth.id, courseId: course._id },
          ],
        }),
      ])

      const progress = calculateCourseProgress({
        course,
        enrollment,
        progress: progressDoc,
        quizAttempts,
        assignmentSubmissions,
      })

      if (progress.isCompleted) {
        enrollment.status = 'completed'
        enrollment.completedAt = enrollment.completedAt || new Date()
        await enrollment.save().catch(() => {})
        return res.status(400).json({ message: 'Completed courses cannot be unenrolled.' })
      }
    }

    enrollment.status = 'cancelled'
    await enrollment.save()

    return res.json({ message: 'Successfully unenrolled from the course.', enrollmentId: enrollment._id })
  } catch (error) {
    return next(error)
  }
}

async function handleGetCourseProgress(req, res, next) {
  try {
    let { courseId } = req.params
    if (typeof courseId === 'string') {
      courseId = courseId.trim().replace(/\/details\/?$/, '').trim()
    }
    if (!isValidObjectId(courseId)) {
      return res.status(400).json({ message: 'Select a valid course.' })
    }

    let course = await Course.findById(courseId).lean().catch(() => null)
    if (!course && isValidObjectId(courseId)) {
      const enr = await safeFindEnrollmentById(courseId)
      if (enr?.courseId) {
        course = await Course.findById(enr.courseId).lean().catch(() => null)
      }
    }
    if (!course) return res.status(404).json({ message: 'Course not found.' })

    const enrollmentQuery = {
      userId: req.auth.id,
      courseId: course._id,
      status: { $ne: 'cancelled' },
    }
    if (req.auth?.user?.studentType === 'college' && req.auth.user.collegeId) {
      enrollmentQuery.collegeId = req.auth.user.collegeId
    }
    let enrollment = await Enrollment.findOne(enrollmentQuery)
    if (!enrollment) {
      enrollment = await Enrollment.findOne({
        _id: courseId,
        userId: req.auth.id,
        status: { $ne: 'cancelled' },
      })
    }

    if (!enrollment) {
      return res.status(404).json({ message: 'You are not enrolled in this course.' })
    }

    const [assignmentSubmissions, quizAttempts, progressDoc] = await Promise.all([
      safeFindAssignmentSubmissions({ userId: req.auth.id, enrollmentId: enrollment._id }),
      safeFindQuizAttempts({ userId: req.auth.id, enrollmentId: enrollment._id }),
      safeFindProgressOne({
        $or: [
          { userId: req.auth.id, courseId: course._id },
          { studentId: req.auth.id, courseId: course._id },
        ],
      }),
    ])

    const progress = calculateCourseProgress({
      course,
      enrollment,
      progress: progressDoc,
      quizAttempts,
      assignmentSubmissions,
    })

    return res.json({
      isEnrolled: true,
      enrollmentId: enrollment._id,
      progress,
    })
  } catch (error) {
    return next(error)
  }
}

async function handleGetCourseCertificate(req, res, next) {
  try {
    let { courseId } = req.params
    if (typeof courseId === 'string') {
      courseId = courseId.trim().replace(/\/details\/?$/, '').trim()
    }
    if (!isValidObjectId(courseId)) {
      return res.status(400).json({ message: 'Select a valid course.' })
    }

    let course = await Course.findById(courseId).lean().catch(() => null)
    if (!course && isValidObjectId(courseId)) {
      const enr = await safeFindEnrollmentById(courseId)
      if (enr?.courseId) {
        course = await Course.findById(enr.courseId).lean().catch(() => null)
      }
    }
    if (!course) return res.status(404).json({ message: 'Course not found.' })

    const enrollmentQuery = {
      userId: req.auth.id,
      courseId: course._id,
      status: { $ne: 'cancelled' },
    }
    if (req.auth?.user?.studentType === 'college' && req.auth.user.collegeId) {
      enrollmentQuery.collegeId = req.auth.user.collegeId
    }
    let enrollment = await Enrollment.findOne(enrollmentQuery)
    if (!enrollment) {
      enrollment = await Enrollment.findOne({
        _id: courseId,
        userId: req.auth.id,
        status: { $ne: 'cancelled' },
      })
    }

    if (!enrollment) {
      return res.status(404).json({ message: 'You are not enrolled in this course.' })
    }

    const [assignmentSubmissions, quizAttempts, progressDoc] = await Promise.all([
      safeFindAssignmentSubmissions({ userId: req.auth.id, enrollmentId: enrollment._id }),
      safeFindQuizAttempts({ userId: req.auth.id, enrollmentId: enrollment._id }),
      safeFindProgressOne({
        $or: [
          { userId: req.auth.id, courseId: course._id },
          { studentId: req.auth.id, courseId: course._id },
        ],
      }),
    ])

    const progress = calculateCourseProgress({
      course,
      enrollment,
      progress: progressDoc,
      quizAttempts,
      assignmentSubmissions,
    })

    if (!progress.isCompleted && enrollment.status !== 'completed') {
      return res.status(403).json({
        message: 'Certificate is only available upon successful completion of all required course activities.',
      })
    }

    let certificate = await Certificate.findOne({
      userId: req.auth.id,
      courseId: course._id,
      status: 'issued',
    }).lean().catch(() => null)

    if (!certificate) {
      try {
        const certId = `AH-${new Date().getFullYear()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`
        const studentName = req.auth?.user?.fullName || req.auth?.user?.name || req.auth?.user?.username || req.auth?.name || 'Student'
        const [createdCert] = await Certificate.create([{
          certificateId: certId,
          userId: req.auth.id,
          collegeId: enrollment.collegeId || null,
          courseId: course._id,
          enrollmentId: enrollment._id,
          studentName,
          studentEmail: req.auth?.user?.email || '',
          courseTitle: course.title,
          courseCategory: course.category || 'Professional Certification',
          issueDate: new Date(),
          completionDate: enrollment.completedAt || new Date(),
          verificationUrl: `/student/certificates/verify/${certId}`,
          status: 'issued',
          metadata: {
            totalLessons: progress.videoStats.total,
            totalQuizzes: progress.quizStats.total,
            totalAssessments: progress.assessmentStats.total,
          },
        }])
        certificate = createdCert?.toObject ? createdCert.toObject() : createdCert
      } catch {
        // non-fatal
      }
    }

    return res.json({ certificate })
  } catch (error) {
    return next(error)
  }
}

async function handleGetStudentCertificates(req, res, next) {
  try {
    const certificates = await Certificate.find({
      userId: req.auth.id,
      status: 'issued',
    })
      .populate('courseId', 'title category thumbnailUrl difficulty')
      .sort({ issueDate: -1 })
      .lean()

    return res.json({ certificates })
  } catch (error) {
    return next(error)
  }
}

router.get('/courses/:courseId', ...requireStudent, handleGetCourseDetails)
router.get('/courses/:courseId/details', ...requireStudent, handleGetCourseDetails)
router.get('/student/courses/:courseId', ...requireStudent, handleGetCourseDetails)
router.get('/student/courses/:courseId/details', ...requireStudent, handleGetCourseDetails)
router.post('/courses/:courseId/enroll', ...requireStudent, handleEnrollCourse)
router.post('/student/courses/:courseId/enroll', ...requireStudent, handleEnrollCourse)
router.post('/courses/:courseId/unenroll', ...requireStudent, handleUnenrollCourse)
router.post('/student/courses/:courseId/unenroll', ...requireStudent, handleUnenrollCourse)
router.post('/enrollments/:courseId/unenroll', ...requireStudent, handleUnenrollCourse)
router.get('/courses/:courseId/progress', ...requireStudent, handleGetCourseProgress)
router.get('/student/courses/:courseId/progress', ...requireStudent, handleGetCourseProgress)
router.get('/courses/:courseId/certificate', ...requireStudent, handleGetCourseCertificate)
router.get('/student/courses/:courseId/certificate', ...requireStudent, handleGetCourseCertificate)
router.get('/student/certificates', ...requireStudent, handleGetStudentCertificates)
router.get('/certificates/me', ...requireStudent, handleGetStudentCertificates)

router.get('/courses/:courseId/learning-content', ...requireStudent, async (req, res, next) => {
  try {
    const { courseId } = req.params
    if (!isValidObjectId(courseId)) return res.status(400).json({ message: 'Select a valid course.' })
    const enrollmentQuery = {
      userId: req.auth.id,
      courseId,
      ...getStudentEnrollmentScope(req),
      status: { $ne: 'cancelled' },
    }
    const enrollment = await Enrollment.findOne(enrollmentQuery).sort({ createdAt: -1 }).lean()
    if (!enrollment) return res.status(404).json({ message: 'Enroll in this course before accessing its content.' })
    const course = await Course.findById(courseId)
      .select('+modules.quiz.questions.correctOptionIndices +modules.contentItems.quiz.questions.correctOptionIndices +quizzes.questions.correctOptionIndex')
      .lean()
    if (!course) return res.status(404).json({ message: 'The enrolled course could not be found.' })

    try {
      if (mongoose.connection.readyState !== 0 || Resource.find !== mongoose.Model.find) {
        const extraResources = await Resource.find({ courseId }).lean()
        if (extraResources?.length) {
          course.resources = [...(course.resources || []), ...extraResources]
        }
      }
    } catch {
      // safe fallback
    }

    const [assignmentSubmissions, quizAttempts] = await Promise.all([
      (mongoose.connection.readyState === 0 && AssignmentSubmission.find === mongoose.Model.find
        ? Promise.resolve([])
        : AssignmentSubmission.find({ userId: req.auth.id, enrollmentId: enrollment._id })
            .select('_id assignmentId fileName contentType fileSize submittedAt reviewStatus reviewedAt reviewComment marksObtained evaluationStatus correctness feedback evaluatedAt')
            .sort({ submittedAt: -1, _id: -1 })
            .lean()),
      (mongoose.connection.readyState === 0 && QuizAttempt.find === mongoose.Model.find
        ? Promise.resolve([])
        : QuizAttempt.find({ userId: req.auth.id, enrollmentId: enrollment._id })
            .select('_id quizId status startedAt passingPercentage timeLimitMinutes timeTakenSeconds answers earnedPoints totalPoints correctAnswers incorrectAnswers scorePercentage passed submittedAt createdAt +questionSnapshot')
            .sort({ createdAt: -1 })
            .lean()),
    ])

    let prog = null
    try {
      prog = await safeFindProgressOne({ userId: req.auth.id, courseId })
    } catch {
      // Safe fallback
    }

    const completedIdsSet = new Set((enrollment.completedLessonIds || []).map(String))
    if (prog?.completedLessons) {
      for (const cl of prog.completedLessons) {
        if (cl.lessonId) completedIdsSet.add(String(cl.lessonId))
      }
    }

    const originalCompletedIds = enrollment.completedLessonIds || []
    const originalCompletedSet = new Set(originalCompletedIds.map(String))
    const additionalCompletedIds = [...completedIdsSet].filter((id) => !originalCompletedSet.has(id))
    const mergedCompletedLessonIds = [...originalCompletedIds, ...additionalCompletedIds]

    const courseProgress = calculateCourseProgress({
      course,
      enrollment: { ...enrollment, completedLessonIds: mergedCompletedLessonIds },
      progress: prog,
      quizAttempts,
      assignmentSubmissions,
    })

    const status = courseProgress.status
    const completedAt = courseProgress.isCompleted
      ? (enrollment.completedAt || new Date())
      : null

    if (courseProgress.isCompleted && enrollment.status !== 'completed') {
      try {
        await Enrollment.updateOne(
          { _id: enrollment._id },
          { $set: { status: 'completed', completedAt } },
        )
      } catch {
        // Safe fallback
      }
    }

    return res.json({
      enrollment: {
        ...enrollment,
        status,
        completedAt,
        completedLessonIds: mergedCompletedLessonIds,
        courseId: hideQuizAnswers(course),
      },
      progress: courseProgress,
      assignmentSubmissions,
      quizAttempts: quizAttempts.map(serializeQuizAttempt),
    })
  } catch (error) {
    return next(error)
  }
})

router.post('/courses/:courseId/quizzes/:quizId/attempts/start', ...requireStudent, async (req, res, next) => {
  try {
    const { courseId, quizId } = req.params
    if (!isValidObjectId(courseId) || !isValidObjectId(quizId)) {
      return res.status(400).json({ message: 'Select a valid course and quiz.' })
    }
    const enrollment = await Enrollment.findOne({
      userId: req.auth.id,
      courseId,
      ...getStudentEnrollmentScope(req),
      status: { $ne: 'cancelled' },
    }).sort({ createdAt: -1 }).lean()
    if (!enrollment) return res.status(404).json({ message: 'An active enrollment is required to submit this quiz.' })

    const course = await Course.findById(courseId)
      .select('+modules.quiz.questions.correctOptionIndices +modules.contentItems.quiz.questions.correctOptionIndices +quizzes.questions.correctOptionIndex')
      .lean()
    if (!course) return res.status(404).json({ message: 'The enrolled course could not be found.' })
    const quiz = findQuiz(course, quizId)
    if (!quiz || !Array.isArray(quiz.questions) || !quiz.questions.length) {
      return res.status(404).json({ message: 'This quiz is not available in the enrolled course.' })
    }
    const questionSnapshot = getQuizQuestionSnapshot(quiz)
    const stateKey = {
      userId: req.auth.id,
      courseId,
      quizId,
    }
    const now = new Date()
    const reservation = await reserveQuizAttempt(stateKey, now)
    if (reservation.reason) {
      const quizStatus = getQuizAttemptStatus(reservation.state, now)
      const message = reservation.reason === 'locked'
        ? 'This quiz is locked until the 24-hour cooldown ends.'
        : reservation.reason === 'passed'
          ? 'You have already passed this quiz.'
          : 'You have used all 3 attempts for this quiz.'
      return res.status(reservation.reason === 'locked' ? 423 : 409).json({ message, quizStatus })
    }

    const attempt = await QuizAttempt.create({
      userId: req.auth.id,
      ...(req.auth.user.studentType === 'college' ? { collegeId: req.auth.user.collegeId } : {}),
      enrollmentId: enrollment._id,
      courseId,
      quizId,
      cycleNumber: reservation.state.cycleNumber,
      attemptNumber: reservation.attemptNumber,
      status: 'started',
      startedAt: now,
      passingPercentage: Number.isFinite(quiz.passingPercentage) ? quiz.passingPercentage : 70,
      timeLimitMinutes: Number.isFinite(quiz.timeLimitMinutes) ? quiz.timeLimitMinutes : 0,
      questionSnapshot,
    })
    return res.status(201).json({
      attempt: {
        _id: attempt._id,
        quizId: attempt.quizId,
        status: attempt.status,
        startedAt: attempt.startedAt,
        passingPercentage: attempt.passingPercentage,
        timeLimitMinutes: attempt.timeLimitMinutes,
        answers: [],
        attemptsMade: reservation.attemptNumber,
        attemptNumber: reservation.attemptNumber,
        cycleNumber: reservation.state.cycleNumber,
        maxAttempts: quizAttemptLimit,
      },
      quizStatus: getQuizAttemptStatus(reservation.state, now),
      questions: getPublicQuestionSnapshot(questionSnapshot),
    })
  } catch (error) {
    if (error?.statusCode === 400) return res.status(400).json({ message: error.message })
    return next(error)
  }
})

router.post('/courses/:courseId/quizzes/:quizId/attempts/:attemptId/submit', ...requireStudent, async (req, res, next) => {
  try {
    const { courseId, quizId, attemptId } = req.params
    if (![courseId, quizId, attemptId].every(isValidObjectId)) {
      return res.status(400).json({ message: 'Select a valid course, quiz, and attempt.' })
    }
    const enrollment = await Enrollment.findOne({
      userId: req.auth.id,
      courseId,
      ...getStudentEnrollmentScope(req),
      status: { $ne: 'cancelled' },
    }).sort({ createdAt: -1 }).lean()
    if (!enrollment) return res.status(404).json({ message: 'An active enrollment is required to submit this quiz.' })

    const attempt = await QuizAttempt.findOne({
      _id: attemptId,
      userId: req.auth.id,
      enrollmentId: enrollment._id,
      courseId,
      quizId,
      status: 'started',
    }).select('+questionSnapshot')
    if (!attempt) return res.status(409).json({ message: 'This quiz attempt has already been submitted or is no longer available.' })

    const stateKey = {
      userId: req.auth.id,
      courseId,
      quizId,
    }
    const stateNow = new Date()
    const state = await getQuizAttemptState(stateKey, stateNow)
    const cycleNumber = attempt.cycleNumber || state.cycleNumber
    if (cycleNumber !== state.cycleNumber || state.passed) {
      return res.status(409).json({ message: 'This quiz attempt is no longer available.', quizStatus: getQuizAttemptStatus(state, stateNow) })
    }
    if (state.lockedUntil && new Date(state.lockedUntil) > stateNow) {
      return res.status(423).json({
        message: 'This quiz is locked until the 24-hour cooldown ends.',
        quizStatus: getQuizAttemptStatus(state, stateNow),
      })
    }
    const attemptNumber = attempt.attemptNumber || state.attemptsUsed

    const course = await Course.findById(courseId)
      .select('+modules.quiz.questions.correctOptionIndices +modules.contentItems.quiz.questions.correctOptionIndices +quizzes.questions.correctOptionIndex')
      .lean()
    if (!course) return res.status(404).json({ message: 'The enrolled course could not be found.' })
    const quiz = findQuiz(course, quizId)
    const questions = attempt.questionSnapshot?.length
      ? attempt.questionSnapshot.map((question) => ({
        _id: question.questionId,
        prompt: question.prompt,
        type: question.type,
        options: question.options,
        correctOptionIndices: question.correctOptionIndices,
        marks: question.marks,
        explanation: question.explanation,
      }))
      : quiz?.questions
    if (!Array.isArray(questions) || !questions.length) {
      return res.status(404).json({ message: 'This quiz is not available in the enrolled course.' })
    }

    const answers = req.body?.answers
    if (!Array.isArray(answers) || answers.length !== questions.length) {
      return res.status(400).json({ message: `Submit an answer for each of the ${questions.length} quiz questions, including unanswered questions.` })
    }
    const quizQuestionIds = new Set(questions.map((question) => canonicalObjectId(question._id)))
    const answerByQuestionId = new Map()
    for (const [answerIndex, answer] of answers.entries()) {
      const questionId = canonicalObjectId(answer?.questionId)
      if (
        !questionId
        || !Array.isArray(answer.selectedOptionIndices)
        || answer.selectedOptionIndices.some((index) => !Number.isInteger(index))
        || answerByQuestionId.has(questionId)
      ) {
        return res.status(400).json({ message: `The submitted answer for question ${answerIndex + 1} has an invalid question ID or answer format.` })
      }
      if (!quizQuestionIds.has(questionId)) {
        return res.status(400).json({ message: `The submitted answer for question ${answerIndex + 1} does not match a question in this quiz.` })
      }
      answerByQuestionId.set(questionId, answer.selectedOptionIndices)
    }

    let earnedPoints = 0
    let totalPoints = 0
    let correctAnswers = 0
    const savedAnswers = []
    for (const [questionIndex, question] of questions.entries()) {
      const questionId = canonicalObjectId(question._id)
      const selectedOptionIndices = answerByQuestionId.get(questionId)
      const correctOptionIndices = Array.isArray(question.correctOptionIndices) && question.correctOptionIndices.length > 0
        ? question.correctOptionIndices
        : Number.isInteger(question.correctOptionIndex) ? [question.correctOptionIndex] : null
      const questionLabel = `Question ${questionIndex + 1}${questionId ? ` (${questionId})` : ''}`
      const questionType = question.type || 'multiple-choice'
      if (!['multiple-choice', 'multiple-select', 'true-false'].includes(questionType)) {
        return res.status(400).json({ message: `${questionLabel} has unsupported question type "${questionType}".` })
      }
      const isMultipleSelect = questionType === 'multiple-select'
      if (
        !isValidObjectId(questionId)
      ) {
        return res.status(400).json({ message: `${questionLabel} is missing a valid saved question ID.` })
      }
      if (!Array.isArray(question.options) || question.options.length < 2 || question.options.some((option) => typeof option !== 'string' || !option.trim())) {
        return res.status(400).json({ message: `${questionLabel} has invalid answer options.` })
      }
      if (!Array.isArray(correctOptionIndices) || !correctOptionIndices.length) {
        return res.status(400).json({ message: `${questionLabel} has no saved correct answer indices.` })
      }
      if (correctOptionIndices.some((index) => !Number.isInteger(index) || index < 0 || index >= question.options.length)) {
        return res.status(400).json({ message: `${questionLabel} has a correct answer index outside its available options.` })
      }
      if (new Set(correctOptionIndices).size !== correctOptionIndices.length) {
        return res.status(400).json({ message: `${questionLabel} contains duplicate correct answer indices.` })
      }
      if (
        (isMultipleSelect && correctOptionIndices.length < 2)
        || (!isMultipleSelect && correctOptionIndices.length !== 1)
      ) {
        return res.status(400).json({ message: `${questionLabel} has a correct answer format that does not match its ${isMultipleSelect ? 'multiple-select' : 'single-select'} type.` })
      }
      if (!Array.isArray(selectedOptionIndices)) {
        return res.status(400).json({ message: `No submitted answer was found for ${questionLabel}.` })
      }
      if (selectedOptionIndices.some((index) => index < 0 || index >= question.options.length)) {
        return res.status(400).json({ message: `The submitted answer for ${questionLabel} contains an option index outside the available options.` })
      }
      const uniqueSelected = [...new Set(selectedOptionIndices)].sort((left, right) => left - right)
      if (uniqueSelected.length !== selectedOptionIndices.length) {
        return res.status(400).json({ message: `Do not select the same answer more than once for ${questionLabel}.` })
      }
      if (uniqueSelected.length && !isMultipleSelect && uniqueSelected.length !== 1) {
        return res.status(400).json({ message: `Choose exactly one answer for ${questionLabel}.` })
      }
      const expected = [...correctOptionIndices].sort((left, right) => left - right)
      const points = Number.isFinite(question.marks) && question.marks > 0 ? question.marks : 1
      totalPoints += points
      if (
        uniqueSelected.length === expected.length
        && uniqueSelected.every((index, answerIndex) => index === expected[answerIndex])
      ) {
        earnedPoints += points
        correctAnswers += 1
      }
      savedAnswers.push({
        questionId,
        selectedOptionIndices: uniqueSelected,
        correctOptionIndices: expected,
        explanation: question.explanation || '',
      })
    }

    const scorePercentage = Math.round((earnedPoints / totalPoints) * 100)
    const passingPercentage = Number.isFinite(attempt.passingPercentage)
      ? attempt.passingPercentage
      : Number.isFinite(quiz?.passingPercentage) ? quiz.passingPercentage : 70
    const submittedAt = new Date()
    const elapsedSeconds = Math.max(0, Math.floor((submittedAt - new Date(attempt.startedAt)) / 1000))
    const timeLimitMinutes = Number.isFinite(attempt.timeLimitMinutes)
      ? attempt.timeLimitMinutes
      : Number.isFinite(quiz?.timeLimitMinutes) ? quiz.timeLimitMinutes : 0
    const timeTakenSeconds = timeLimitMinutes > 0
      ? Math.min(elapsedSeconds, timeLimitMinutes * 60)
      : elapsedSeconds
    const passed = scorePercentage >= passingPercentage
    const submittedAttempt = await QuizAttempt.findOneAndUpdate(
      { _id: attempt._id, userId: req.auth.id, status: 'started' },
      {
        $set: {
          status: 'submitted',
          answers: savedAnswers,
          earnedPoints,
          totalPoints,
          correctAnswers,
          incorrectAnswers: questions.length - correctAnswers,
          scorePercentage,
          passed,
          passingPercentage,
          timeLimitMinutes,
          timeTakenSeconds,
          submittedAt,
        },
      },
      { new: true, runValidators: true },
    )
    if (!submittedAttempt) {
      return res.status(409).json({ message: 'This quiz attempt has already been submitted.' })
    }

    let updatedState = state
    if (passed || attemptNumber === quizAttemptLimit) {
      updatedState = await QuizAttemptState.findOneAndUpdate(
        { ...stateKey, cycleNumber, passed: { $ne: true } },
        {
          $set: passed
            ? { passed: true, lockedUntil: null }
            : { lockedUntil: new Date(submittedAt.getTime() + quizAttemptCooldownMs) },
        },
        { new: true },
      ).lean() || await QuizAttemptState.findOne(stateKey).lean()
    }
    if (!updatedState) throw new Error('Quiz attempt state could not be updated after submission.')
    const quizStatus = getQuizAttemptStatus(updatedState, submittedAt)

    await createStudentNotification({
      recipientId: req.auth.id,
      eventKey: `quiz-result:${req.auth.id}:${submittedAttempt._id}`,
      type: 'quiz_result',
      title: `${quiz?.title || 'Quiz'} result available`,
      message: `${course.title || 'Your course'} · Score: ${scorePercentage}% · ${passed ? 'Passed' : 'Not passed'}.`,
      link: `/student/course/${encodeURIComponent(courseId)}/learn?activity=${encodeURIComponent(quizId)}&activityType=quiz`,
      metadata: {
        courseId,
        quizId,
        attemptId: String(submittedAttempt._id),
        scorePercentage,
        passed,
      },
    })

    if (submittedAttempt.passed) {
      await issueCertificateIfEligible({
        userId: req.auth.id,
        studentName: req.auth.user.fullName,
        enrollment,
        course,
      })
    }

    // Synchronize with Progress and Enrollment models
    let courseProgress = null
    try {
      let progressDoc = await Progress.findOne({ userId: req.auth.id, courseId })
      if (!progressDoc) {
        progressDoc = new Progress({
          userId: req.auth.id,
          courseId,
          collegeId: req.auth.user?.collegeId || null,
          completedLessons: [],
          quizSubmissions: [],
          progressPercentage: 0,
          status: 'not_started',
        })
      }

      const isPassed = scorePercentage >= passingPercentage
      const existingSubmission = (progressDoc.quizSubmissions || []).find(
        (sub) => canonicalObjectId(sub.quizId) === canonicalObjectId(quizId),
      )
      if (existingSubmission) {
        existingSubmission.score = earnedPoints
        existingSubmission.totalQuestions = questions.length
        existingSubmission.passed = Boolean(existingSubmission.passed || isPassed)
        existingSubmission.submittedAt = submittedAt
      } else {
        progressDoc.quizSubmissions.push({
          quizId,
          score: earnedPoints,
          totalQuestions: questions.length,
          passed: isPassed,
          submittedAt,
        })
      }

      const [allAttempts, assignmentSubmissions] = await Promise.all([
        QuizAttempt.find({ userId: req.auth.id, enrollmentId: enrollment._id })
          .select('_id quizId status passed scorePercentage')
          .lean(),
        AssignmentSubmission.find({ userId: req.auth.id, enrollmentId: enrollment._id })
          .select('_id assignmentId submittedAt')
          .lean(),
      ])

      courseProgress = calculateCourseProgress({
        course,
        enrollment,
        progress: progressDoc,
        quizAttempts: allAttempts,
        assignmentSubmissions,
      })

      progressDoc.progressPercentage = courseProgress.progressPercentage
      progressDoc.status = courseProgress.isCompleted ? 'completed' : 'in_progress'
      if (courseProgress.isCompleted) {
        progressDoc.completedAt = progressDoc.completedAt || new Date()
      }
      progressDoc.lastActivityAt = new Date()
      await progressDoc.save()

      const enrollmentUpdate = {
        status: courseProgress.status,
      }
      if (courseProgress.isCompleted) {
        enrollmentUpdate.completedAt = enrollment.completedAt || new Date()
      }
      await Enrollment.updateOne({ _id: enrollment._id }, { $set: enrollmentUpdate })
    } catch {
      // Safe fallback
    }

    return res.status(200).json({
      attempt: {
        _id: submittedAttempt._id,
        quizId: submittedAttempt.quizId,
        status: submittedAttempt.status,
        startedAt: submittedAttempt.startedAt,
        submittedAt: submittedAttempt.submittedAt,
        timeTakenSeconds: submittedAttempt.timeTakenSeconds,
        passingPercentage: submittedAttempt.passingPercentage,
        timeLimitMinutes: submittedAttempt.timeLimitMinutes,
        attemptNumber,
        cycleNumber,
        answers: submittedAttempt.answers,
        earnedPoints,
        totalPoints,
        correctAnswers,
        incorrectAnswers: questions.length - correctAnswers,
        scorePercentage,
        passed,
        attemptsMade: attemptNumber,
        maxAttempts: quizAttemptLimit,
        questions: getPublicQuestionSnapshot(attempt.questionSnapshot?.length
          ? attempt.questionSnapshot
          : questions.map((question) => ({
            questionId: question._id,
            prompt: question.prompt,
            type: question.type || 'multiple-choice',
            options: question.options || [],
          }))),
      },
      quizStatus,
      progress: courseProgress,
    })
  } catch (error) {
    return next(error)
  }
})

router.post(
  '/courses/:courseId/assignments/:assignmentId/submissions',
  ...requireStudent,
  receiveAssignmentSubmission,
  async (req, res, next) => {
    try {
      const { courseId, assignmentId } = req.params
      if (!isValidObjectId(courseId) || !isValidObjectId(assignmentId)) {
        return res.status(400).json({ message: 'Select a valid course and assignment.' })
      }
      if (!req.file || !isValidAssignmentFile(req.file)) {
        return res.status(400).json({ message: 'Upload a valid PDF, DOCX, or TXT file up to 10 MB.' })
      }
      const enrollment = await Enrollment.findOne({
        userId: req.auth.id,
        courseId,
        ...getStudentEnrollmentScope(req),
        status: { $ne: 'cancelled' },
      }).sort({ createdAt: -1 }).lean()
      if (!enrollment) return res.status(404).json({ message: 'An active enrollment is required to submit this assignment.' })
      const course = await Course.findById(courseId).select('assignments modules.contentItems').lean()
      if (!course || !findAssignment(course, assignmentId)) {
        return res.status(404).json({ message: 'This assignment is not available in the enrolled course.' })
      }
      const submission = await AssignmentSubmission.create({
        userId: req.auth.id,
        ...(req.auth.user.studentType === 'college' ? { collegeId: req.auth.user.collegeId } : {}),
        enrollmentId: enrollment._id,
        courseId,
        assignmentId,
        fileName: sanitizeSubmissionFileName(req.file.originalname),
        contentType: req.file.mimetype,
        fileSize: req.file.size,
        fileData: req.file.buffer,
      })
      // Synchronize with Progress and Enrollment models
      let courseProgress = null
      try {
        let progressDoc = await Progress.findOne({ userId: req.auth.id, courseId })
        if (!progressDoc) {
          progressDoc = new Progress({
            userId: req.auth.id,
            courseId,
            collegeId: req.auth.user?.collegeId || null,
            completedLessons: [],
            quizSubmissions: [],
            progressPercentage: 0,
            status: 'not_started',
          })
        }

        const [quizAttempts, allSubmissions] = await Promise.all([
          QuizAttempt.find({ userId: req.auth.id, enrollmentId: enrollment._id })
            .select('_id quizId status passed scorePercentage')
            .lean(),
          AssignmentSubmission.find({ userId: req.auth.id, enrollmentId: enrollment._id })
            .select('_id assignmentId submittedAt')
            .lean(),
        ])

        courseProgress = calculateCourseProgress({
          course,
          enrollment,
          progress: progressDoc,
          quizAttempts,
          assignmentSubmissions: allSubmissions,
        })

        progressDoc.progressPercentage = courseProgress.progressPercentage
        progressDoc.status = courseProgress.isCompleted ? 'completed' : 'in_progress'
        if (courseProgress.isCompleted) {
          progressDoc.completedAt = progressDoc.completedAt || new Date()
        }
        progressDoc.lastActivityAt = new Date()
        await progressDoc.save()

        const enrollmentUpdate = {
          status: courseProgress.status,
        }
        if (courseProgress.isCompleted) {
          enrollmentUpdate.completedAt = enrollment.completedAt || new Date()
        }
        await Enrollment.updateOne({ _id: enrollment._id }, { $set: enrollmentUpdate })
      } catch {
        // Safe fallback
      }

      const assignment = findAssignment(course, assignmentId)
      await createStudentNotification({
        recipientId: req.auth.id,
        eventKey: `assignment-submitted:${req.auth.id}:${submission._id}`,
        type: 'assignment_submitted',
        title: 'Assignment submitted',
        message: `${assignment.title || 'Your assignment'} is awaiting review.`,
        link: '/student/assignments',
        metadata: { courseId, assignmentId, submissionId: String(submission._id) },
      })
      return res.status(201).json({
        submission: {
          _id: submission._id,
          assignmentId: submission.assignmentId,
          fileName: submission.fileName,
          contentType: submission.contentType,
          fileSize: submission.fileSize,
          submittedAt: submission.submittedAt,
        },
        progress: courseProgress,
      })
    } catch (error) {
      return next(error)
    }
  },
)

router.get('/assignment-submissions/:submissionId/download', ...requireStudent, async (req, res, next) => {
  try {
    const { submissionId } = req.params
    if (!isValidObjectId(submissionId)) return res.status(400).json({ message: 'Select a valid submission.' })
    const submission = await AssignmentSubmission.findOne({
      _id: submissionId,
      userId: req.auth.id,
    }).select('+fileData').lean()
    if (!submission) return res.status(404).json({ message: 'The submission was not found.' })
    const enrollment = await Enrollment.findOne({
      _id: submission.enrollmentId,
      userId: req.auth.id,
      ...getStudentEnrollmentScope(req),
      status: { $ne: 'cancelled' },
    }).select('_id').lean()
    if (!enrollment) return res.status(404).json({ message: 'The submission was not found.' })
    const fileData = toMongoBuffer(submission.fileData)
    if (!fileData || fileData.length < 1 || fileData.length > maxAssignmentSubmissionBytes) {
      return res.status(404).json({ message: 'The submission file is unavailable.' })
    }
    res.set({
      'Content-Type': submission.contentType,
      'Content-Length': String(fileData.length),
      'Content-Disposition': `attachment; filename="${submission.fileName}"`,
      'X-Content-Type-Options': 'nosniff',
    })
    return res.send(fileData)
  } catch (error) {
    return next(error)
  }
})

router.get('/enrollments/me', ...requireStudent, async (req, res, next) => {
  try {
    const scope = req.auth.user.studentType === 'college'
      ? { collegeId: req.auth.user.collegeId }
      : { collegeId: { $exists: false } }
    const enrollments = await Enrollment.find({
      userId: req.auth.id,
      ...scope,
      status: { $ne: 'cancelled' },
    })
      .populate(
        'courseId',
        'title description detailedDescription category difficulty thumbnailUrl estimatedDurationMinutes modules assignments quizzes status',
      )
      .sort({ createdAt: -1 })
      .lean()

    const enrollmentIds = enrollments.map((e) => e._id)
    const courseIds = enrollments.map((e) => e.courseId?._id).filter(Boolean)
    const [progressList, allQuizAttempts, allAssignmentSubmissions, allCertificates] = await Promise.all([
      safeFindProgress({ userId: req.auth.id }),
      safeFindQuizAttempts({ userId: req.auth.id, enrollmentId: { $in: enrollmentIds }, status: 'submitted' }),
      safeFindAssignmentSubmissions(
        { userId: req.auth.id, enrollmentId: { $in: enrollmentIds } },
        '_id enrollmentId assignmentId submittedAt',
      ),
      Certificate.find({
        courseId: { $in: courseIds },
        $or: [
          { userId: req.auth.id },
          { studentId: req.auth.id },
        ],
      })
        .select('_id certificateId courseId studentName courseName completedAt issuedAt templateId')
        .lean()
        .catch(() => []),
    ])

    const progressMap = new Map((progressList || []).map((p) => [String(p.courseId), p]))
    const certificateMap = new Map((allCertificates || []).map((c) => [String(c.courseId), c]))
    const quizAttemptsByEnrollment = new Map()
    for (const qa of allQuizAttempts || []) {
      const eid = String(qa.enrollmentId)
      const list = quizAttemptsByEnrollment.get(eid) || []
      list.push(qa)
      quizAttemptsByEnrollment.set(eid, list)
    }
    const assignmentSubmissionsByEnrollment = new Map()
    for (const as of allAssignmentSubmissions || []) {
      const eid = String(as.enrollmentId)
      const list = assignmentSubmissionsByEnrollment.get(eid) || []
      list.push(as)
      assignmentSubmissionsByEnrollment.set(eid, list)
    }

    return res.json({
      enrollments: enrollments.map((enrollment) => {
        const course = enrollment.courseId
        const prog = course?._id ? progressMap.get(String(course._id)) : null
        const completedIdsSet = new Set((enrollment.completedLessonIds || []).map(String))
        if (prog?.completedLessons) {
          for (const cl of prog.completedLessons) {
            if (cl.lessonId) completedIdsSet.add(String(cl.lessonId))
          }
        }

        const originalCompletedIds = enrollment.completedLessonIds || []
        const originalCompletedSet = new Set(originalCompletedIds.map(String))
        const additionalCompletedIds = [...completedIdsSet].filter((id) => !originalCompletedSet.has(id))
        const mergedCompletedLessonIds = [...originalCompletedIds, ...additionalCompletedIds]

        const attemptsForEnrollment = quizAttemptsByEnrollment.get(String(enrollment._id)) || []
        const submissionsForEnrollment = assignmentSubmissionsByEnrollment.get(String(enrollment._id)) || []

        const courseProgress = calculateCourseProgress({
          course,
          enrollment: { ...enrollment, completedLessonIds: mergedCompletedLessonIds },
          progress: prog,
          quizAttempts: attemptsForEnrollment,
          assignmentSubmissions: submissionsForEnrollment,
        })

        const status = courseProgress.status
        const completedAt = courseProgress.isCompleted
          ? (enrollment.completedAt || new Date())
          : null
        const certDoc = course?._id ? certificateMap.get(String(course._id)) : null

        return {
          ...enrollment,
          status,
          completedAt,
          progress: courseProgress,
          completedLessonIds: mergedCompletedLessonIds,
          courseId: hideQuizAnswers(enrollment.courseId),
          certificate: certDoc ? {
            id: String(certDoc._id),
            _id: String(certDoc._id),
            certificateId: certDoc.certificateId,
            studentName: certDoc.studentName,
            courseName: certDoc.courseName,
            completedAt: certDoc.completedAt || certDoc.issuedAt,
          } : null,
        }
      }),
    })
  } catch (error) {
    return next(error)
  }
})

router.patch('/enrollments/:enrollmentId/progress', ...requireStudent, async (req, res, next) => {
  try {
    const { enrollmentId } = req.params
    const { lessonId, completed, started, positionSeconds } = req.body ?? {}
    const hasPositionSeconds = Object.prototype.hasOwnProperty.call(req.body || {}, 'positionSeconds')
    if (
      !isValidObjectId(enrollmentId)
      || !isValidObjectId(lessonId)
      || (typeof completed !== 'boolean' && started !== true && !hasPositionSeconds)
      || (hasPositionSeconds && (!Number.isFinite(positionSeconds) || positionSeconds < 0 || positionSeconds > 43200))
    ) {
      return res.status(400).json({ message: 'A valid enrollment, lesson, and progress state are required.' })
    }

    const scope = req.auth.user.studentType === 'college'
      ? { collegeId: req.auth.user.collegeId }
      : { collegeId: { $exists: false } }
    const enrollmentQuery = {
      _id: enrollmentId,
      userId: req.auth.id,
      ...scope,
      status: { $ne: 'cancelled' },
    }
    const enrollment = await Enrollment.findOne(enrollmentQuery)
      .populate('courseId', 'title modules assignments quizzes generateCertificate')
      .lean()
    if (!enrollment) return res.status(404).json({ message: 'The enrollment was not found.' })
    if (!courseHasLesson(enrollment.courseId, lessonId)) {
      return res.status(404).json({ message: 'The lesson was not found in this course.' })
    }

    const isAlreadyCompleted = (enrollment.completedLessonIds || []).some((id) => String(id) === lessonId)
    const update = { $addToSet: { startedLessonIds: lessonId } }
    if (typeof completed === 'boolean') {
      if (completed) {
        update.$addToSet.completedLessonIds = lessonId
        if (!isAlreadyCompleted) {
          update.$set = { [`lessonCompletionDates.${lessonId}`]: new Date() }
        }
      } else {
        update.$pull = { completedLessonIds: lessonId }
        update.$unset = { [`lessonCompletionDates.${lessonId}`]: 1 }
      }
    }
    if (hasPositionSeconds) {
      update.$set = {
        ...update.$set,
        [`lessonPlaybackPositions.${lessonId}`]: positionSeconds,
      }
      const previousPositionValue = getMapValue(enrollment.lessonPlaybackPositions, lessonId)
      const previousPositionQuery = previousPositionValue === undefined
        ? { $exists: false }
        : previousPositionValue
      enrollmentQuery[`lessonPlaybackPositions.${lessonId}`] = previousPositionQuery
    }
    const result = await Enrollment.updateOne(enrollmentQuery, update)
    if (!result.matchedCount) {
      if (!hasPositionSeconds) return res.status(404).json({ message: 'The enrollment was not found.' })
      const latestEnrollment = await Enrollment.findOne({
        _id: enrollmentId,
        userId: req.auth.id,
        ...scope,
        status: { $ne: 'cancelled' },
      })
        .select('completedLessonIds startedLessonIds lessonPlaybackPositions')
        .lean()
      if (!latestEnrollment) return res.status(404).json({ message: 'The enrollment was not found.' })
      return res.json({
        completedLessonIds: (latestEnrollment.completedLessonIds || []).map(String),
        startedLessonIds: (latestEnrollment.startedLessonIds || []).map(String),
        lessonPlaybackPositions: getLessonPlaybackPositions(latestEnrollment),
      })
    }

    const completedLessonIds = new Set((enrollment.completedLessonIds || []).map(String))
    const startedLessonIds = new Set((enrollment.startedLessonIds || []).map(String))
    startedLessonIds.add(lessonId)
    if (completed === true) completedLessonIds.add(lessonId)
    if (completed === false) completedLessonIds.delete(lessonId)

    if (completed === true) {
      const currentEnrollment = await Enrollment.findOne(enrollmentQuery)
        .populate('courseId', 'title modules')
        .lean()
      if (currentEnrollment) await issueCourseCertificate(req, currentEnrollment)
    }

    // Synchronize with Progress model
    if (mongoose.connection?.readyState === 1) {
      try {
        const allLessons = getCourseAllLessons(enrollment.courseId)
        const targetItem = allLessons.find((item) => String(item.lessonId) === String(lessonId))
        const targetModuleId = targetItem?.moduleId || new mongoose.Types.ObjectId()
        let progress = await Progress.findOne({
          userId: req.auth.id,
          courseId: enrollment.courseId._id,
        })
        if (progress) {
          if (typeof completed === 'boolean') {
            if (completed) {
              if (!progress.completedLessons.some((entry) => String(entry.lessonId) === String(lessonId))) {
                progress.completedLessons.push({
                  moduleId: targetModuleId,
                  lessonId,
                  completedAt: new Date(),
                })
              }
            } else {
              progress.completedLessons = progress.completedLessons.filter(
                (entry) => String(entry.lessonId) !== String(lessonId),
              )
            }
          }
          await progress.save().catch(() => {})
        }
      } catch {
        // Safe fallback
      }
    }

    // Synchronize with LearningActivity
    if (completed === true && mongoose.connection?.readyState === 1) {
      try {
        const tz = (req.body?.timezone && typeof req.body.timezone === 'string') ? req.body.timezone : 'UTC'
        const todayStr = getLocalDateString(new Date(), tz)
        const existingActivity = await LearningActivity.findOne({
          studentId: req.auth.id,
          lessonId,
          date: todayStr,
        })
        if (existingActivity) {
          existingActivity.completed = true
          existingActivity.completedAt = new Date()
          await existingActivity.save()
        } else {
          const allLessons = getCourseAllLessons(enrollment.courseId)
          const targetItem = allLessons.find((item) => String(item.lessonId) === String(lessonId))
          const targetModuleId = targetItem?.moduleId || new mongoose.Types.ObjectId()
          await LearningActivity.create({
            studentId: req.auth.id,
            collegeId: req.auth.user?.collegeId || null,
            courseId: enrollment.courseId._id,
            moduleId: targetModuleId,
            lessonId,
            sessionId: `complete-${req.auth.id}-${lessonId}-${Date.now()}`,
            activityType: 'video_watching',
            startedAt: new Date(),
            endedAt: new Date(),
            durationSeconds: 30,
            date: todayStr,
            completed: true,
            completedAt: new Date(),
          })
        }
      } catch {
        // Safe fallback
      }
    }

    const lessonPlaybackPositions = getLessonPlaybackPositions(enrollment)
    if (hasPositionSeconds) lessonPlaybackPositions[lessonId] = positionSeconds
    return res.json({
      completedLessonIds: [...completedLessonIds],
      startedLessonIds: [...startedLessonIds],
      lessonPlaybackPositions,
    })
  } catch (error) {
    return next(error)
  }
})

router.get('/certificates', ...requireStudent, async (req, res, next) => {
  try {
    const enrollments = await Enrollment.find({
      userId: req.auth.id,
      ...getStudentEnrollmentScope(req),
      status: { $ne: 'cancelled' },
    })
      .populate('courseId', 'title thumbnailUrl modules assignments quizzes generateCertificate')
      .sort({ createdAt: -1 })
      .lean()
    const latestEnrollmentByCourse = new Map()
    for (const enrollment of enrollments) {
      if (!enrollment.courseId) continue
      const courseId = String(enrollment.courseId._id)
      if (!latestEnrollmentByCourse.has(courseId)) latestEnrollmentByCourse.set(courseId, enrollment)
    }

    const certificates = await Promise.all([...latestEnrollmentByCourse.values()].map(async (enrollment) => {
      const course = enrollment.courseId
      const existing = await Certificate.findOne({ userId: req.auth.id, courseId: course._id }).lean()
      if (existing) {
        const requiredActivities = getRequiredCertificateActivities(course)
        return {
          courseId: String(course._id),
          courseName: existing.courseName,
          thumbnailUrl: course.thumbnailUrl || '',
          eligible: true,
          pendingRequirements: [],
          progress: getCertificateCourseProgress(requiredActivities, [], true),
          certificate: {
            id: String(existing._id),
            certificateId: existing.certificateId,
            studentName: existing.studentName,
            courseName: existing.courseName,
            completedAt: existing.completedAt,
          },
        }
      }

      const eligibility = await evaluateCertificateEligibility({ course, enrollment })
      const pendingRequirements = [...eligibility.pendingRequirements]
      let certificate = null
      if (eligibility.eligible && req.auth.user.fullName?.trim()) {
        certificate = await issueCertificateIfEligible({
          userId: req.auth.id,
          studentName: req.auth.user.fullName,
          enrollment,
          course,
          eligibility,
        })
      }
      if (eligibility.eligible && !req.auth.user.fullName?.trim()) {
        pendingRequirements.push({ type: 'profile', title: 'Add your full name to your account', status: 'name-required' })
      }
      return {
        courseId: String(course._id),
        courseName: course.title,
        thumbnailUrl: course.thumbnailUrl || '',
        eligible: Boolean(certificate),
        pendingRequirements: certificate ? [] : pendingRequirements,
        progress: getCertificateCourseProgress(eligibility.activities, pendingRequirements, Boolean(certificate)),
        certificate: certificate ? {
          id: String(certificate._id),
          certificateId: certificate.certificateId,
          studentName: certificate.studentName,
          courseName: certificate.courseName,
          completedAt: certificate.completedAt,
        } : null,
      }
    }))

    return res.json({ certificates })
  } catch (error) {
    return next(error)
  }
})

router.get('/certificates/:certificateId/pdf', ...requireStudent, async (req, res, next) => {
  try {
    const { certificateId } = req.params
    if (!isValidObjectId(certificateId)) return res.status(404).json({ message: 'The certificate was not found.' })
    const activeTemplateId = await getActiveCertificateTemplateId()
    const certificate = await Certificate.findOne({ _id: certificateId, userId: req.auth.id }).lean()
    if (!certificate) return res.status(404).json({ message: 'The certificate was not found.' })
    const templateId = certificate.templateId || activeTemplateId
    const template = templateId === 'builtin'
      ? null
      : await CertificateTemplate.findById(templateId).select('+imageData secureUrl').lean()
    if (templateId !== 'builtin' && !template) {
      throw new Error('The certificate background used for this certificate is unavailable.')
    }
    const templateImage = templateId === 'builtin' ? undefined : await loadCertificateTemplateImage(template)
    const pdf = await generateCertificatePdf(certificate, templateImage)
    const download = req.query.download === 'true'
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `${download ? 'attachment' : 'inline'}; filename="aiHustle-certificate-${certificate.certificateId}.pdf"`)
    res.setHeader('Cache-Control', 'private, no-store')
    return res.send(pdf)
  } catch (error) {
    return next(error)
  }
})
router.post('/enrollments', ...requireStudent, async (req, res, next) => {
  try {
    const { courseId } = req.body ?? {}
    if (!isValidObjectId(courseId)) {
      return res.status(400).json({ message: 'Select a valid course.' })
    }

    if (req.auth.user.studentType !== 'independent' || req.auth.user.collegeId) {
      return res.status(403).json({ message: 'College students must be enrolled by their college sub-admin.' })
    }

    const student = await Student.findOne({ _id: req.auth.id, role: 'student', studentType: 'independent' })
      .select('_id')
      .lean()
    if (!student) return res.status(404).json({ message: 'The student account was not found.' })

    const course = await Course.findOne({ _id: courseId, status: 'published' }).select('_id title')
    if (!course) return res.status(404).json({ message: 'The published course was not found.' })
    const existing = await Enrollment.findOne({
      userId: student._id,
      courseId: course._id,
      status: { $ne: 'cancelled' },
    }).select('_id')
    if (existing) return res.status(409).json({ message: 'You are already enrolled in this course.' })

    const [enrollment] = await Enrollment.create([{
      userId: student._id,
      courseId: course._id,
      assignedBy: student._id,
      status: 'active',
    }])
    await createStudentNotification({
      recipientId: student._id,
      eventKey: `course-assigned:${student._id}:${enrollment._id}`,
      type: 'course_assigned',
      title: 'New course added',
      message: `You are now enrolled in ${course.title || 'a course'}.`,
      link: `/student/course/${encodeURIComponent(String(course._id))}/learn`,
      metadata: { courseId: String(course._id), enrollmentId: String(enrollment._id) },
    })
    return res.status(201).json({ message: 'You are now enrolled in this course.', enrollment })
  } catch (error) {
    return next(error)
  }
})

router.post('/college/students', ...requireCollegeAdmin, async (req, res, next) => {
  try {
    const subAdmin = await getAssignedCollegeAdmin(req)
    if (!subAdmin) {
      return res.status(403).json({ message: 'Your Sub-Admin account is not assigned to a valid college.' })
    }

    const { fullName, email, username, password, studentId, department, batch } = req.body ?? {}
    if (typeof fullName !== 'string' || !fullName.trim() || fullName.trim().length > 120) {
      return res.status(400).json({ message: 'Enter a student name between 1 and 120 characters.' })
    }
    if (typeof email !== 'string' || email.trim().length > 254 || !emailPattern.test(email.trim())) {
      return res.status(400).json({ message: 'Enter a valid email address.' })
    }
    if (typeof username !== 'string' || !usernamePattern.test(username.trim())) {
      return res.status(400).json({ message: 'Use a username with 3–30 letters, numbers, dots, underscores, or hyphens.' })
    }
    if (typeof password !== 'string' || password.length < 8 || Buffer.byteLength(password, 'utf8') > 72) {
      return res.status(400).json({ message: 'Use a password of at least 8 characters.' })
    }
    if (typeof studentId !== 'string' || !studentId.trim() || studentId.trim().length > 100) {
      return res.status(400).json({ message: 'Enter a student ID of up to 100 characters.' })
    }
    if (department !== undefined && (typeof department !== 'string' || department.trim().length > 120)) {
      return res.status(400).json({ message: 'Department must be 120 characters or fewer.' })
    }
    if (batch !== undefined && (typeof batch !== 'string' || batch.trim().length > 80)) {
      return res.status(400).json({ message: 'Batch must be 80 characters or fewer.' })
    }

    const normalizedEmail = email.trim().toLowerCase()
    const normalizedUsername = username.trim().toLowerCase()
    const normalizedStudentId = studentId.trim()
    const [existingEmail, existingUsername, existingStudentId] = await Promise.all([
      accountIdentifierExists('email', normalizedEmail),
      accountIdentifierExists('username', normalizedUsername),
      Promise.all([
        isDuplicateStudentId(normalizedStudentId, Student),
        isDuplicateStudentId(normalizedStudentId, CollegeStudent),
      ]).then((matches) => matches.some(Boolean)),
    ])
    if (existingEmail) return res.status(409).json({ message: 'An account with this email already exists.' })
    if (existingUsername) return res.status(409).json({ message: 'This username is already taken.' })
    if (existingStudentId) return res.status(409).json({ message: 'This student ID already exists.' })

    const accountId = new mongoose.Types.ObjectId()
    const passwordHash = await bcrypt.hash(password, 12)
    const session = await mongoose.startSession()
    let student
    try {
      await session.withTransaction(async () => {
        await assertCollegeStudentCapacity(subAdmin.collegeId, session)
        const duplicate = await AccountIdentity.findOne({
          $or: [{ email: normalizedEmail }, { username: normalizedUsername }],
        }).session(session)
        if (duplicate) {
          const error = new Error('Email or username already belongs to an LMS account.')
          error.statusCode = 409
          throw error
        }
        if ((await Promise.all([
          isDuplicateStudentId(normalizedStudentId, Student, session),
          isDuplicateStudentId(normalizedStudentId, CollegeStudent, session),
        ])).some(Boolean)) {
          const error = new Error('This student ID already exists.')
          error.statusCode = 409
          throw error
        }
        await AccountIdentity.create([{
          email: normalizedEmail,
          username: normalizedUsername,
          accountCollection: CollegeStudent.collection.name,
          accountId,
        }], { session })
        ;[student] = await CollegeStudent.create([{
          _id: accountId,
          fullName: fullName.trim(),
          email: normalizedEmail,
          username: normalizedUsername,
          studentId: normalizedStudentId,
          department: department?.trim() || undefined,
          batch: batch?.trim() || undefined,
          passwordHash,
          role: 'student',
          studentType: 'college',
          collegeId: subAdmin.collegeId,
          status: 'active',
          isActive: true,
          permissions: [],
        }], { session })
      })
    } finally {
      await session.endSession()
    }
    return res.status(201).json({
      message: 'The student account was created successfully.',
      student: {
        _id: String(student._id),
        studentId: student.studentId,
        fullName: student.fullName,
        email: student.email,
        username: student.username,
        department: student.department,
        batch: student.batch,
      },
    })
  } catch (error) {
    if (error?.code === 'college_student_limit' || error?.statusCode === 409) {
      return res.status(error.statusCode || 409).json({ message: error.message })
    }
    return next(error)
  }
})

router.post('/college/students/import', ...requireCollegeAdmin, async (req, res, next) => {
  try {
    const subAdmin = await getAssignedCollegeAdmin(req)
    if (!subAdmin) {
      return res.status(403).json({ message: 'Your Sub-Admin account is not assigned to a valid college.' })
    }
    let rows
    try {
      rows = parseStudentCsv(req.body?.csvText)
    } catch (error) {
      return res.status(400).json({ message: error.message })
    }
    if (rows.length > 500) {
      return res.status(400).json({ message: 'Import is limited to 500 students per CSV.' })
    }

    const imported = []
    const failures = []
    const seenEmails = new Set()
    const seenStudentIds = new Set()
    const seenUsernames = new Set()
    for (const row of rows) {
      if (row.error) {
        failures.push({ row: row.rowNumber, reason: row.error })
        continue
      }

      const { fullName, studentId, email, department, batch } = row
      const username = makeImportUsername(studentId)
      const errors = []
      if (!fullName || fullName.length > 120) errors.push('Full Name is required and must be 120 characters or fewer.')
      if (!studentId || studentId.length > 100) errors.push('Student ID is required and must be 100 characters or fewer.')
      if (!emailPattern.test(email) || email.length > 254) errors.push('Enter a valid email address.')
      if (!department || department.length > 120) errors.push('Department is required and must be 120 characters or fewer.')
      if (!batch || batch.length > 80) errors.push('Batch is required and must be 80 characters or fewer.')
      if (seenEmails.has(email)) errors.push('Email is duplicated in this CSV.')
      if (seenStudentIds.has(studentId.toLowerCase())) errors.push('Student ID is duplicated in this CSV.')
      if (seenUsernames.has(username)) errors.push('Generated username is duplicated in this CSV.')
      seenEmails.add(email)
      seenStudentIds.add(studentId.toLowerCase())
      seenUsernames.add(username)
      if (!errors.length) {
        const [existingEmail, existingStudentId, existingUsername] = await Promise.all([
          accountIdentifierExists('email', email),
          isDuplicateStudentId(studentId, CollegeStudent),
          accountIdentifierExists('username', username),
        ])
        if (existingEmail) errors.push('Email already belongs to an LMS account.')
        if (existingStudentId) errors.push('Student ID already exists.')
        if (existingUsername) errors.push('Generated username conflicts with an LMS account.')
      }
      if (errors.length) {
        failures.push({ row: row.rowNumber, email, studentId, reason: errors.join(' ') })
        continue
      }

      const accountId = new mongoose.Types.ObjectId()
      const passwordHash = await bcrypt.hash(crypto.randomBytes(48).toString('base64url'), 12)
      const session = await mongoose.startSession()
      try {
        await session.withTransaction(async () => {
          await assertCollegeStudentCapacity(subAdmin.collegeId, session)
          await AccountIdentity.create([{
            email,
            username,
            accountCollection: CollegeStudent.collection.name,
            accountId,
          }], { session })
          await CollegeStudent.create([{
            _id: accountId,
            fullName,
            email,
            username,
            studentId,
            department,
            batch,
            passwordHash,
            role: 'student',
            studentType: 'college',
            collegeId: subAdmin.collegeId,
            status: 'active',
            isActive: true,
            permissions: [],
          }], { session })
        })
        imported.push({ row: row.rowNumber, email, studentId })
      } catch (error) {
        if (error?.statusCode === 409 || error?.code === 11000 || error?.code === 'college_student_limit') {
          failures.push({ row: row.rowNumber, email, studentId, reason: error.message || 'Email, username, or Student ID already exists.' })
        } else {
          throw error
        }
      } finally {
        await session.endSession()
      }
    }
    return res.json({
      message: 'College student import completed. No invitation emails were sent.',
      summary: { total: rows.length, imported: imported.length, failed: failures.length },
      imported,
      failures,
    })
  } catch (error) {
    return next(error)
  }
})

router.get('/college/dashboard', ...requireCollegeAdmin, async (req, res, next) => {
  try {
    const collegeId = req.auth.user.collegeId
    if (!isValidObjectId(collegeId)) {
      return res.status(403).json({ message: 'This sub-admin is not assigned to a valid college.' })
    }
    const subAdmin = await getAssignedCollegeAdmin(req)
    if (!subAdmin) {
      return res.status(403).json({ message: 'Your Sub-Admin account is not assigned to a valid college.' })
    }

    const [college, students, courses, enrollments, totalStudents, studentLimit] = await Promise.all([
      College.findById(collegeId).select('name').lean(),
      CollegeStudent.find({ role: 'student', studentType: 'college', collegeId })
        .select('fullName username email studentId department batch')
        .sort({ fullName: 1 })
        .limit(1000)
        .lean(),
      Course.find({ status: 'published' })
        .select('title description')
        .sort({ title: 1 })
        .limit(500)
        .lean(),
      Enrollment.find({ collegeId })
        .populate('userId', 'fullName username email studentId')
        .populate('courseId', 'title')
        .sort({ createdAt: -1 })
        .limit(1000)
        .lean(),
      countCollegeStudents(subAdmin.collegeId),
      getCollegeStudentLimit(subAdmin.collegeId),
    ])
    if (!college) return res.status(403).json({ message: 'The assigned college no longer exists.' })
    return res.json({
      college,
      students,
      courses,
      enrollments,
      studentLimit,
      totalStudents,
      remainingSlots: studentLimit === null ? null : Math.max(0, studentLimit - totalStudents),
    })
  } catch (error) {
    return next(error)
  }
})

router.post('/college/enrollments', ...requireCollegeAdmin, async (req, res, next) => {
  try {
    const collegeId = req.auth.user.collegeId
    const { studentId, courseId } = req.body ?? {}
    if (!isValidObjectId(collegeId) || !isValidObjectId(studentId) || !isValidObjectId(courseId)) {
      return res.status(400).json({ message: 'Select a valid student and course.' })
    }

    const [student, course] = await Promise.all([
      CollegeStudent.findOne({
        _id: studentId,
        role: 'student',
        studentType: 'college',
        collegeId,
      }).select('_id'),
      Course.findOne({ _id: courseId, status: 'published' }).select('_id title'),
    ])
    if (!student) {
      return res.status(404).json({ message: 'The student was not found in your college.' })
    }
    if (!course) return res.status(404).json({ message: 'The published course was not found.' })

    const existing = await Enrollment.findOne({
      userId: student._id,
      courseId: course._id,
      collegeId,
      status: { $ne: 'cancelled' },
    }).select('_id')
    if (existing) return res.status(409).json({ message: 'This student is already enrolled in the course.' })

    const [enrollment] = await Enrollment.create([{
      userId: student._id,
      courseId: course._id,
      collegeId,
      assignedBy: req.auth.id,
      status: 'active',
    }])
    await createStudentNotification({
      recipientId: student._id,
      eventKey: `course-assigned:${student._id}:${enrollment._id}`,
      type: 'course_assigned',
      title: 'New course assigned',
      message: `${course.title || 'A course'} has been added to your courses.`,
      link: `/student/course/${encodeURIComponent(String(course._id))}/learn`,
      metadata: { courseId: String(course._id), enrollmentId: String(enrollment._id) },
    })
    return res.status(201).json({ message: 'Course assigned to the student.', enrollment })
  } catch (error) {
    return next(error)
  }
})


function getLocalDateString(date = new Date(), timezone = 'UTC') {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(date)
  } catch {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC' }).format(date)
  }
}

function getWeekRange(weekOffset = 0, timezone = 'UTC') {
  const now = new Date()
  let weekday = 'Mon'
  let year = now.getUTCFullYear()
  let month = now.getUTCMonth() + 1
  let day = now.getUTCDate()

  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      weekday: 'short',
    }).formatToParts(now)
    const partMap = {}
    parts.forEach((p) => {
      partMap[p.type] = p.value
    })
    weekday = partMap.weekday || 'Mon'
    year = parseInt(partMap.year, 10)
    month = parseInt(partMap.month, 10)
    day = parseInt(partMap.day, 10)
  } catch {
    // Fallback to UTC
  }

  const dayMap = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }
  const currentDayNum = dayMap[weekday] || 1

  const localToday = new Date(Date.UTC(year, month - 1, day))
  const daysToMonday = currentDayNum - 1 - weekOffset * 7
  const monday = new Date(localToday.getTime() - daysToMonday * 24 * 60 * 60 * 1000)

  const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
  const days = []
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday.getTime() + i * 24 * 60 * 60 * 1000)
    const dateStr = d.toISOString().split('T')[0]
    days.push({
      date: dateStr,
      dayName: dayNames[i],
      label: `${dayNames[i]} ${d.getUTCDate()}`,
    })
  }

  return {
    startDate: days[0].date,
    endDate: days[6].date,
    days,
  }
}

function calculateStreaks(sortedDateStrings, timezone = 'UTC') {
  if (!sortedDateStrings || sortedDateStrings.length === 0) {
    return { currentStreak: 0, longestStreak: 0 }
  }

  const todayStr = getLocalDateString(new Date(), timezone)
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000)
  const yesterdayStr = getLocalDateString(yesterday, timezone)
  const dateSet = new Set(sortedDateStrings)

  // Longest streak
  let longestStreak = 0
  let currentRun = 0
  let prevDate = null

  for (const dateStr of sortedDateStrings) {
    const [y, m, d] = dateStr.split('-').map(Number)
    const thisDate = new Date(Date.UTC(y, m - 1, d))
    if (prevDate) {
      const diffDays = Math.round((thisDate.getTime() - prevDate.getTime()) / (24 * 60 * 60 * 1000))
      if (diffDays === 1) {
        currentRun++
      } else if (diffDays > 1) {
        currentRun = 1
      }
    } else {
      currentRun = 1
    }
    prevDate = thisDate
    if (currentRun > longestStreak) {
      longestStreak = currentRun
    }
  }

  // Current streak
  let currentStreak = 0
  if (dateSet.has(todayStr) || dateSet.has(yesterdayStr)) {
    let checkDateStr = dateSet.has(todayStr) ? todayStr : yesterdayStr
    while (dateSet.has(checkDateStr)) {
      currentStreak++
      const [y, m, d] = checkDateStr.split('-').map(Number)
      const prev = new Date(Date.UTC(y, m - 1, d) - 24 * 60 * 60 * 1000)
      checkDateStr = prev.toISOString().split('T')[0]
    }
  }

  return {
    currentStreak,
    longestStreak: Math.max(longestStreak, currentStreak),
  }
}

// 1. Session start
router.post('/learning/session/start', ...requireStudent, async (req, res, next) => {
  try {
    const { courseId, moduleId, lessonId, activityType, timezone } = req.body ?? {}
    if (!isValidObjectId(courseId)) {
      return res.status(400).json({ message: 'Valid courseId is required.' })
    }

    const enrollment = await Enrollment.findOne({
      userId: req.auth.id,
      courseId,
      status: { $ne: 'cancelled' },
    }).select('_id').lean()

    if (!enrollment) {
      return res.status(403).json({ message: 'You are not enrolled in this course.' })
    }

    // End any open unended sessions for this student to prevent overlapping / cheating
    await LearningActivity.updateMany(
      { studentId: req.auth.id, endedAt: null },
      { $set: { endedAt: new Date() } },
    )

    const sessionId = crypto.randomUUID()
    const tz = timezone || 'UTC'
    const todayStr = getLocalDateString(new Date(), tz)

    const session = await LearningActivity.create({
      studentId: req.auth.id,
      collegeId: req.auth.user?.collegeId || null,
      courseId,
      moduleId: isValidObjectId(moduleId) ? moduleId : null,
      lessonId: isValidObjectId(lessonId) ? lessonId : null,
      sessionId,
      activityType: ['video_watching', 'general_study'].includes(activityType)
        ? activityType
        : 'lesson_reading',
      startedAt: new Date(),
      lastHeartbeatAt: new Date(),
      endedAt: null,
      durationSeconds: 0,
      date: todayStr,
      completed: false,
    })

    return res.status(201).json({
      message: 'Learning session started.',
      sessionId: session.sessionId,
    })
  } catch (error) {
    return next(error)
  }
})

// 2. Session heartbeat
router.post('/learning/session/heartbeat', ...requireStudent, async (req, res, next) => {
  try {
    const { sessionId, durationDelta } = req.body ?? {}
    if (!sessionId || typeof sessionId !== 'string') {
      return res.status(400).json({ message: 'Valid sessionId is required.' })
    }

    const session = await LearningActivity.findOne({
      sessionId,
      studentId: req.auth.id,
    })

    if (!session) {
      return res.status(404).json({ message: 'Learning session not found.' })
    }

    if (session.endedAt) {
      return res.json({
        success: true,
        durationSeconds: session.durationSeconds,
        ended: true,
      })
    }

    const rawDelta = Number(durationDelta) || 15
    // Safety cap: max 30s per pulse to avoid runaway timers or background cheating
    const safeDelta = Math.min(Math.max(rawDelta, 1), 30)

    const now = new Date()
    session.durationSeconds = (session.durationSeconds || 0) + safeDelta
    session.lastHeartbeatAt = now
    await session.save()

    // Update Progress lastActivityAt
    await Progress.updateOne(
      { userId: req.auth.id, courseId: session.courseId },
      { $set: { lastActivityAt: now } },
    )

    return res.json({
      success: true,
      durationSeconds: session.durationSeconds,
    })
  } catch (error) {
    return next(error)
  }
})

// 3. Session end
router.post('/learning/session/end', ...requireStudent, async (req, res, next) => {
  try {
    const { sessionId, durationDelta } = req.body ?? {}
    if (!sessionId || typeof sessionId !== 'string') {
      return res.status(400).json({ message: 'Valid sessionId is required.' })
    }

    const session = await LearningActivity.findOne({
      sessionId,
      studentId: req.auth.id,
    })

    if (!session) {
      return res.status(404).json({ message: 'Learning session not found.' })
    }

    if (!session.endedAt) {
      if (durationDelta && Number(durationDelta) > 0) {
        const safeDelta = Math.min(Number(durationDelta), 30)
        session.durationSeconds = (session.durationSeconds || 0) + safeDelta
      }
      session.endedAt = new Date()
      await session.save()
    }

    return res.json({
      success: true,
      totalDurationSeconds: session.durationSeconds,
    })
  } catch (error) {
    return next(error)
  }
})

// 4. Mark lesson completion
router.post('/learning/lessons/complete', ...requireStudent, async (req, res, next) => {
  try {
    const { courseId, moduleId, lessonId, completed = true, timezone } = req.body ?? {}
    if (!isValidObjectId(courseId) || !isValidObjectId(lessonId)) {
      return res.status(400).json({ message: 'Valid courseId and lessonId are required.' })
    }

    const course = await Course.findById(courseId).select('modules').lean()
    if (!course) {
      return res.status(404).json({ message: 'Course not found.' })
    }

    const allLessons = getCourseAllLessons(course)
    const totalLessons = allLessons.length
    const foundLesson = allLessons.find((item) => String(item.lessonId) === String(lessonId))

    if (!foundLesson) {
      return res.status(404).json({ message: 'Lesson was not found in this course.' })
    }

    let resolvedModuleId = isValidObjectId(moduleId) ? moduleId : foundLesson.moduleId

    let progress = await Progress.findOne({
      userId: req.auth.id,
      courseId,
    })

    if (!progress) {
      progress = new Progress({
        userId: req.auth.id,
        courseId,
        collegeId: req.auth.user?.collegeId || null,
        completedLessons: [],
        progressPercentage: 0,
        status: 'not_started',
      })
    }

    const isMarkingComplete = completed !== false

    if (isMarkingComplete) {
      const alreadyCompleted = progress.completedLessons.some(
        (entry) => String(entry.lessonId) === String(lessonId),
      )
      if (!alreadyCompleted) {
        progress.completedLessons.push({
          moduleId: resolvedModuleId || new mongoose.Types.ObjectId(),
          lessonId,
          completedAt: new Date(),
        })
      }
    } else {
      progress.completedLessons = progress.completedLessons.filter(
        (entry) => String(entry.lessonId) !== String(lessonId),
      )
    }

    const completedCount = progress.completedLessons.length
    const [quizAttempts, assignmentSubmissions] = await Promise.all([
      safeFindQuizAttempts({ userId: req.auth.id, courseId, status: 'submitted' }),
      safeFindAssignmentSubmissions({ userId: req.auth.id, courseId }),
    ])

    const completedLessonIds = progress.completedLessons.map((entry) => String(entry.lessonId))
    const courseProgress = calculateCourseProgress({
      course,
      enrollment: { completedLessonIds },
      progress,
      quizAttempts,
      assignmentSubmissions,
    })

    const isAllCompleted = courseProgress.isCompleted
    const targetStatus = isAllCompleted ? 'completed' : (completedCount > 0 ? 'in_progress' : 'not_started')

    const lessonProgressPercentage =
      totalLessons > 0 ? Math.min(100, Math.round((completedCount / totalLessons) * 100)) : 0
    const progressPercentage = courseProgress.totalRequiredActivities > totalLessons
      ? courseProgress.progressPercentage
      : lessonProgressPercentage

    progress.progressPercentage = progressPercentage
    progress.status = targetStatus
    if (isAllCompleted) {
      progress.completedAt = progress.completedAt || new Date()
    } else if (!isMarkingComplete) {
      progress.completedAt = null
    }
    progress.lastActivityAt = new Date()
    await progress.save()

    // Sync with Enrollment model
    try {
      const scope = req.auth.user?.studentType === 'college'
        ? { collegeId: req.auth.user.collegeId }
        : { collegeId: { $exists: false } }
      const enrollmentQuery = {
        userId: req.auth.id,
        courseId,
        ...scope,
        status: { $ne: 'cancelled' },
      }
      const enrollmentUpdate = {
        $addToSet: { startedLessonIds: lessonId },
      }
      if (isMarkingComplete) {
        enrollmentUpdate.$addToSet.completedLessonIds = lessonId
        enrollmentUpdate.$set = {
          [`lessonCompletionDates.${lessonId}`]: new Date(),
          status: isAllCompleted ? 'completed' : 'active',
        }
        if (isAllCompleted) {
          enrollmentUpdate.$set.completedAt = new Date()
        }
      } else {
        enrollmentUpdate.$pull = { completedLessonIds: lessonId }
        enrollmentUpdate.$unset = { [`lessonCompletionDates.${lessonId}`]: 1 }
        enrollmentUpdate.$set = {
          status: 'active',
        }
        enrollmentUpdate.$unset.completedAt = 1
      }
      if (typeof Enrollment.updateMany === 'function' && (mongoose.connection.readyState !== 0 || Enrollment.updateMany !== mongoose.Model.updateMany)) {
        await Enrollment.updateMany(enrollmentQuery, enrollmentUpdate)
      }
    } catch {
      // Safe fallback
    }

    // Sync with LearningActivity
    const tz = timezone || 'UTC'
    const todayStr = getLocalDateString(new Date(), tz)

    if (isMarkingComplete) {
      const existingActivity = await LearningActivity.findOne({
        studentId: req.auth.id,
        lessonId,
        date: todayStr,
      })
      if (existingActivity) {
        existingActivity.completed = true
        existingActivity.completedAt = new Date()
        await existingActivity.save()
      } else {
        await LearningActivity.create({
          studentId: req.auth.id,
          collegeId: req.auth.user?.collegeId || null,
          courseId,
          moduleId: resolvedModuleId,
          lessonId,
          sessionId: `complete-${req.auth.id}-${lessonId}-${Date.now()}`,
          activityType: 'lesson_reading',
          startedAt: new Date(),
          endedAt: new Date(),
          durationSeconds: 0,
          date: todayStr,
          completed: true,
          completedAt: new Date(),
        })
      }
    }

    return res.json({
      success: true,
      progressPercentage: progress.progressPercentage,
      status: progress.status,
      completedLessons: progress.completedLessons,
      courseProgress,
    })
  } catch (error) {
    return next(error)
  }
})

// 5. Daily summary for today
router.get('/learning/summary/today', ...requireStudent, async (req, res, next) => {
  try {
    const tz = (req.query.timezone && typeof req.query.timezone === 'string') ? req.query.timezone : 'UTC'
    const todayStr = getLocalDateString(new Date(), tz)

    const StudentModel = req.auth.user?.studentType === 'college' ? CollegeStudent : Student
    const account = await StudentModel.findById(req.auth.id).select('dailyLearningGoalMinutes').lean()
    const dailyGoalMinutes = account?.dailyLearningGoalMinutes || 60

    const activities = await LearningActivity.find({
      studentId: req.auth.id,
      date: todayStr,
    }).lean()

    let totalDurationSeconds = 0
    const completedLessonIds = new Set()
    let videosWatched = 0

    for (const act of activities) {
      totalDurationSeconds += act.durationSeconds || 0
      if (act.completed && act.lessonId) {
        completedLessonIds.add(String(act.lessonId))
      }
      if (act.activityType === 'video_watching' && (act.durationSeconds >= 30 || act.completed)) {
        videosWatched++
      }
    }

    // Also include lessons marked complete in Progress on today's calendar date
    const startOfToday = new Date(`${todayStr}T00:00:00Z`)
    const endOfToday = new Date(`${todayStr}T23:59:59.999Z`)
    const studentProgresses = await Progress.find({ userId: req.auth.id }).lean()
    for (const prog of studentProgresses) {
      for (const cl of prog.completedLessons || []) {
        if (
          cl.completedAt &&
          new Date(cl.completedAt) >= startOfToday &&
          new Date(cl.completedAt) <= endOfToday
        ) {
          completedLessonIds.add(String(cl.lessonId))
        }
      }
    }

    const totalMinutes = Math.round(totalDurationSeconds / 60)
    const goalProgressPercentage = Math.min(
      100,
      Math.round((totalMinutes / dailyGoalMinutes) * 100),
    )

    return res.json({
      today: todayStr,
      totalDurationSeconds,
      totalMinutes,
      lessonsCompleted: completedLessonIds.size,
      videosWatched,
      dailyLearningGoalMinutes: dailyGoalMinutes,
      goalProgressPercentage,
    })
  } catch (error) {
    return next(error)
  }
})

// 6. Weekly learning activity chart
router.get('/learning/activity/weekly', ...requireStudent, async (req, res, next) => {
  try {
    const tz = (req.query.timezone && typeof req.query.timezone === 'string') ? req.query.timezone : 'UTC'
    const weekOffset = parseInt(req.query.weekOffset, 10) || 0

    const { startDate, endDate, days } = getWeekRange(weekOffset, tz)

    const activities = await LearningActivity.find({
      studentId: req.auth.id,
      date: { $gte: startDate, $lte: endDate },
    }).lean()

    const activityByDate = new Map()
    for (const act of activities) {
      const d = act.date
      if (!activityByDate.has(d)) {
        activityByDate.set(d, {
          totalSeconds: 0,
          completedLessonIds: new Set(),
        })
      }
      const entry = activityByDate.get(d)
      entry.totalSeconds += act.durationSeconds || 0
      if (act.completed && act.lessonId) {
        entry.completedLessonIds.add(String(act.lessonId))
      }
    }

    let totalWeeklyDurationSeconds = 0
    let mostActiveDay = null
    let mostActiveDayMinutes = 0

    const mappedDays = days.map((day) => {
      const entry = activityByDate.get(day.date)
      const durationSeconds = entry ? entry.totalSeconds : 0
      const durationMinutes = Math.round(durationSeconds / 60)
      const lessonsCompleted = entry ? entry.completedLessonIds.size : 0

      totalWeeklyDurationSeconds += durationSeconds
      if (durationMinutes > mostActiveDayMinutes) {
        mostActiveDayMinutes = durationMinutes
        mostActiveDay = day.dayName
      }

      return {
        date: day.date,
        dayName: day.dayName,
        label: day.label,
        durationSeconds,
        durationMinutes,
        lessonsCompleted,
      }
    })

    const totalWeeklyMinutes = Math.round(totalWeeklyDurationSeconds / 60)
    const averageDailyMinutes = Math.round(totalWeeklyMinutes / 7)

    return res.json({
      weekOffset,
      startDate,
      endDate,
      days: mappedDays,
      totalWeeklyMinutes,
      averageDailyMinutes,
      mostActiveDay,
      mostActiveDayMinutes,
    })
  } catch (error) {
    return next(error)
  }
})

// 7. Overall learning overview
router.get('/learning/overview', ...requireStudent, async (req, res, next) => {
  try {
    const tz = (req.query.timezone && typeof req.query.timezone === 'string') ? req.query.timezone : 'UTC'

    const scope =
      req.auth.user?.studentType === 'college'
        ? { collegeId: req.auth.user.collegeId }
        : { collegeId: { $exists: false } }

    const [enrollments, progressList, activityTotals, account] = await Promise.all([
      Enrollment.find({
        userId: req.auth.id,
        ...scope,
        status: { $ne: 'cancelled' },
      })
        .populate('courseId', 'title description modules status')
        .sort({ createdAt: -1 })
        .lean(),
      Progress.find({ userId: req.auth.id }).lean(),
      LearningActivity.aggregate([
        { $match: { studentId: new mongoose.Types.ObjectId(req.auth.id) } },
        {
          $group: {
            _id: null,
            totalSeconds: { $sum: '$durationSeconds' },
            distinctDates: { $addToSet: '$date' },
          },
        },
      ]),
      (req.auth.user?.studentType === 'college' ? CollegeStudent : Student)
        .findById(req.auth.id)
        .select('dailyLearningGoalMinutes')
        .lean(),
    ])

    const progressMap = new Map(progressList.map((p) => [String(p.courseId), p]))

    let totalLessonsAcrossCourses = 0
    let totalCompletedLessonsCount = 0
    let completedCoursesCount = 0

    const coursesData = enrollments
      .filter((e) => e.courseId && typeof e.courseId === 'object')
      .map((enrollment) => {
        const course = enrollment.courseId
        const prog = progressMap.get(String(course._id))

        const allLessons = getCourseAllLessons(course)

        const completedLessonIds = new Set([
          ...(prog?.completedLessons?.map((l) => String(l.lessonId)) || []),
          ...(enrollment.completedLessonIds || []).map(String),
        ])
        const completedCount = allLessons.filter((l) => completedLessonIds.has(String(l.lessonId))).length
        const totalCount = allLessons.length
        totalLessonsAcrossCourses += totalCount
        totalCompletedLessonsCount += completedCount

        const isAllComplete = totalCount > 0 && completedCount >= totalCount
        const percentage = totalCount > 0
          ? Math.min(100, Math.round((completedCount / totalCount) * 100))
          : 0

        const status = isAllComplete || enrollment.status === 'completed'
          ? 'completed'
          : percentage > 0
            ? 'in_progress'
            : 'not_started'

        if (status === 'completed') {
          completedCoursesCount++
        }

        const nextLesson =
          allLessons.find((l) => !completedLessonIds.has(String(l.lessonId))) ||
          allLessons[0] ||
          null

        return {
          courseId: course._id,
          title: course.title,
          description: course.description,
          totalLessons: totalCount,
          completedLessons: completedCount,
          progressPercentage: percentage,
          status,
          nextLessonId: nextLesson?.lessonId || null,
          nextLessonTitle: nextLesson?.title || null,
          lastActivityAt: prog?.lastActivityAt || enrollment.updatedAt || enrollment.createdAt || null,
        }
      })

    const totalSeconds = activityTotals[0]?.totalSeconds || 0
    const totalHours = Number((totalSeconds / 3600).toFixed(1))
    const totalMinutes = Math.round(totalSeconds / 60)

    const distinctDates = (activityTotals[0]?.distinctDates || [])
      .filter((d) => typeof d === 'string' && d.length === 10)
      .sort()

    const { currentStreak, longestStreak } = calculateStreaks(distinctDates, tz)

    const overallProgressPercentage =
      totalLessonsAcrossCourses > 0
        ? Math.min(100, Math.round((totalCompletedLessonsCount / totalLessonsAcrossCourses) * 100))
        : 0

    const pendingLessonsCount = Math.max(0, totalLessonsAcrossCourses - totalCompletedLessonsCount)

    return res.json({
      totalHours,
      totalMinutes,
      totalCompletedLessons: totalCompletedLessonsCount,
      totalEnrolledCourses: coursesData.length,
      totalCompletedCourses: completedCoursesCount,
      pendingLessonsCount,
      overallProgressPercentage,
      currentStreak,
      longestStreak,
      dailyLearningGoalMinutes: account?.dailyLearningGoalMinutes || 60,
      courses: coursesData,
    })
  } catch (error) {
    return next(error)
  }
})

// 8. Update daily learning goal
router.put('/learning/goal', ...requireStudent, async (req, res, next) => {
  try {
    const goal = parseInt(req.body?.dailyLearningGoalMinutes, 10)
    if (isNaN(goal) || goal < 15 || goal > 480) {
      return res.status(400).json({
        message: 'Daily learning goal must be an integer between 15 and 480 minutes.',
      })
    }

    const StudentModel = req.auth.user?.studentType === 'college' ? CollegeStudent : Student
    await StudentModel.findByIdAndUpdate(req.auth.id, { dailyLearningGoalMinutes: goal })

    return res.json({
      message: 'Daily learning goal updated successfully.',
      dailyLearningGoalMinutes: goal,
    })
  } catch (error) {
    return next(error)
  }
})



// ---------------------------------------------------------------------------
// Video Attention Checks & PDF Certificates (Preserved from GitHub updates)
// ---------------------------------------------------------------------------
router.post('/courses/:courseId/attention-checks/:lessonId/start', ...requireStudent, async (req, res, next) => {
  try {
    const { courseId, lessonId } = req.params
    const { sessionId, triggerIndex, positionSeconds } = req.body ?? {}
    if (
      !isValidObjectId(courseId)
      || !isValidObjectId(lessonId)
      || typeof sessionId !== 'string'
      || !/^[a-f\d-]{36}$/i.test(sessionId)
      || !Number.isInteger(triggerIndex)
      || triggerIndex < 0
      || triggerIndex > 99
      || !Number.isFinite(positionSeconds)
      || positionSeconds < 0
      || positionSeconds > 43200
    ) {
      return res.status(400).json({ message: 'A valid course, lesson, playback session, question number, and video position are required.' })
    }

    const enrollment = await Enrollment.findOne({
      userId: req.auth.id,
      courseId,
      ...getStudentEnrollmentScope(req),
      status: { $ne: 'cancelled' },
    }).sort({ createdAt: -1 }).lean()
    if (!enrollment) return res.status(404).json({ message: 'An active enrollment is required to answer this attention check.' })

    const course = await Course.findById(courseId)
      .select('+modules.lessons.attentionCheck.questions.correctOptionIndices +modules.contentItems.attentionCheck.questions.correctOptionIndices')
      .lean()
    if (!course) return res.status(404).json({ message: 'The enrolled course could not be found.' })
    const lesson = findVideoLesson(course, lessonId)
    const attentionCheck = lesson?.attentionCheck
    if (!attentionCheck?.enabled) return res.status(404).json({ message: 'Attention checks are not enabled for this lesson.' })

    const questions = getSelectedAttentionQuestions(attentionCheck)
    const questionCount = attentionCheck.questionsDuringVideo ?? questions.length
    if (!questions.length || questions.length !== questionCount || triggerIndex >= questionCount) {
      return res.status(409).json({ message: 'The attention check configuration for this lesson is incomplete.' })
    }

    const scope = {
      userId: req.auth.id,
      enrollmentId: enrollment._id,
      courseId,
      lessonId,
      sessionId,
      triggerIndex,
    }
    const previousResponse = await VideoAttentionResponse.findOne(scope).select('+correctOptionIndices').lean()
    if (previousResponse && previousResponse.status !== 'presented') {
      return res.json({
        recorded: true,
        status: previousResponse.status,
        responseTimeMs: previousResponse.responseTimeMs,
        presentedAt: previousResponse.presentedAt,
        serverTime: new Date(),
      })
    }
    if (previousResponse) {
      return res.json({
        responseId: String(previousResponse._id),
        question: {
          _id: String(previousResponse.questionId),
          prompt: previousResponse.questionPrompt,
          type: previousResponse.questionType,
          options: previousResponse.options,
        },
        presentedAt: previousResponse.presentedAt,
        serverTime: new Date(),
      })
    }

    const priorResponses = await VideoAttentionResponse.find({
      userId: req.auth.id,
      enrollmentId: enrollment._id,
      lessonId,
      sessionId,
    }).select('questionId').lean()
    const usedQuestionIds = new Set(priorResponses.map((response) => String(response.questionId)))
    const availableQuestions = questions.filter((question) => !usedQuestionIds.has(String(question._id)))
    if (!availableQuestions.length) {
      return res.status(409).json({ message: 'There are no unused attention questions remaining in this playback session.' })
    }
    const question = availableQuestions[Math.floor(Math.random() * availableQuestions.length)]
    const presentedAt = new Date()
    const response = await VideoAttentionResponse.create({
      userId: req.auth.id,
      ...(req.auth.user.studentType === 'college' ? { collegeId: req.auth.user.collegeId } : {}),
      enrollmentId: enrollment._id,
      courseId,
      lessonId,
      lessonTitle: lesson.title || 'Video lesson',
      sessionId,
      triggerIndex,
      questionId: question._id,
      questionPrompt: question.prompt,
      questionType: question.type,
      options: question.options,
      correctOptionIndices: question.correctOptionIndices,
      videoPositionSeconds: positionSeconds,
      presentedAt,
      status: 'presented',
    })
    return res.status(201).json({
      responseId: String(response._id),
      question: {
        _id: String(question._id),
        prompt: question.prompt,
        type: question.type,
        options: question.options,
      },
      presentedAt,
      serverTime: new Date(),
    })
  } catch (error) {
    return next(error)
  }
})

router.post('/courses/:courseId/attention-checks/:lessonId/submit', ...requireStudent, async (req, res, next) => {
  try {
    const { courseId, lessonId } = req.params
    const { responseId, selectedOptionIndices, notAnswered } = req.body ?? {}
    if (!isValidObjectId(courseId) || !isValidObjectId(lessonId) || !isValidObjectId(responseId)) {
      return res.status(400).json({ message: 'Select a valid course, lesson, and attention check response.' })
    }
    if (notAnswered !== undefined && typeof notAnswered !== 'boolean') {
      return res.status(400).json({ message: 'The attention check response status is invalid.' })
    }

    const enrollment = await Enrollment.findOne({
      userId: req.auth.id,
      courseId,
      ...getStudentEnrollmentScope(req),
      status: { $ne: 'cancelled' },
    }).sort({ createdAt: -1 }).lean()
    if (!enrollment) return res.status(404).json({ message: 'An active enrollment is required to submit this attention check.' })

    const response = await VideoAttentionResponse.findOne({
      _id: responseId,
      userId: req.auth.id,
      enrollmentId: enrollment._id,
      courseId,
      lessonId,
    }).select('+correctOptionIndices')
    if (!response) return res.status(409).json({ message: 'This attention check is no longer available for submission.' })
    const answeredAt = new Date()
    const responseTimeMs = Math.max(0, answeredAt.getTime() - new Date(response.presentedAt).getTime())
    const isTimedOut = responseTimeMs >= attentionCheckResponseTimeoutMs
    const hasNoAnswer = notAnswered === true
      || selectedOptionIndices === undefined
      || (Array.isArray(selectedOptionIndices) && selectedOptionIndices.length === 0)
    const isNotAnswered = hasNoAnswer || isTimedOut

    if (response.status === 'answered') {
      if (notAnswered === true || !Array.isArray(selectedOptionIndices) || !isCorrectAttentionAnswer(selectedOptionIndices, response.selectedOptionIndices || [])) {
        return res.status(409).json({ message: 'This attention check has already been answered.' })
      }
      return res.json({
        recorded: true,
        status: 'answered',
        isCorrect: response.isCorrect,
        responseTimeMs: response.responseTimeMs,
      })
    }

    if (response.status === 'not_answered') {
      if (!isNotAnswered) return res.status(409).json({ message: 'This attention check was recorded as not answered.' })
      return res.json({
        recorded: true,
        status: 'not_answered',
        isCorrect: false,
        responseTimeMs: response.responseTimeMs,
      })
    }

    if (isNotAnswered && !isTimedOut) {
      return res.status(409).json({ message: 'The 10-second response window is still active.' })
    }

    if (isNotAnswered) {
      response.selectedOptionIndices = []
      response.answeredAt = answeredAt
      response.responseTimeMs = attentionCheckResponseTimeoutMs
      response.isCorrect = false
      response.status = 'not_answered'
      await response.save()
      return res.json({
        recorded: true,
        status: 'not_answered',
        isCorrect: false,
        responseTimeMs: response.responseTimeMs,
      })
    }

    if (
      !Array.isArray(selectedOptionIndices)
      || selectedOptionIndices.length < 1
      || selectedOptionIndices.length > response.options.length
      || selectedOptionIndices.some((index) => !Number.isInteger(index) || index < 0 || index >= response.options.length)
      || new Set(selectedOptionIndices).size !== selectedOptionIndices.length
      || (response.questionType !== 'multiple-select' && selectedOptionIndices.length !== 1)
    ) {
      return res.status(400).json({ message: 'Select a valid answer for this attention check.' })
    }

    response.selectedOptionIndices = selectedOptionIndices
    response.answeredAt = answeredAt
    response.responseTimeMs = responseTimeMs
    response.isCorrect = isCorrectAttentionAnswer(selectedOptionIndices, response.correctOptionIndices)
    response.status = 'answered'
    await response.save()
    return res.json({
      recorded: true,
      status: 'answered',
      isCorrect: response.isCorrect,
      responseTimeMs: response.responseTimeMs,
    })
  } catch (error) {
    return next(error)
  }
})

router.get('/courses/:courseId/quizzes/:quizId/attempts/status', ...requireStudent, async (req, res, next) => {
  try {
    const { courseId, quizId } = req.params
    if (![courseId, quizId].every(isValidObjectId)) {
      return res.status(400).json({ message: 'Select a valid course and quiz.' })
    }
    const enrollment = await Enrollment.findOne({
      userId: req.auth.id,
      courseId,
      ...getStudentEnrollmentScope(req),
      status: { $ne: 'cancelled' },
    }).sort({ createdAt: -1 }).lean()
    if (!enrollment) return res.status(404).json({ message: 'An active enrollment is required to view quiz status.' })

    const course = await Course.findById(courseId).select('_id modules quizzes').lean()
    if (!course) return res.status(404).json({ message: 'The enrolled course could not be found.' })
    if (!findQuiz(course, quizId)) return res.status(404).json({ message: 'This quiz is not available in the enrolled course.' })

    const now = new Date()
    const state = await getQuizAttemptState({
      userId: req.auth.id,
      courseId,
      quizId,
    }, now)
    return res.status(200).json({ quizStatus: getQuizAttemptStatus(state, now) })
  } catch (error) {
    return next(error)
  }
})

router.get(
  ['/certificates/:certificateId/pdf', '/certificates/:certificateId/preview', '/certificates/:certificateId/download'],
  ...requireStudent,
  async (req, res, next) => {
    try {
      const { certificateId } = req.params
      const isObjectId = isValidObjectId(certificateId)

      const ownership = {
        $or: [
          { userId: req.auth.id },
          { studentId: req.auth.id },
        ],
      }

      let certificate = null
      if (isObjectId) {
        certificate = await Certificate.findOne({
          _id: certificateId,
          ...ownership,
        }).lean()

        if (!certificate) {
          certificate = await Certificate.findOne({
            courseId: certificateId,
            ...ownership,
          }).lean()
        }
      } else {
        certificate = await Certificate.findOne({
          certificateId,
          ...ownership,
        }).lean()
      }

      if (!certificate && isObjectId) {
        const enrollment = await Enrollment.findOne({
          courseId: certificateId,
          userId: req.auth.id,
          status: 'completed',
        }).populate('courseId').lean()
        if (enrollment && enrollment.courseId?.generateCertificate !== false && req.auth.user.fullName?.trim()) {
          try {
            certificate = await issueCertificateIfEligible({
              userId: req.auth.id,
              studentName: req.auth.user.fullName,
              enrollment,
              course: enrollment.courseId,
            })
          } catch {
            // non-fatal fallback
          }
        }
      }

      if (!certificate) return res.status(404).json({ message: 'The certificate was not found.' })

      const activeTemplateId = await getActiveCertificateTemplateId()
      const templateId = certificate.templateId || activeTemplateId
      let templateImage = undefined
      if (templateId && templateId !== 'builtin') {
        try {
          const template = await CertificateTemplate.findById(templateId).select('+imageData secureUrl').lean()
          if (template) {
            templateImage = await loadCertificateTemplateImage(template)
          }
        } catch {
          templateImage = undefined
        }
      }

      const pdf = await generateCertificatePdf(certificate, templateImage)
      const download = req.query.download === 'true' || req.path.endsWith('/download')
      const courseSlug = (certificate.courseName || certificate.name || 'Course')
        .replace(/[^a-zA-Z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
      const filename = courseSlug
        ? `aiHustle-${courseSlug}-Certificate.pdf`
        : `aiHustle-certificate-${certificate.certificateId}.pdf`

      res.setHeader('Content-Type', 'application/pdf')
      res.setHeader('Content-Disposition', `${download ? 'attachment' : 'inline'}; filename="${filename}"`)
      res.setHeader('Cache-Control', 'private, no-store')
      res.setHeader('X-Content-Type-Options', 'nosniff')
      return res.send(pdf)
    } catch (error) {
      return next(error)
    }
  },
)

/* ==========================================================================
   Student Notes System APIs
   ========================================================================== */

async function handleGetCourseNotes(req, res, next) {
  try {
    const { courseId } = req.params
    if (!isValidObjectId(courseId)) {
      return res.status(400).json({ message: 'Select a valid course.' })
    }

    const { search, lessonId, pinned, sort = 'newest' } = req.query

    const course = await Course.findById(courseId).select('title').lean()
    if (!course) {
      return res.status(404).json({ message: 'Course not found.' })
    }

    const enrollment = await Enrollment.findOne({
      userId: req.auth.id,
      courseId,
      ...getStudentEnrollmentScope(req),
      status: { $ne: 'cancelled' },
    }).select('_id').lean()
    if (!enrollment) {
      return res.status(403).json({ message: 'Enroll in this course before accessing its notes.' })
    }

    const allNotes = await StudentNote.find({
      studentId: req.auth.id,
      courseId,
    }).sort({ isPinned: -1, updatedAt: -1 }).lean()

    const totalCount = allNotes.length
    const distinctLessons = new Set(allNotes.map((n) => n.lessonId).filter(Boolean))
    const lessonsCoveredCount = distinctLessons.size
    const pinnedCount = allNotes.filter((n) => n.isPinned).length

    let filtered = [...allNotes]

    if (search && typeof search === 'string' && search.trim()) {
      const term = search.trim().toLowerCase()
      filtered = filtered.filter((n) =>
        (n.title && n.title.toLowerCase().includes(term)) ||
        (n.content && n.content.toLowerCase().includes(term)) ||
        (n.lessonTitle && n.lessonTitle.toLowerCase().includes(term))
      )
    }

    if (lessonId && typeof lessonId === 'string' && lessonId.trim()) {
      filtered = filtered.filter((n) => String(n.lessonId) === lessonId.trim())
    }

    if (pinned === 'true' || pinned === true) {
      filtered = filtered.filter((n) => n.isPinned)
    }

    if (sort === 'oldest') {
      filtered.sort((a, b) => {
        if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1
        return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
      })
    } else if (sort === 'recently_edited') {
      filtered.sort((a, b) => {
        if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1
        return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
      })
    } else if (sort === 'lesson') {
      filtered.sort((a, b) => {
        if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1
        const comp = (a.lessonTitle || '').localeCompare(b.lessonTitle || '')
        if (comp !== 0) return comp
        return (a.videoTimestamp || 0) - (b.videoTimestamp || 0)
      })
    } else {
      filtered.sort((a, b) => {
        if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      })
    }

    return res.json({
      notes: filtered,
      totalCount,
      lessonsCoveredCount,
      pinnedCount,
    })
  } catch (error) {
    return next(error)
  }
}

async function handleCreateCourseNote(req, res, next) {
  try {
    const { courseId } = req.params
    if (!isValidObjectId(courseId)) {
      return res.status(400).json({ message: 'Select a valid course.' })
    }

    const { title, content, lessonId, lessonTitle, videoTimestamp, videoTimestampDisplay, isPinned } = req.body || {}

    if (!title || typeof title !== 'string' || !title.trim()) {
      return res.status(400).json({ message: 'Note title is required.' })
    }

    const course = await Course.findById(courseId).select('title').lean()
    if (!course) {
      return res.status(404).json({ message: 'Course not found.' })
    }

    const enrollment = await Enrollment.findOne({
      userId: req.auth.id,
      courseId,
      ...getStudentEnrollmentScope(req),
      status: { $ne: 'cancelled' },
    }).select('_id').lean()
    if (!enrollment) {
      return res.status(403).json({ message: 'Enroll in this course before saving notes.' })
    }

    const note = await StudentNote.create({
      studentId: req.auth.id,
      studentType: req.auth.user?.studentType === 'college' ? 'college' : 'independent',
      collegeId: req.auth.user?.collegeId || null,
      courseId,
      lessonId: typeof lessonId === 'string' ? lessonId.trim() : '',
      lessonTitle: typeof lessonTitle === 'string' ? lessonTitle.trim() : '',
      title: title.trim().slice(0, 200),
      content: typeof content === 'string' ? content.slice(0, 50000) : '',
      videoTimestamp: typeof videoTimestamp === 'number' && videoTimestamp >= 0 ? videoTimestamp : null,
      videoTimestampDisplay: typeof videoTimestampDisplay === 'string' ? videoTimestampDisplay.trim().slice(0, 20) : '',
      isPinned: Boolean(isPinned),
    })

    return res.status(201).json({
      message: 'Note created successfully.',
      note,
    })
  } catch (error) {
    return next(error)
  }
}

async function handleUpdateStudentNote(req, res, next) {
  try {
    const { noteId } = req.params
    if (!isValidObjectId(noteId)) {
      return res.status(400).json({ message: 'Valid note ID is required.' })
    }

    const note = await StudentNote.findOne({
      _id: noteId,
      studentId: req.auth.id,
    })
    if (!note) {
      return res.status(404).json({ message: 'Note not found.' })
    }

    const { title, content, lessonId, lessonTitle, videoTimestamp, videoTimestampDisplay, isPinned } = req.body || {}

    if (title !== undefined) {
      if (!title || typeof title !== 'string' || !title.trim()) {
        return res.status(400).json({ message: 'Note title cannot be empty.' })
      }
      note.title = title.trim().slice(0, 200)
    }

    if (content !== undefined) {
      note.content = typeof content === 'string' ? content.slice(0, 50000) : ''
    }

    if (lessonId !== undefined) {
      note.lessonId = typeof lessonId === 'string' ? lessonId.trim() : ''
    }

    if (lessonTitle !== undefined) {
      note.lessonTitle = typeof lessonTitle === 'string' ? lessonTitle.trim().slice(0, 300) : ''
    }

    if (videoTimestamp !== undefined) {
      note.videoTimestamp = typeof videoTimestamp === 'number' && videoTimestamp >= 0 ? videoTimestamp : null
    }

    if (videoTimestampDisplay !== undefined) {
      note.videoTimestampDisplay = typeof videoTimestampDisplay === 'string' ? videoTimestampDisplay.trim().slice(0, 20) : ''
    }

    if (isPinned !== undefined) {
      note.isPinned = Boolean(isPinned)
    }

    note.updatedAt = new Date()
    await note.save()

    return res.json({
      message: 'Note updated successfully.',
      note,
    })
  } catch (error) {
    return next(error)
  }
}

async function handleDeleteStudentNote(req, res, next) {
  try {
    const { noteId } = req.params
    if (!isValidObjectId(noteId)) {
      return res.status(400).json({ message: 'Valid note ID is required.' })
    }

    const note = await StudentNote.findOne({
      _id: noteId,
      studentId: req.auth.id,
    })
    if (!note) {
      return res.status(404).json({ message: 'Note not found.' })
    }

    await StudentNote.deleteOne({ _id: noteId, studentId: req.auth.id })

    return res.json({ message: 'Note deleted successfully.' })
  } catch (error) {
    return next(error)
  }
}

async function handleTogglePinStudentNote(req, res, next) {
  try {
    const { noteId } = req.params
    if (!isValidObjectId(noteId)) {
      return res.status(400).json({ message: 'Valid note ID is required.' })
    }

    const note = await StudentNote.findOne({
      _id: noteId,
      studentId: req.auth.id,
    })
    if (!note) {
      return res.status(404).json({ message: 'Note not found.' })
    }

    if (req.body?.isPinned !== undefined) {
      note.isPinned = Boolean(req.body.isPinned)
    } else {
      note.isPinned = !note.isPinned
    }

    note.updatedAt = new Date()
    await note.save()

    return res.json({
      message: note.isPinned ? 'Note pinned.' : 'Note unpinned.',
      note,
    })
  } catch (error) {
    return next(error)
  }
}

async function handleExportCourseNotes(req, res, next) {
  try {
    const { courseId } = req.params
    if (!isValidObjectId(courseId)) {
      return res.status(400).json({ message: 'Select a valid course.' })
    }

    const course = await Course.findById(courseId).select('title').lean()
    if (!course) {
      return res.status(404).json({ message: 'Course not found.' })
    }

    const enrollment = await Enrollment.findOne({
      userId: req.auth.id,
      courseId,
      ...getStudentEnrollmentScope(req),
      status: { $ne: 'cancelled' },
    }).select('_id').lean()
    if (!enrollment) {
      return res.status(403).json({ message: 'Enroll in this course before exporting notes.' })
    }

    const notes = await StudentNote.find({
      studentId: req.auth.id,
      courseId,
    }).sort({ isPinned: -1, createdAt: 1 }).lean()

    const courseSlug = (course.title || 'Course').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    const filename = `aiHustle-${courseSlug}-Notes.pdf`

    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    res.setHeader('Cache-Control', 'private, no-store')
    res.setHeader('X-Content-Type-Options', 'nosniff')

    const studentName = req.auth.user?.fullName || req.auth.user?.username || 'Student'
    generateStudentNotesPdf(res, { courseTitle: course.title, studentName, notes })
  } catch (error) {
    return next(error)
  }
}

router.get('/courses/:courseId/notes', ...requireStudent, handleGetCourseNotes)
router.get('/learning/courses/:courseId/notes', ...requireStudent, handleGetCourseNotes)

router.post('/courses/:courseId/notes', ...requireStudent, handleCreateCourseNote)
router.post('/learning/courses/:courseId/notes', ...requireStudent, handleCreateCourseNote)

router.put('/notes/:noteId', ...requireStudent, handleUpdateStudentNote)
router.put('/learning/notes/:noteId', ...requireStudent, handleUpdateStudentNote)
router.put('/courses/:courseId/notes/:noteId', ...requireStudent, handleUpdateStudentNote)
router.put('/learning/courses/:courseId/notes/:noteId', ...requireStudent, handleUpdateStudentNote)

router.delete('/notes/:noteId', ...requireStudent, handleDeleteStudentNote)
router.delete('/learning/notes/:noteId', ...requireStudent, handleDeleteStudentNote)
router.delete('/courses/:courseId/notes/:noteId', ...requireStudent, handleDeleteStudentNote)
router.delete('/learning/courses/:courseId/notes/:noteId', ...requireStudent, handleDeleteStudentNote)

router.patch('/notes/:noteId/pin', ...requireStudent, handleTogglePinStudentNote)
router.patch('/learning/notes/:noteId/pin', ...requireStudent, handleTogglePinStudentNote)

router.get('/courses/:courseId/notes/export', ...requireStudent, handleExportCourseNotes)
router.get('/learning/courses/:courseId/notes/export', ...requireStudent, handleExportCourseNotes)

/* ==========================================================================
   Student Resources APIs (Course Cheat Sheets & Supplementary Materials)
   ========================================================================== */

async function handleGetStudentResources(req, res, next) {
  try {
    const enrollments = await Enrollment.find({
      userId: req.auth.id,
      status: { $ne: 'cancelled' },
      ...getStudentEnrollmentScope(req),
    }).populate('courseId', 'title category thumbnailUrl').lean()

    const enrolledCourses = (enrollments || [])
      .map((e) => e.courseId)
      .filter((c) => c && typeof c === 'object')

    const courseIds = enrolledCourses.map((c) => c._id)

    const { courseId, search } = req.query
    const query = { courseId: { $in: courseIds } }

    if (courseId && isValidObjectId(courseId)) {
      if (!courseIds.some((id) => String(id) === String(courseId))) {
        return res.status(403).json({ message: 'You are not enrolled in this course.' })
      }
      query.courseId = courseId
    }

    if (search && typeof search === 'string' && search.trim()) {
      const term = search.trim().toLowerCase()
      query.$or = [
        { title: { $regex: term, $options: 'i' } },
        { description: { $regex: term, $options: 'i' } },
        { originalFileName: { $regex: term, $options: 'i' } },
      ]
    }

    const resources = await Resource.find(query)
      .populate('courseId', 'title category thumbnailUrl')
      .sort({ createdAt: -1 })
      .lean()

    const enrichedResources = (resources || []).map((resource) => {
      const { deliveryUrl, downloadUrl } = getSignedResourceDeliveryUrls(resource)
      return {
        ...resource,
        url: deliveryUrl || resource.url,
        signedUrl: deliveryUrl || resource.url,
        downloadUrl: downloadUrl || deliveryUrl || resource.url,
      }
    })

    return res.json({
      resources: enrichedResources,
      courses: enrolledCourses,
    })
  } catch (error) {
    return next(error)
  }
}

async function handleGetCourseResources(req, res, next) {
  try {
    const { courseId } = req.params
    if (!isValidObjectId(courseId)) {
      return res.status(400).json({ message: 'Select a valid course.' })
    }

    const enrollment = await Enrollment.findOne({
      userId: req.auth.id,
      courseId,
      status: { $ne: 'cancelled' },
      ...getStudentEnrollmentScope(req),
    }).select('_id').lean()

    if (!enrollment) {
      return res.status(403).json({ message: 'Enroll in this course before accessing its resources.' })
    }

    const resources = await Resource.find({ courseId })
      .populate('courseId', 'title category thumbnailUrl')
      .sort({ createdAt: -1 })
      .lean()

    const enrichedResources = (resources || []).map((resource) => {
      const { deliveryUrl, downloadUrl } = getSignedResourceDeliveryUrls(resource)
      return {
        ...resource,
        url: deliveryUrl || resource.url,
        signedUrl: deliveryUrl || resource.url,
        downloadUrl: downloadUrl || deliveryUrl || resource.url,
      }
    })

    return res.json({ resources: enrichedResources })
  } catch (error) {
    return next(error)
  }
}

async function handleGetResourceFile(req, res, next) {
  try {
    const { resourceId } = req.params
    if (!isValidObjectId(resourceId)) {
      return res.status(400).json({ message: 'Valid resource ID is required.' })
    }

    const resource = await Resource.findById(resourceId).lean()
    if (!resource) {
      return res.status(404).json({ message: 'Resource not found.' })
    }

    if (req.auth.role === 'student') {
      const enrollment = await Enrollment.findOne({
        userId: req.auth.id,
        courseId: resource.courseId,
        status: { $ne: 'cancelled' },
        ...getStudentEnrollmentScope(req),
      }).select('_id').lean()

      if (!enrollment) {
        return res.status(403).json({ message: 'Enroll in this course before accessing its resources.' })
      }
    } else if (!['main_admin', 'college_admin'].includes(req.auth.role)) {
      return res.status(403).json({ message: 'You do not have permission to access this resource.' })
    }

    const buffer = await fetchResourcePdfBuffer(resource)
    const isDownload = req.query.download === 'true' || req.query.download === '1'
    const originalName = resource.originalFileName || `${resource.title || 'resource'}.pdf`
    const safeFilename = path.basename(originalName).replace(/["\r\n]/g, '_')

    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader(
      'Content-Disposition',
      `${isDownload ? 'attachment' : 'inline'}; filename="${safeFilename}"`
    )
    res.setHeader('Content-Length', buffer.length)
    res.setHeader('Cache-Control', 'private, no-store, max-age=0')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    return res.end(buffer)
  } catch (error) {
    return next(error)
  }
}

async function handleGetResourceAccess(req, res, next) {
  try {
    const { resourceId } = req.params
    if (!isValidObjectId(resourceId)) {
      return res.status(400).json({ message: 'Valid resource ID is required.' })
    }

    const resource = await Resource.findById(resourceId)
      .populate('courseId', 'title category thumbnailUrl')
      .lean()

    if (!resource) {
      return res.status(404).json({ message: 'Resource not found.' })
    }

    if (req.auth.role === 'student') {
      const enrollment = await Enrollment.findOne({
        userId: req.auth.id,
        courseId: resource.courseId,
        status: { $ne: 'cancelled' },
        ...getStudentEnrollmentScope(req),
      }).select('_id').lean()

      if (!enrollment) {
        return res.status(403).json({ message: 'Enroll in this course before accessing its resources.' })
      }
    } else if (!['main_admin', 'college_admin'].includes(req.auth.role)) {
      return res.status(403).json({ message: 'You do not have permission to access this resource.' })
    }

    const { deliveryUrl, downloadUrl } = getSignedResourceDeliveryUrls(resource)
    const proxyUrl = `/api/resources/${resource._id}/file`

    return res.json({
      success: true,
      resourceId: resource._id,
      title: resource.title,
      fileName: resource.originalFileName || `${resource.title || 'resource'}.pdf`,
      fileSize: resource.fileSize,
      url: deliveryUrl || resource.url,
      signedUrl: deliveryUrl,
      downloadUrl: downloadUrl || deliveryUrl || resource.url,
      proxyUrl,
    })
  } catch (error) {
    return next(error)
  }
}

const requireResourceAccess = [authenticate, requireRoles('student', 'main_admin', 'college_admin')]

router.get('/student/resources', ...requireStudent, handleGetStudentResources)
router.get('/learning/resources', ...requireStudent, handleGetStudentResources)
router.get('/courses/:courseId/resources', ...requireStudent, handleGetCourseResources)
router.get('/learning/courses/:courseId/resources', ...requireStudent, handleGetCourseResources)
router.get('/resources/:resourceId/file', ...requireResourceAccess, handleGetResourceFile)
router.get('/student/resources/:resourceId/file', ...requireResourceAccess, handleGetResourceFile)
router.get('/resources/:resourceId/access', ...requireResourceAccess, handleGetResourceAccess)
router.get('/student/resources/:resourceId/access', ...requireResourceAccess, handleGetResourceAccess)

export default router
