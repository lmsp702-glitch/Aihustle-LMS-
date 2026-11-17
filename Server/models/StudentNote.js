import mongoose from 'mongoose'

const studentNoteSchema = new mongoose.Schema(
  {
    studentId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      index: true,
    },
    studentType: {
      type: String,
      enum: ['independent', 'college'],
      default: 'independent',
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
    lessonId: {
      type: String,
      trim: true,
      default: '',
    },
    lessonTitle: {
      type: String,
      trim: true,
      maxlength: 300,
      default: '',
    },
    title: {
      type: String,
      trim: true,
      required: true,
      maxlength: 200,
    },
    content: {
      type: String,
      default: '',
      maxlength: 50000,
    },
    videoTimestamp: {
      type: Number,
      min: 0,
      default: null,
    },
    videoTimestampDisplay: {
      type: String,
      trim: true,
      maxlength: 20,
      default: '',
    },
    isPinned: {
      type: Boolean,
      default: false,
      index: true,
    },
  },
  {
    timestamps: true,
    collection: 'student_notes',
  },
)

studentNoteSchema.index({ studentId: 1, courseId: 1, isPinned: -1, updatedAt: -1 })
studentNoteSchema.index({ studentId: 1, courseId: 1, lessonId: 1 })

const StudentNote = mongoose.models.StudentNote || mongoose.model('StudentNote', studentNoteSchema)

export default StudentNote

