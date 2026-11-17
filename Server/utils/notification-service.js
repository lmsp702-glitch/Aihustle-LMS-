import Notification from '../models/Notification.js'
import NotificationPreference, { DEFAULT_NOTIFICATION_PREFERENCES } from '../models/NotificationPreference.js'
import { emailNotificationsConfigured, logEmailDeliveryFailure, sendResendEmail } from './email.js'

export const NOTIFICATION_CATEGORIES = Object.freeze({
  courseAnnouncements: 'courseAnnouncements',
  newCourseUpdates: 'newCourseUpdates',
  assignmentDeadlines: 'assignmentDeadlines',
  quizReminders: 'quizReminders',
  referralNotifications: 'referralNotifications',
  emailNotifications: 'emailNotifications',
})

const CATEGORY_MAP = Object.freeze({
  course_announcements: 'courseAnnouncements',
  courseannouncements: 'courseAnnouncements',
  announcements: 'courseAnnouncements',
  new_course_updates: 'newCourseUpdates',
  newcourseupdates: 'newCourseUpdates',
  course_published: 'newCourseUpdates',
  assignment_deadlines: 'assignmentDeadlines',
  assignmentdeadlines: 'assignmentDeadlines',
  assignment_reminder: 'assignmentDeadlines',
  quiz_reminders: 'quizReminders',
  quizreminders: 'quizReminders',
  quiz_reminder: 'quizReminders',
  referral_notifications: 'referralNotifications',
  referralnotifications: 'referralNotifications',
  referral_registered: 'referralNotifications',
})

export function normalizeCategoryKey(category) {
  if (!category || typeof category !== 'string') return null
  const normalized = category.trim().toLowerCase().replaceAll('-', '_')
  return CATEGORY_MAP[normalized] || (category in DEFAULT_NOTIFICATION_PREFERENCES ? category : null)
}

export function sanitizePreferences(doc) {
  return {
    courseAnnouncements: doc?.courseAnnouncements ?? DEFAULT_NOTIFICATION_PREFERENCES.courseAnnouncements,
    newCourseUpdates: doc?.newCourseUpdates ?? DEFAULT_NOTIFICATION_PREFERENCES.newCourseUpdates,
    assignmentDeadlines: doc?.assignmentDeadlines ?? DEFAULT_NOTIFICATION_PREFERENCES.assignmentDeadlines,
    quizReminders: doc?.quizReminders ?? DEFAULT_NOTIFICATION_PREFERENCES.quizReminders,
    referralNotifications: doc?.referralNotifications ?? DEFAULT_NOTIFICATION_PREFERENCES.referralNotifications,
    emailNotifications: doc?.emailNotifications ?? DEFAULT_NOTIFICATION_PREFERENCES.emailNotifications,
  }
}

export async function getStudentNotificationPreferences(studentId) {
  if (!studentId) return { ...DEFAULT_NOTIFICATION_PREFERENCES }
  try {
    const doc = await NotificationPreference.findOne({ userId: studentId }).lean()
    return sanitizePreferences(doc)
  } catch {
    return { ...DEFAULT_NOTIFICATION_PREFERENCES }
  }
}

export function canDeliverNotification(preferences, category, channel = 'in_app') {
  const current = preferences || DEFAULT_NOTIFICATION_PREFERENCES
  if (channel === 'email' && current.emailNotifications === false) {
    return false
  }
  const key = normalizeCategoryKey(category)
  if (key && current[key] === false) {
    return false
  }
  return true
}

export async function sendNotification({
  recipientRole = 'student',
  recipientId,
  collegeId = null,
  type,
  category = null,
  title,
  message,
  link = null,
  metadata = {},
  emailOptions = null,
}) {
  // Non-student recipients (admin, college_admin) are not filtered by student preferences
  if (recipientRole !== 'student') {
    const notification = await Notification.create({
      recipientRole,
      recipientId,
      collegeId,
      type,
      title,
      message,
      link,
      metadata,
    })
    return { inAppDelivered: true, emailDelivered: false, notification }
  }

  // Student recipient: check notification preferences
  const preferences = await getStudentNotificationPreferences(recipientId)

  const inAppAllowed = canDeliverNotification(preferences, category, 'in_app')
  let notification = null
  if (inAppAllowed) {
    notification = await Notification.create({
      recipientRole: 'student',
      recipientId,
      collegeId,
      type,
      title,
      message,
      link,
      metadata,
    })
  }

  let emailDelivered = false
  if (emailOptions && emailOptions.to) {
    const emailAllowed = inAppAllowed && canDeliverNotification(preferences, category, 'email')
    if (emailAllowed && emailNotificationsConfigured()) {
      try {
        await sendResendEmail(emailOptions)
        emailDelivered = true
      } catch (emailError) {
        logEmailDeliveryFailure({
          event: 'notification.email.failed',
          accountId: recipientId,
          error: emailError,
        })
      }
    }
  }

  return { inAppDelivered: inAppAllowed, emailDelivered, notification }
}

