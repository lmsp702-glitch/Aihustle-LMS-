import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { Router } from 'express'
import mongoose from 'mongoose'
import SupportTicket, { ticketCategories, ticketPriorities, ticketStatuses } from '../models/SupportTicket.js'
import Notification from '../models/Notification.js'
import { Admin, CollegeStudent, Student } from '../models/account-models.js'
import { authenticate } from '../middleware/auth.js'
import {
  logEmailDeliveryFailure,
  sendSupportTicketComplaintEmail,
} from '../utils/email.js'

const router = Router()
const maxAttachmentBytes = 5 * 1024 * 1024
const attachmentTypes = new Set(['image/png', 'image/jpeg', 'image/webp', 'application/pdf'])

router.use(authenticate)

function isValidText(value, minLength, maxLength) {
  return typeof value === 'string' && value.trim().length >= minLength && value.trim().length <= maxLength
}

function adminPermissions(req) {
  const permissions = req.auth.user.permissions
  return Array.isArray(permissions) ? permissions : []
}

function getTicketScope(req) {
  if (req.auth.role === 'student') {
    return {
      userId: new mongoose.Types.ObjectId(req.auth.id),
      userCollection: req.auth.accountCollection,
    }
  }
  if (req.auth.role === 'main_admin') return {}
  if (req.auth.role !== 'college_admin') return null

  const permissions = adminPermissions(req)
  if (permissions.includes('support:college') && mongoose.isValidObjectId(req.auth.user.collegeId)) {
    return { collegeId: new mongoose.Types.ObjectId(req.auth.user.collegeId) }
  }
  return null
}

function ticketJson(ticket, requester) {
  const result = ticket.toObject ? ticket.toObject() : { ...ticket }
  if (result.attachment) {
    delete result.attachment.data
    result.attachment = {
      id: String(result.attachment.id),
      fileName: result.attachment.fileName,
      contentType: result.attachment.contentType,
      size: result.attachment.size,
    }
  }
  result.studentId = result.userId ? String(result.userId) : undefined
  result.messages = result.replies || []
  if (requester) result.requester = requester
  return result
}

function cleanFileName(fileName) {
  return path.basename(fileName).replace(/[^\w.-]/g, '_').slice(0, 120) || 'attachment'
}

function decodeAttachment(input) {
  if (input === undefined || input === null) return undefined
  if (
    !input ||
    typeof input !== 'object' ||
    typeof input.fileName !== 'string' ||
    typeof input.contentType !== 'string' ||
    typeof input.data !== 'string' ||
    !attachmentTypes.has(input.contentType) ||
    input.data.length > Math.ceil(maxAttachmentBytes / 3) * 4 + 8 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.data)
  ) {
    const error = new Error('Choose a valid PNG, JPEG, WebP, or PDF attachment up to 5 MB.')
    error.statusCode = 400
    throw error
  }

  const data = Buffer.from(input.data, 'base64')
  if (!data.length || data.length > maxAttachmentBytes) {
    const error = new Error('Attachments must be 5 MB or smaller.')
    error.statusCode = 400
    throw error
  }

  const signatures = {
    'image/png': data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
    'image/jpeg': data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff,
    'image/webp': data.length >= 12 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP',
    'application/pdf': data.subarray(0, 5).toString('ascii') === '%PDF-',
  }
  if (!signatures[input.contentType]) {
    const error = new Error('The attachment content does not match its file type.')
    error.statusCode = 400
    throw error
  }

  return {
    id: new mongoose.Types.ObjectId(),
    fileName: cleanFileName(input.fileName),
    contentType: input.contentType,
    size: data.length,
    data,
  }
}

function requireTicketScope(req, res) {
  const scope = getTicketScope(req)
  if (!scope) {
    res.status(403).json({ message: 'You do not have permission to access support tickets.' })
    return null
  }
  return scope
}

function createTicketId() {
  return `LMS-${Date.now().toString(36).toUpperCase()}-${randomBytes(4).toString('hex').toUpperCase()}`
}

function scopedTicketQuery(scope, ticketId) {
  if (mongoose.isValidObjectId(ticketId)) {
    return { ...scope, $or: [{ ticketId }, { _id: ticketId }] }
  }
  return { ...scope, ticketId }
}

