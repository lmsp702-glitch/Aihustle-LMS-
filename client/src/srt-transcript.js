const maxTranscriptBytes = 2 * 1024 * 1024
const maxTranscriptCues = 10000
const maxTranscriptDurationMs = 12 * 60 * 60 * 1000
const timestampPattern = /^(\d{2,}):([0-5]\d):([0-5]\d)[,.](\d{3})\s+-->\s+(\d{2,}):([0-5]\d):([0-5]\d)[,.](\d{3})$/

function timestampToMilliseconds(hours, minutes, seconds, milliseconds) {
  return Number(hours) * 3600000
    + Number(minutes) * 60000
    + Number(seconds) * 1000
    + Number(milliseconds)
}

export function parseSrtTranscript(source) {
  if (typeof source !== 'string' || !source.trim()) {
    throw new Error('The transcript file is empty.')
  }
  if (source.length > maxTranscriptBytes) {
    throw new Error('Choose an SRT transcript up to 2 MB.')
  }

  const blocks = source
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .trim()
    .split(/\n[ \t]*\n/)
  if (blocks.length > maxTranscriptCues) {
    throw new Error('The transcript contains too many cues.')
  }

  const cues = blocks.map((block, index) => {
    const lines = block.split('\n')
    const timestampLineIndex = /^\d+$/.test(lines[0].trim()) ? 1 : 0
    const match = timestampPattern.exec(lines[timestampLineIndex]?.trim() || '')
    if (!match) throw new Error(`Transcript cue ${index + 1} has an invalid timestamp.`)

    const startTimeMs = timestampToMilliseconds(...match.slice(1, 5))
    const endTimeMs = timestampToMilliseconds(...match.slice(5, 9))
    const text = lines.slice(timestampLineIndex + 1)
      .join('\n')
      .replace(/<[^>]*>/g, '')
      .trim()
    if (
      startTimeMs < 0
      || endTimeMs <= startTimeMs
      || endTimeMs > maxTranscriptDurationMs
      || !text
      || text.length > 5000
    ) {
      throw new Error(`Transcript cue ${index + 1} has invalid timing or text.`)
    }

    return { startTimeMs, endTimeMs, text }
  })

  return cues.sort((left, right) => left.startTimeMs - right.startTimeMs)
}

export function formatTranscriptTime(milliseconds) {
  const totalSeconds = Math.floor(milliseconds / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  const formattedMinutes = String(minutes).padStart(2, '0')
  const formattedSeconds = String(seconds).padStart(2, '0')
  return hours
    ? `${String(hours).padStart(2, '0')}:${formattedMinutes}:${formattedSeconds}`
    : `${formattedMinutes}:${formattedSeconds}`
}

export function findActiveTranscriptCueIndex(cues, currentTimeSeconds) {
  const currentTimeMs = Math.floor(currentTimeSeconds * 1000)
  let low = 0
  let high = cues.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (cues[middle].startTimeMs <= currentTimeMs) low = middle + 1
    else high = middle
  }
  for (let index = low - 1; index >= 0; index -= 1) {
    if (cues[index].endTimeMs > currentTimeMs) return index
  }
  return -1
}
