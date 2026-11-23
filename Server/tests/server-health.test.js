import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { app } from '../server.js'

const server = app.listen(0)

after(async () => {
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
  })
})

test('backend health route responds successfully at the root and API health paths', async () => {
  const { port } = server.address()

  for (const path of ['/', '/api', '/api/health']) {
    const response = await fetch(`http://127.0.0.1:${port}${path}`)
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { status: 'ok', service: 'LMS API' })
  }
})
