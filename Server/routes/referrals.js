import { randomBytes } from 'node:crypto'
import mongoose from 'mongoose'
import { Router } from 'express'
import { authenticate, requireRoles } from '../middleware/auth.js'
import { Student } from '../models/account-models.js'
import ReferralCode from '../models/ReferralCode.js'
import ReferralCodeDailyLimit from '../models/ReferralCodeDailyLimit.js'

const router = Router()
const maxLifetimeReferralCodes = 20
const maxActiveReferralCodes = maxLifetimeReferralCodes // Alias for backwards compatibility
const dailyGenerationLimit = maxLifetimeReferralCodes // Alias for backwards compatibility
const codeLifetimeMs = 15 * 24 * 60 * 60 * 1000 // 15 days
const requireExternalUser = [
  authenticate,
  requireRoles('student'),
  (req, res, next) => {
    if (req.auth.user.studentType !== 'independent' || req.auth.accountCollection !== 'students') {
      return res.status(403).json({ message: 'Referral codes are available to External Users only.' })
    }
    return next()
  },
]

function getUtcDayStart(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
}

function createRequestError(statusCode, message) {
  const error = new Error(message)
  error.statusCode = statusCode
  return error
}

function registrationStatusForAccount(account) {
  const status = String(account?.approvalStatus || account?.status || '').toLowerCase()
  if (status === 'rejected') return 'rejected'
  if (status === 'active' || status === 'approved') return 'approved'
  return 'awaiting_approval'
}

function serializeCode(code, registrationStatus = code.registrationStatus, friend = null) {
  const expired = code.status === 'expired' || code.expiresAt <= new Date()
  const isUsed = Boolean(code.usedBy) || code.status === 'used'
  const isAccountDeleted = registrationStatus === 'account_deleted' || code.registrationStatus === 'account_deleted'
  const referredStudentName = isAccountDeleted || code.referredUserAnonymized
    ? '[Deleted Student]'
    : (isUsed && friend
      ? (friend.fullName?.trim() || friend.username?.trim() || 'Referred Student')
      : null)
  const referredStudentRegistrationDate = isUsed && friend && !isAccountDeleted
    ? (friend.createdAt || code.usedAt || null)
    : (isUsed ? code.usedAt : null)
  const usedAt = code.usedAt || null
  const rewardStatus = isAccountDeleted
    ? 'cancelled'
    : (code.rewardStatus || (registrationStatus === 'approved' ? 'earned' : (isUsed ? 'pending' : null)))
  const referralMessage = isAccountDeleted
    ? 'Referred student account was deleted · Pending rewards cancelled.'
    : (isUsed && referredStudentName
      ? `${referredStudentName} joined aiHustle using your referral code.`
      : null)

  return {
    code: code.code,
    createdAt: code.createdAt,
    expiresAt: code.expiresAt,
    status: isUsed ? 'used' : (expired ? 'expired' : code.status),
    friendRegistered: isUsed,
    usedAt,
    registrationStatus: isUsed ? (isAccountDeleted ? 'account_deleted' : (registrationStatus || 'awaiting_approval')) : null,
    rewardStatus,
    isDeactivated: Boolean(code.isDeactivated),
    referredStudentName,
    referredStudentRegistrationDate,
    referralMessage,
  }
}

async function reconcileReferralAttributions() {
  try {
    const usedCodes = await ReferralCode.find({ usedBy: { $ne: null } })
      .select('_id code generatedBy usedBy usedAt createdAt')
      .lean()

    for (const code of usedCodes) {
      if (code.usedBy) {
        await Student.updateOne(
          { _id: code.usedBy, referredBy: null },
          {
            $set: {
              referredBy: code.generatedBy,
              referredByCode: code.code,
              referralRedeemedAt: code.usedAt || code.createdAt || new Date(),
            },
          },
        )
      }
    }

    const referredStudents = await Student.find({
      referredByCode: { $ne: null },
      studentType: 'independent',
    }).select('_id referredBy referredByCode createdAt').lean()

    for (const student of referredStudents) {
      if (student.referredByCode) {
        await ReferralCode.updateOne(
          { code: student.referredByCode, usedBy: null },
          {
            $set: {
              status: 'used',
              usedBy: student._id,
              usedAt: student.createdAt || new Date(),
            },
          },
        )
      }
    }
  } catch (error) {
    // Non-fatal background reconciliation
  }
}

