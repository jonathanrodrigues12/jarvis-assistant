import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import type { Drive } from './Scene'
import { useStore } from '../store'

/**
 * The nucleus — a shell of light made of points.
 *
 * About twelve thousand dots are laid over a sphere in rows of latitude, each
 * row holding as many as its circumference allows, so the dots read as lines
 * the way they do in the reference. They are pushed in and out along their
 * normals by 3D simplex noise that drifts with time — a slow swell plus
 * mid-sized ripples that ruffle the outline. Colour runs top to bottom from
 * cyan through blue-violet to magenta, fixed to the screen while the body
 * turns inside it, and dots seen edge-on on a ripple are lit a little brighter.
 *
 * At rest the folds keep wandering and the whole body turns and breathes, so
 * it is never still. While JARVIS speaks the voice level drives it: the shell
 * swells, the folds deepen, and ripples run across the surface with each
 * syllable.
 *
 * All the motion is in the vertex shader. The CPU uploads the lattice once and
 * then only a handful of uniforms per frame.
 */

/** Rows of latitude. Each row gets as many dots as its circumference holds,
 *  which is what lays them out in the visible lines of the reference. */
const ROWS = 96
const RADIUS = 1.45

/** Ashima Arts / Stefan Gustavson 3D simplex noise (MIT). */
const NOISE = /* glsl */ `
vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 mod289(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 permute(vec4 x){return mod289(((x*34.0)+1.0)*x);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-0.85373472095314*r;}
float snoise(vec3 v){
  const vec2 C=vec2(1.0/6.0,1.0/3.0);
  const vec4 D=vec4(0.0,0.5,1.0,2.0);
  vec3 i=floor(v+dot(v,C.yyy));
  vec3 x0=v-i+dot(i,C.xxx);
  vec3 g=step(x0.yzx,x0.xyz);
  vec3 l=1.0-g;
  vec3 i1=min(g.xyz,l.zxy);
  vec3 i2=max(g.xyz,l.zxy);
  vec3 x1=x0-i1+C.xxx;
  vec3 x2=x0-i2+C.yyy;
  vec3 x3=x0-D.yyy;
  i=mod289(i);
  vec4 p=permute(permute(permute(i.z+vec4(0.0,i1.z,i2.z,1.0))+i.y+vec4(0.0,i1.y,i2.y,1.0))+i.x+vec4(0.0,i1.x,i2.x,1.0));
  float n_=0.142857142857;
  vec3 ns=n_*D.wyz-D.xzx;
  vec4 j=p-49.0*floor(p*ns.z*ns.z);
  vec4 x_=floor(j*ns.z);
  vec4 y_=floor(j-7.0*x_);
  vec4 x=x_*ns.x+ns.yyyy;
  vec4 y=y_*ns.x+ns.yyyy;
  vec4 h=1.0-abs(x)-abs(y);
  vec4 b0=vec4(x.xy,y.xy);
  vec4 b1=vec4(x.zw,y.zw);
  vec4 s0=floor(b0)*2.0+1.0;
  vec4 s1=floor(b1)*2.0+1.0;
  vec4 sh=-step(h,vec4(0.0));
  vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy;
  vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
  vec3 p0=vec3(a0.xy,h.x);
  vec3 p1=vec3(a0.zw,h.y);
  vec3 p2=vec3(a1.xy,h.z);
  vec3 p3=vec3(a1.zw,h.w);
  vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
  p0*=norm.x;p1*=norm.y;p2*=norm.z;p3*=norm.w;
  vec4 m=max(0.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0);
  m=m*m;
  return 42.0*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
}
`

const VERTEX = /* glsl */ `
uniform float uTime;
uniform float uFold;    // depth of the folds
uniform float uPulse;   // 0..1, the voice
uniform float uScale;
uniform float uSize;
uniform float uPixelRatio;
attribute float aSeed;
varying float vRim;
varying float vSeed;
varying float vHeight;
${NOISE}

vec3 shape(vec3 dir, float t) {
  // A sphere that ripples rather than folds: one slow swell, plus waves of a
  // middling size that ruffle the outline the way the reference's edge does.
  vec3 q = dir * 0.9 + vec3(0.0, t * 0.08, t * 0.05);
  vec3 warp = vec3(snoise(q + 11.0), snoise(q + 23.0), snoise(q + 37.0));
  float n = snoise(dir * 0.8 + warp * 0.35 + vec3(t * 0.06)) * 0.55;
  float fine = snoise(dir * 2.6 + warp * 0.4 - vec3(t * 0.14)) * 0.45;
  // Ripples that run over the surface only while he speaks.
  float ripple = sin(dir.y * 9.0 + dir.x * 4.0 - t * 7.5) * 0.06 * uPulse;
  float r = 1.0 + (n + fine) * uFold + ripple;
  return dir * r;
}

void main() {
  vec3 dir = normalize(position);
  vec3 p = shape(dir, uTime);

  // A normal from two neighbours on the deformed surface, for the rim light.
  vec3 t1 = normalize(cross(dir, abs(dir.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
  vec3 t2 = cross(dir, t1);
  vec3 pa = shape(normalize(dir + t1 * 0.02), uTime);
  vec3 pb = shape(normalize(dir + t2 * 0.02), uTime);
  vec3 n = normalize(cross(pa - p, pb - p));

  vec4 mv = modelViewMatrix * vec4(p * uScale, 1.0);
  vec3 nv = normalize(normalMatrix * n);
  vec3 view = normalize(-mv.xyz);
  vRim = pow(1.0 - abs(dot(nv, view)), 1.6);
  vSeed = aSeed;
  // Height on screen, -1 at the foot of the ball to 1 at its crown, for the
  // colour ramp. Taken after rotation so the ramp stays upright while the body
  // turns inside it, as in the reference.
  vHeight = clamp((modelMatrix * vec4(p * uScale, 1.0)).y / (uScale * 1.15), -1.0, 1.0);

  gl_Position = projectionMatrix * mv;
  gl_PointSize = uSize * uPixelRatio * (0.85 + aSeed * 0.3) * (3.0 / -mv.z);
}
`

