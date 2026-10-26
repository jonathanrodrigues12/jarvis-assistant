import { execFile } from 'node:child_process'
import { cpus, freemem, totalmem } from 'node:os'

/**
 * Live machine telemetry for the HUD's gauges: CPU, memory, GPU load and
 * temperature, CPU temperature, and network throughput.
 *
 * Every figure is measured, never estimated. What this machine cannot report
 * comes back as null and the gauge says so, rather than showing a number that
 * only looks like data:
 *
 *   - CPU and memory come from Node itself.
 *   - GPU load, temperature and memory from `nvidia-smi`, which ships with the
 *     NVIDIA driver. No NVIDIA card, no GPU figures.
 *   - CPU temperature is the hard one. Windows does not expose it to ordinary
 *     programs on most machines, so it is read from LibreHardwareMonitor's
 *     local web server (http://localhost:8085/data.json) when that is running,
 *     and is null otherwise. JARVIS_LHM_URL overrides the address.
 *   - Network throughput is the difference between two readings of the
 *     interface byte counters (`netstat -e` on Windows), divided by the time
 *     between them.
 *
 * Sampling is lazy: a reading is taken when the HUD asks and reused for a
 * moment, so a closed interface costs nothing and an open one costs one set of
 * small processes every couple of seconds.
 */

const CACHE_MS = 1500
const LHM_URL = process.env.JARVIS_LHM_URL ?? 'http://localhost:8085/data.json'

function run(file, args, timeout = 2500) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout, windowsHide: true }, (err, stdout) =>
      resolve(err ? null : String(stdout)),
    )
  })
}

// -- CPU: busy share of all cores since the previous reading ---------------
let lastCpu = null
function cpuUsage() {
  const now = cpus().reduce(
    (acc, c) => {
      const t = c.times
      acc.idle += t.idle
      acc.total += t.user + t.nice + t.sys + t.idle + t.irq
      return acc
    },
    { idle: 0, total: 0 },
  )
  const prev = lastCpu
  lastCpu = now
  if (!prev || now.total === prev.total) return null
  return 1 - (now.idle - prev.idle) / (now.total - prev.total)
}

// -- GPU --------------------------------------------------------------------
async function gpu() {
  const out = await run('nvidia-smi', [
    '--query-gpu=name,utilization.gpu,temperature.gpu,memory.used,memory.total',
    '--format=csv,noheader,nounits',
  ])
  if (!out) return null
  const [name, util, temp, used, total] = out.trim().split('\n')[0].split(',').map((s) => s.trim())
  return {
    name,
    usage: Number(util) / 100,
    temp: Number(temp),
    memUsed: Number(used),
    memTotal: Number(total),
  }
}

// -- CPU temperature, from LibreHardwareMonitor if it is running ------------
function findCpuTemp(node) {
  // The tree is hardware → sensor groups → sensors. The package temperature is
  // the figure worth showing; any CPU core temperature is the fallback.
  let best = null
  const walk = (n, inCpu) => {
    const here = inCpu || /cpu|processor|intel|amd ryzen/i.test(n.Text ?? '')
    if (here && /°C/.test(n.Value ?? '')) {
      const v = parseFloat(String(n.Value).replace(',', '.'))
      if (Number.isFinite(v)) {
        if (/package|tctl|tdie/i.test(n.Text ?? '')) best = v
        else best ??= v
      }
    }
    for (const c of n.Children ?? []) walk(c, here)
  }
  walk(node, false)
  return best
}

async function cpuTemp() {
  try {
    const res = await fetch(LHM_URL, { signal: AbortSignal.timeout(600) })
    if (!res.ok) return null
    return findCpuTemp(await res.json())
  } catch {
    return null
  }
}

// -- Network: bytes per second from two counter readings ---------------------
let lastNet = null
async function network() {
  let rx = null
  let tx = null
  if (process.platform === 'win32') {
    const out = await run('netstat', ['-e'])
    // The bytes line is the first one carrying two large integers, whatever
    // the system language calls it.
    const line = out?.split('\n').find((l) => /^\s*\S+\s+\d{4,}\s+\d{4,}\s*$/.test(l))
    if (line) [rx, tx] = line.trim().split(/\s+/).slice(-2).map(Number)
  } else {
    const out = await run('cat', ['/proc/net/dev'])
    if (out) {
      rx = 0
      tx = 0
      for (const l of out.split('\n').slice(2)) {
        const [iface, rest] = l.split(':')
        if (!rest || iface.trim() === 'lo') continue
        const f = rest.trim().split(/\s+/).map(Number)
        rx += f[0]
        tx += f[8]
      }
    }
  }
  if (rx == null) return null
  const at = Date.now()
  const prev = lastNet
  lastNet = { rx, tx, at }
  if (!prev || at === prev.at) return { down: null, up: null }
  const secs = (at - prev.at) / 1000
  return { down: Math.max(0, (rx - prev.rx) / secs), up: Math.max(0, (tx - prev.tx) / secs) }
}

// ---------------------------------------------------------------------------

let cached = null
let cachedAt = 0
let inflight = null

async function sample() {
  const [g, ct, net] = await Promise.all([gpu(), cpuTemp(), network()])
  return {
    at: Date.now(),
    cpu: { usage: cpuUsage(), temp: ct, cores: cpus().length },
    memory: { usage: 1 - freemem() / totalmem(), totalGb: totalmem() / 2 ** 30 },
    gpu: g,
    network: net,
  }
}

/** The latest reading, at most CACHE_MS old. */
export async function systemStats() {
  if (cached && Date.now() - cachedAt < CACHE_MS) return cached
  inflight ??= sample().finally(() => {
    inflight = null
  })
  cached = await inflight
  cachedAt = Date.now()
  return cached
}
