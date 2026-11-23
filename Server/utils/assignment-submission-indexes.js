const perAttemptIdentityFields = new Set([
  'userId',
  'enrollmentId',
  'courseId',
  'assignmentId',
  'attemptNumber',
])

function isLegacySingleSubmissionIndex(index) {
  if (!index?.unique || !index.name || !index.key || index.name === '_id_') return false
  const fields = Object.keys(index.key)
  return fields.includes('assignmentId')
    && fields.some((field) => field === 'userId' || field === 'enrollmentId')
    && fields.every((field) => perAttemptIdentityFields.has(field))
}

export async function removeLegacyUniqueAssignmentSubmissionIndexes(collection) {
  const indexes = await collection.indexes()
  const removedIndexes = []

  for (const index of indexes) {
    if (!isLegacySingleSubmissionIndex(index)) continue
    try {
      await collection.dropIndex(index.name)
      removedIndexes.push(index.name)
    } catch (error) {
      if (error?.code !== 27) throw error
    }
  }

  return removedIndexes
}
