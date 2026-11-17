import crypto from 'node:crypto'
import mongoose from 'mongoose'

function canonicalObjectId(value) {
  if (!value) return ''
  const isBsonObjectId = value instanceof mongoose.Types.ObjectId
    || (value?._bsontype === 'ObjectId' && typeof value.toHexString === 'function')
  if (!isBsonObjectId && (typeof value !== 'string' || !mongoose.isValidObjectId(value))) return ''
  return new mongoose.Types.ObjectId(value).toString()
}

export function getDeterministicObjectId(courseId, type, index) {
  const seed = `${String(courseId || 'course')}:${type}:${index}`
  const hash = crypto.createHash('md5').update(seed).digest('hex').slice(0, 24)
  return new mongoose.Types.ObjectId(hash)
}

export function findSequencedQuiz(course, quizId) {
  const targetId = canonicalObjectId(quizId)
  if (!targetId || !course) return null
  const sequence = buildCourseActivitySequence(course)
  const item = sequence.find(
    (act) => act.type === 'quiz' && (canonicalObjectId(act.quizId) === targetId || canonicalObjectId(act.id) === targetId),
  )
  return item?.quiz || item || null
}

export function findSequencedAssessment(course, assignmentId) {
  const targetId = canonicalObjectId(assignmentId)
  if (!targetId || !course) return null
  const sequence = buildCourseActivitySequence(course)
  const item = sequence.find(
    (act) => act.type === 'assessment' && (canonicalObjectId(act.assignmentId) === targetId || canonicalObjectId(act.id) === targetId),
  )
  return item?.assignment || item || null
}


/**
 * Extracts all video lessons from a course in order.
 */
export function getCourseAllLessons(course) {
  const allLessons = []
  for (const module of course?.modules || []) {
    const videoItems = module.contentItems?.filter((item) => item.type === 'video-lesson') || []
    const lessons = videoItems.length ? videoItems : module.lessons || []
    for (const lesson of lessons) {
      allLessons.push({
        module,
        moduleId: module._id,
        moduleTitle: module.title || 'Course Module',
        lesson,
        lessonId: lesson._id,
        title: lesson.title,
        durationSeconds: lesson.durationSeconds || 0,
        videoUrl: lesson.videoUrl,
      })
    }
  }
  return allLessons
}

/**
 * Extracts all quizzes defined directly in the course.
 */
export function getAllCourseQuizzes(course) {
  const quizzes = []
  const seenIds = new Set()

  for (const module of course?.modules || []) {
    for (const item of module.contentItems || []) {
      if (item.type === 'quiz' && item.quiz) {
        const id = canonicalObjectId(item.quiz._id || item._id)
        if (id && !seenIds.has(id)) {
          seenIds.add(id)
          quizzes.push({
            ...item.quiz,
            _id: item.quiz._id || item._id,
            title: item.quiz.title || item.title || 'Module Quiz',
            moduleId: module._id,
            moduleTitle: module.title,
          })
        }
      }
    }
    if (module.quiz && module.quiz.questions?.length) {
      const id = canonicalObjectId(module.quiz._id)
      if (id && !seenIds.has(id)) {
        seenIds.add(id)
        quizzes.push({
          ...module.quiz,
          _id: module.quiz._id,
          title: module.quiz.title || `${module.title || 'Module'} Quiz`,
          moduleId: module._id,
          moduleTitle: module.title,
        })
      }
    }
  }

  for (const quiz of course?.quizzes || []) {
    const id = canonicalObjectId(quiz._id)
    if (id && !seenIds.has(id)) {
      seenIds.add(id)
      quizzes.push({
        ...quiz,
        _id: quiz._id,
        title: quiz.title || 'Course Quiz',
        moduleId: null,
      })
    }
  }

  return quizzes
}

/**
 * Extracts all assignments/assessments defined directly in the course.
 */
export function getAllCourseAssessments(course) {
  const assessments = []
  const seenIds = new Set()

  for (const module of course?.modules || []) {
    for (const item of module.contentItems || []) {
      if (item.type === 'assignment') {
        const id = canonicalObjectId(item._id)
        if (id && !seenIds.has(id)) {
          seenIds.add(id)
          assessments.push({
            ...item,
            _id: item._id,
            title: item.title || 'Module Assignment',
            moduleId: module._id,
            moduleTitle: module.title,
          })
        }
      }
    }
  }

  for (const assignment of course?.assignments || []) {
    const id = canonicalObjectId(assignment._id)
    if (id && !seenIds.has(id)) {
      seenIds.add(id)
      assessments.push({
        ...assignment,
        _id: assignment._id,
        title: assignment.title || 'Course Assessment',
        moduleId: null,
      })
    }
  }

  return assessments
}

