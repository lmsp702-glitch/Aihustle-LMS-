import assert from 'node:assert/strict'
import test from 'node:test'
import { buildCollegeUsernameSyncPlan } from '../scripts/sync-college-student-usernames.js'

test('college username synchronization derives usernames from Student IDs and leaves synced accounts alone', () => {
  const plan = buildCollegeUsernameSyncPlan(
    [
      { _id: 'student-1', studentId: ' CS-100 ', username: 'legacy-name' },
      { _id: 'student-2', studentId: 'CS-101', username: 'cs-101' },
    ],
    [
      { _id: 'identity-1', accountCollection: 'clg_students', accountId: 'student-1', username: 'legacy-name' },
      { _id: 'identity-2', accountCollection: 'clg_students', accountId: 'student-2', username: 'cs-101' },
    ],
    [
      { _id: 'student-2', collection: 'clg_students', username: 'cs-101' },
    ],
  )

  assert.deepEqual(plan.map(({ status, targetUsername }) => ({ status, targetUsername })), [
    { status: 'update', targetUsername: 'cs-100' },
    { status: 'unchanged', targetUsername: 'cs-101' },
  ])
})

test('college username synchronization skips duplicate IDs, username collisions, and accounts without identities', () => {
  const plan = buildCollegeUsernameSyncPlan(
    [
      { _id: 'student-1', studentId: 'CS-100', username: 'legacy-1' },
      { _id: 'student-2', studentId: 'cs-100', username: 'legacy-2' },
      { _id: 'student-3', studentId: 'taken-name', username: 'legacy-3' },
      { _id: 'student-4', studentId: 'CS-404', username: 'legacy-4' },
    ],
    [
      { _id: 'identity-1', accountCollection: 'clg_students', accountId: 'student-1', username: 'legacy-1' },
      { _id: 'identity-2', accountCollection: 'clg_students', accountId: 'student-2', username: 'legacy-2' },
      { _id: 'identity-3', accountCollection: 'clg_students', accountId: 'student-3', username: 'legacy-3' },
    ],
    [
      { _id: 'admin-1', collection: 'admin', username: 'taken-name' },
    ],
  )

  assert.deepEqual(plan.map(({ status, reason }) => ({ status, reason })), [
    { status: 'conflict', reason: 'duplicate_student_id' },
    { status: 'conflict', reason: 'duplicate_student_id' },
    { status: 'conflict', reason: 'username_already_in_use' },
    { status: 'conflict', reason: 'missing_or_duplicate_identity' },
  ])
})
