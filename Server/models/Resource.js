import mongoose from 'mongoose'

const resourceSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
      trim: true,
      maxlength: 200,
    },
    description: {
      type: String,
      trim: true,
      maxlength: 2000,
      default: '',
    },
    courseId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Course',
      required: true,
      index: true,
    },
    url: {
      type: String,
      required: true,
      trim: true,
      maxlength: 2048,
    },
    publicId: {
      type: String,
      trim: true,
      maxlength: 255,
      default: '',
    },
    resourceType: {
      type: String,
      enum: ['raw', 'image', 'video'],
      default: 'raw',
    },
    format: {
      type: String,
      trim: true,
      maxlength: 20,
      default: 'pdf',
    },
    fileSize: {
      type: Number,
      min: 0,
      default: 0,
    },
    originalFileName: {
      type: String,
      trim: true,
      maxlength: 255,
      default: '',
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Admin',
    },
  },
  {
    timestamps: true,
    collection: 'resources',
  },
)

resourceSchema.index({ courseId: 1, createdAt: -1 })
resourceSchema.index({ title: 'text', description: 'text' })

const Resource = mongoose.models.Resource || mongoose.model('Resource', resourceSchema)

export default Resource

