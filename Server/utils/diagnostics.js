import { config } from '../config/env.js'

export function redactSensitive(val) {
  if (val === null || val === undefined) return val
  if (typeof val === 'number' || typeof val === 'boolean') return val

  if (typeof val !== 'string') {
    if (val instanceof Error) {
      return redactSensitive(val.message)
    }
    try {
      return JSON.parse(redactSensitive(JSON.stringify(val)))
    } catch {
      return redactSensitive(String(val))
    }
  }

  let result = val

  // Extract passwords and credentials from any URIs in config or val
  const sources = [val, config.mongoUri].filter(Boolean)
  for (const src of sources) {
    if (typeof src === 'string') {
      const matches = src.matchAll(/:\/\/(?:([^:]+):)?([^@/?#\s]+)@/g)
      for (const match of matches) {
        const [, user, pass] = match
        if (pass && pass.length > 2) {
          result = result.replaceAll(pass, '[REDACTED]')
        }
        if (user && user.length > 2) {
          result = result.replaceAll(user, '[REDACTED]')
        }
      }
    }
  }

  // Redact full MongoDB URIs (standard and +srv)
  result = result.replace(/mongodb(?:\+srv)?:\/\/[^\s"'`<>]+/gi, '[REDACTED_MONGO_URI]')

  // Redact any user:pass@ credentials in connection strings or URLs
  result = result.replace(/(:\/\/[^:/?#\s]+):([^@/?#\s]+)@/g, '$1:[REDACTED]@')

  // Redact exact mongoUri from configuration
  if (config.mongoUri && config.mongoUri.length > 5) {
    result = result.replaceAll(config.mongoUri, '[REDACTED_MONGO_URI]')
  }

  // Redact configured secrets/passwords if present
  const secrets = [
    config.adminPassword,
    config.jwtSecret,
    config.googleClientSecret,
    config.smtpPassword,
  ]
  for (const secret of secrets) {
    if (secret && typeof secret === 'string' && secret.length > 3) {
      result = result.replaceAll(secret, '[REDACTED]')
    }
  }

  return result
}

export function buildStartupDiagnostic(error, readyState) {
  const name = redactSensitive(error?.name || 'Error')
  const message = redactSensitive(error?.message || 'Unknown error')
  const code = error?.code !== undefined ? error.code : null
  const codeName = error?.codeName !== undefined ? error.codeName : null
  let cause = undefined
  if (error?.cause) {
    if (error.cause instanceof Error) {
      cause = redactSensitive(`${error.cause.name}: ${error.cause.message}`)
    } else if (typeof error.cause === 'object') {
      try {
        cause = redactSensitive(JSON.stringify(error.cause))
      } catch {
        cause = redactSensitive(String(error.cause))
      }
    } else {
      cause = redactSensitive(String(error.cause))
    }
  }

  return {
    name,
    message,
    code,
    codeName,
    ...(cause !== undefined ? { cause } : {}),
    readyState: readyState !== undefined ? readyState : null,
  }
}
