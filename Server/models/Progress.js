import mongoose from 'mongoose'

const lessonCompletionSchema = new mongoose.Schema(
  {
    moduleId: { type: mongoose.Schema.Types.ObjectId, required: true },
    lessonId: { type: mongoose.Schema.Types.ObjectId, required: true },
    completedAt: { type: Date, default: Date.now },
  },
  { _id: false },
)

const quizSubmissionSchema = new mongoose.Schema(
  {
    quizId: { type: mongoose.Schema.Types.ObjectId, required: true },
    score: { type: Number, default: 0 },
    totalQuestions: { type: Number, default: 0 },
    passed: { type: Boolean, default: false },
    submittedAt: { type: Date, default: Date.now },
  },
  { _id: false },
)

const progressSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    courseId: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', required: true, index: true },
    collegeId: { type: mongoose.Schema.Types.ObjectId, ref: 'College', required: false, default: null, index: true },
    completedLessons: { type: [lessonCompletionSchema], default: [] },
    quizSubmissions: { type: [quizSubmissionSchema], default: [] },
    progressPercentage: { type: Number, default: 0, min: 0, max: 100 },
    status: {
      type: String,
      enum: ['not_started', 'in_progress', 'completed'],
      default: 'in_progress',
    },
    completedAt: { type: Date },
    lastActivityAt: { type: Date, default: Date.now },
  },
  { autoCreate: false, autoIndex: false, timestamps: true, collection: 'student_progress' },
)

progressSchema.index({ userId: 1, courseId: 1 }, { unique: true, name: 'unique_user_course_progress' })
progressSchema.index({ collegeId: 1, progressPercentage: -1 })

const Progress =
  mongoose.models.Progress || mongoose.model('Progress', progressSchema, 'student_progress')

export default Progress

