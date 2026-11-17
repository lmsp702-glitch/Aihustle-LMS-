import mongoose from 'mongoose'

const placementApplicationSchema = new mongoose.Schema(
  {
    studentId: { type: mongoose.Schema.Types.ObjectId, ref: 'CollegeStudent', required: true },
    studentName: { type: String, trim: true, maxlength: 120 },
    studentEmail: { type: String, trim: true, lowercase: true, maxlength: 254 },
    studentRollNo: { type: String, trim: true, maxlength: 100 },
    department: { type: String, trim: true, maxlength: 120 },
    batch: { type: String, trim: true, maxlength: 80 },
    cgpa: { type: Number, default: 0 },
    resumeUrl: { type: String, trim: true, maxlength: 500, default: '' },
    status: {
      type: String,
      enum: ['applied', 'shortlisted', 'interviewing', 'placed', 'rejected'],
      default: 'applied',
    },
    offeredPackage: { type: Number, default: 0 }, // in LPA
    appliedAt: { type: Date, default: Date.now },
    interviewDate: { type: Date },
    notes: { type: String, trim: true, maxlength: 500, default: '' },
  },
  { _id: true },
)

const placementDriveSchema = new mongoose.Schema(
  {
    collegeId: { type: mongoose.Schema.Types.ObjectId, ref: 'College', required: true, index: true },
    companyName: { type: String, required: true, trim: true, maxlength: 150 },
    companyWebsite: { type: String, trim: true, maxlength: 250, default: '' },
    jobTitle: { type: String, required: true, trim: true, maxlength: 150 }, // e.g. "Associate Software Engineer"
    opportunityType: {
      type: String,
      enum: ['full_time', 'internship', 'ppo'],
      default: 'full_time',
    },
    packageLpa: { type: Number, default: 0 }, // in LPA
    stipendMonthly: { type: Number, default: 0 }, // in INR
    location: { type: String, trim: true, maxlength: 120, default: 'Multiple' },
    eligibleDepartments: { type: [String], default: [] },
    minCgpa: { type: Number, default: 6.0, min: 0, max: 10 },
    maxBacklogs: { type: Number, default: 0, min: 0 },
    deadline: { type: Date, required: true },
    driveDate: { type: Date },
    status: {
      type: String,
      enum: ['upcoming', 'active', 'in_progress', 'completed', 'closed'],
      default: 'upcoming',
    },
    rounds: { type: [String], default: ['Online Assessment', 'Technical Interview', 'HR Interview'] },
    applications: { type: [placementApplicationSchema], default: [] },
  },
  { autoCreate: false, autoIndex: false, timestamps: true, collection: 'placement_drives' },
)

placementDriveSchema.index({ collegeId: 1, status: 1 })
placementDriveSchema.index({ collegeId: 1, opportunityType: 1 })

const PlacementDrive =
  mongoose.models.PlacementDrive ||
  mongoose.model('PlacementDrive', placementDriveSchema, 'placement_drives')

export default PlacementDrive

