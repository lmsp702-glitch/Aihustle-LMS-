import { randomBytes } from 'node:crypto'
import { Router } from 'express'
import mongoose from 'mongoose'
import Complaint, { complaintStatuses } from '../models/Complaint.js'
import { CollegeStudent, Student } from '../models/account-models.js'
import { authenticate } from '../middleware/auth.js'
import {
  logEmailDeliveryFailure,
  sendEmailSupportMessage,
  sendEmailSupportReply,
} from '../utils/email.js'

const router = Router()
const studentCollections = new Set(['students', 'clg_students'])
const complaintCategories = new Set([
  'Account and Login',
  'Course and Enrollment',
  'Assignments and Results',
  'Payments and Purchases',
  'Technical Issue',
  'Other',
])
const emailSupportStatuses = ['Unsolved', 'Solved']

router.use(authenticate)

function isValidText(value, minLength, maxLength) {
  return typeof value === 'string' && value.trim().length >= minLength && value.trim().length <= maxLength
}

function isValidEmailSupportSubject(value) {
  return isValidText(value, 3, 160) && !/[\r\n\u0000-\u001f\u007f]/.test(value)
}

function requireStudent(req, res) {
  if (req.auth.role !== 'student' || !studentCollections.has(req.auth.accountCollection)) {
    res.status(403).json({ message: 'Student access is required.' })
    return false
  }
  return true
}

function requireMainAdmin(req, res) {
  if (req.auth.role !== 'main_admin') {
    res.status(403).json({ message: 'Main Admin access is required.' })
    return false
  }
  return true
}

function createComplaintId() {
  return `CMP-${Date.now().toString(36).toUpperCase()}-${randomBytes(4).toString('hex').toUpperCase()}`
}

function serializeComplaint(complaint, student) {
  const record = complaint.toObject ? complaint.toObject() : { ...complaint }
  const userId = String(record.userId)
  return {
    ...record,
    requester: {
      id: userId,
      studentId: record.studentId || student?.studentId || userId,
      fullName: record.studentName || student?.fullName || 'Student',
      email: record.studentEmail || student?.email || 'Email unavailable',
      collegeId: record.collegeId ? String(record.collegeId) : student?.collegeId ? String(student.collegeId) : null,
    },
  }
}

async function includeStudentDetails(complaintRecords) {
  const independentIds = complaintRecords
    .filter((record) => record.userCollection === 'students')
    .map((record) => record.userId)
  const collegeIds = complaintRecords
    .filter((record) => record.userCollection === 'clg_students')
    .map((record) => record.userId)
  const [independentStudents, collegeStudents] = await Promise.all([
    Student.find({ _id: { $in: independentIds } }).select('fullName email studentId').lean(),
    CollegeStudent.find({ _id: { $in: collegeIds } }).select('fullName email studentId collegeId').lean(),
  ])
  const studentsById = new Map(
    [...independentStudents, ...collegeStudents].map((student) => [String(student._id), student]),
  )
  return complaintRecords.map((record) => serializeComplaint(record, studentsById.get(String(record.userId))))
}

router.get('/profile', async (req, res, next) => {
  try {
    if (!requireStudent(req, res)) return
    const StudentModel = req.auth.accountCollection === 'clg_students' ? CollegeStudent : Student
    const student = await StudentModel.findById(req.auth.id)
      .select('fullName email studentId studentType collegeId')
      .lean()
    if (!student) return res.status(404).json({ message: 'Student account not found.' })

    return res.json({
      student: {
        fullName: student.fullName || '',
        email: student.email || '',
        studentType: req.auth.accountCollection === 'clg_students' ? 'college' : 'independent',
        studentId: student.studentId || '',
        collegeId: student.collegeId ? String(student.collegeId) : '',
      },
    })
  } catch (error) {
    return next(error)
  }
})