router.post('/validate', async (req, res, next) => {
  try {
    const rawCode = req.body?.code
    if (typeof rawCode !== 'string' || rawCode.trim().length < 8 || rawCode.trim().length > 64) {
      return res.status(400).json({ message: 'Enter a valid referral code.' })
    }

    const code = await ReferralCode.findOne({
      code: rawCode.trim().toUpperCase(),
      status: 'active',
      isDeactivated: { $ne: true },
      expiresAt: { $gt: new Date() },
      usedBy: null,
    }).select('expiresAt generatedBy').lean()

    if (!code) {
      return res.status(400).json({ message: 'This referral code is invalid, expired, or already used.' })
    }

    const referrer = await Student.findById(code.generatedBy)
    if (!referrer || referrer.status === 'deleted' || referrer.isActive === false) {
      return res.status(400).json({ message: 'This referral code is no longer valid.' })
    }

    return res.json({ valid: true, expiresAt: code.expiresAt })
  } catch (error) {
    return next(error)
  }
})

router.get('/me', ...requireExternalUser, async (req, res, next) => {
  try {
    const now = new Date()
    const generatedBy = new mongoose.Types.ObjectId(req.auth.id)

    // Mark outdated active codes as expired in the database
    await ReferralCode.updateMany(
      { generatedBy, status: 'active', expiresAt: { $lte: now } },
      { $set: { status: 'expired' } },
    )

    const codes = await ReferralCode.find({ generatedBy }).sort({ createdAt: -1 }).lean()
    const usedIds = codes.filter((code) => code.usedBy && code.registrationStatus !== 'account_deleted').map((code) => code.usedBy)
    const friends = usedIds.length
      ? await Student.find({ _id: { $in: usedIds } })
        .select('_id fullName username status approvalStatus createdAt')
        .lean()
      : []
    const friendsById = new Map(friends.map((friend) => [String(friend._id), friend]))

    const serializedCodes = await Promise.all(codes.map(async (code) => {
      const isAccountDeleted = code.registrationStatus === 'account_deleted'
      const friend = (code.usedBy && !isAccountDeleted) ? friendsById.get(String(code.usedBy)) : null
      const registrationStatus = isAccountDeleted
        ? 'account_deleted'
        : (friend
          ? registrationStatusForAccount(friend)
          : code.registrationStatus)
      if (code.usedBy && registrationStatus && registrationStatus !== code.registrationStatus) {
        await ReferralCode.updateOne(
          { _id: code._id, usedBy: code.usedBy },
          { $set: { registrationStatus } },
        )
      }
      return serializeCode(code, registrationStatus, friend)
    }))

    // Lifetime counting: ALL codes ever generated count towards the 20 lifetime limit
    const totalGenerated = codes.length
    const remainingSlots = Math.max(0, maxLifetimeReferralCodes - totalGenerated)
    const activeCount = serializedCodes.filter((code) => code.status === 'active' && !code.friendRegistered && !code.isDeactivated).length
    const expiredCount = serializedCodes.filter((code) => code.status === 'expired').length
    const successfullyUsed = serializedCodes.filter((code) => (code.friendRegistered || code.status === 'used') && code.registrationStatus !== 'account_deleted').length
    const accountDeletedReferrals = serializedCodes.filter((code) => code.registrationStatus === 'account_deleted').length
    const cancelledRewards = serializedCodes.filter((code) => code.rewardStatus === 'cancelled').length
    const earnedRewards = serializedCodes.filter((code) => code.rewardStatus === 'earned').length

    const dayStart = getUtcDayStart(now)
    const generatedToday = codes.filter((code) => code.createdAt >= dayStart).length

    const stats = {
      totalGenerated,
      maxLifetimeLimit: maxLifetimeReferralCodes,
      lifetimeLimit: maxLifetimeReferralCodes,
      remainingSlots,
      remainingGenerations: remainingSlots,
      active: activeCount,
      successfullyUsed,
      accountDeletedReferrals,
      cancelledRewards,
      earnedRewards,
      expired: expiredCount,
      generatedToday,
      maxActiveLimit: maxLifetimeReferralCodes,
      dailyLimit: maxLifetimeReferralCodes,
    }
    return res.json({ stats, codes: serializedCodes })
  } catch (error) {
    return next(error)
  }
})

