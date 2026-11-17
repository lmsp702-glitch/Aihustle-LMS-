import mongoose from 'mongoose'

const collegeDocumentSchema = new mongoose.Schema(
  {
    collegeId: { type: mongoose.Schema.Types.ObjectId, ref: 'College', required: true, index: true },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    category: {
      type: String,
      enum: ['syllabus', 'policy', 'academic_report', 'naac_nba', 'student_record', 'general'],
      default: 'general',
    },
    fileName: { type: String, required: true, trim: true, maxlength: 250 },
    fileUrl: { type: String, trim: true, maxlength: 1000, default: '' },
    fileSize: { type: Number, default: 0 }, // in bytes
    fileType: { type: String, trim: true, maxlength: 50, default: 'application/pdf' },
    uploadedBy: { type: String, trim: true, maxlength: 120, default: 'College Admin' },
    department: { type: String, trim: true, maxlength: 120, default: '' },
    description: { type: String, trim: true, maxlength: 1000, default: '' },
  },
  { autoCreate: false, autoIndex: false, timestamps: true, collection: 'college_documents' },
)

collegeDocumentSchema.index({ collegeId: 1, category: 1 })

const CollegeDocument =
  mongoose.models.CollegeDocument ||
  mongoose.model('CollegeDocument', collegeDocumentSchema, 'college_documents')

export default CollegeDocument

