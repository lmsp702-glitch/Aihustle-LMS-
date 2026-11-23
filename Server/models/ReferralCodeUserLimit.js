import mongoose from 'mongoose'

const referralCodeUserLimitSchema = new mongoose.Schema(
  {
    generatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Student',
      required: true,
    },
    count: { type: Number, required: true, default: 0, min: 0, max: 20 },
  },
  {
    autoCreate: false,
    autoIndex: false,
    timestamps: true,
    collection: 'referralCodeUserLimits',
  },
)

referralCodeUserLimitSchema.index(
  { generatedBy: 1 },
  { unique: true, name: 'unique_referral_user_limit' },
)

const ReferralCodeUserLimit = mongoose.models.ReferralCodeUserLimit
  || mongoose.model('ReferralCodeUserLimit', referralCodeUserLimitSchema, 'referralCodeUserLimits')

export default ReferralCodeUserLimit
