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
    title: { type: String, required: true, trim: true, maxlength: 160 },
    message: { type: String, required: true, trim: true, maxlength: 1200 },
    link: { type: String, trim: true, maxlength: 300 },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { autoCreate: false, autoIndex: false, timestamps: true, collection: 'notifications' },
)

notificationSchema.index({ recipientRole: 1, recipientId: 1, createdAt: -1 })
notificationSchema.index({ collegeId: 1, recipientRole: 1, createdAt: -1 })

const Notification =
  mongoose.models.Notification ||
  mongoose.model('Notification', notificationSchema, 'notifications')

export default Notification
