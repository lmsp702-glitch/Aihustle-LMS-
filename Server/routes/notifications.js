import { Router } from 'express'
import Notification from '../models/Notification.js'
import NotificationPreference from '../models/NotificationPreference.js'
import { sanitizePreferences } from '../utils/notification-service.js'
import { authenticate, requireRoles } from '../middleware/auth.js'

const router = Router()

const allowedPreferenceKeys = [
  'courseAnnouncements',
  'newCourseUpdates',
  'assignmentDeadlines',
  'quizReminders',
  'referralNotifications',
  'emailNotifications',
]

router.get('/preferences', authenticate, requireRoles('student'), async (req, res, next) => {
  try {
    const doc = await NotificationPreference.findOne({
      userId: req.auth.id,
      accountCollection: req.auth.accountCollection,
    }).lean()

    return res.json({
      preferences: sanitizePreferences(doc),
    })
  } catch (error) {
    return next(error)
  }
})

async function handleUpdatePreferences(req, res, next) {
  try {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ message: 'Invalid notification preferences payload.' })
    }

    const updates = {}
    for (const key of allowedPreferenceKeys) {
      if (key in req.body) {
        if (typeof req.body[key] !== 'boolean') {
          return res.status(400).json({ message: `Preference ${key} must be a boolean.` })
        }
        updates[key] = req.body[key]
      }
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ message: 'No valid notification preferences were provided.' })
    }

    const studentType = req.auth.user?.studentType || (req.auth.accountCollection === 'clg_students' ? 'college' : 'independent')

    const updated = await NotificationPreference.findOneAndUpdate(
      { userId: req.auth.id, accountCollection: req.auth.accountCollection },
      {
        $set: {
          userId: req.auth.id,
          accountCollection: req.auth.accountCollection,
          studentType,
          ...updates,
        },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    ).lean()

    return res.json({
      message: 'Notification preferences updated.',
      preferences: sanitizePreferences(updated),
    })
  } catch (error) {
    return next(error)
  }
}

router.patch('/preferences', authenticate, requireRoles('student'), handleUpdatePreferences)
router.put('/preferences', authenticate, requireRoles('student'), handleUpdatePreferences)

router.get('/me', authenticate, requireRoles('main_admin', 'student'), async (req, res, next) => {
  try {
    const filter = { recipientRole: req.auth.role }
    if (req.auth.role === 'student') filter.recipientId = req.auth.id

    const notifications = await Notification.find(filter)
      .sort({ createdAt: -1 })
      .limit(50)
      .lean()
    return res.json({
      notifications: notifications.map((notification) => ({
        id: String(notification._id),
        type: notification.type,
        title: notification.title,
        message: notification.message,
        link: notification.link,
        metadata: notification.metadata,
        createdAt: notification.createdAt,
      })),
    })
  } catch (error) {
    return next(error)
  }
})

export default router
