import mongoose from 'mongoose'

const examResultRecordSchema = new mongoose.Schema(
  {
    studentId: { type: mongoose.Schema.Types.ObjectId, ref: 'CollegeStudent', required: true },
    studentRollNo: { type: String, trim: true, maxlength: 100 },
    studentName: { type: String, trim: true, maxlength: 120 },
    subject: { type: String, trim: true, maxlength: 120, default: '' },
    marksObtained: { type: Number, required: true, min: 0 },
    maxMarks: { type: Number, required: true, min: 1 },
    grade: {
      type: String,
      enum: ['A+', 'A', 'B+', 'B', 'C', 'D', 'F'],
      default: 'F',
    },
    isPass: { type: Boolean, default: false },
    backlog: { type: Boolean, default: false },
    remarks: { type: String, trim: true, maxlength: 300, default: '' },
    updatedAt: { type: Date, default: Date.now },
  },
  { _id: true },
)

const examinationSchema = new mongoose.Schema(
  {
    collegeId: { type: mongoose.Schema.Types.ObjectId, ref: 'College', required: true, index: true },
    title: { type: String, required: true, trim: true, maxlength: 200 }, // e.g. "Fall 2026 Mid-Semester Assessment"
    examType: {
      type: String,
      enum: ['internal', 'mid_term', 'final', 'quiz', 'practical'],
      default: 'internal',
    },
    semester: { type: String, trim: true, maxlength: 50, default: '' },
    department: { type: String, trim: true, maxlength: 120, default: '' },
    batch: { type: String, trim: true, maxlength: 80, default: '' },
    subject: { type: String, trim: true, maxlength: 150, default: '' },
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
    maxMarks: { type: Number, default: 100, min: 10 },
    passingMarks: { type: Number, default: 40, min: 0 },
    status: {
      type: String,
      enum: ['scheduled', 'ongoing', 'completed', 'published'],
      default: 'scheduled',
    },
    results: { type: [examResultRecordSchema], default: [] },
  },
  { autoCreate: false, autoIndex: false, timestamps: true, collection: 'examinations' },
)

examinationSchema.index({ collegeId: 1, department: 1, semester: 1 })
examinationSchema.index({ collegeId: 1, 'results.studentId': 1 })

const Examination =
  mongoose.models.Examination || mongoose.model('Examination', examinationSchema, 'examinations')

export default Examination

