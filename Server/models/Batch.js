import mongoose from 'mongoose'

const batchSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    academicYear: { type: String, trim: true, maxlength: 50, default: '' },
    semester: { type: String, trim: true, maxlength: 50, default: '' },
    department: { type: String, trim: true, maxlength: 120, default: '' },
    departmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Department' },
    collegeId: { type: mongoose.Schema.Types.ObjectId, ref: 'College', required: true, index: true },
    startDate: { type: Date },
    endDate: { type: Date },
    status: { type: String, enum: ['active', 'graduated', 'archived'], default: 'active' },
  },
  { autoCreate: false, autoIndex: false, timestamps: true, collection: 'batches' },
)

batchSchema.index({ collegeId: 1, name: 1 }, { unique: true, name: 'unique_college_batch_name' })

const Batch = mongoose.models.Batch || mongoose.model('Batch', batchSchema, 'batches')

export default Batch

