import mongoose from 'mongoose'

const departmentSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    code: { type: String, required: true, trim: true, uppercase: true, maxlength: 40 },
    description: { type: String, trim: true, maxlength: 500, default: '' },
    headOfDepartment: { type: String, trim: true, maxlength: 120, default: '' },
    intakeCapacity: { type: Number, default: 60, min: 0 },
    collegeId: { type: mongoose.Schema.Types.ObjectId, ref: 'College', required: true, index: true },
    status: { type: String, enum: ['active', 'inactive'], default: 'active' },
  },
  { autoCreate: false, autoIndex: false, timestamps: true, collection: 'departments' },
)

departmentSchema.index({ collegeId: 1, code: 1 }, { unique: true, name: 'unique_college_department_code' })
departmentSchema.index({ collegeId: 1, name: 1 }, { unique: true, name: 'unique_college_department_name' })

const Department =
  mongoose.models.Department || mongoose.model('Department', departmentSchema, 'departments')

export default Department