router.post('/generate', ...requireExternalUser, async (req, res, next) => {
  const requestId = req.body?.requestId
  if (requestId !== undefined && (typeof requestId !== 'string' || !/^[a-zA-Z0-9_-]{8,80}$/.test(requestId))) {
    return res.status(400).json({ message: 'A valid generation request ID is required.' })
  }

  const rawQuantity = req.body?.quantity
  const quantity = rawQuantity === undefined ? 1 : Number(rawQuantity)
  if (!Number.isInteger(quantity) || quantity < 1) {
    return res.status(400).json({ message: 'Select a valid quantity of referral codes to generate.' })
  }

  const generatedBy = new mongoose.Types.ObjectId(req.auth.id)
  const now = new Date()

  // First, mark any expired codes for this user
  await ReferralCode.updateMany(
    { generatedBy, status: 'active', expiresAt: { $lte: now } },
    { $set: { status: 'expired' } },
  )

  // Lifetime limit check: count ALL codes ever generated by this user
  const totalGenerated = await ReferralCode.countDocuments({ generatedBy })
  const remainingSlots = Math.max(0, maxLifetimeReferralCodes - totalGenerated)

  // Idempotency check with requestId before limit checks
  if (requestId) {
    if (quantity === 1) {
      const existing = await ReferralCode.findOne({ generatedBy, requestId }).lean()
      if (existing) {
        return res.status(200).json({
          code: serializeCode(existing),
          codes: [serializeCode(existing)],
          repeated: true,
          remainingSlots,
          remainingGenerations: remainingSlots,
          totalGenerated,
          maxLifetimeLimit: maxLifetimeReferralCodes,
        })
      }
    } else {
      const existingBatch = await ReferralCode.find({
        generatedBy,
        requestId: { $regex: `^${requestId}(-\\d+)?$` },
      }).lean()
      if (existingBatch.length > 0) {
        return res.status(200).json({
          code: serializeCode(existingBatch[0]),
          codes: existingBatch.map((c) => serializeCode(c)),
          count: existingBatch.length,
          repeated: true,
          remainingSlots,
          remainingGenerations: remainingSlots,
          totalGenerated,
          maxLifetimeLimit: maxLifetimeReferralCodes,
        })
      }
    }
  }

  if (totalGenerated >= maxLifetimeReferralCodes || remainingSlots === 0) {
    return res.status(429).json({
      message: 'You have reached your lifetime limit of 20 referral codes.',
      totalGenerated,
      remainingSlots: 0,
      remainingGenerations: 0,
      maxLifetimeLimit: maxLifetimeReferralCodes,
    })
  }

  if (quantity > remainingSlots) {
    return res.status(400).json({
      message: `You can only generate up to ${remainingSlots} more referral code${remainingSlots === 1 ? '' : 's'} (lifetime limit: 20).`,
      totalGenerated,
      remainingSlots,
      remainingGenerations: remainingSlots,
      maxLifetimeLimit: maxLifetimeReferralCodes,
    })
  }

  let session = null
  let createdDocs = []

  try {
    try {
      session = await mongoose.startSession()
    } catch {
      session = null
    }

    if (session) {
      try {
        await session.withTransaction(async () => {
          // Strictly count ALL lifetime codes inside the transaction
          const countInsideTx = await ReferralCode.countDocuments({ generatedBy }).session(session)

          if (countInsideTx + quantity > maxLifetimeReferralCodes) {
            const available = Math.max(0, maxLifetimeReferralCodes - countInsideTx)
            throw createRequestError(
              429,
              available === 0
                ? 'You have reached your lifetime limit of 20 referral codes.'
                : `You can only generate up to ${available} more referral code${available === 1 ? '' : 's'} (lifetime limit: 20).`,
            )
          }

          const docs = []
          const baseReqId = requestId || randomBytes(16).toString('hex')
          for (let i = 0; i < quantity; i++) {
            const codeCreatedAt = new Date()
            const codeExpiresAt = new Date(codeCreatedAt.getTime() + codeLifetimeMs)
            const codeReqId = quantity === 1 ? baseReqId : `${baseReqId}-${i}`
            const code = `LMS-${randomBytes(16).toString('hex').toUpperCase()}`
            docs.push({
              code,
              generatedBy,
              requestId: codeReqId,
              createdAt: codeCreatedAt,
              expiresAt: codeExpiresAt,
              status: 'active',
            })
          }

          createdDocs = await ReferralCode.create(docs, { session, ordered: true })
        })
      } catch (txError) {
        const isTxUnsupported =
          txError?.code === 20 ||
          txError?.codeName === 'IllegalOperation' ||
          txError?.message?.includes('Transaction numbers are only allowed') ||
          txError?.message?.includes('transactions are not supported') ||
          txError?.message?.includes('standalone') ||
          txError?.message?.includes('replica set')

        if (isTxUnsupported) {
          // Fallback for standalone MongoDB without replica set
          const countFallback = await ReferralCode.countDocuments({ generatedBy })
          if (countFallback + quantity > maxLifetimeReferralCodes) {
            const available = Math.max(0, maxLifetimeReferralCodes - countFallback)
            return res.status(429).json({
              message: available === 0
                ? 'You have reached your lifetime limit of 20 referral codes.'
                : `You can only generate up to ${available} more referral code${available === 1 ? '' : 's'} (lifetime limit: 20).`,
              totalGenerated: countFallback,
              remainingSlots: available,
              remainingGenerations: available,
              maxLifetimeLimit: maxLifetimeReferralCodes,
            })
          }
          const docs = []
          const baseReqId = requestId || randomBytes(16).toString('hex')
          for (let i = 0; i < quantity; i++) {
            const codeCreatedAt = new Date()
            const codeExpiresAt = new Date(codeCreatedAt.getTime() + codeLifetimeMs)
            const codeReqId = quantity === 1 ? baseReqId : `${baseReqId}-${i}`
            const code = `LMS-${randomBytes(16).toString('hex').toUpperCase()}`
            docs.push({
              code,
              generatedBy,
              requestId: codeReqId,
              createdAt: codeCreatedAt,
              expiresAt: codeExpiresAt,
              status: 'active',
            })
          }
          createdDocs = await ReferralCode.create(docs, { ordered: true })
        } else {
          throw txError
        }
      }
    } else {
      // Direct insertion if sessions not supported
      const countDirect = await ReferralCode.countDocuments({ generatedBy })
      if (countDirect + quantity > maxLifetimeReferralCodes) {
        const available = Math.max(0, maxLifetimeReferralCodes - countDirect)
        return res.status(429).json({
          message: available === 0
            ? 'You have reached your lifetime limit of 20 referral codes.'
            : `You can only generate up to ${available} more referral code${available === 1 ? '' : 's'} (lifetime limit: 20).`,
          totalGenerated: countDirect,
          remainingSlots: available,
          remainingGenerations: available,
          maxLifetimeLimit: maxLifetimeReferralCodes,
        })
      }
      const docs = []
      const baseReqId = requestId || randomBytes(16).toString('hex')
      for (let i = 0; i < quantity; i++) {
        const codeCreatedAt = new Date()
        const codeExpiresAt = new Date(codeCreatedAt.getTime() + codeLifetimeMs)
        const codeReqId = quantity === 1 ? baseReqId : `${baseReqId}-${i}`
        const code = `LMS-${randomBytes(16).toString('hex').toUpperCase()}`
        docs.push({
          code,
          generatedBy,
          requestId: codeReqId,
          createdAt: codeCreatedAt,
          expiresAt: codeExpiresAt,
          status: 'active',
        })
      }
      createdDocs = await ReferralCode.create(docs, { ordered: true })
    }

    const serialized = createdDocs.map((doc) =>
      serializeCode(doc?.toObject ? doc.toObject() : doc),
    )
    const newRemaining = Math.max(0, remainingSlots - quantity)

    return res.status(201).json({
      code: serialized[0],
      codes: serialized,
      count: serialized.length,
      repeated: false,
      remainingSlots: newRemaining,
      remainingGenerations: newRemaining,
      totalGenerated: totalGenerated + quantity,
      maxLifetimeLimit: maxLifetimeReferralCodes,
      lifetimeLimit: maxLifetimeReferralCodes,
    })
  } catch (error) {
    if (error?.statusCode === 429) {
      return res.status(429).json({ message: error.message, maxLifetimeLimit: maxLifetimeReferralCodes })
    }
    if (error?.code === 11000) {
      return res.status(409).json({ message: 'This generation request has already been processed.' })
    }
    return next(error)
  } finally {
    if (session) await session.endSession()
  }
})

export {
  maxLifetimeReferralCodes,
  maxLifetimeReferralCodes as maxActiveReferralCodes,
  maxLifetimeReferralCodes as dailyGenerationLimit,
  codeLifetimeMs,
  getUtcDayStart,
  registrationStatusForAccount,
  reconcileReferralAttributions,
}
export default router