router.post('/', async (req, res, next) => {
  try {
    if (!requireStudent(req, res)) return
    const { subject, category, description } = req.body ?? {}
    if (!isValidText(subject, 3, 160)) {
      return res.status(400).json({ message: 'Enter a subject between 3 and 160 characters.' })
    }
    if (!complaintCategories.has(category)) {
      return res.status(400).json({ message: 'Choose a valid complaint category.' })
    }
    if (!isValidText(description, 10, 10000)) {
      return res.status(400).json({ message: 'Enter a description between 10 and 10,000 characters.' })
    }

    const StudentModel = req.auth.accountCollection === 'clg_students' ? CollegeStudent : Student
    const student = await StudentModel.findById(req.auth.id)
      .select('fullName email studentId studentType collegeId')
      .lean()
    if (!student) return res.status(404).json({ message: 'Student account not found.' })
    const complaint = await Complaint.create({
      complaintId: createComplaintId(),
      userId: new mongoose.Types.ObjectId(req.auth.id),
      userCollection: req.auth.accountCollection,
      studentName: student.fullName || 'Student',
      studentId: student.studentId || String(student._id),
      studentEmail: student.email,
      ...(req.auth.accountCollection === 'clg_students' && student.collegeId
        ? { collegeId: student.collegeId }
        : {}),
      subject: subject.trim(),
      category,
      description: description.trim(),
      status: 'Unsolved',
    })
    return res.status(201).json({ complaint: serializeComplaint(complaint, student) })
  } catch (error) {
    if (error?.code === 11000) {
      return res.status(503).json({ message: 'A unique complaint ID could not be allocated. Please try again.' })
    }
    return next(error)
  }
})

router.post('/email-support', async (req, res, next) => {
  try {
    if (!requireStudent(req, res)) return
    const { subject, message } = req.body ?? {}
    if (!isValidEmailSupportSubject(subject)) {
      return res.status(400).json({ message: 'Enter a subject between 3 and 160 characters.' })
    }
    if (!isValidText(message, 10, 10000)) {
      return res.status(400).json({ message: 'Enter a message between 10 and 10,000 characters.' })
    }

    const StudentModel = req.auth.accountCollection === 'clg_students' ? CollegeStudent : Student
    const student = await StudentModel.findById(req.auth.id)
      .select('fullName email studentId studentType collegeId')
      .lean()
    if (!student) return res.status(404).json({ message: 'Student account not found.' })
    if (!isValidText(student.fullName, 1, 120) || !isValidText(student.email, 3, 254)) {
      return res.status(409).json({ message: 'Your student profile must have a name and email before contacting support.' })
    }

    const complaint = await Complaint.create({
      complaintId: createComplaintId(),
      userId: new mongoose.Types.ObjectId(req.auth.id),
      userCollection: req.auth.accountCollection,
      studentName: student.fullName || 'Student',
      studentId: student.studentId || String(student._id),
      studentEmail: student.email,
      ...(req.auth.accountCollection === 'clg_students' && student.collegeId
        ? { collegeId: student.collegeId }
        : {}),
      source: 'Email Support',
      priority: 'Normal',
      subject: subject.trim(),
      category: 'Email Support',
      description: message.trim(),
      status: 'Unsolved',
    })

    let emailSent = true
    let notificationMessage
    try {
      await sendEmailSupportMessage({
        email: student.email,
        fullName: student.fullName || 'Student',
        subject: complaint.subject,
        message: complaint.description,
      })
    } catch (emailError) {
      emailSent = false
      notificationMessage = `Your message was saved as ${complaint.complaintId}, but its email notification could not be sent. Support can still review it; please do not resubmit.`
      logEmailDeliveryFailure({
        event: 'notification.email_support.failed',
        accountId: req.auth.id,
        error: emailError,
      })
    }

    return res.status(201).json({
      complaint: serializeComplaint(complaint, student),
      emailSent,
      ...(notificationMessage ? { message: notificationMessage } : {}),
    })
  } catch (error) {
    if (error?.code === 11000) {
      return res.status(503).json({ message: 'A unique complaint ID could not be allocated. Please try again.' })
    }
    return next(error)
  }
})

router.get('/mine', async (req, res, next) => {
  try {
    if (!requireStudent(req, res)) return
    const complaints = await Complaint.find({
      userId: new mongoose.Types.ObjectId(req.auth.id),
      userCollection: req.auth.accountCollection,
    }).sort({ createdAt: -1 }).lean()
    return res.json({ complaints })
  } catch (error) {
    return next(error)
  }
})

