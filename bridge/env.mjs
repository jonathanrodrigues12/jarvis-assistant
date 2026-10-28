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
//
// The installed app points JARVIS_ENV_FILE at %APPDATA%\JARVIS\.env.local, so the
// keys never ship inside the installer. It is loaded first, so it wins over a
// copy beside the bridge.
for (const file of [process.env.JARVIS_ENV_FILE, new URL('../.env.local', import.meta.url)]) {
  if (!file) continue
  try {
    process.loadEnvFile(file)
  } catch {
    // No file is the normal case; everything has a default.
  }
}
