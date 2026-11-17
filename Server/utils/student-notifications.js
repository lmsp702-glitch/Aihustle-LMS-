import Notification from '../models/Notification.js'

export async function createStudentNotification({
  recipientId,
  eventKey,
  type,
  title,
  message,
  link,
  metadata = {},
}) {
  if (
    recipientId === undefined
    || typeof eventKey !== 'string'
    || !eventKey.trim()
    || eventKey.length > 300
    || typeof title !== 'string'
    || typeof message !== 'string'
  ) {
    throw new TypeError('A student notification requires a recipient, event key, title, and message.')
  }
  const notification = await Notification.findOneAndUpdate(
    { eventKey },
    {
      $setOnInsert: {
        recipientRole: 'student',
        recipientId,
        eventKey,
        type,
        title,
        message,
        link,
        metadata,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true },
  ).lean()
  if (!notification) throw new Error('The student notification could not be saved.')
  return notification
}
