import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import type { Drive } from './Scene'

/**
 * The filament orb — a ball of light wound from loose, breathing loops.
 *
 * Each strand is a closed loop around the centre, tilted to its own random
 * orientation and wobbled by two travelling sine waves, so together they read
 * as a sphere without any of them being one. Seen edge-on the loops crowd the
 * silhouette, which is what gives the ball its bright rim and its hollow core.
 *
 * WebGL lines are one pixel wide whatever you ask for, so every strand is drawn
 * three times a hair apart, the outer two dimmer: under bloom that reads as a
 * glowing ribbon rather than a scratch. A highlight travels along each loop,
 * mixed toward white, and the whole thing swells with the voice level.
 *
 * Positions and colours are rewritten on the CPU each frame. At eighteen
 * strands that is about twelve thousand vertices — trivial next to the bloom
 * pass, and far simpler than a shader that has to agree with itself about
 * where a loop is.
 */

const STRANDS = 18
const SEGMENTS = 200
const RADIUS = 1.5
/** Radial offsets of the three passes that thicken each strand, and their weight. */
const PASSES = [
  [-0.014, 0.45],
  [0, 1],
  [0.014, 0.45],
] as const

type Strand = {
  q: THREE.Quaternion
  k1: number
  k2: number
  a1: number
  a2: number
  w1: number
  w2: number
  p1: number
  p2: number
  bulge: number
  alpha: number
  speed: number
}

/** Deterministic, so the orb has the same shape on every load. */
function rng(seed: number) {
  let s = seed
  return () => (s = (s * 16807) % 2147483647) / 2147483647
}

function makeStrands(): Strand[] {
  const r = rng(20261026)
  return Array.from({ length: STRANDS }, () => {
    // A uniformly random orientation, so no axis of the ball is favoured.
    const u = r(), v = r(), w = r()
    const q = new THREE.Quaternion(
      Math.sqrt(1 - u) * Math.sin(2 * Math.PI * v),
      Math.sqrt(1 - u) * Math.cos(2 * Math.PI * v),
      Math.sqrt(u) * Math.sin(2 * Math.PI * w),
      Math.sqrt(u) * Math.cos(2 * Math.PI * w),
    )
    return {
      q,
      k1: 2 + Math.floor(r() * 2),
      k2: 3 + Math.floor(r() * 3),
      a1: 0.03 + r() * 0.05,
      a2: 0.012 + r() * 0.03,
      w1: 0.25 + r() * 0.55,
      w2: 0.2 + r() * 0.45,
      p1: r() * Math.PI * 2,
      p2: r() * Math.PI * 2,
      bulge: 0.08 + r() * 0.18,
      alpha: 0.35 + r() * 0.65,
      speed: (0.35 + r() * 0.6) * (r() < 0.5 ? -1 : 1),
    }
  })
}

export function Filaments({ drive }: { drive: Drive }) {
  const group = useRef<THREE.Group>(null)
  const reveal = useRef(0)
  const strands = useMemo(makeStrands, [])

  const { geometry, material } = useMemo(() => {
    const verts = STRANDS * PASSES.length * SEGMENTS * 2
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts * 3), 3))
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(verts * 3), 3))
    // The ball never leaves the frame; a fixed bound saves recomputing one
    // from twelve thousand moving points every frame.
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), RADIUS * 3)
    const m = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    })
    return { geometry: g, material: m }
  }, [])

  const tmp = useMemo(() => new THREE.Vector3(), [])
  const ring = useMemo(() => new Float32Array(SEGMENTS * 4), []) // x, y, z, brightness

  useFrame((state, dt) => {
    const t = state.clock.elapsedTime
    const r = drive.reactor
    const g = group.current
    if (!g) return
    g.visible = r.visible

    // Grows out of the centre on power-up, the way the ring used to.
    reveal.current += (Math.min(1, drive.open / 1.6) - reveal.current) * Math.min(1, dt * 1.6)
    const size = RADIUS * r.scale * (0.35 + 0.65 * reveal.current)

    g.rotation.y += dt * 0.12 * drive.spin * r.spin
    g.rotation.x = Math.sin(t * 0.21) * 0.25
    g.rotation.z = Math.cos(t * 0.17) * 0.12

    const level = drive.level
    const glow = r.intensity * (0.95 + level * 0.9)
    const col = r.color
    const pos = geometry.attributes.position.array as Float32Array
    const clr = geometry.attributes.color.array as Float32Array
    let o = 0

    for (const s of strands) {
      // One pass over the loop in its own plane, then three offset copies.
      for (let i = 0; i < SEGMENTS; i++) {
        const th = (i / SEGMENTS) * Math.PI * 2
        const rad =
          1 +
          s.a1 * Math.sin(s.k1 * th + s.w1 * t + s.p1) +
          s.a2 * Math.sin(s.k2 * th - s.w2 * t + s.p2) +
          level * 0.09 * Math.sin(3 * th + t * 4 + s.p1)
        tmp.set(Math.cos(th) * rad, Math.sin(th) * rad, s.bulge * Math.sin(2 * th + s.w1 * t + s.p2))
        tmp.applyQuaternion(s.q)
        // A highlight running round the loop.
        const run = 0.5 + 0.5 * Math.sin(th * 2 - t * s.speed * 2 + s.p1)
        const b = s.alpha * (0.32 + 0.68 * Math.pow(run, 5))
        ring[i * 4] = tmp.x
        ring[i * 4 + 1] = tmp.y
        ring[i * 4 + 2] = tmp.z
        ring[i * 4 + 3] = b
      }
      for (const [off, weight] of PASSES) {
        const k = size * (1 + off)
        for (let i = 0; i < SEGMENTS; i++) {
          const j = (i + 1) % SEGMENTS
          for (const n of [i, j]) {
            pos[o] = ring[n * 4] * k
            pos[o + 1] = ring[n * 4 + 1] * k
            pos[o + 2] = ring[n * 4 + 2] * k
            const b = ring[n * 4 + 3] * weight * glow
            // Brightest points blow out toward white, the rest carry the accent.
            const hot = Math.pow(ring[n * 4 + 3], 3) * 0.8 * weight
            clr[o] = col.r * b + hot
            clr[o + 1] = col.g * b + hot
            clr[o + 2] = col.b * b + hot
            o += 3
          }
        }
      }
    }
    geometry.attributes.position.needsUpdate = true
    geometry.attributes.color.needsUpdate = true
  })

  return (
    <group ref={group}>
      <lineSegments geometry={geometry} material={material} />
    </group>
  )
}
