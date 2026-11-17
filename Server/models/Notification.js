import mongoose from 'mongoose'

const notificationSchema = new mongoose.Schema(
  {
    recipientRole: {
      type: String,
      enum: ['main_admin', 'student', 'college_admin', 'college'],
      required: true,
    },
    recipientId: { type: mongoose.Schema.Types.ObjectId },
    collegeId: { type: mongoose.Schema.Types.ObjectId, ref: 'College' },
    isRead: { type: Boolean, default: false },
    type: {
      type: String,
      required: true,
    },
    eventKey: { type: String, trim: true, maxlength: 300 },
    title: { type: String, required: true, trim: true, maxlength: 160 },
    message: { type: String, required: true, trim: true, maxlength: 1200 },
    link: { type: String, trim: true, maxlength: 300 },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
    readAt: { type: Date, default: null },
    deletedAt: { type: Date, default: null },
    readBy: [{ type: mongoose.Schema.Types.ObjectId }],
    actionCompletedAt: { type: Date },
  },
  { autoCreate: false, autoIndex: false, timestamps: true, collection: 'notifications' },
)

notificationSchema.index({ recipientRole: 1, recipientId: 1, createdAt: -1 })
notificationSchema.index({ collegeId: 1, recipientRole: 1, createdAt: -1 })
notificationSchema.index({ eventKey: 1 }, { unique: true, sparse: true, name: 'unique_notification_event_key' })
notificationSchema.index({ recipientRole: 1, recipientId: 1, deletedAt: 1, readAt: 1 }, { name: 'notification_unread_count' })

const Notification =
  mongoose.models.Notification ||
  mongoose.model('Notification', notificationSchema, 'notifications')

export default Notification
