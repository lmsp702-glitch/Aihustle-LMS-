import { randomInt } from 'node:crypto'
import { config } from '../config/env.js'
import { sendRegistrationEmailVerificationCodeEmail } from '../utils/email.js'

if (config.nodeEnv === 'production') {
  console.error('Refusing to run the Gmail email test in production.')
  process.exitCode = 1
} else {
  const recipients = process.argv.slice(2).map((recipient) => recipient.trim().toLowerCase())
  if (
    recipients.length !== 2 ||
    recipients.some((recipient) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) ||
    recipients[0] === recipients[1]
  ) {
    console.error('Usage: npm run test:email -- <first-controlled-email> <second-controlled-email>')
    process.exitCode = 1
  } else {
    for (const [index, email] of recipients.entries()) {
      try {
        await sendRegistrationEmailVerificationCodeEmail({
          email,
          fullName: 'Gmail SMTP Test',
          code: String(randomInt(0, 1_000_000)).padStart(6, '0'),
        })
        console.log(JSON.stringify({
          event: 'gmail_test_email.accepted',
          recipientNumber: index + 1,
        }))
      } catch (error) {
        console.error(JSON.stringify({
          event: 'gmail_test_email.failed',
          recipientNumber: index + 1,
          errorName: error instanceof Error ? error.name : 'UnknownError',
          errorCode: typeof error?.code === 'string' ? error.code : undefined,
          smtpResponseCode: Number.isInteger(error?.responseCode) ? error.responseCode : undefined,
        }))
        process.exitCode = 1
      }
    }
  }
}
