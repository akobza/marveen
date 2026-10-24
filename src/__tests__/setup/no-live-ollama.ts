// GLOBAL SUITE SEAM: no test may reach a live Ollama.
//
// 1a7b1b66 (2026-10-24). A checkout has no
// .env and no store/config-overrides.json, and cfg() reads nothing else -- not
// process.env -- so OLLAMA_URL and EMBED_URL resolve to http://localhost:11434.
// On a host that runs Ollama for the fleet, that is the production instance.
// saveMemory and saveAgentMemory call generateEmbedding on every save without
// awaiting it (src/db.ts), so a full run sent its embedding requests into that
// queue: 453 of them from 18 test files, most of them after the test file that
// started them had already finished, and the shared model answered the fleet
// with 5xx waves while the suite stayed green.
//
// The seam is the fetch the call goes through, not the address: the production
// config path (cfg(), config.ts) is left as it is. A request to port 11434,
// whatever the host and the path, is refused here the way an unreachable backend
// refuses it -- a rejected promise with TypeError('fetch failed') -- which is the
// case generateEmbedding already handles (null and a log line), and the one the
// suite was measured against with the network cut off (the same 13 known reds).
// The cause carries a code the guard test asserts, so "refused by this seam" and
// "refused by the network" stay apart.
//
// Port, not host: localhost, 127.0.0.1, [::1] and a LAN name can all reach the
// same daemon. Every other address goes to the real fetch untouched. A test that
// stubs fetch itself keeps its stub; unstubbing returns here, not to the network.
const OLLAMA_PORT = '11434'
const realFetch = globalThis.fetch

function targetUrl(input: unknown): URL | null {
  try {
    if (input instanceof URL) return input
    if (typeof input === 'string') return new URL(input)
    if (input && typeof (input as { url?: unknown }).url === 'string') return new URL((input as { url: string }).url)
  } catch {
    // not an absolute URL: not an Ollama address either; the real fetch says what is wrong with it
  }
  return null
}

globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const url = targetUrl(input)
  if (url && url.port === OLLAMA_PORT) {
    const cause = Object.assign(new Error(`the test suite does not reach Ollama (${url.host}${url.pathname})`), {
      code: 'MARVEEN_TEST_NO_LIVE_OLLAMA',
    })
    throw new TypeError('fetch failed', { cause })
  }
  return realFetch(input, init)
}) as typeof fetch
