import { Router } from 'express'
import mongoose from 'mongoose'
import Feedback from '../models/Feedback.js'
import { CollegeStudent, Student } from '../models/account-models.js'
import { authenticate } from '../middleware/auth.js'

const router = Router()
const studentCollections = new Set(['students', 'clg_students'])

router.use(authenticate)

function isValidText(value, minLength, maxLength) {
  return typeof value === 'string' && value.trim().length >= minLength && value.trim().length <= maxLength
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

function serializeFeedback(feedback, student) {
  const record = feedback.toObject ? feedback.toObject() : { ...feedback }
  return {
    ...record,
    requester: {
      id: String(record.userId),
      studentId: student?.studentId || String(record.userId),
      fullName: student?.fullName || 'Student',
      email: student?.email || 'Email unavailable',
    },
  }
}

async function includeStudentDetails(feedbackRecords) {
  const independentIds = feedbackRecords
    .filter((record) => record.userCollection === 'students')
    .map((record) => record.userId)
  const collegeIds = feedbackRecords
    .filter((record) => record.userCollection === 'clg_students')
    .map((record) => record.userId)
  const [independentStudents, collegeStudents] = await Promise.all([
    Student.find({ _id: { $in: independentIds } }).select('fullName email studentId').lean(),
    CollegeStudent.find({ _id: { $in: collegeIds } }).select('fullName email studentId').lean(),
  ])
  const studentsById = new Map(
    [...independentStudents, ...collegeStudents].map((student) => [String(student._id), student]),
  )
  return feedbackRecords.map((record) => serializeFeedback(record, studentsById.get(String(record.userId))))
}

router.post('/', async (req, res, next) => {
  try {
    if (!requireStudent(req, res)) return
    if (!isValidText(req.body?.message, 1, 5000)) {
      return res.status(400).json({ message: 'Enter feedback of no more than 5,000 characters.' })
    }

    const feedback = await Feedback.create({
      userId: new mongoose.Types.ObjectId(req.auth.id),
      userCollection: req.auth.accountCollection,
      message: req.body.message.trim(),
    })
    return res.status(201).json({ feedback: serializeFeedback(feedback, req.auth.user) })
  } catch (error) {
    return next(error)
  }
})

router.get('/mine', async (req, res, next) => {
  try {
    if (!requireStudent(req, res)) return
    const feedback = await Feedback.find({
      userId: new mongoose.Types.ObjectId(req.auth.id),
      userCollection: req.auth.accountCollection,
    }).sort({ createdAt: -1 }).lean()
    return res.json({ feedback })
  } catch (error) {
    return next(error)
  }
})

router.get('/admin', async (req, res, next) => {
  try {
    if (!requireMainAdmin(req, res)) return
    const feedback = await Feedback.find({}).sort({ createdAt: -1 }).lean()
    return res.json({ feedback: await includeStudentDetails(feedback) })
  } catch (error) {
    return next(error)
  }
})

router.post('/admin/:feedbackId/replies', async (req, res, next) => {
  try {
    if (!requireMainAdmin(req, res)) return
    if (!mongoose.isValidObjectId(req.params.feedbackId)) {
      return res.status(400).json({ message: 'Select valid feedback.' })
    }
    if (!isValidText(req.body?.message, 1, 5000)) {
      return res.status(400).json({ message: 'Enter a reply of no more than 5,000 characters.' })
    }
    const feedback = await Feedback.findById(req.params.feedbackId)
    if (!feedback) return res.status(404).json({ message: 'Feedback not found.' })

    feedback.replies.push({
      authorId: new mongoose.Types.ObjectId(req.auth.id),
      authorRole: 'main_admin',
      message: req.body.message.trim(),
    })
    await feedback.save()
    const [result] = await includeStudentDetails([feedback])
    return res.json({ feedback: result })
  } catch (error) {
    return next(error)
  }
})

export default router
