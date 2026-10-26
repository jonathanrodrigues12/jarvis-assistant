/**
 * Loads .env.local into the environment.
 *
 * Its own module, imported first by server.mjs, because ES module imports are
 * evaluated before the importing module's body: a loadEnvFile call in
 * server.mjs itself ran only after briefing.mjs had already read JARVIS_CITY
 * and the rest, so every setting in the file was silently ignored in favour of
 * the defaults. Variables already set in the environment win. The file is
 * gitignored (*.local), which is what makes it a safe home for a key.
 */
try {
  process.loadEnvFile(new URL('../.env.local', import.meta.url))
} catch {
  // No file is the normal case; everything has a default.
}
