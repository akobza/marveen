// GLOBAL SUITE SEAM: no test may reach a live Ollama by default (card 22cedf69).
//
// A checkout with no .env resolves OLLAMA_URL and EMBED_URL to http://localhost:11434 (src/config.ts). On a host that
// runs Ollama for production that address IS the production instance, and the suite reached it: saveMemory and
// saveAgentMemory call generateEmbedding on every save, fire-and-forget, so a full run sent its embedding requests into
// that queue while the tests themselves stayed green (measured 2026-09-29/30, card 0c053df4).
//
// This file points both keys at a dead loopback port through the MARVEEN_TEST_OLLAMA_URL seam in src/config.ts. Port 9
// (discard) has no listener, so a call fails at once with ECONNREFUSED and takes the code's own failure path, as an
// unreachable backend does. A test that needs a working backend stubs fetch, as the embedding tests already do.
//
// Scoped, not blanket: an existing MARVEEN_TEST_OLLAMA_URL is respected, so a runner that brings its own stand-in (one
// that counts the requests, for example) keeps it. Set in every worker before any test module imports src/config.ts,
// the value also reaches the subprocesses the tests spawn.
if (!process.env.MARVEEN_TEST_OLLAMA_URL) process.env.MARVEEN_TEST_OLLAMA_URL = 'http://127.0.0.1:9'
