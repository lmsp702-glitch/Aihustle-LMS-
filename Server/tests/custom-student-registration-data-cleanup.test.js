import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildCleanupFilter,
  buildCleanupUpdate,
  removedRegistrationFieldPaths,
} from '../scripts/remove-custom-student-registration-details.js'

test('student data cleanup targets only custom qualification and living arrangement fields', () => {
  const expectedNames = [
    'customQualification',
    'custom_qualification',
    'otherQualification',
    'qualificationOther',
    'customLivingArrangement',
    'custom_living_arrangement',
    'otherLivingArrangement',
  ]
  const expectedPaths = [
    ...expectedNames,
    ...expectedNames.map((field) => `registrationDetails.${field}`),
  ]

  assert.deepEqual(removedRegistrationFieldPaths, expectedPaths)
  assert.deepEqual(Object.keys(buildCleanupUpdate().$unset), expectedPaths)
  assert.deepEqual(
    buildCleanupFilter().$or.map((condition) => Object.keys(condition)[0]),
    expectedPaths,
  )
})
