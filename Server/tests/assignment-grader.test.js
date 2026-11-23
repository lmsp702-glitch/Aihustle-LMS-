import assert from 'node:assert/strict'
import { deflateRawSync } from 'node:zlib'
import { test } from 'node:test'
import { normalizeCourseDetails } from '../utils/course-validation.js'
import {
  GEMINI_ASSIGNMENT_MODEL,
  GeminiGradingError,
  gradeAssignmentSubmission,
  validateAssignmentEvaluation,
} from '../utils/assignment-grader.js'

const rubric = [
  { name: 'Technical accuracy', description: 'Correctly explain the method.', maximumMarks: 6 },
  { name: 'Application', description: 'Apply the method to an example.', maximumMarks: 4 },
]
const validEvaluation = {
  readable: true,
  totalMarks: 8,
  maximumMarks: 10,
  criteria: [
    { name: 'Technical accuracy', marks: 5, maximumMarks: 6, feedback: 'The method is mostly correct.' },
    { name: 'Application', marks: 3, maximumMarks: 4, feedback: 'The example is relevant.' },
  ],
  strengths: ['The explanation is focused.'],
  improvements: ['Show more intermediate steps.'],
  overallFeedback: 'A clear response with room for more detail.',
}

function responseWithEvaluation(evaluation = validEvaluation, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify({
      candidates: [{ content: { parts: [{ text: JSON.stringify(evaluation) }] } }],
    }),
  }
}

function responseWithProviderError(status, error, retryAfter = null) {
  return {
    ok: false,
    status,
    headers: { get: (name) => name.toLowerCase() === 'retry-after' ? retryAfter : null },
    text: async () => JSON.stringify({ error }),
  }
}

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let index = 0; index < 8; index += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function makeDocx(entries) {
  const localFiles = []
  const centralFiles = []
  let offset = 0
  for (const { name, content } of entries) {
    const fileName = Buffer.from(name)
    const source = Buffer.from(content)
    const compressed = deflateRawSync(source)
    const checksum = crc32(source)
    const localHeader = Buffer.alloc(30)
    localHeader.writeUInt32LE(0x04034b50, 0)
    localHeader.writeUInt16LE(20, 4)
    localHeader.writeUInt16LE(8, 8)
    localHeader.writeUInt32LE(checksum, 14)
    localHeader.writeUInt32LE(compressed.length, 18)
    localHeader.writeUInt32LE(source.length, 22)
    localHeader.writeUInt16LE(fileName.length, 26)
    localFiles.push(localHeader, fileName, compressed)

    const centralHeader = Buffer.alloc(46)
    centralHeader.writeUInt32LE(0x02014b50, 0)
    centralHeader.writeUInt16LE(20, 4)
    centralHeader.writeUInt16LE(20, 6)
    centralHeader.writeUInt16LE(8, 10)
    centralHeader.writeUInt32LE(checksum, 16)
    centralHeader.writeUInt32LE(compressed.length, 20)
    centralHeader.writeUInt32LE(source.length, 24)
    centralHeader.writeUInt16LE(fileName.length, 28)
    centralHeader.writeUInt32LE(offset, 42)
    centralFiles.push(centralHeader, fileName)
    offset += localHeader.length + fileName.length + compressed.length
  }
  const centralDirectory = Buffer.concat(centralFiles)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralDirectory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...localFiles, centralDirectory, end])
}

test('Gemini receives rubric-aware PDF grading input and returns validated marks', async () => {
  let request
  const evaluation = await gradeAssignmentSubmission({
    assignment: { title: 'Explain a sorting algorithm', description: 'Compare the method with an example.', points: 10, rubric },
    courseTitle: 'Algorithms',
    fileData: Buffer.from('%PDF-1.7 safe sample'),
    contentType: 'application/pdf',
  }, {
    apiKey: 'test-only-key',
    fetchImpl: async (url, options) => {
      request = { url, options, body: JSON.parse(options.body) }
      return responseWithEvaluation()
    },
  })

  assert.match(request.url, /generativelanguage\.googleapis\.com/)
  assert.match(request.url, new RegExp(GEMINI_ASSIGNMENT_MODEL))
  assert.equal(request.options.headers['x-goog-api-key'], 'test-only-key')
  assert.equal(request.body.contents[0].parts[1].inlineData.mimeType, 'application/pdf')
  assert.match(request.body.contents[0].parts[0].text, /Compare the method with an example/)
  assert.match(request.body.contents[0].parts[0].text, /Technical accuracy/)
  assert.equal(evaluation.totalMarks, 8)
  assert.equal(evaluation.criteria.length, 2)
})

