import mongoose from 'mongoose'

const facultyAssignedCourseSchema = new mongoose.Schema(
  {
    courseId: { type: mongoose.Schema.Types.ObjectId, ref: 'Course' },
    courseTitle: { type: String, trim: true, maxlength: 200 },
    batch: { type: String, trim: true, maxlength: 80 },
    semester: { type: String, trim: true, maxlength: 50 },
  },
  { _id: true },
)

const facultySchema = new mongoose.Schema(
  {
    facultyId: { type: String, required: true, trim: true, maxlength: 50 }, // e.g. "FAC-2026-001"
    fullName: { type: String, required: true, trim: true, maxlength: 120 },
    email: { type: String, required: true, trim: true, lowercase: true, maxlength: 254 },
    phone: { type: String, trim: true, maxlength: 40, default: '' },
    department: { type: String, trim: true, maxlength: 120, default: '' },
    departmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Department' },
    designation: {
      type: String,
      trim: true,
      maxlength: 100,
      default: 'Assistant Professor',
    }, // e.g. "Professor", "Associate Professor", "Assistant Professor", "HOD", "Lecturer"
    qualification: { type: String, trim: true, maxlength: 150, default: '' }, // e.g. "Ph.D. in CS, M.Tech"
    specialization: { type: String, trim: true, maxlength: 200, default: '' },
    collegeId: { type: mongoose.Schema.Types.ObjectId, ref: 'College', required: true, index: true },
    assignedCourses: { type: [facultyAssignedCourseSchema], default: [] },
    workloadHours: { type: Number, default: 16, min: 0, max: 60 },
    status: { type: String, enum: ['active', 'on_leave', 'inactive'], default: 'active' },
    joiningDate: { type: Date, default: Date.now },
  },
  { autoCreate: false, autoIndex: false, timestamps: true, collection: 'faculty' },
)

facultySchema.index({ collegeId: 1, facultyId: 1 }, { unique: true, name: 'unique_college_faculty_id' })
facultySchema.index({ collegeId: 1, email: 1 }, { unique: true, name: 'unique_college_faculty_email' })

const Faculty = mongoose.models.Faculty || mongoose.model('Faculty', facultySchema, 'faculty')

export default Faculty