const FRAGMENT = /* glsl */ `
uniform float uIntensity;
uniform float uPulse;
uniform float uTime;
varying float vRim;
varying float vSeed;
varying float vHeight;

// Cyan at the crown, blue-violet through the middle, magenta at the foot.
const vec3 TOP = vec3(0.12, 0.88, 1.0);
const vec3 MID = vec3(0.42, 0.28, 1.0);
const vec3 LOW = vec3(1.0, 0.08, 0.82);

void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c);
  if (d > 0.5) discard;
  float soft = smoothstep(0.5, 0.15, d);
  // Eased so each colour holds a band rather than sliding through grey.
  float h = smoothstep(-0.85, 0.85, vHeight);
  vec3 ramp = h > 0.5 ? mix(MID, TOP, smoothstep(0.5, 1.0, h)) : mix(LOW, MID, smoothstep(0.0, 0.5, h));
  // A few dots twinkle, so the surface reads as particles rather than a mesh.
  float twinkle = 0.85 + 0.15 * sin(uTime * (1.5 + vSeed * 3.0) + vSeed * 40.0);
  // Every dot is clearly visible, as in the reference; the ruffles seen
  // edge-on are lit a little above the rest.
  // Kept below the point where bloom clips to white — the colour IS the look,
  // and an over-bright dot loses its hue first.
  float bright = (0.58 + vRim * 0.5) * twinkle * uIntensity * (1.0 + uPulse * 0.6);
  vec3 col = mix(ramp, vec3(1.0), clamp(vRim * 0.06 + uPulse * 0.08, 0.0, 1.0));
  gl_FragColor = vec4(col * bright, soft * clamp(bright, 0.0, 1.0));
}
`

function lattice(): { positions: Float32Array; seeds: Float32Array } {
  const points: number[] = []
  const seeds: number[] = []
  let s = 1234567
  for (let i = 0; i < ROWS; i++) {
    const lat = -Math.PI / 2 + ((i + 0.5) / ROWS) * Math.PI
    const ring = Math.cos(lat)
    // As many dots as the row's circumference holds at the rows' own spacing.
    const n = Math.max(1, Math.round(ROWS * 2 * ring))
    const offset = (i % 2) * 0.5 // alternate rows interleave, like a weave
    for (let j = 0; j < n; j++) {
      const lon = ((j + offset) / n) * Math.PI * 2
      points.push(Math.cos(lon) * ring, Math.sin(lat), Math.sin(lon) * ring)
      s = (s * 16807) % 2147483647
      seeds.push(s / 2147483647)
    }
  }
  return { positions: new Float32Array(points), seeds: new Float32Array(seeds) }
}

export function Nucleus({ drive }: { drive: Drive }) {
  const group = useRef<THREE.Group>(null)
  const reveal = useRef(0)
  const pulse = useRef(0)

  const { geometry, material } = useMemo(() => {
    const { positions, seeds } = lattice()
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    g.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1))
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), RADIUS * 3)
    const m = new THREE.ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uTime: { value: 0 },
        uFold: { value: 0.14 },
        uPulse: { value: 0 },
        uScale: { value: RADIUS },
        uSize: { value: 5.2 },
        uPixelRatio: { value: Math.min(window.devicePixelRatio, 2) },
        uIntensity: { value: 1 },
      },
    })
    return { geometry: g, material: m }
  }, [])

  useFrame((state, dt) => {
    const g = group.current
    if (!g) return
    const r = drive.reactor
    g.visible = r.visible
    const t = state.clock.elapsedTime
    const speaking = useStore.getState().phase === 'speaking'

    // The voice, smoothed fast on the way up and slower on the way down, so
    // each syllable lands as a beat rather than a flicker.
    const want = speaking ? Math.min(1, drive.level * 1.6) : 0
    pulse.current += (want - pulse.current) * Math.min(1, dt * (want > pulse.current ? 14 : 5))

    reveal.current += (Math.min(1, drive.open / 1.6) - reveal.current) * Math.min(1, dt * 1.6)
    const breathe = 1 + Math.sin(t * 0.8) * 0.018

    const u = material.uniforms
    u.uTime.value = t
    u.uPulse.value = pulse.current
    u.uFold.value = 0.14 + pulse.current * 0.12 + drive.level * 0.03
    u.uScale.value =
      RADIUS * r.scale * (0.3 + 0.7 * reveal.current) * breathe * (1 + pulse.current * 0.1)
    u.uIntensity.value = r.intensity * (0.85 + drive.level * 0.4)

    g.rotation.y += dt * 0.1 * drive.spin * r.spin
    g.rotation.x = Math.sin(t * 0.17) * 0.3
    g.rotation.z = Math.cos(t * 0.13) * 0.15
  })

  return (
    <group ref={group}>
      <points geometry={geometry} material={material} />
    </group>
  )
}
