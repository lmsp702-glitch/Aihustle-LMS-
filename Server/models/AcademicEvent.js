import mongoose from 'mongoose'

const academicEventSchema = new mongoose.Schema(
  {
    collegeId: { type: mongoose.Schema.Types.ObjectId, ref: 'College', required: true, index: true },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, trim: true, maxlength: 1000, default: '' },
    eventType: {
      type: String,
      enum: ['exam', 'holiday', 'deadline', 'activity', 'announcement', 'workshop', 'seminar'],
      default: 'activity',
    },
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
    targetAudience: { type: String, enum: ['all', 'department', 'batch'], default: 'all' },
    department: { type: String, trim: true, maxlength: 120, default: '' },
    batch: { type: String, trim: true, maxlength: 80, default: '' },
    isHoliday: { type: Boolean, default: false },
    venue: { type: String, trim: true, maxlength: 150, default: '' },
    organizer: { type: String, trim: true, maxlength: 120, default: '' },
  },
  { autoCreate: false, autoIndex: false, timestamps: true, collection: 'academic_events' },
)

academicEventSchema.index({ collegeId: 1, startDate: 1 })
academicEventSchema.index({ collegeId: 1, eventType: 1 })

const AcademicEvent =
  mongoose.models.AcademicEvent || mongoose.model('AcademicEvent', academicEventSchema, 'academic_events')

export default AcademicEvent

