import mongoose from 'mongoose'
import { Router } from 'express'
import AssignmentSubmission from '../models/AssignmentSubmission.js'
import Enrollment from '../models/Enrollment.js'
import Notification from '../models/Notification.js'
import QuizAttempt from '../models/QuizAttempt.js'
import { authenticate, requireRoles } from '../middleware/auth.js'
import { getCourseActivities } from '../utils/certificates.js'
import { createStudentNotification } from '../utils/student-notifications.js'

const router = Router()

function getStudentEnrollmentScope(req) {
  return req.auth.user.studentType === 'college'
    ? { collegeId: req.auth.user.collegeId }
    : { collegeId: { $exists: false } }
}

function getCourseAssignments(course) {
  const moduleAssignments = (course.modules || []).flatMap((module) => (
    (module.contentItems || [])
      .filter((item) => item.type === 'assignment')
      .map((item) => ({
        ...item,
        ...(item.assignment || {}),
        _id: item._id || item.assignment?._id,
      }))
  ))
  const seenIds = new Set()
  return [...(course.assignments || []), ...moduleAssignments].filter((assignment) => {
    const id = String(assignment._id || '')
    if (!id || seenIds.has(id)) return false
    seenIds.add(id)
    return true
  })
}

function getStudentCourseLink(courseId, activityId, activityType) {
  const params = new URLSearchParams()
  if (activityId && activityType) {
    params.set('activity', String(activityId))
    params.set('activityType', activityType)
  }
  const query = params.toString()
  return `/student/course/${encodeURIComponent(String(courseId))}/learn${query ? `?${query}` : ''}`
}

function formatActivityCount(count, label) {
  const pluralLabel = label === 'quiz' ? 'quizzes' : `${label}s`
  return `${count} ${count === 1 ? label : pluralLabel}`
}

async function createDailyCourseReminders(req) {
  const enrollments = await Enrollment.find({
    userId: req.auth.id,
    ...getStudentEnrollmentScope(req),
    status: 'active',
  })
    .populate('courseId', 'title status assignments quizzes modules')
    .sort({ createdAt: -1 })
    .limit(500)
    .lean()
  if (!enrollments.length) return

  const enrollmentIds = enrollments.map(({ _id }) => _id)
  const [passedAttempts, submissions] = await Promise.all([
    QuizAttempt.find({
      userId: req.auth.id,
      enrollmentId: { $in: enrollmentIds },
      status: 'submitted',
      passed: true,
    })
      .select('enrollmentId quizId')
      .lean(),
    AssignmentSubmission.find({
      userId: req.auth.id,
      enrollmentId: { $in: enrollmentIds },
    })
      .select('enrollmentId assignmentId reviewStatus submittedAt')
      .sort({ submittedAt: -1, _id: -1 })
      .lean(),
  ])
  const passedQuizKeys = new Set(passedAttempts.map((attempt) => `${attempt.enrollmentId}:${attempt.quizId}`))
  const submissionByAssignment = new Map()
  for (const submission of submissions) {
    const key = `${submission.enrollmentId}:${submission.assignmentId}`
    if (!submissionByAssignment.has(key)) submissionByAssignment.set(key, submission)
  }

  const now = new Date()
  const reminderDate = now.toISOString().slice(0, 10)
  const reminderEvents = []
  for (const enrollment of enrollments) {
    const course = enrollment.courseId
    if (!course) continue
    const activities = getCourseActivities(course)
    const completedLessonIds = new Set((enrollment.completedLessonIds || []).map(String))
    const pendingLessons = activities.videos.filter(({ id }) => !completedLessonIds.has(id))
    const pendingQuizzes = activities.quizzes.filter(({ id }) => (
      !passedQuizKeys.has(`${enrollment._id}:${id}`)
    ))
    const pendingAssignments = activities.assignments
      .map((activity) => ({
        activity,
        submission: submissionByAssignment.get(`${enrollment._id}:${activity.id}`),
      }))
      .filter(({ submission }) => submission?.reviewStatus !== 'approved')

    if (!pendingLessons.length && !pendingQuizzes.length && !pendingAssignments.length) continue

    const assignmentsToSubmit = pendingAssignments.filter(({ submission }) => !submission)
    const assignmentsToResubmit = pendingAssignments.filter(({ submission }) => submission?.reviewStatus === 'rejected')
    const assignmentsAwaitingReview = pendingAssignments.filter(({ submission }) => (
      submission && submission.reviewStatus !== 'rejected'
    ))
    const pendingParts = []
    if (pendingLessons.length) pendingParts.push(formatActivityCount(pendingLessons.length, 'lesson'))
    if (pendingQuizzes.length) pendingParts.push(formatActivityCount(pendingQuizzes.length, 'quiz'))
    if (assignmentsToSubmit.length) {
      pendingParts.push(`${formatActivityCount(assignmentsToSubmit.length, 'assignment')} to submit`)
    }
    if (assignmentsToResubmit.length) {
      pendingParts.push(`${formatActivityCount(assignmentsToResubmit.length, 'assignment')} to resubmit`)
    }
    if (assignmentsAwaitingReview.length) {
      pendingParts.push(`${formatActivityCount(assignmentsAwaitingReview.length, 'assignment')} awaiting review`)
    }

    const pendingAssignmentIds = new Set(pendingAssignments.map(({ activity }) => activity.id))
    const nearestDueAssignment = getCourseAssignments(course)
      .filter((assignment) => pendingAssignmentIds.has(String(assignment._id)) && assignment.dueDate)
      .map((assignment) => ({ ...assignment, dueDate: new Date(assignment.dueDate) }))
      .filter((assignment) => Number.isFinite(assignment.dueDate.getTime()))
      .sort((left, right) => left.dueDate - right.dueDate)[0]
    const dueDateMessage = nearestDueAssignment
      ? `${nearestDueAssignment.dueDate < now ? 'Overdue' : 'Next due'}: ${nearestDueAssignment.title || 'Assignment'} · ${new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' }).format(nearestDueAssignment.dueDate)}.`
      : ''
    const courseTitle = course.title || 'your course'

    reminderEvents.push({
      recipientId: req.auth.id,
      eventKey: `course-incomplete:${req.auth.id}:${enrollment._id}:${reminderDate}`,
      type: 'course_incomplete',
      title: `Continue ${courseTitle}`.slice(0, 160),
      message: `${courseTitle} · Still pending: ${pendingParts.join(', ')}.${dueDateMessage ? ` ${dueDateMessage}` : ''}`,
      link: getStudentCourseLink(course._id),
      metadata: {
        courseId: String(course._id),
        enrollmentId: String(enrollment._id),
        reminderDate,
        pendingLessons: pendingLessons.length,
        pendingQuizzes: pendingQuizzes.length,
        pendingAssignments: pendingAssignments.length,
      },
    })
  }
  await Promise.all(reminderEvents.map((event) => createStudentNotification(event)))
}

