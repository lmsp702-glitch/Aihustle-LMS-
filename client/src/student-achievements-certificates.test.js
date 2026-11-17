import assert from 'node:assert/strict'
import { test } from 'node:test'

function formatCertificateFilename(courseName, certificateId) {
  const title = courseName || 'Certificate'
  const slug = title
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug ? `aiHustle-${slug}-Certificate.pdf` : `aiHustle-certificate-${certificateId}.pdf`
}

function resolveAchievementCertificate(entry, certificatesByCourse) {
  const courseId = String(entry.courseId?._id || entry.courseId || '')
  return certificatesByCourse.get(courseId) || entry.certificate || null
}

function getAchievementActionState(certificate, activeAction) {
  if (!certificate) {
    return {
      hasCertificate: false,
      unavailableLabel: 'Certificate unavailable',
    }
  }

  const certKey = certificate.id || certificate._id || certificate.certificateId
  const isPreviewing = Boolean(certKey && activeAction?.id === certKey && activeAction?.type === 'preview')
  const isDownloading = Boolean(certKey && activeAction?.id === certKey && activeAction?.type === 'download')
  const isBusy = Boolean(certKey && activeAction?.id === certKey)

  return {
    hasCertificate: true,
    certKey,
    isPreviewing,
    isDownloading,
    isBusy,
    previewButtonText: isPreviewing ? 'Opening…' : 'Preview Certificate',
    downloadButtonText: isDownloading ? 'Downloading…' : 'Download Certificate',
  }
}

test('Achievement Certificates Client Logic Suite', async (t) => {
  await t.test('formatCertificateFilename generates clean professional filename from course title', () => {
    assert.equal(
      formatCertificateFilename('Digital Marketing Fundamentals', 'AIH-2026-ABCDEF123456'),
      'aiHustle-Digital-Marketing-Fundamentals-Certificate.pdf',
    )
    assert.equal(
      formatCertificateFilename('Web Development & Cloud Computing 101!', 'AIH-2026-ABCDEF123456'),
      'aiHustle-Web-Development-Cloud-Computing-101-Certificate.pdf',
    )
    assert.equal(
      formatCertificateFilename('', 'AIH-2026-ABCDEF123456'),
      'aiHustle-Certificate-Certificate.pdf',
    )
  })

  await t.test('resolveAchievementCertificate retrieves certificate from map or entry', () => {
    const courseId = '6af41d144ad96cf02e2b769b'
    const mockCert = { id: 'cert-1', certificateId: 'AIH-2026-001', courseName: 'Marketing' }
    const certMap = new Map([[courseId, mockCert]])

    // Case 1: populated from map
    const entry1 = { _id: 'e1', courseId: { _id: courseId, title: 'Marketing' }, status: 'completed' }
    assert.deepEqual(resolveAchievementCertificate(entry1, certMap), mockCert)

    // Case 2: populated directly on entry
    const entry2 = { _id: 'e2', courseId: { _id: 'other-id' }, certificate: mockCert, status: 'completed' }
    assert.deepEqual(resolveAchievementCertificate(entry2, new Map()), mockCert)

    // Case 3: no certificate available
    const entry3 = { _id: 'e3', courseId: { _id: 'missing-id' }, status: 'completed' }
    assert.equal(resolveAchievementCertificate(entry3, new Map()), null)
  })

  await t.test('getAchievementActionState handles available, loading, and unavailable states', () => {
    const mockCert = { id: 'cert-123', certificateId: 'AIH-2026-999' }

    // Idle available state
    const idleState = getAchievementActionState(mockCert, null)
    assert.equal(idleState.hasCertificate, true)
    assert.equal(idleState.isBusy, false)
    assert.equal(idleState.previewButtonText, 'Preview Certificate')
    assert.equal(idleState.downloadButtonText, 'Download Certificate')

    // Preview active state
    const previewState = getAchievementActionState(mockCert, { id: 'cert-123', type: 'preview' })
    assert.equal(previewState.isBusy, true)
    assert.equal(previewState.isPreviewing, true)
    assert.equal(previewState.previewButtonText, 'Opening…')

    // Download active state
    const downloadState = getAchievementActionState(mockCert, { id: 'cert-123', type: 'download' })
    assert.equal(downloadState.isBusy, true)
    assert.equal(downloadState.isDownloading, true)
    assert.equal(downloadState.downloadButtonText, 'Downloading…')

    // Unavailable state
    const unavailableState = getAchievementActionState(null, null)
    assert.equal(unavailableState.hasCertificate, false)
    assert.equal(unavailableState.unavailableLabel, 'Certificate unavailable')
  })
})