async function findScopedTicket(scope, ticketId, select = '') {
  return SupportTicket.findOne(scopedTicketQuery(scope, ticketId)).select(select)
}

async function includeRequesterDetails(tickets) {
  const [independent, college] = await Promise.all([
    Student.find({ _id: { $in: tickets.filter((ticket) => ticket.userCollection === 'students').map((ticket) => ticket.userId) } })
      .select('fullName email').lean(),
    CollegeStudent.find({ _id: { $in: tickets.filter((ticket) => ticket.userCollection === 'clg_students').map((ticket) => ticket.userId) } })
      .select('fullName email').lean(),
  ])
  const usersByKey = new Map([
    ...independent.map((user) => [`students:${user._id}`, user]),
    ...college.map((user) => [`clg_students:${user._id}`, user]),
  ])
  return tickets.map((ticket) => {
    const requester = usersByKey.get(`${ticket.userCollection}:${ticket.userId}`)
    return ticketJson(ticket, requester ? { fullName: requester.fullName, email: requester.email } : undefined)
  })
}

async function findRequester(ticket) {
  if (!ticket?.userId) return null
  if (mongoose.connection.readyState === 0 && Student.findById === mongoose.Model.findById) {
    return null
  }
  const AccountModel = ticket.userCollection === 'clg_students' ? CollegeStudent : Student
  return AccountModel.findById(ticket.userId).select('fullName email').lean()
}

function validateTicketFilters(query) {
  const filters = {}
  for (const [field, values] of [
    ['status', ticketStatuses],
    ['category', ticketCategories],
    ['priority', ticketPriorities],
  ]) {
    if (query[field] !== undefined) {
      if (typeof query[field] !== 'string' || !values.includes(query[field])) {
        const error = new Error(`Invalid ${field} filter.`)
        error.statusCode = 400
        throw error
      }
      filters[field] = query[field]
    }
  }
  return filters
}

function requireAdmin(req, res) {
  if (!['main_admin', 'college_admin'].includes(req.auth.role)) {
    res.status(403).json({ message: 'Only authorized support administrators can perform this action.' })
    return false
  }
  if (!requireTicketScope(req, res)) return false
  return true
}

async function emitNotification({ recipientRole, recipientId, collegeId, title, message, link, metadata }) {
  try {
    await Notification.create({
      recipientRole,
      ...(recipientId ? { recipientId, userId: recipientId } : {}),
      ...(collegeId ? { collegeId } : {}),
      type: 'support',
      title,
      message,
      link,
      metadata: metadata || {},
    })
  } catch (err) {
    // Non-blocking notification emission
  }
}

// Compute statistics for a given query scope
async function computeTicketStats(scope) {
  const [total, open, inProgress, waitingForStudent, resolved, closed] = await Promise.all([
    SupportTicket.countDocuments(scope),
    SupportTicket.countDocuments({ ...scope, status: 'Open' }),
    SupportTicket.countDocuments({ ...scope, status: 'In Progress' }),
    SupportTicket.countDocuments({ ...scope, status: { $in: ['Waiting for Student', 'Waiting for User'] } }),
    SupportTicket.countDocuments({ ...scope, status: 'Resolved' }),
    SupportTicket.countDocuments({ ...scope, status: 'Closed' }),
  ])
  return { total, open, inProgress, waitingForStudent, resolved, closed }
}

// ---------------------------------------------------------------------------
// Student Endpoints
// ---------------------------------------------------------------------------

