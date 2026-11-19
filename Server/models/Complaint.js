import mongoose from 'mongoose'

export const complaintStatuses = ['Unsolved', 'Solved', 'Open', 'In Progress', 'Resolved']

const complaintReplySchema = new mongoose.Schema(
  {
    authorId: { type: mongoose.Schema.Types.ObjectId, required: true },
    authorRole: { type: String, enum: ['main_admin'], required: true },
    message: { type: String, required: true, trim: true, maxlength: 5000 },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
)

const complaintStatusHistorySchema = new mongoose.Schema(
  {
    from: { type: String, enum: complaintStatuses },
    to: { type: String, enum: complaintStatuses, required: true },
    changedBy: { type: mongoose.Schema.Types.ObjectId, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
)

const complaintSchema = new mongoose.Schema(
  {
    complaintId: { type: String, required: true, unique: true, trim: true },
    userId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    userCollection: { type: String, enum: ['students', 'clg_students'], required: true },
    studentName: { type: String, trim: true, maxlength: 120 },
    studentId: { type: String, trim: true, maxlength: 100 },
    studentEmail: { type: String, trim: true, lowercase: true, maxlength: 254 },
    source: { type: String, enum: ['Complaint', 'Email Support'], default: 'Complaint' },
    priority: { type: String, enum: ['Low', 'Normal', 'High'], default: 'Normal' },
    collegeId: { type: mongoose.Schema.Types.ObjectId, ref: 'College' },
    subject: { type: String, required: true, trim: true, minlength: 3, maxlength: 160 },
    category: { type: String, required: true, trim: true, maxlength: 100 },
    description: { type: String, required: true, trim: true, minlength: 10, maxlength: 10000 },
    status: { type: String, required: true, enum: complaintStatuses, default: 'Unsolved' },
    replies: { type: [complaintReplySchema], default: [] },
    statusHistory: { type: [complaintStatusHistorySchema], default: [] },
  },
  { autoCreate: false, autoIndex: false, timestamps: true, collection: 'complaints' },
)

complaintSchema.index({ createdAt: -1 })

const Complaint =
  mongoose.models.Complaint ||
  mongoose.model('Complaint', complaintSchema, 'complaints')

export default Complaint
