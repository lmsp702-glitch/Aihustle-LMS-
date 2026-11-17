import assert from 'node:assert/strict'
import test from 'node:test'
import {
  findActiveTranscriptCueIndex,
  formatTranscriptTime,
  parseSrtTranscript,
} from '../src/srt-transcript.js'

test('parses numbered SRT cues, multiline text, and sorts by timestamp', () => {
  const cues = parseSrtTranscript([
    '2',
    '00:00:02,500 --> 00:00:04,000',
    '<i>Second sentence.</i>',
    '',
    '1',
    '00:00:00.000 --> 00:00:02.500',
    'First line.',
    'Continued here.',
  ].join('\r\n'))

  assert.deepEqual(cues, [
    { startTimeMs: 0, endTimeMs: 2500, text: 'First line.\nContinued here.' },
    { startTimeMs: 2500, endTimeMs: 4000, text: 'Second sentence.' },
  ])
})

test('rejects invalid SRT timestamps and empty cue text', () => {
  assert.throws(
    () => parseSrtTranscript('1\n00:00:03,000 --> 00:00:02,000\nInvalid interval'),
    /invalid timing or text/i,
  )
  assert.throws(
    () => parseSrtTranscript('1\n00:00:00,000 --> 00:00:01,000'),
    /invalid timing or text/i,
  )
})

test('formats transcript cue timestamps for display', () => {
  assert.equal(formatTranscriptTime(65000), '01:05')
  assert.equal(formatTranscriptTime(3665000), '01:01:05')
})

test('finds the active cue using playback time, including backward and forward seeks', () => {
  const cues = [
    { startTimeMs: 1000, endTimeMs: 2000, text: 'First.' },
    { startTimeMs: 2000, endTimeMs: 3500, text: 'Second.' },
  ]

  assert.equal(findActiveTranscriptCueIndex(cues, 1.5), 0)
  assert.equal(findActiveTranscriptCueIndex(cues, 2.5), 1)
  assert.equal(findActiveTranscriptCueIndex(cues, 1.25), 0)
  assert.equal(findActiveTranscriptCueIndex(cues, 3.5), -1)
})
