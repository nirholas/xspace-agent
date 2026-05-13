'use strict'

let _original = global.fetch

/**
 * Install a stub global.fetch that matches routes defined as:
 *   [method, urlMatcher, responseDescriptor]
 * where urlMatcher is a string (exact), RegExp, or function(url)->bool.
 * responseDescriptor: { ok, status, json, text, body }
 */
function installMockFetch(routes) {
  global.fetch = async function mockFetch(url, opts = {}) {
    const method = (opts.method || 'GET').toUpperCase()
    for (const [routeMethod, matcher, response] of routes) {
      if (routeMethod.toUpperCase() !== method) continue
      const matched =
        typeof matcher === 'string' ? url === matcher :
        matcher instanceof RegExp ? matcher.test(url) :
        typeof matcher === 'function' ? matcher(url) : false
      if (matched) return _buildResponse(response)
    }
    throw new Error(`mock-fetch: no route for ${method} ${url}`)
  }
}

function _buildResponse({ ok = true, status = 200, json: jsonBody, text: textBody, body }) {
  const rawText = jsonBody !== undefined ? JSON.stringify(jsonBody) : (textBody || '')
  return {
    ok,
    status,
    body: body || null,
    headers: { get: () => null },
    json: async () => (jsonBody !== undefined ? jsonBody : JSON.parse(rawText)),
    text: async () => rawText,
  }
}

function restoreFetch() {
  global.fetch = _original
}

/**
 * Build a WHATWG ReadableStream from an array of Buffer/string chunks.
 * Each chunk is enqueued synchronously in `pull` as a Uint8Array.
 */
function streamFromChunks(chunks) {
  let idx = 0
  return new ReadableStream({
    pull(controller) {
      if (idx < chunks.length) {
        const chunk = chunks[idx++]
        controller.enqueue(
          typeof chunk === 'string' ? Buffer.from(chunk) : chunk
        )
      } else {
        controller.close()
      }
    },
  })
}

module.exports = { installMockFetch, restoreFetch, streamFromChunks }