// POST /tickets - Create a new support ticket
router.post('/tickets', async (req, res, next) => {
  try {
    if (req.auth.role !== 'student') {
      return res.status(403).json({ message: 'Only student accounts can submit support tickets.' })
    }
    const { subject, category, priority, description, attachment: attachmentInput } = req.body ?? {}
    if (!isValidText(subject, 3, 160)) {
      return res.status(400).json({ message: 'Enter a subject between 3 and 160 characters.' })
    }
    if (!ticketCategories.includes(category)) {
      return res.status(400).json({ message: 'Choose a valid support category.' })
    }
    if (!ticketPriorities.includes(priority)) {
      return res.status(400).json({ message: 'Choose a valid priority.' })
    }
    if (!isValidText(description, 10, 10000)) {
      return res.status(400).json({ message: 'Enter a description between 10 and 10,000 characters.' })
    }

    const user = req.auth.user
    const studentObjectId = new mongoose.Types.ObjectId(req.auth.id)
    const ticketId = createTicketId()

    const ticket = await SupportTicket.create({
      ticketId,
      userId: studentObjectId,
      studentId: studentObjectId,
      userCollection: req.auth.accountCollection,
      accountType: user.studentType === 'college' ? 'college' : 'independent',
      ...(user.studentType === 'college' && mongoose.isValidObjectId(user.collegeId)
        ? { collegeId: new mongoose.Types.ObjectId(user.collegeId) }
        : {}),
      subject: subject.trim(),
      category,
      priority,
      description: description.trim(),
      attachment: decodeAttachment(attachmentInput),
      status: 'Open',
      statusHistory: [
        {
          to: 'Open',
          changedBy: studentObjectId,
          changedByRole: 'student',
        },
      ],
    })

    // Notify student of ticket creation
    await emitNotification({
      recipientRole: 'student',
      recipientId: studentObjectId,
      title: `Support Ticket Received: ${ticketId}`,
      message: `Your request "${ticket.subject}" has been received. Our support team will review it.`,
      link: `/student/help/requests/${ticketId}`,
      metadata: { ticketId },
    })


    try {
      await sendSupportTicketComplaintEmail({
        email: user.email,
        fullName: user.fullName,
        ticket,
      })
    } catch (deliveryError) {
      logEmailDeliveryFailure('support_ticket_complaint_email', deliveryError, {
        accountId: req.auth.id,
      })
    }

    // Notify main admin of new incoming ticket
    await emitNotification({
      recipientRole: 'main_admin',
      collegeId: ticket.collegeId,
      title: `New Support Request (${ticketId})`,
      message: `${user.fullName || 'Student'} created ticket: "${ticket.subject}" [${ticket.priority}]`,
      link: `/admin/support/${ticketId}`,
      metadata: { ticketId, priority: ticket.priority, category: ticket.category },
    })

    return res.status(201).json({ ticket: ticketJson(ticket) })
  } catch (error) {
    if (error?.statusCode) return res.status(error.statusCode).json({ message: error.message })
    if (error?.code === 11000) return res.status(503).json({ message: 'A unique ticket ID could not be allocated. Please try again.' })
    return next(error)
  }
})

