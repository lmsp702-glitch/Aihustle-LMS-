import mongoose from 'mongoose'

const learningActivitySchema = new mongoose.Schema(
  {
    studentId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      index: true,
    },
    userRole: {
      type: String,
      enum: ['student'],
      default: 'student',
    },
    collegeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'College',
      default: null,
    },
    courseId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Course',
      required: true,
      index: true,
    },
    moduleId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },
    lessonId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
      index: true,
    },
    sessionId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    activityType: {
      type: String,
      enum: ['lesson_reading', 'video_watching', 'general_study'],
      default: 'lesson_reading',
    },
    startedAt: {
      type: Date,
      default: Date.now,
    },
    lastHeartbeatAt: {
      type: Date,
      default: Date.now,
    },
    endedAt: {
      type: Date,
      default: null,
    },
    durationSeconds: {
      type: Number,
      default: 0,
      min: 0,
    },
    date: {
      type: String,
      required: true,
      index: true,
    },
    completed: {
      type: Boolean,
      default: false,
    },
    completedAt: {
      type: Date,
      default: null,
    },
  },
  {
    autoCreate: false,
    autoIndex: false,
    timestamps: true,
    collection: 'learning_activities',
  },
)

learningActivitySchema.index({ studentId: 1, date: 1 })
learningActivitySchema.index({ studentId: 1, courseId: 1 })
learningActivitySchema.index({ studentId: 1, completed: 1, date: 1 })

const LearningActivity =
  mongoose.models.LearningActivity ||
  mongoose.model('LearningActivity', learningActivitySchema, 'learning_activities')

export default LearningActivity

