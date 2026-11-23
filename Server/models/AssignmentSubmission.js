import mongoose from 'mongoose'
import { HUMAN_REVIEW_REASON_OPTIONS } from '../utils/assignment-human-review.js'

const evaluationCriterionSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    marks: { type: Number, required: true, min: 0 },
    maximumMarks: { type: Number, required: true, min: 0 },
    feedback: { type: String, required: true, trim: true, maxlength: 2000 },
  },
  { _id: false },
)

const assignmentEvaluationSchema = new mongoose.Schema(
  {
    totalMarks: { type: Number, required: true, min: 0 },
    maximumMarks: { type: Number, required: true, min: 0 },
    criteria: { type: [evaluationCriterionSchema], required: true },
    strengths: { type: [String], default: [] },
    improvements: { type: [String], default: [] },
    overallFeedback: { type: String, required: true, trim: true, maxlength: 5000 },
    evaluatedAt: { type: Date, required: true },
    evaluatorId: { type: mongoose.Schema.Types.ObjectId },
    model: { type: String, trim: true, maxlength: 100 },
  },
  { _id: false },
)

const humanReviewRequestSchema = new mongoose.Schema(
  {
    reason: { type: String, trim: true, maxlength: 5000, default: '' },
    reasons: {
      type: [{
        type: String,
        enum: HUMAN_REVIEW_REASON_OPTIONS,
      }],
      default: [],
    },
    otherExplanation: { type: String, trim: true, maxlength: 2000, default: '' },
    comments: { type: String, trim: true, maxlength: 2000, default: '' },
    requestedAt: { type: Date, required: true },
    requestedBy: { type: mongoose.Schema.Types.ObjectId, required: true },
  },
  { _id: false },
)

const evaluationSchema = new mongoose.Schema(
  {
    marksObtained: { type: Number, min: 0, required: true },
    feedback: { type: String, trim: true, maxlength: 5000, default: '' },
    correctness: {
      type: String,
      enum: ['correct', 'partially_correct', 'incorrect', 'not_applicable'],
      default: 'not_applicable',
    },
    evaluationStatus: {
      type: String,
      enum: ['evaluated', 're_evaluation_required'],
      default: 'evaluated',
    },
    evaluatedAt: { type: Date, required: true },
    evaluatorId: { type: mongoose.Schema.Types.ObjectId, required: true },
  },
  { _id: false },
)

const assignmentSubmissionSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, required: true },
    collegeId: { type: mongoose.Schema.Types.ObjectId, ref: 'College' },
    enrollmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Enrollment', required: true },
    courseId: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', required: true },
    assignmentId: { type: mongoose.Schema.Types.ObjectId, required: true },
    fileName: { type: String, required: true, maxlength: 180 },
    contentType: {
      type: String,
      required: true,
      enum: [
        'application/pdf',
        'text/plain',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'image/jpeg',
        'image/png',
        'image/webp',
      ],
    },
    fileSize: { type: Number, required: true, min: 1, max: 10 * 1024 * 1024 },
    fileData: { type: Buffer, required: true, select: false },
    submittedAt: { type: Date, required: true, default: Date.now },
    activeSubmissionKey: { type: String, select: false },
    attemptNumber: { type: Number, min: 1, max: 3, default: 1 },
    lockoutStartedAt: { type: Date },
    lockoutUntil: { type: Date },
    gradingStatus: {
      type: String,
      enum: ['Submitted', 'AI Grading', 'AI Graded', 'AI Grading Failed', 'Re-evaluation Requested', 'Human Review', 'Final Result'],
      default: 'Submitted',
    },
    gradingError: { type: String, trim: true, maxlength: 500, default: '' },
    gradingRetryCount: { type: Number, min: 0, max: 3, default: 0 },
    gradingNextRetryAt: { type: Date },
    gradingLeaseUntil: { type: Date },
    gradingLeaseToken: { type: String, select: false },
    gradingTraceId: { type: String, trim: true, maxlength: 80 },
    aiEvaluation: { type: assignmentEvaluationSchema },
    humanReviewRequest: { type: humanReviewRequestSchema },
    humanEvaluation: { type: assignmentEvaluationSchema },
    finalMarks: { type: Number, min: 0 },
    finalFeedback: { type: String, trim: true, maxlength: 5000 },
    scorePercentage: { type: Number, min: 0, max: 100 },
    academicStatus: { type: String, enum: ['Passed', 'Failed'] },
    marksObtained: { type: Number, min: 0 },
    evaluationStatus: {
      type: String,
      enum: ['pending', 'evaluated', 're_evaluation_required'],
      default: 'pending',
    },
    correctness: {
      type: String,
      enum: ['correct', 'partially_correct', 'incorrect', 'not_applicable'],
    },
    feedback: { type: String, trim: true, maxlength: 5000, default: '' },
    evaluatedAt: { type: Date },
    evaluatorId: { type: mongoose.Schema.Types.ObjectId },
    evaluationHistory: { type: [evaluationSchema], default: [] },
    reviewStatus: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending', required: true },
    reviewedAt: { type: Date },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' },
    reviewComment: { type: String, trim: true, maxlength: 1000, default: '' },
  },
  { autoCreate: false, autoIndex: false, timestamps: true, collection: 'assignment_submissions' },
)

assignmentSubmissionSchema.index({ enrollmentId: 1, assignmentId: 1, submittedAt: -1 })
assignmentSubmissionSchema.index({ reviewStatus: 1, submittedAt: -1 })
assignmentSubmissionSchema.index(
  { gradingStatus: 1, 'humanReviewRequest.requestedAt': 1 },
  { name: 'assignment_human_review_queue' },
)
assignmentSubmissionSchema.index(
  { gradingStatus: 1, gradingNextRetryAt: 1, gradingLeaseUntil: 1, submittedAt: 1 },
  { name: 'assignment_grading_jobs' },
)
assignmentSubmissionSchema.index(
  { activeSubmissionKey: 1 },
  {
    unique: true,
    partialFilterExpression: { activeSubmissionKey: { $type: 'string' } },
    name: 'unique_active_assignment_submission',
  },
)

const AssignmentSubmission = mongoose.models.AssignmentSubmission
  || mongoose.model('AssignmentSubmission', assignmentSubmissionSchema, 'assignment_submissions')

export default AssignmentSubmission
