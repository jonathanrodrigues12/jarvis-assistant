/**
 * Lists the house as the bridge will see it, so a wrong key or region shows up
 * here rather than as JARVIS saying he cannot find the living-room light.
 *
 *   npm run check:home
 */

import '../bridge/env.mjs'
import { homeConfig, listHome } from '../bridge/home.mjs'

if (!homeConfig.enabled) {
  console.log('Casa desligada: defina TUYA_ACCESS_ID e TUYA_ACCESS_SECRET em .env.local.')
  process.exit(1)
}

console.log(`Tuya ${homeConfig.region} · ${homeConfig.host}\n`)
try {
  const list = await listHome()
  if (!list.length) {
    console.log('Nenhum dispositivo. A conta do Smart Life está vinculada ao projeto (Devices → Link App Account)?')
  }
  for (const d of list) console.log(JSON.stringify(d))
} catch (err) {
  console.error(err.message)
  if (/1004|sign/i.test(err.message)) console.error('→ Access ID ou Secret errados.')
  if (/1106|permission/i.test(err.message)) {
    console.error('→ Falta autorizar a API: no projeto, Service API → IoT Core e Authorization.')
  }
  if (/2009|1010|token/i.test(err.message)) console.error('→ Confira TUYA_REGION (us para contas do Brasil).')
  process.exit(1)
}
