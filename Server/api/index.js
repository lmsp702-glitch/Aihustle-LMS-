import { connectToDatabase } from '../config/db.js'
import { requireJwtSecret } from '../config/env.js'
import { app } from '../server.js'

let initializationPromise

async function initialize() {
  if (!initializationPromise) {
    initializationPromise = Promise.resolve()
      .then(() => {
        requireJwtSecret()
        return connectToDatabase()
      })
      .catch((error) => {
        initializationPromise = undefined
        throw error
      })
  }
  await initializationPromise
}

export default async function handler(req, res) {
  await initialize()
  app(req, res)
}
