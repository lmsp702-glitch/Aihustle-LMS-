import mongoose from 'mongoose'

const subjectSchema = new mongoose.Schema(
  {
    code: { type: String, trim: true, uppercase: true, maxlength: 30 },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    credits: { type: Number, default: 3, min: 1, max: 20 },
    facultyName: { type: String, trim: true, maxlength: 120, default: '' },
  },
  { _id: true },
)

const semesterSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 }, // e.g. "Semester 1", "Fall 2026"
    academicYear: { type: String, trim: true, maxlength: 50, default: '' }, // e.g. "2025-2026"
    department: { type: String, trim: true, maxlength: 120, default: '' },
    departmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Department' },
    collegeId: { type: mongoose.Schema.Types.ObjectId, ref: 'College', required: true, index: true },
    startDate: { type: Date },
    endDate: { type: Date },
    isCurrent: { type: Boolean, default: false },
    subjects: { type: [subjectSchema], default: [] },
    status: { type: String, enum: ['upcoming', 'active', 'completed'], default: 'active' },
  },
  { autoCreate: false, autoIndex: false, timestamps: true, collection: 'semesters' },
)

semesterSchema.index({ collegeId: 1, name: 1, department: 1 }, { unique: true, name: 'unique_college_dept_semester' })

const Semester = mongoose.models.Semester || mongoose.model('Semester', semesterSchema, 'semesters')

export default Semester