test('DOCX text is extracted before it is sent to Gemini', async () => {
  const fileData = makeDocx([
    {
      name: '[Content_Types].xml',
      content: '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>',
    },
    {
      name: 'word/document.xml',
      content: '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Safe sample DOCX answer</w:t></w:r></w:p></w:body></w:document>',
    },
  ])
  let sentContents
  await gradeAssignmentSubmission({
    assignment: { title: 'A test assignment', description: 'Answer the prompt.', points: 10, rubric },
    fileData,
    contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  }, {
    apiKey: 'test-only-key',
    fetchImpl: async (_url, options) => {
      sentContents = JSON.parse(options.body).contents
      return responseWithEvaluation()
    },
  })
  assert.match(sentContents[0].parts[1].text, /Safe sample DOCX answer/)
})

test('image submissions are forwarded as Gemini inline image data', async () => {
  let contents
  await gradeAssignmentSubmission({
    assignment: { title: 'Read this diagram', description: 'Explain the diagram.', points: 10 },
    fileData: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    contentType: 'image/png',
  }, {
    apiKey: 'test-only-key',
    fetchImpl: async (_url, options) => {
      contents = JSON.parse(options.body).contents
      return responseWithEvaluation({
        ...validEvaluation,
        criteria: [{ name: 'Diagram explanation', marks: 8, maximumMarks: 10, feedback: 'The explanation is mostly accurate.' }],
      })
    },
  })
  assert.equal(contents[0].parts[1].inlineData.mimeType, 'image/png')
})

test('AI evaluation rejects marks, totals, and rubric criteria that do not validate', () => {
  assert.throws(
    () => validateAssignmentEvaluation({ ...validEvaluation, totalMarks: 11 }, 10, rubric),
    /invalid assignment marks or feedback/,
  )
  assert.throws(
    () => validateAssignmentEvaluation({
      ...validEvaluation,
      criteria: validEvaluation.criteria.map((criterion, index) => (
        index === 1 ? { ...criterion, marks: 2 } : criterion
      )),
    }, 10, rubric),
    /criterion marks that do not match/,
  )
  assert.throws(
    () => validateAssignmentEvaluation({
      ...validEvaluation,
      criteria: validEvaluation.criteria.map((criterion, index) => (
        index === 0 ? { ...criterion, name: 'Unrequested criterion' } : criterion
      )),
    }, 10, rubric),
    /instructor marking rubric/,
  )
})

test('Gemini failures and unreadable text do not produce evaluation marks', async () => {
  await assert.rejects(
    gradeAssignmentSubmission({
      assignment: { title: 'Task', points: 10, rubric },
      fileData: Buffer.from('safe'),
      contentType: 'text/plain',
    }, {
      apiKey: 'test-only-key',
      fetchImpl: async () => responseWithEvaluation({}, 503),
    }),
    /Gemini assignment grading failed/,
  )
  await assert.rejects(
    gradeAssignmentSubmission({
      assignment: { title: 'Task', points: 10, rubric },
      fileData: Buffer.from([0xff, 0xfe]),
      contentType: 'text/plain',
    }, { apiKey: 'test-only-key', fetchImpl: async () => responseWithEvaluation() }),
    (error) => error instanceof GeminiGradingError && error.category === 'file_processing',
  )
})

