import PDFDocument from 'pdfkit'

function stripHtml(html = '') {
  if (typeof html !== 'string') return ''
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/h[1-6]>/gi, '\n\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function formatDate(date) {
  if (!date) return 'Unknown date'
  try {
    return new Date(date).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    })
  } catch {
    return String(date)
  }
}

export function generateStudentNotesPdf(res, { courseTitle = 'Course', studentName = 'Student', notes = [] }) {
  const doc = new PDFDocument({
    margin: 40,
    size: 'A4',
    bufferPages: true,
    info: {
      Title: `${courseTitle} - Study Notes`,
      Author: studentName,
      Subject: 'aiHustle LMS Student Course Notes',
    },
  })

  doc.pipe(res)

  // Colors
  const primaryBrand = '#1b5e52' // Muted teal
  const goldAccent = '#b3820a' // Golden yellow
  const textDark = '#26332f' // Dark text
  const textMuted = '#66706b' // Muted text
  const cardBorder = '#dce8dc' // Border line
  const bgLight = '#f8fbf9'

  // Header Banner
  doc.rect(40, 40, 515, 65).fill(bgLight).stroke(cardBorder)

  doc.fontSize(10).fillColor(goldAccent).font('Helvetica-Bold').text('AIHUSTLE LMS • PERSONAL STUDY NOTES', 55, 52)
  doc.fontSize(16).fillColor(primaryBrand).font('Helvetica-Bold').text(courseTitle, 55, 67, { width: 485, lineBreak: false, ellipsis: true })
  doc.fontSize(9).fillColor(textMuted).font('Helvetica').text(`Student: ${studentName}   |   Exported: ${formatDate(new Date())}   |   Total Notes: ${notes.length}`, 55, 87)

  doc.y = 120

  if (!notes.length) {
    doc.moveDown(2)
    doc.fontSize(12).fillColor(textMuted).font('Helvetica-Oblique').text('No personal notes have been saved for this course yet.', { align: 'center' })
  } else {
    notes.forEach((note, index) => {
      // Check page break safety
      if (doc.y > 680) {
        doc.addPage()
      }

      const noteStartY = doc.y

      // Card Header
      doc.fontSize(12).fillColor(note.isPinned ? goldAccent : primaryBrand).font('Helvetica-Bold')
      const titlePrefix = note.isPinned ? '[PINNED] ' : ''
      doc.text(`${titlePrefix}${note.title || 'Untitled Note'}`, 45, noteStartY, { width: 505 })

      // Metadata line: Lesson & Timestamp & Date
      const metaParts = []
      if (note.lessonTitle) metaParts.push(`Lesson: ${note.lessonTitle}`)
      if (note.videoTimestampDisplay || (note.videoTimestamp != null && !isNaN(note.videoTimestamp))) {
        const timeStr = note.videoTimestampDisplay || `${Math.floor(note.videoTimestamp / 60)}:${String(Math.floor(note.videoTimestamp % 60)).padStart(2, '0')}`
        metaParts.push(`Timestamp: ${timeStr}`)
      }
      metaParts.push(`Updated: ${formatDate(note.updatedAt || note.createdAt)}`)

      doc.fontSize(8.5).fillColor(textMuted).font('Helvetica').text(metaParts.join('   •   '), 45, doc.y + 2, { width: 505 })

      // Content
      doc.moveDown(0.5)
      const cleanContent = stripHtml(note.content)
      if (cleanContent) {
        doc.fontSize(10).fillColor(textDark).font('Helvetica').text(cleanContent, 45, doc.y, {
          width: 505,
          lineGap: 2.5,
        })
      } else {
        doc.fontSize(9).fillColor(textMuted).font('Helvetica-Oblique').text('(No content body)', 45, doc.y)
      }

      doc.moveDown(0.8)
      // Divider
      doc.moveTo(45, doc.y).lineTo(550, doc.y).strokeColor(cardBorder).lineWidth(0.75).stroke()
      doc.moveDown(0.8)
    })
  }

  // Footer & Page Numbers
  const totalPages = doc.bufferedPageRange().count
  for (let i = 0; i < totalPages; i++) {
    doc.switchToPage(i)
    doc.fontSize(8).fillColor(textMuted).font('Helvetica').text(
      `aiHustle LMS   •   ${courseTitle}   •   Page ${i + 1} of ${totalPages}`,
      40,
      790,
      { align: 'center', width: 515 },
    )
  }

  doc.end()
}