function createDefaultQuiz(course, quizIndex, precedingVideos = []) {
  const quizId = getDeterministicObjectId(course?._id, 'quiz', quizIndex)
  const videoTitles = precedingVideos.map((v) => v.title).filter(Boolean)
  const topicLabel = videoTitles.length ? videoTitles.join(' & ') : `Lessons ${quizIndex * 2 - 1}-${quizIndex * 2}`

  const q1Id = getDeterministicObjectId(course?._id, `quiz-${quizIndex}-q`, 1)
  const q2Id = getDeterministicObjectId(course?._id, `quiz-${quizIndex}-q`, 2)

  return {
    _id: quizId,
    title: `Quiz ${quizIndex}: Review of ${topicLabel}`,
    passingPercentage: 70,
    maxAttempts: 3,
    timeLimitMinutes: 10,
    questions: [
      {
        _id: q1Id,
        prompt: `Key Concept Review for ${topicLabel}: What is the primary focus of this learning checkpoint?`,
        type: 'multiple-choice',
        options: [
          'Mastering and verifying core principles taught in preceding lessons',
          'Skipping video practice and proceeding without comprehension',
          'Storing unverified assumptions without evaluation',
          'Disregarding practical exercises and code examples',
        ],
        correctOptionIndices: [0],
        correctOptionIndex: 0,
        marks: 1,
        explanation: 'Reviewing key concepts is required before proceeding to subsequent topics.',
      },
      {
        _id: q2Id,
        prompt: 'Practical Application Check: Which method best reinforces learning retention and technical competence?',
        type: 'multiple-choice',
        options: [
          'Consistent active practice and self-assessment',
          'Passive observation without implementation',
          'Memorizing answers without understanding mechanisms',
          'Delaying all practice until the final exam',
        ],
        correctOptionIndices: [0],
        correctOptionIndex: 0,
        marks: 1,
        explanation: 'Hands-on practice and regular assessment solidify technical learning.',
      },
    ],
  }
}

function createDefaultAssessment(course, assessmentIndex, videoCheckpoint) {
  const assessmentId = getDeterministicObjectId(course?._id, 'assessment', assessmentIndex)
  return {
    _id: assessmentId,
    title: `Assessment ${assessmentIndex}: Practical Milestone Project`,
    description: `Complete and submit the hands-on milestone assessment covering lessons up to video ${videoCheckpoint}. Submit a PDF, DOCX, or TXT file documenting your solution and implementation.`,
    points: 100,
    passingCriteria: 'Submit a valid milestone project document (PDF, DOCX, or TXT) demonstrating understanding and completion of required exercises.',
    dueDate: null,
  }
}

/**
 * Builds the complete sequenced activity curriculum according to the required rules:
 * - Every 2 video lessons must be followed by one quiz.
 * - Every 4 video lessons must be followed by one assessment.
 * - Order strictly follows the lessons in the course.
 */
