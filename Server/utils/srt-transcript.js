const maxTranscriptBytes = 2 * 1024 * 1024
const maxTranscriptCues = 10000
const maxTranscriptDurationMs = 12 * 60 * 60 * 1000
const timestampPattern = /^(\d+):([0-5]\d):([0-5]\d)[,.](\d{3})\s+-->\s+(\d+):([0-5]\d):([0-5]\d)[,.](\d{3})(?:[ \t]+.*)?$/

function timestampToMilliseconds(hours, minutes, seconds, milliseconds) {
  return Number(hours) * 3600000
    + Number(minutes) * 60000
    + Number(seconds) * 1000
    + Number(milliseconds)
}

export function parseSrtTranscript(source) {
  if (!Buffer.isBuffer(source) || source.length > maxTranscriptBytes) {
    throw new Error('Choose an SRT transcript up to 2 MB.')
  }
  const text = source.toString('utf8')
  if (!text.trim()) throw new Error('The transcript file is empty.')

  const blocks = text
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .trim()
    .split(/\n[ \t]*\n/)
  if (blocks.length > maxTranscriptCues) {
    throw new Error('The transcript contains too many cues.')
  }

  const cues = blocks.map((block, index) => {
    const lines = block.split('\n')
    const timestampLineIndex = lines.findIndex((line) => timestampPattern.test(line.trim()))
    const match = timestampPattern.exec(lines[timestampLineIndex]?.trim() || '')
    if (timestampLineIndex < 0 || !match) throw new Error(`Transcript cue ${index + 1} has an invalid timestamp.`)

    const startTimeMs = timestampToMilliseconds(...match.slice(1, 5))
    const endTimeMs = timestampToMilliseconds(...match.slice(5, 9))
    const cueText = lines.slice(timestampLineIndex + 1)
      .join('\n')
      .replace(/<[^>]*>/g, '')
      .trim()
    if (
      !Number.isSafeInteger(startTimeMs)
      || !Number.isSafeInteger(endTimeMs)
      || startTimeMs < 0
      || endTimeMs <= startTimeMs
      || endTimeMs > maxTranscriptDurationMs
      || !cueText
      || cueText.length > 5000
    ) {
      throw new Error(`Transcript cue ${index + 1} has invalid timing or text.`)
    }

    return { startTimeMs, endTimeMs, text: cueText }
  })

  return cues.sort((left, right) => left.startTimeMs - right.startTimeMs)
}
