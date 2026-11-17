import mongoose from 'mongoose'

const feedbackReplySchema = new mongoose.Schema(
  {
    authorId: { type: mongoose.Schema.Types.ObjectId, required: true },
    authorRole: { type: String, enum: ['main_admin'], required: true },
    message: { type: String, required: true, trim: true, maxlength: 5000 },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
)

const feedbackSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    userCollection: { type: String, enum: ['students', 'clg_students'], required: true },
    message: { type: String, required: true, trim: true, minlength: 1, maxlength: 5000 },
    replies: { type: [feedbackReplySchema], default: [] },
  },
  { autoCreate: false, autoIndex: false, timestamps: true, collection: 'feedback' },
)

feedbackSchema.index({ createdAt: -1 })

const Feedback =
  mongoose.models.Feedback ||
  mongoose.model('Feedback', feedbackSchema, 'feedback')

export default Feedback
