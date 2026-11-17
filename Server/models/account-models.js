import mongoose from 'mongoose'

const accountFields = {
  fullName: { type: String, trim: true, maxlength: 120 },
  username: { type: String, required: true, unique: true, lowercase: true, trim: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, select: false },
  status: {
    type: String,
    enum: ['active', 'pending', 'inactive', 'suspended', 'invitation_pending', 'rejected', 'deleted'],
    default: 'active',
    lowercase: true,
  },
  isActive: { type: Boolean, default: true },
  deletedAt: { type: Date, default: null },
  permissions: { type: [String], default: [] },
}

function createAccountModel(modelName, collectionName, role, additionalFields = {}) {
  const schema = new mongoose.Schema(
    {
      ...accountFields,
      ...additionalFields,
      role: { type: String, enum: [role], default: role, required: true, immutable: true },
    },
    { autoCreate: false, autoIndex: false, timestamps: true, collection: collectionName },
  )

  schema.pre('save', function syncActiveState() {
    if (this.status) {
      this.isActive = this.status === 'active'
    } else {
      this.status = this.isActive === false ? 'inactive' : 'active'
    }
  })

  return mongoose.models[modelName] || mongoose.model(modelName, schema, collectionName)
}

const independentStudentFields = {
  status: {
    ...accountFields.status,
    enum: [...accountFields.status.enum, 'rejected'],
  },
  studentType: { type: String, enum: ['independent'], default: 'independent', required: true },
  twoFactorEnabled: { type: Boolean, default: false },
  twoFactorEnabledAt: { type: Date },
  studentId: { type: String, trim: true, maxlength: 100 },
  registrationDetails: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
  approvalStatus: {
    type: String,
    enum: ['pending', 'approved', 'rejected'],
    default: 'pending',
    required: true,
  },
  approvedAt: { type: Date },
  approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' },
  rejectedAt: { type: Date },
  rejectedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' },
  rejectionReason: { type: String, trim: true, maxlength: 1000 },
  referredBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Student', default: null },
  referredByCode: { type: String, trim: true, uppercase: true, default: null },
  referralRedeemedAt: { type: Date, default: null },
  hearAboutUs: {
    type: String,
    enum: [
      'College / University Referral',
      'Friend / Student Referral',
      'Social Media',
      'Online Advertisement',
      'Google / Search Engine',
      'YouTube',
      'College Event / Workshop',
      'Other Website / Blog',
      'Other',
    ],
    trim: true,
  },
  hearAboutUsOther: { type: String, trim: true, maxlength: 200, default: '' },
  dailyLearningGoalMinutes: { type: Number, default: 60, min: 15, max: 480 },
}

const collegeStudentFields = {
  studentType: { type: String, enum: ['college'], default: 'college', required: true },
  collegeId: { type: mongoose.Schema.Types.ObjectId, ref: 'College', required: true },
  studentId: { type: String, trim: true, maxlength: 100 },
  department: { type: String, trim: true, maxlength: 120 },
  batch: { type: String, trim: true, maxlength: 80 },
  twoFactorEnabled: { type: Boolean, default: false },
  twoFactorEnabledAt: { type: Date },
  phone: { type: String, trim: true, maxlength: 40, default: '' },
  dateOfBirth: { type: Date },
  gender: { type: String, trim: true, maxlength: 20, default: '' },
  bloodGroup: { type: String, trim: true, maxlength: 10, default: '' },
  address: { type: String, trim: true, maxlength: 300, default: '' },
  guardianName: { type: String, trim: true, maxlength: 120, default: '' },
  guardianPhone: { type: String, trim: true, maxlength: 40, default: '' },
  semester: { type: String, trim: true, maxlength: 50, default: '' },
  cgpa: { type: Number, default: 0, min: 0, max: 10 },
  academicStanding: {
    type: String,
    enum: ['good', 'probation', 'at_risk', 'excellent'],
    default: 'good',
  },
  skills: { type: [String], default: [] },
  resumeUrl: { type: String, trim: true, maxlength: 500, default: '' },
  placementStatus: {
    type: String,
    enum: ['not_eligible', 'seeking', 'interviewing', 'placed', 'opted_out'],
    default: 'seeking',
  },
  placedCompany: { type: String, trim: true, maxlength: 150, default: '' },
  placementPackage: { type: Number, default: 0 },
  achievements: {
    type: [
      {
        title: { type: String, trim: true, maxlength: 150 },
        description: { type: String, trim: true, maxlength: 500 },
        date: { type: Date, default: Date.now },
        category: { type: String, trim: true, maxlength: 50, default: 'Academic' },
      },
    ],
    default: [],
  },
  documents: {
    type: [
      {
        name: { type: String, trim: true, maxlength: 150 },
        fileUrl: { type: String, trim: true, maxlength: 500 },
        docType: { type: String, trim: true, maxlength: 50, default: 'General' },
        uploadedAt: { type: Date, default: Date.now },
      },
    ],
    default: [],
  },
  dailyLearningGoalMinutes: { type: Number, default: 60, min: 15, max: 480 },
}

const collegeAdminFields = {
  collegeId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'College',
    required: true,
  },
  studentLimit: { type: Number, min: 0, validate: Number.isSafeInteger },
  activationTokenHash: { type: String, select: false },
  activationTokenExpiresAt: { type: Date, select: false },
}

export const Admin = createAccountModel('Admin', 'admin', 'main_admin')
export const CollegeAdmin = createAccountModel('CollegeAdmin', 'sub_admins', 'college_admin', collegeAdminFields)
export const Student = createAccountModel('Student', 'students', 'student', independentStudentFields)
export const CollegeStudent = createAccountModel('CollegeStudent', 'clg_students', 'student', collegeStudentFields)
CollegeStudent.schema.index(
  { collegeId: 1, studentId: 1 },
  {
    unique: true,
    sparse: true,
    collation: { locale: 'en', strength: 2 },
    name: 'unique_college_student_id',
  },
)

export const accountModelsByRole = Object.freeze({
  main_admin: Admin,
  college_admin: CollegeAdmin,
  student: Student,
})

export const accountModelsByCollection = Object.freeze({
  admin: Admin,
  sub_admins: CollegeAdmin,
  students: Student,
  clg_students: CollegeStudent,
})

export function roleForAccountCollection(collectionName) {
  switch (collectionName) {
    case 'admin':
      return 'main_admin'
    case 'sub_admins':
      return 'college_admin'
    case 'students':
    case 'clg_students':
      return 'student'
    default:
      return null
  }
}

export function matchesStoredAccountRole(collectionName, storedRole) {
  const expectedRole = roleForAccountCollection(collectionName)
  return storedRole === expectedRole
}
