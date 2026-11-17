import mongoose from 'mongoose'

export const DEFAULT_NOTIFICATION_PREFERENCES = Object.freeze({
  courseAnnouncements: true,
  newCourseUpdates: true,
  assignmentDeadlines: true,
  quizReminders: true,
  referralNotifications: true,
  emailNotifications: true,
})

const notificationPreferenceSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      index: true,
    },
    accountCollection: {
      type: String,
      enum: ['students', 'clg_students'],
      required: true,
      default: 'students',
    },
    studentType: {
      type: String,
      enum: ['independent', 'college'],
      default: 'independent',
    },
    courseAnnouncements: { type: Boolean, default: true, required: true },
    newCourseUpdates: { type: Boolean, default: true, required: true },
    assignmentDeadlines: { type: Boolean, default: true, required: true },
    quizReminders: { type: Boolean, default: true, required: true },
    referralNotifications: { type: Boolean, default: true, required: true },
    emailNotifications: { type: Boolean, default: true, required: true },
  },
  {
    autoCreate: false,
    autoIndex: false,
    timestamps: true,
    collection: 'notification_preferences',
  },
)

notificationPreferenceSchema.index({ userId: 1, accountCollection: 1 }, { unique: true })

const NotificationPreference =
  mongoose.models.NotificationPreference ||
  mongoose.model('NotificationPreference', notificationPreferenceSchema, 'notification_preferences')

export default NotificationPreference