export function buildCourseActivitySequence(course) {
  const allLessons = getCourseAllLessons(course)
  const existingQuizzes = getAllCourseQuizzes(course)
  const existingAssessments = getAllCourseAssessments(course)

  const totalVideos = allLessons.length
  const shouldSequenceAssessments = totalVideos >= 4 || existingQuizzes.length > 0 || existingAssessments.length > 0

  const sequence = []
  let videoCount = 0
  let quizIndex = 0
  let assessmentIndex = 0

  for (const video of allLessons) {
    videoCount++
    sequence.push({
      sequenceIndex: sequence.length + 1,
      sequenceNumber: sequence.length + 1,
      type: 'video-lesson',
      id: String(video.lessonId),
      lessonId: video.lessonId,
      moduleId: video.moduleId,
      moduleTitle: video.moduleTitle,
      title: video.title,
      durationSeconds: video.durationSeconds,
      videoUrl: video.videoUrl,
      videoNumber: videoCount,
      lesson: video.lesson,
    })

    if (shouldSequenceAssessments) {
      // After every 2 video lessons: 1 Quiz
      if (videoCount % 2 === 0) {
        quizIndex++
        const preceding = [allLessons[videoCount - 2], allLessons[videoCount - 1]].filter(Boolean)
        const existing = existingQuizzes[quizIndex - 1]
        const quizObj = existing ? {
          ...existing,
          title: existing.title || `Quiz ${quizIndex}`,
        } : createDefaultQuiz(course, quizIndex, preceding)

        sequence.push({
          sequenceIndex: sequence.length + 1,
          sequenceNumber: sequence.length + 1,
          type: 'quiz',
          id: String(quizObj._id),
          quizId: quizObj._id,
          moduleId: quizObj.moduleId || video.moduleId,
          moduleTitle: quizObj.moduleTitle || video.moduleTitle,
          title: quizObj.title,
          passingPercentage: Number(quizObj.passingPercentage) || 70,
          maxAttempts: Number(quizObj.maxAttempts) || 3,
          timeLimitMinutes: Number(quizObj.timeLimitMinutes) || 0,
          questions: quizObj.questions || [],
          quizIndex,
          quiz: quizObj,
        })
      }

      // After every 4 video lessons: 1 Assessment
      if (videoCount % 4 === 0) {
        assessmentIndex++
        const existing = existingAssessments[assessmentIndex - 1]
        const assessmentObj = existing ? {
          ...existing,
          title: existing.title || `Assessment ${assessmentIndex}`,
        } : createDefaultAssessment(course, assessmentIndex, videoCount)

        sequence.push({
          sequenceIndex: sequence.length + 1,
          sequenceNumber: sequence.length + 1,
          type: 'assessment',
          id: String(assessmentObj._id),
          assignmentId: assessmentObj._id,
          moduleId: assessmentObj.moduleId || video.moduleId,
          moduleTitle: assessmentObj.moduleTitle || video.moduleTitle,
          title: assessmentObj.title,
          description: assessmentObj.description,
          points: Number(assessmentObj.points) || 100,
          passingCriteria: assessmentObj.passingCriteria || 'Successful milestone submission required',
          dueDate: assessmentObj.dueDate,
          assessmentIndex,
          assignment: assessmentObj,
        })
      }
    }
  }

  // Any remaining explicit course quizzes not assigned by modulo
  while (quizIndex < existingQuizzes.length) {
    const quizObj = existingQuizzes[quizIndex]
    quizIndex++
    sequence.push({
      sequenceIndex: sequence.length + 1,
      sequenceNumber: sequence.length + 1,
      type: 'quiz',
      id: String(quizObj._id),
      quizId: quizObj._id,
      moduleId: quizObj.moduleId,
      title: quizObj.title || `Quiz ${quizIndex}`,
      passingPercentage: Number(quizObj.passingPercentage) || 70,
      maxAttempts: Number(quizObj.maxAttempts) || 3,
      timeLimitMinutes: Number(quizObj.timeLimitMinutes) || 0,
      questions: quizObj.questions || [],
      quizIndex,
      quiz: quizObj,
    })
  }

  // Any remaining explicit course assessments not assigned by modulo
  while (assessmentIndex < existingAssessments.length) {
    const assessmentObj = existingAssessments[assessmentIndex]
    assessmentIndex++
    sequence.push({
      sequenceIndex: sequence.length + 1,
      sequenceNumber: sequence.length + 1,
      type: 'assessment',
      id: String(assessmentObj._id),
      assignmentId: assessmentObj._id,
      moduleId: assessmentObj.moduleId,
      title: assessmentObj.title || `Assessment ${assessmentIndex}`,
      description: assessmentObj.description,
      points: Number(assessmentObj.points) || 100,
      dueDate: assessmentObj.dueDate,
      assessmentIndex,
      assignment: assessmentObj,
    })
  }

  return sequence
}

/**
 * Calculates unified course progress and completion status.
 */