// GET /tickets and GET /tickets/mine - List tickets (Role-aware: student sees theirs; admin sees scoped)
async function handleListTickets(req, res, next) {
  try {
    const scope = getTicketScope(req)
    if (!scope) return res.status(403).json({ message: 'You do not have permission to access support tickets.' })

    const filters = validateTicketFilters(req.query)
    const searchQuery = typeof req.query.search === 'string' ? req.query.search.trim() : ''

    const query = { ...scope, ...filters }

    if (searchQuery) {
      const searchRegex = new RegExp(searchQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
      query.$or = [{ ticketId: searchRegex }, { subject: searchRegex }]
    }

    if (req.auth.role === 'student') {
      const [tickets, stats] = await Promise.all([
        SupportTicket.find(query).select('-attachment.data').sort({ updatedAt: -1 }).lean(),
        computeTicketStats(scope),
      ])
      return res.json({
        tickets: tickets.map((t) => ticketJson(t)),
        stats,
      })
    }

    // Admin listing
    const tickets = await SupportTicket.find(query)
      .select('-attachment.data')
      .sort({ updatedAt: -1 })
      .limit(200)
      .lean()

    const stats = await computeTicketStats(scope)
    return res.json({
      tickets: await includeRequesterDetails(tickets),
      stats,
    })
  } catch (error) {
    if (error?.statusCode) return res.status(error.statusCode).json({ message: error.message })
    return next(error)
  }
}

router.get('/tickets', handleListTickets)
router.get('/tickets/mine', handleListTickets)

// GET /tickets/stats & /tickets/mine/stats - Get ticket stats
async function handleGetStats(req, res, next) {
  try {
    const scope = getTicketScope(req)
    if (!scope) return res.status(403).json({ message: 'Permission denied.' })
    const stats = await computeTicketStats(scope)
    return res.json({ stats })
  } catch (error) {
    return next(error)
  }
}

router.get('/tickets/stats', handleGetStats)
router.get('/tickets/mine/stats', handleGetStats)

// GET /tickets/:ticketId & GET /tickets/mine/:ticketId - Get single ticket
async function handleGetSingleTicket(req, res, next) {
  try {
    const scope = getTicketScope(req)
    if (!scope) return res.status(403).json({ message: 'Permission denied.' })

    const ticket = await findScopedTicket(scope, req.params.ticketId, '-attachment.data')
    if (!ticket) return res.status(404).json({ message: 'Support request not found.' })

    let requester
    if (['main_admin', 'college_admin'].includes(req.auth.role)) {
      requester = await findRequester(ticket)
    }

    return res.json({
      ticket: ticketJson(ticket, requester ? { fullName: requester.fullName, email: requester.email } : undefined),
    })
  } catch (error) {
    return next(error)
  }
}

router.get('/tickets/:ticketId', handleGetSingleTicket)
router.get('/tickets/mine/:ticketId', handleGetSingleTicket)

// POST /tickets/:ticketId/messages & /tickets/:ticketId/replies & /tickets/mine/:ticketId/replies - Reply to ticket
async function handleReplyTicket(req, res, next) {
  try {
    if (!isValidText(req.body?.message, 1, 5000)) {
      return res.status(400).json({ message: 'Enter a reply of no more than 5,000 characters.' })
    }

    const scope = getTicketScope(req)
    if (!scope) return res.status(403).json({ message: 'Permission denied.' })

    const ticket = await findScopedTicket(scope, req.params.ticketId)
    if (!ticket) return res.status(404).json({ message: 'Support request not found.' })

    if (req.auth.role === 'student') {
      if (['Resolved', 'Closed'].includes(ticket.status)) {
        return res.status(409).json({ message: 'Replies are only available while a ticket is open or in progress.' })
      }

      const previousStatus = ticket.status
      ticket.replies.push({
        authorId: req.auth.id,
        authorRole: 'student',
        message: req.body.message.trim(),
      })

      if (['Waiting for Student', 'Waiting for User'].includes(ticket.status)) {
        ticket.status = 'In Progress'
        ticket.statusHistory.push({
          from: previousStatus,
          to: 'In Progress',
          changedBy: req.auth.id,
          changedByRole: 'student',
        })
      }

      await ticket.save()

      // Notify admin of student reply
      await emitNotification({
        recipientRole: 'main_admin',
        collegeId: ticket.collegeId,
        title: `Student Reply on Ticket ${ticket.ticketId}`,
        message: `Student replied to ticket: "${ticket.subject}"`,
        link: `/admin/support/${ticket.ticketId}`,
        metadata: { ticketId: ticket.ticketId },
      })

      return res.json({ ticket: ticketJson(ticket) })
    }

    // Admin reply
    if (['Closed'].includes(ticket.status)) {
      return res.status(409).json({ message: 'This support request is closed to replies.' })
    }

    const previousStatus = ticket.status
    ticket.replies.push({
      authorId: req.auth.id,
      authorRole: 'admin',
      message: req.body.message.trim(),
    })

    ticket.status = 'Waiting for Student'
    ticket.statusHistory.push({
      from: previousStatus,
      to: 'Waiting for Student',
      changedBy: req.auth.id,
      changedByRole: 'admin',
    })

    await ticket.save()

    // Notify student of admin reply
    await emitNotification({
      recipientRole: 'student',
      recipientId: ticket.userId,
      title: `New Reply on Ticket ${ticket.ticketId}`,
      message: `The support team replied to your ticket "${ticket.subject}".`,
      link: `/student/help/requests/${ticket.ticketId}`,
      metadata: { ticketId: ticket.ticketId },
    })

    const requester = await findRequester(ticket)
    return res.json({
      ticket: ticketJson(ticket, requester ? { fullName: requester.fullName, email: requester.email } : undefined),
    })
  } catch (error) {
    return next(error)
  }
}

router.post('/tickets/:ticketId/messages', handleReplyTicket)
router.post('/tickets/:ticketId/replies', handleReplyTicket)
router.post('/tickets/mine/:ticketId/replies', handleReplyTicket)

// GET /tickets/:ticketId/attachment & /tickets/mine/:ticketId/attachment - Download attachment
async function handleDownloadAttachment(req, res, next) {
  try {
    const scope = getTicketScope(req)
    if (!scope) return res.status(403).json({ message: 'Permission denied.' })

    const ticket = await SupportTicket.findOne({
      ...scopedTicketQuery(scope, req.params.ticketId),
      ...(req.query.id ? { 'attachment.id': req.query.id } : {}),
    }).select('+attachment.data')

    if (!ticket?.attachment?.data) return res.status(404).json({ message: 'Attachment not found.' })
    res.type(ticket.attachment.contentType)
    res.set('Content-Disposition', `attachment; filename="${ticket.attachment.fileName}"`)
    res.set('X-Content-Type-Options', 'nosniff')
    return res.send(ticket.attachment.data)
  } catch (error) {
    return next(error)
  }
}

router.get('/tickets/:ticketId/attachment', handleDownloadAttachment)
router.get('/tickets/mine/:ticketId/attachment', handleDownloadAttachment)

// ---------------------------------------------------------------------------
// Admin Dedicated Endpoints
// ---------------------------------------------------------------------------

router.get('/admin/stats', async (req, res, next) => {
  try {
    if (!requireAdmin(req, res)) return
    const scope = getTicketScope(req)
    const stats = await computeTicketStats(scope)
    return res.json({ stats })
  } catch (error) {
    return next(error)
  }
})

router.get('/admin/tickets', async (req, res, next) => {
  try {
    if (!requireAdmin(req, res)) return
    const scope = getTicketScope(req)
    const filters = validateTicketFilters(req.query)
    const searchQuery = typeof req.query.search === 'string' ? req.query.search.trim() : ''

    const query = { ...scope, ...filters }
    if (searchQuery) {
      const searchRegex = new RegExp(searchQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
      query.$or = [{ ticketId: searchRegex }, { subject: searchRegex }]
    }

    const [tickets, stats] = await Promise.all([
      SupportTicket.find(query).select('-attachment.data').sort({ updatedAt: -1 }).limit(200).lean(),
      computeTicketStats(scope),
    ])

    return res.json({
      tickets: await includeRequesterDetails(tickets),
      stats,
    })
  } catch (error) {
    if (error?.statusCode) return res.status(error.statusCode).json({ message: error.message })
    return next(error)
  }
})

router.get('/admin/tickets/handlers', async (req, res, next) => {
  try {
    if (!requireAdmin(req, res)) return
    const scope = getTicketScope(req)
    const query = { permissions: { $in: ['*', 'support:all', 'support:handle'] } }
    if (scope.collegeId) query.collegeId = scope.collegeId
    const handlers = await Admin.find(query).select('fullName email collegeId').lean()
    return res.json({
      handlers: handlers.map(({ _id, fullName, email }) => ({
        id: String(_id),
        fullName: fullName || 'Support administrator',
        email,
      })),
    })
  } catch (error) {
    return next(error)
  }
})

router.get('/admin/tickets/:ticketId', async (req, res, next) => {
  try {
    if (!requireAdmin(req, res)) return
    const ticket = await findScopedTicket(getTicketScope(req), req.params.ticketId, '-attachment.data')
    if (!ticket) return res.status(404).json({ message: 'Support request not found.' })
    const requester = await findRequester(ticket)
    return res.json({
      ticket: ticketJson(ticket, requester ? { fullName: requester.fullName, email: requester.email } : undefined),
    })
  } catch (error) {
    return next(error)
  }
})

router.post('/admin/tickets/:ticketId/messages', handleReplyTicket)
router.post('/admin/tickets/:ticketId/replies', handleReplyTicket)

// PATCH /admin/tickets/:ticketId/status & PATCH /tickets/:ticketId/status - Update ticket status
async function handleUpdateStatus(req, res, next) {
  try {
    if (!requireAdmin(req, res)) return
    const { status, priority } = req.body ?? {}
    if (!status || !ticketStatuses.includes(status)) {
      return res.status(400).json({ message: 'Choose a valid ticket status.' })
    }
    if (priority && !ticketPriorities.includes(priority)) {
      return res.status(400).json({ message: 'Choose a valid priority.' })
    }

    const ticket = await findScopedTicket(getTicketScope(req), req.params.ticketId)
    if (!ticket) return res.status(404).json({ message: 'Support request not found.' })

    const previousStatus = ticket.status
    if (ticket.status !== status) {
      ticket.statusHistory.push({
        from: previousStatus,
        to: status,
        changedBy: req.auth.id,
        changedByRole: 'admin',
      })
      ticket.status = status
      if (status === 'Resolved') {
        ticket.resolvedAt = new Date()
      } else {
        ticket.resolvedAt = undefined
      }
    }

    if (priority) {
      ticket.priority = priority
    }

    await ticket.save()

    // Notify student of status update
    await emitNotification({
      recipientRole: 'student',
      recipientId: ticket.userId,
      title: `Ticket ${ticket.ticketId} Status: ${status}`,
      message: `Your ticket "${ticket.subject}" has been marked as ${status}.`,
      link: `/student/help/requests/${ticket.ticketId}`,
      metadata: { ticketId: ticket.ticketId, status },
    })

    const requester = await findRequester(ticket)
    return res.json({
      ticket: ticketJson(ticket, requester ? { fullName: requester.fullName, email: requester.email } : undefined),
    })
  } catch (error) {
    return next(error)
  }
}

router.patch('/admin/tickets/:ticketId/status', handleUpdateStatus)
router.patch('/tickets/:ticketId/status', handleUpdateStatus)

async function handleUpdatePriority(req, res, next) {
  try {
    if (!requireAdmin(req, res)) return
    const { priority } = req.body ?? {}
    if (!priority || !ticketPriorities.includes(priority)) {
      return res.status(400).json({ message: 'Choose a valid ticket priority.' })
    }
    const ticket = await findScopedTicket(getTicketScope(req), req.params.ticketId)
    if (!ticket) return res.status(404).json({ message: 'Support request not found.' })
    if (ticket.priority !== priority) {
      ticket.priorityHistory = ticket.priorityHistory || []
      ticket.priorityHistory.push({
        from: ticket.priority,
        to: priority,
        changedBy: req.auth.id,
        changedByRole: 'admin',
      })
      ticket.priority = priority
      await ticket.save()
    }
    const requester = await findRequester(ticket)
    return res.json({
      ticket: ticketJson(ticket, requester ? { fullName: requester.fullName, email: requester.email } : undefined),
    })
  } catch (error) {
    return next(error)
  }
}

router.patch('/admin/tickets/:ticketId/priority', handleUpdatePriority)
router.patch('/tickets/:ticketId/priority', handleUpdatePriority)

router.patch('/admin/tickets/:ticketId/assignment', async (req, res, next) => {
  try {
    if (!requireAdmin(req, res)) return
    const { assignedTo } = req.body ?? {}
    if (assignedTo !== null && (typeof assignedTo !== 'string' || !mongoose.isValidObjectId(assignedTo))) {
      return res.status(400).json({ message: 'Choose a valid support handler.' })
    }
    const ticket = await findScopedTicket(getTicketScope(req), req.params.ticketId)
    if (!ticket) return res.status(404).json({ message: 'Support request not found.' })

    if (assignedTo === null) {
      ticket.assignedTo = undefined
    } else {
      const handler = await Admin.findOne({
        _id: assignedTo,
        permissions: { $in: ['*', 'support:all', 'support:handle'] },
      }).select('_id collegeId').lean()
      if (!handler) return res.status(400).json({ message: 'The selected account is not an authorized support handler.' })
      const scope = getTicketScope(req)
      if (scope.collegeId && String(handler.collegeId) !== String(scope.collegeId)) {
        return res.status(403).json({ message: 'You cannot assign tickets outside your college.' })
      }
      if (scope.collegeId && String(ticket.collegeId) !== String(scope.collegeId)) {
        return res.status(404).json({ message: 'Support request not found.' })
      }
      ticket.assignedTo = handler._id
    }
    await ticket.save()
    return res.json({ ticket: ticketJson(ticket) })
  } catch (error) {
    return next(error)
  }
})

router.get('/admin/tickets/:ticketId/attachment', handleDownloadAttachment)

export { computeTicketStats }
export default router
