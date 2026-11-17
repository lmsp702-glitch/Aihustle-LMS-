import mongoose from 'mongoose'

const referralCodeSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, immutable: true },
    generatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Student',
      required: true,
      immutable: true,
    },
    requestId: { type: String, required: true, immutable: true, maxlength: 80 },
    createdAt: { type: Date, required: true, immutable: true },
    expiresAt: { type: Date, required: true, immutable: true },
    status: {
      type: String,
      enum: ['active', 'used', 'expired'],
      default: 'active',
      required: true,
    },
    usedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Student', default: null },
    usedAt: { type: Date, default: null },
    registrationStatus: {
      type: String,
      enum: ['awaiting_approval', 'approved', 'rejected', 'account_deleted', null],
      default: null,
    },
    rewardStatus: {
      type: String,
      enum: ['pending', 'earned', 'cancelled', null],
      default: null,
    },
    isDeactivated: { type: Boolean, default: false },
    referredEmailHash: { type: String, default: null },
    referredUserAnonymized: { type: Boolean, default: false },
  },
  { autoCreate: false, autoIndex: false, versionKey: false, collection: 'referralCodes' },
)

referralCodeSchema.index({ code: 1 }, { unique: true, name: 'unique_referral_code' })
referralCodeSchema.index({ generatedBy: 1, createdAt: -1 }, { name: 'referral_history_by_owner' })
referralCodeSchema.index({ expiresAt: 1 }, { name: 'referral_expiry_lookup' })
referralCodeSchema.index(
  { generatedBy: 1, requestId: 1 },
  { unique: true, name: 'unique_referral_request_per_owner' },
)
referralCodeSchema.index(
  { referredEmailHash: 1 },
  { sparse: true, name: 'referral_email_hash_lookup' },
)

const ReferralCode = mongoose.models.ReferralCode
  || mongoose.model('ReferralCode', referralCodeSchema, 'referralCodes')

export default ReferralCode