function getNotificationScope(req) {
  return {
    recipientRole: req.auth.role,
    ...(req.auth.role === 'student' ? { recipientId: req.auth.id } : {}),
    deletedAt: null,
  }
}

router.get('/me', authenticate, requireRoles('main_admin', 'student'), async (req, res, next) => {
  try {
    if (req.auth.role === 'student') await createDailyCourseReminders(req)

    const filter = getNotificationScope(req)
    const [notifications, unreadCount] = await Promise.all([
      Notification.find(filter).sort({ createdAt: -1 }).limit(50).lean(),
      Notification.countDocuments({
        ...filter,
        ...(req.auth.role === 'main_admin'
          ? { readBy: { $ne: req.auth.id } }
          : { readAt: null }),
      }),
    ])
    return res.json({
      notifications: notifications.map((notification) => ({
        id: String(notification._id),
        type: notification.type,
        title: notification.title,
        message: notification.message,
        link: notification.link,
        metadata: notification.metadata,
        createdAt: notification.createdAt,
        readAt: notification.readAt || null,
        ...(req.auth.role === 'main_admin'
          ? {
            isRead: (notification.readBy || [])
              .some((adminId) => String(adminId) === String(req.auth.id)),
            actionCompleted: Boolean(notification.actionCompletedAt),
          }
          : { isRead: Boolean(notification.readAt) }),
      })),
      unreadCount,
    })
  } catch (error) {
    return next(error)
  }
})

router.patch('/read-all', authenticate, requireRoles('student'), async (req, res, next) => {
  try {
    const result = await Notification.updateMany(
      { ...getNotificationScope(req), readAt: null },
      { $set: { readAt: new Date() } },
    )
    return res.json({ updatedCount: result.modifiedCount || 0 })
  } catch (error) {
    return next(error)
  }
})

router.patch('/:notificationId/read', authenticate, requireRoles('main_admin', 'student'), async (req, res, next) => {
  try {
    const { notificationId } = req.params
    if (!mongoose.isValidObjectId(notificationId)) {
      return res.status(400).json({ message: 'Select a valid notification.' })
    }
    const filter = req.auth.role === 'main_admin'
      ? { _id: notificationId, recipientRole: 'main_admin', deletedAt: null }
      : { _id: notificationId, ...getNotificationScope(req) }
    const update = req.auth.role === 'main_admin'
      ? { $addToSet: { readBy: req.auth.id } }
      : { $set: { readAt: new Date() } }
    const notification = await Notification.findOneAndUpdate(filter, update, { new: true })
    if (!notification) return res.status(404).json({ message: 'The notification was not found.' })
    if (req.auth.role === 'main_admin') return res.json({ isRead: true })
    return res.json({
      id: String(notification._id),
      readAt: notification.readAt || null,
      isRead: true,
    })
  } catch (error) {
    return next(error)
  }
})

router.delete('/:notificationId', authenticate, requireRoles('student'), async (req, res, next) => {
  try {
    const { notificationId } = req.params
    if (!mongoose.isValidObjectId(notificationId)) {
      return res.status(400).json({ message: 'Select a valid notification.' })
    }
    const notification = await Notification.findOneAndUpdate(
      { _id: notificationId, ...getNotificationScope(req) },
      { $set: { deletedAt: new Date() } },
      { new: true },
    ).lean()
    if (!notification) return res.status(404).json({ message: 'The notification was not found.' })
    return res.json({ deleted: true })
  } catch (error) {
    return next(error)
  }
})

export default router