router.get('/admin', async (req, res, next) => {
  try {
    if (!requireMainAdmin(req, res)) return
    const complaints = await Complaint.find({}).sort({ createdAt: -1 }).lean()
    return res.json({ complaints: await includeStudentDetails(complaints) })
  } catch (error) {
    return next(error)
  }
})

router.get('/admin/:complaintId', async (req, res, next) => {
  try {
    if (!requireMainAdmin(req, res)) return
    if (!mongoose.isValidObjectId(req.params.complaintId)) {
      return res.status(400).json({ message: 'Select a valid complaint.' })
    }
    const complaint = await Complaint.findById(req.params.complaintId).lean()
    if (!complaint) return res.status(404).json({ message: 'Complaint not found.' })
    const [result] = await includeStudentDetails([complaint])
    return res.json({ complaint: result })
  } catch (error) {
    return next(error)
  }
})

router.post('/admin/:complaintId/replies', async (req, res, next) => {
  try {
    if (!requireMainAdmin(req, res)) return
    if (!mongoose.isValidObjectId(req.params.complaintId)) {
      return res.status(400).json({ message: 'Select a valid complaint.' })
    }
    if (!isValidText(req.body?.message, 1, 5000)) {
      return res.status(400).json({ message: 'Enter a reply of no more than 5,000 characters.' })
    }
    const complaint = await Complaint.findById(req.params.complaintId)
    if (!complaint) return res.status(404).json({ message: 'Complaint not found.' })

    const replyMessage = req.body.message.trim()
    complaint.replies.push({
      authorId: new mongoose.Types.ObjectId(req.auth.id),
      authorRole: 'main_admin',
      message: replyMessage,
    })
    await complaint.save()
    let emailSent
    let notificationMessage
    if (complaint.source === 'Email Support') {
      emailSent = true
      try {
        await sendEmailSupportReply({
          email: complaint.studentEmail,
          fullName: complaint.studentName,
          subject: complaint.subject,
          message: replyMessage,
        })
      } catch (emailError) {
        emailSent = false
        notificationMessage = 'The reply was saved, but its email could not be delivered. The saved reply is visible here.'
        logEmailDeliveryFailure({
          event: 'notification.email_support_reply.failed',
          accountId: req.auth.id,
          error: emailError,
        })
      }
    }
    const [result] = await includeStudentDetails([complaint])
    return res.json({
      complaint: result,
      ...(emailSent !== undefined ? { emailSent } : {}),
      ...(notificationMessage ? { message: notificationMessage } : {}),
    })
  } catch (error) {
    return next(error)
  }
})

router.patch('/admin/:complaintId/status', async (req, res, next) => {
  try {
    if (!requireMainAdmin(req, res)) return
    if (!mongoose.isValidObjectId(req.params.complaintId)) {
      return res.status(400).json({ message: 'Select a valid complaint.' })
    }
    const { status } = req.body ?? {}
    const complaint = await Complaint.findById(req.params.complaintId)
    if (!complaint) return res.status(404).json({ message: 'Complaint not found.' })
    if (
      !complaintStatuses.includes(status) ||
      (complaint.source === 'Email Support' && !emailSupportStatuses.includes(status))
    ) {
      return res.status(400).json({ message: 'Choose Solved or Unsolved.' })
    }

    if (complaint.status !== status) {
      complaint.statusHistory.push({
        from: complaint.status,
        to: status,
        changedBy: new mongoose.Types.ObjectId(req.auth.id),
      })
      complaint.status = status
      await complaint.save()
    }
    const [result] = await includeStudentDetails([complaint])
    return res.json({ complaint: result })
  } catch (error) {
    return next(error)
  }
})

router.get('/mine/:complaintId', async (req, res, next) => {
  try {
    if (!requireStudent(req, res)) return
    if (!mongoose.isValidObjectId(req.params.complaintId)) {
      return res.status(400).json({ message: 'Select a valid complaint.' })
    }
    const complaint = await Complaint.findOne({
      _id: req.params.complaintId,
      userId: new mongoose.Types.ObjectId(req.auth.id),
      userCollection: req.auth.accountCollection,
    }).lean()
    if (!complaint) return res.status(404).json({ message: 'Complaint not found.' })
    return res.json({ complaint })
  } catch (error) {
    return next(error)
  }
})

export default router
