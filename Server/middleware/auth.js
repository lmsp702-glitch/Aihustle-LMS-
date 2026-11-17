import jwt from 'jsonwebtoken'
import { config } from '../config/env.js'
import {
  accountModelsByCollection,
  matchesStoredAccountRole,
  roleForAccountCollection,
} from '../models/account-models.js'
import {
  independentApprovalMessage,
  isIndependentStudentAccount,
} from '../utils/independent-approval.js'

const allowedRoles = new Set(['main_admin', 'college_admin', 'student'])

export async function authenticate(req, res, next) {
  let token = null
  const authorization = req.get('authorization')
  if (authorization) {
    const [scheme, headerToken, ...extra] = authorization.trim().split(/\s+/)
    if (scheme === 'Bearer' && headerToken && !extra.length) {
      token = headerToken
    }
  } else if (typeof req.query?.token === 'string' && req.query.token.trim()) {
    token = req.query.token.trim()
  }

  if (!token) {
    return res.status(401).json({ message: 'A valid access token is required.' })
  }
  if (!config.jwtSecret || !config.jwtSecret.trim()) {
    return res.status(503).json({ message: 'Authentication is not configured.' })
  }

  try {
    const payload = jwt.verify(token, config.jwtSecret)
    if (
      typeof payload === 'string' ||
      typeof payload.sub !== 'string' ||
      !allowedRoles.has(payload.role) ||
      typeof payload.accountCollection !== 'string' ||
      roleForAccountCollection(payload.accountCollection) !== payload.role
    ) {
      return res.status(401).json({ message: 'The access token is invalid.' })
    }

    const AccountModel = accountModelsByCollection[payload.accountCollection]
    const user = await AccountModel.findById(payload.sub)
    if (!user || !matchesStoredAccountRole(payload.accountCollection, user.role)) {
      return res.status(401).json({ message: 'The access token is invalid.' })
    }

    const approvalMessage = independentApprovalMessage(user, payload.accountCollection)
    const status = String(user.status || user.approvalStatus || '').toLowerCase()
    const approvalStatus = String(user.approvalStatus || '').toLowerCase()
    const independentStudent = isIndependentStudentAccount(user, payload.accountCollection)
    if (
      user.isActive === false ||
      status !== 'active' ||
      (independentStudent && approvalStatus !== 'approved')
    ) {
      return res.status(403).json({ message: approvalMessage || 'Your account is not active.' })
    }

    req.auth = {
      id: String(user._id),
      role: payload.role,
      accountCollection: payload.accountCollection,
      user: {
        id: String(user._id),
        fullName: user.fullName,
        username: user.username,
        email: user.email,
        role: payload.role,
        collegeId: user.collegeId ? String(user.collegeId) : undefined,
        studentType: user.studentType,
        status: user.status,
        approvalStatus: user.approvalStatus,
        isActive: user.isActive,
        permissions: user.permissions,
      },
    }
    return next()
  } catch (error) {
    if (error instanceof jwt.JsonWebTokenError) {
      return res.status(401).json({ message: 'The access token is invalid or expired.' })
    }
    return next(error)
  }
}

export function requireRoles(...roles) {
  const allowed = new Set(
    roles.flatMap((r) => {
      const aliasMap = {
        college: ['college', 'college_admin'],
        college_admin: ['college', 'college_admin'],
        admin: ['admin', 'main_admin'],
        main_admin: ['admin', 'main_admin'],
      }
      return aliasMap[r] || [r]
    }),
  )
  return function authorizeRole(req, res, next) {
    if (!req.auth) {
      return res.status(401).json({ message: 'Authentication is required.' })
    }
    if (!allowed.has(req.auth.role)) {
      return res.status(403).json({ message: 'You do not have permission to access this resource.' })
    }
    return next()
  }
}