test('transient provider failures retry with bounded backoff and retain the HTTP status', async () => {
  let calls = 0
  const diagnostics = []
  const originalInfo = console.info
  let evaluation
  console.info = (entry) => { diagnostics.push(JSON.parse(entry)) }
  try {
    evaluation = await gradeAssignmentSubmission({
      assignment: { title: 'Task', points: 10, rubric },
      fileData: Buffer.from('safe test answer'),
      contentType: 'text/plain',
    }, {
      apiKey: 'test-only-key',
      fetchImpl: async () => {
        calls += 1
        return calls === 1
          ? responseWithProviderError(503, { status: 'UNAVAILABLE', message: 'Temporary provider failure.' })
          : responseWithEvaluation()
      },
    })
  } finally {
    console.info = originalInfo
  }

  assert.equal(calls, 2)
  assert.equal(evaluation.totalMarks, 8)
  assert.deepEqual(diagnostics.map(({ event, category, httpStatus }) => [event, category, httpStatus]), [
    ['gemini.assignment.initial_request', 'provider_unavailable', 503],
    ['gemini.assignment.initial_request', 'http_success', 200],
    ['gemini.assignment.initial_success', 'evaluation_validated', 200],
  ])
  assert.equal(new Set(diagnostics.map(({ traceId }) => traceId)).size, 1)
  assert.equal(JSON.stringify(diagnostics).includes('test-only-key'), false)
  assert.deepEqual(Object.keys(diagnostics[0]).sort(), [
    'attempt',
    'category',
    'event',
    'httpStatus',
    'providerCode',
    'traceId',
  ])
})

test('Gemini authentication, model, quota and rate-limit failures are classified safely', async () => {
  const input = {
    assignment: { title: 'Task', points: 10, rubric },
    fileData: Buffer.from('safe test answer'),
    contentType: 'text/plain',
  }
  for (const [status, error, expectedCategory] of [
    [401, { status: 'UNAUTHENTICATED', message: 'Invalid key.' }, 'authentication'],
    [403, { status: 'PERMISSION_DENIED', message: 'Permission denied.' }, 'permission_denied'],
    [404, { status: 'NOT_FOUND', message: 'Model not found.' }, 'model_unavailable'],
    [429, { status: 'RESOURCE_EXHAUSTED', message: 'Daily quota exceeded.', details: [{ quotaId: 'requests_per_day' }] }, 'daily_quota_exceeded'],
    [429, { status: 'RESOURCE_EXHAUSTED', message: 'Requests per minute limit exceeded.' }, 'rate_limited'],
  ]) {
    let calls = 0
    await assert.rejects(
      gradeAssignmentSubmission(input, {
        apiKey: 'test-only-key',
        fetchImpl: async () => {
          calls += 1
          return responseWithProviderError(status, error)
        },
      }),
      (failure) => {
        assert.ok(failure instanceof GeminiGradingError)
        assert.equal(failure.category, expectedCategory)
        assert.equal(failure.httpStatus, status)
        assert.equal(failure.attempts, expectedCategory === 'rate_limited' ? 3 : 1)
        assert.equal(failure.message.includes('test-only-key'), false)
        return true
      },
    )
    assert.equal(calls, expectedCategory === 'rate_limited' ? 3 : 1)
  }
})

test('a timeout is retried once without changing the saved submission input', async () => {
  let calls = 0
  await gradeAssignmentSubmission({
    assignment: { title: 'Task', points: 10, rubric },
    fileData: Buffer.from('safe test answer'),
    contentType: 'text/plain',
  }, {
    apiKey: 'test-only-key',
    fetchImpl: async () => {
      calls += 1
      if (calls === 1) {
        const error = new Error('Abort')
        error.name = 'AbortError'
        throw error
      }
      return responseWithEvaluation()
    },
  })
  assert.equal(calls, 2)
})

test('course validation requires instructor rubric marks to match assignment points', () => {
  const valid = normalizeCourseDetails({
    title: 'Rubric course',
    modules: [{
      title: 'Module',
      contentItems: [{
        type: 'assignment',
        title: 'Assignment',
        points: 10,
        rubric,
      }],
    }],
  })
  assert.equal(valid.error, undefined)
  assert.equal(valid.value.modules[0].contentItems[0].rubric[0].name, 'Technical accuracy')

  const invalid = normalizeCourseDetails({
    title: 'Invalid rubric course',
    modules: [{
      title: 'Module',
      contentItems: [{
        type: 'assignment',
        title: 'Assignment',
        points: 10,
        rubric: [{ name: 'Technical accuracy', maximumMarks: 9 }],
      }],
    }],
  })
  assert.match(invalid.error, /must add up/i)
})