export function calculateCourseProgress({
  course,
  enrollment,
  progress,
  quizAttempts = [],
  assignmentSubmissions = [],
}) {
  const sequence = buildCourseActivitySequence(course)

  // 1. Video completions
  const completedLessonIds = new Set([
    ...(enrollment?.completedLessonIds || []).map(String),
    ...(progress?.completedLessons || []).map((cl) => String(cl.lessonId)).filter(Boolean),
  ])

  // 2. Quiz attempts & pass/fail
  const passedQuizIds = new Set()
  const attemptedQuizIds = new Set()
  const failedQuizIds = new Set()

  for (const attempt of quizAttempts) {
    if (!attempt?.quizId) continue
    const qid = String(attempt.quizId)
    attemptedQuizIds.add(qid)
    if (attempt.status === 'submitted') {
      if (attempt.passed === true) {
        passedQuizIds.add(qid)
      }
    }
  }

  for (const qs of progress?.quizSubmissions || []) {
    if (!qs?.quizId) continue
    const qid = String(qs.quizId)
    attemptedQuizIds.add(qid)
    if (qs.passed === true) {
      passedQuizIds.add(qid)
    }
  }

  for (const qid of attemptedQuizIds) {
    if (!passedQuizIds.has(qid)) {
      failedQuizIds.add(qid)
    }
  }

  // 3. Assessment submissions
  const completedAssessmentIds = new Set()
  for (const sub of assignmentSubmissions) {
    if (sub?.assignmentId) {
      completedAssessmentIds.add(String(sub.assignmentId))
    }
  }

  // Split sequence by activity type
  const videoActivities = sequence.filter((item) => item.type === 'video-lesson')
  const quizActivities = sequence.filter((item) => item.type === 'quiz')
  const assessmentActivities = sequence.filter((item) => item.type === 'assessment')

  const totalVideos = videoActivities.length
  const completedVideos = videoActivities.filter((item) => completedLessonIds.has(String(item.id))).length

  const totalQuizzes = quizActivities.length
  const passedQuizzes = quizActivities.filter((item) => passedQuizIds.has(String(item.id))).length

  const totalAssessments = assessmentActivities.length
  const completedAssessments = assessmentActivities.filter((item) => completedAssessmentIds.has(String(item.id))).length

  const totalRequiredActivities = totalVideos + totalQuizzes + totalAssessments
  const completedActivities = completedVideos + passedQuizzes + completedAssessments

  const progressPercentage = totalRequiredActivities > 0
    ? Math.min(100, Math.round((completedActivities / totalRequiredActivities) * 100))
    : 0

  // Strict completion condition:
  // Course is completed ONLY when:
  // 1. Every required video is completed
  // 2. Every required quiz is passed
  // 3. Every required assessment is passed/completed
  const isAllVideosCompleted = totalVideos > 0 && completedVideos >= totalVideos
  const isAllQuizzesPassed = totalQuizzes === 0 || passedQuizzes >= totalQuizzes
  const isAllAssessmentsCompleted = totalAssessments === 0 || completedAssessments >= totalAssessments

  const isCompleted = totalRequiredActivities > 0
    && isAllVideosCompleted
    && isAllQuizzesPassed
    && isAllAssessmentsCompleted

  const status = isCompleted ? 'completed' : (completedActivities > 0 ? 'active' : (enrollment?.status || 'active'))

  let nextActivity = null
  const annotatedSequence = sequence.map((item) => {
    let itemCompleted = false
    let itemFailed = false
    let itemSubmitted = false

    if (item.type === 'video-lesson') {
      itemCompleted = completedLessonIds.has(String(item.id))
    } else if (item.type === 'quiz') {
      itemCompleted = passedQuizIds.has(String(item.id))
      itemFailed = failedQuizIds.has(String(item.id)) && !itemCompleted
      itemSubmitted = attemptedQuizIds.has(String(item.id))
    } else if (item.type === 'assessment') {
      itemCompleted = completedAssessmentIds.has(String(item.id))
      itemSubmitted = itemCompleted
    }

    if (!itemCompleted && !nextActivity) {
      nextActivity = {
        ...item,
        isCompleted: false,
        isFailed: itemFailed,
      }
    }

    return {
      ...item,
      isCompleted: itemCompleted,
      isFailed: itemFailed,
      isSubmitted: itemSubmitted,
    }
  })

  return {
    progressPercentage,
    totalRequiredActivities,
    completedActivities,
    isCompleted,
    status,
    videoStats: {
      completed: completedVideos,
      total: totalVideos,
      isCompleted: isAllVideosCompleted,
    },
    quizStats: {
      passed: passedQuizzes,
      total: totalQuizzes,
      isCompleted: isAllQuizzesPassed,
    },
    assessmentStats: {
      completed: completedAssessments,
      total: totalAssessments,
      isCompleted: isAllAssessmentsCompleted,
    },
    nextActivity,
    sequence: annotatedSequence,
  }
}
