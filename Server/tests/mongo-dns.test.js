import assert from 'node:assert/strict'
import { test } from 'node:test'
import dns from 'node:dns'
import {
  extractSrvHostname,
  isLoopbackDns,
  parseDnsServerList,
  ensureMongoDnsResolution,
} from '../config/dns.js'

test('extractSrvHostname extracts cluster domain from mongodb+srv URIs and ignores standard URIs', () => {
  const srvUri = 'mongodb+srv://admin:secret123@cluster0.sheiqd7.mongodb.net/LMS?retryWrites=true&w=majority'
  assert.equal(extractSrvHostname(srvUri), 'cluster0.sheiqd7.mongodb.net')

  const srvWithoutAuth = 'mongodb+srv://cluster0.sheiqd7.mongodb.net/LMS'
  assert.equal(extractSrvHostname(srvWithoutAuth), 'cluster0.sheiqd7.mongodb.net')

  const standardUri = 'mongodb://127.0.0.1:27017/LMS'
  assert.equal(extractSrvHostname(standardUri), null)

  assert.equal(extractSrvHostname(null), null)
  assert.equal(extractSrvHostname(''), null)
  assert.equal(extractSrvHostname(12345), null)
})

test('isLoopbackDns accurately identifies loopback-only DNS server configurations', () => {
  assert.equal(isLoopbackDns(['127.0.0.1']), true)
  assert.equal(isLoopbackDns(['127.0.0.1', '::1']), true)
  assert.equal(isLoopbackDns(['127.0.0.53']), true)
  assert.equal(isLoopbackDns([]), true)
  assert.equal(isLoopbackDns(null), true)

  assert.equal(isLoopbackDns(['8.8.8.8']), false)
  assert.equal(isLoopbackDns(['1.1.1.1', '8.8.8.8']), false)
  assert.equal(isLoopbackDns(['192.168.1.1']), false)
  assert.equal(isLoopbackDns(['127.0.0.1', '8.8.8.8']), false)
})

test('parseDnsServerList parses multiple delimiters safely', () => {
  assert.deepEqual(parseDnsServerList('1.1.1.1,8.8.8.8'), ['1.1.1.1', '8.8.8.8'])
  assert.deepEqual(parseDnsServerList('1.1.1.1, 8.8.8.8'), ['1.1.1.1', '8.8.8.8'])
  assert.deepEqual(parseDnsServerList('1.1.1.1 8.8.8.8'), ['1.1.1.1', '8.8.8.8'])
  assert.deepEqual(parseDnsServerList(''), [])
  assert.deepEqual(parseDnsServerList(null), [])
})

test('ensureMongoDnsResolution skips non-SRV URIs immediately without modifying servers', async () => {
  const initial = dns.getServers()
  const result = await ensureMongoDnsResolution('mongodb://127.0.0.1:27017/LMS')
  assert.equal(result.resolved, true)
  assert.equal(result.skipped, true)
  assert.deepEqual(dns.getServers(), initial)
})

test('ensureMongoDnsResolution handles SRV resolution gracefully and restores servers if unresolvable', async () => {
  const initial = dns.getServers()
  // Non-existent cluster domain
  const result = await ensureMongoDnsResolution('mongodb+srv://user:pass@nonexistent-fake-cluster.mongodb.net/test')
  assert.equal(result.resolved, false)
  assert.equal(result.method, 'failed')
  assert.ok(result.justification)
  assert.ok(result.error)
  assert.deepEqual(dns.getServers(), initial)
})

