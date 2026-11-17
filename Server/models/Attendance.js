import mongoose from 'mongoose'

const attendanceRecordSchema = new mongoose.Schema(
  {
    studentId: { type: mongoose.Schema.Types.ObjectId, ref: 'CollegeStudent', required: true },
    studentRollNo: { type: String, trim: true, maxlength: 100 },
    studentName: { type: String, trim: true, maxlength: 120 },
    status: {
      type: String,
      enum: ['present', 'absent', 'late', 'excused'],
      default: 'present',
    },
    remarks: { type: String, trim: true, maxlength: 200, default: '' },
  },
  { _id: true },
)

const correctionHistorySchema = new mongoose.Schema(
  {
    correctedAt: { type: Date, default: Date.now },
    correctedBy: { type: String, trim: true, maxlength: 120, default: 'College Admin' },
    studentId: { type: mongoose.Schema.Types.ObjectId, ref: 'CollegeStudent' },
    studentName: { type: String, trim: true, maxlength: 120 },
    previousStatus: { type: String },
    newStatus: { type: String },
    reason: { type: String, trim: true, maxlength: 300, default: '' },
  },
  { _id: true },
)

const attendanceSchema = new mongoose.Schema(
  {
    collegeId: { type: mongoose.Schema.Types.ObjectId, ref: 'College', required: true, index: true },
    date: { type: Date, required: true },
    department: { type: String, required: true, trim: true, maxlength: 120 },
    batch: { type: String, required: true, trim: true, maxlength: 80 },
    subject: { type: String, required: true, trim: true, maxlength: 150 },
    semester: { type: String, trim: true, maxlength: 50, default: '' },
    takenBy: { type: String, trim: true, maxlength: 120, default: 'Faculty' },
    records: { type: [attendanceRecordSchema], default: [] },
    correctionHistory: { type: [correctionHistorySchema], default: [] },
  },
  { autoCreate: false, autoIndex: false, timestamps: true, collection: 'attendance' },
)

attendanceSchema.index({ collegeId: 1, date: 1, batch: 1, subject: 1 })
attendanceSchema.index({ collegeId: 1, department: 1 })
attendanceSchema.index({ collegeId: 1, 'records.studentId': 1 })

const Attendance = mongoose.models.Attendance || mongoose.model('Attendance', attendanceSchema, 'attendance')

export default Attendance

