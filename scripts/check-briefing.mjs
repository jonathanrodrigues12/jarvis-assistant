/**
 * Runs the morning briefing's sources once and prints what came back, so a
 * broken feed shows up here rather than as JARVIS skipping half the briefing.
 *
 *   npm run check:briefing
 */

import { briefingConfig, news, now, weather } from '../bridge/briefing.mjs'

console.log('agora:', now())
console.log('clima:', JSON.stringify(await weather(briefingConfig.city), null, 2))
for (const topic of briefingConfig.topics) {
  const { noticias } = await news(topic, 2)
  console.log(`\n${topic}:`)
  for (const n of noticias) console.log(`  - ${n.titulo} [${n.fonte}]`)
}
