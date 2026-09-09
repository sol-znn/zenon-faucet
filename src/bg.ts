// The background: a lattice of points with a slow swell moving through it.
//
// Zenon calls its chain a Network of Momentum, so the background is a network
// with momentum travelling across it -- a flat grid of nodes, lit by two long
// sine waves crossing at an angle, seen from just above the plane. Nothing
// strobes, nothing spins fast, and the whole thing is one draw call.
//
// It is decoration, so it is also disposable: if WebGL is unavailable the page
// keeps its flat background and nothing else changes.

import {
  BufferGeometry,
  Color,
  DoubleSide,
  Float32BufferAttribute,
  Mesh,
  PerspectiveCamera,
  Points,
  Scene,
  ShaderMaterial,
  Vector2,
  WebGLRenderer,
  AdditiveBlending,
} from 'three'

/** Points per side. 120 x 120 is 14,400 points -- one buffer, one draw.
 *  Denser than this aliases into moire bands at the shallow end of the plane. */
const SIDE = 180
/** World units the lattice spans. */
const EXTENT = 160

const vertexShader = /* glsl */ `
  uniform float uTime;
  uniform float uSize;
  uniform float uAmplitude;
  uniform float uCenterGlow;
  uniform vec2 uMouse;
  varying float vGlow;

  void main() {
    vec3 p = position;

    // Two long waves crossing at an angle, plus a third much slower one that
    // keeps the pattern from reading as a repeating tile.
    //
    // These rates and the displacement below are the difference between a
    // background that moves and one that only moves in principle: the first
    // pass was slow and shallow enough that under a second's observation it
    // was indistinguishable from a still image.
    float a = sin(p.x * 0.075 + uTime * 1.1);
    float b = sin(p.z * 0.061 - uTime * 0.85);
    float c = sin((p.x + p.z) * 0.026 + uTime * 0.5);
    float swell = (a * 0.55 + b * 0.5 + c * 0.9) * uAmplitude;

    p.y += swell * 6.5;

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;

    // The lattice is always faintly there and the swell lights a band of it as
    // it passes. Letting troughs go fully dark instead leaves only the crest
    // visible, which reads as a stray patch of dots rather than a network.
    //
    // depth used to fall all the way to 0.0 past 95 units out, which measured
    // dead flat -- literally the bare background colour, no dots at all -- for
    // the farthest ~20% of the screen. A camera this high looks across enough
    // of the plane that "far" is reached well inside the frame, so a hard cutoff
    // reads as the animation switching off rather than fading. depthFloor keeps
    // every point at least dimly present regardless of distance.
    float crest = smoothstep(-1.1, 1.5, swell);
    float depthFloor = 0.22;
    float depth = depthFloor + (1.0 - depthFloor) * (1.0 - smoothstep(30.0, 170.0, -mv.z));
    // The three waves periodically drift into phase near their troughs at once,
    // so crest can go to 0 across the whole lattice at the same time -- not just
    // one point. A per-point floor doesn't cover that: it only keeps a dim point
    // dim, it doesn't stop every point from being dim simultaneously, which reads
    // as the whole background fading to black. glowFloor is a floor on the base
    // term itself, so a global trough still leaves the lattice visibly present.
    float glowFloor = 0.5;
    float baseGlow = (glowFloor + crest * (1.0 - glowFloor)) * depth;

    vec2 ndc = gl_Position.xy / gl_Position.w;

    // uCenterGlow pulls extra brightness toward the middle of the frame --
    // used for the static image so the eye lands on the card, not the corners.
    // Zero for the running animation, which stays evenly lit.
    float centerFalloff = 1.0 - smoothstep(0.0, 1.1, length(ndc));
    float centerBoost = uCenterGlow * centerFalloff * 1.4;

    // A soft spotlight that follows the pointer, in both the static image and
    // the running animation. uMouse sits far off-screen until the first move,
    // so this is 0 everywhere before that.
    float mouseFalloff = 1.0 - smoothstep(0.0, 0.4, length(ndc - uMouse));
    float mouseBoost = mouseFalloff * 1.6;

    float boost = 1.0 + centerBoost + mouseBoost;
    vGlow = min(baseGlow * boost, 1.4);

    gl_PointSize = uSize * (0.35 + crest * 1.55) * (0.35 + depth * 0.65) * (24.0 / -mv.z) * (1.0 + centerBoost * 0.35 + mouseBoost * 0.35);
  }
`

const fragmentShader = /* glsl */ `
  uniform vec3 uColor;
  varying float vGlow;

  void main() {
    // Round the square point sprite off, and fade it at the rim.
    vec2 d = gl_PointCoord - vec2(0.5);
    float r = dot(d, d);
    if (r > 0.25) discard;
    float falloff = 1.0 - smoothstep(0.04, 0.25, r);

    float alpha = falloff * vGlow * 0.8;
    if (alpha < 0.004) discard;
    gl_FragColor = vec4(uColor, alpha);
  }
`

/** How many light-links exist at once. Each fires, pauses, and fires again. */
const LINK_COUNT = 8

/** The brand tri-color, from `docs/frontend/zenon-design-system.md`: Zenon
 *  green, Quasar blue (ZNN's sister token), and the reserved Plasma pink
 *  accent. Each bar picks one at random when it's built, weighted by
 *  LINK_SPAWN_WEIGHTS below rather than drawn uniformly. */
const LINK_COLORS = [0x00d557, 0x0061eb, 0xf91690]

/**
 * Relative spawn weight per LINK_COLORS entry -- not a uniform 1-in-3 draw.
 * Green is also the lattice's own color (see uColor below), so a green link
 * riding over green dots reads as one continuous bright shape rather than a
 * distinct bar, which makes green links register far more often than an even
 * split would suggest even before accounting for randomness. Weighting it
 * down and blue/pink up here corrects for that at the source, rather than
 * relying on brightness alone (LINK_BRIGHTNESS, above) to make the rarer
 * colors stand out once they do spawn. Blue was overcorrected on the first
 * pass (1.6, level with pink) and started dominating in turn, so it's been
 * eased down twice since -- now just under green.
 */
const LINK_SPAWN_WEIGHTS = [1, 0.9, 1.6]

/** Picks a LINK_COLORS index according to LINK_SPAWN_WEIGHTS. */
function pickColorIndex(): number {
  const total = LINK_SPAWN_WEIGHTS.reduce((sum, w) => sum + w, 0)
  let r = Math.random() * total
  for (let i = 0; i < LINK_SPAWN_WEIGHTS.length; i++) {
    r -= LINK_SPAWN_WEIGHTS[i]
    if (r <= 0) return i
  }
  return LINK_SPAWN_WEIGHTS.length - 1
}

/**
 * Perceived-brightness compensation, one multiplier per LINK_COLORS entry.
 *
 * Additive blending sums raw RGB, so at equal alpha the three brand colors
 * do not read as equally bright: by Rec.709 luma weighting (blue and red
 * contribute far less than green to perceived brightness), the blue is
 * roughly half as bright as the green, and the pink -- which is red-heavy
 * with a comparatively small blue channel -- loses that blue channel first
 * as it dims, which is what reads as plain red rather than pink at low
 * brightness. Scaling each color's RGB up uniformly before it reaches the
 * shader preserves hue while raising every channel together, including the
 * pink's blue channel, so it stays legibly pink instead of drifting to red.
 * The scale factors below equalize luma against the green (left at 1) and
 * are clamped per-channel by the GPU, not applied here, so hue is preserved
 * exactly up to that clamp.
 */
const LINK_BRIGHTNESS = [1, 1.75, 1.9]

/**
 * A link is a ribbon of quads laid exactly along one row or column of the
 * lattice, so its vertices sit on the same (x, z) as the dots it passes over
 * -- it connects real nodes rather than cutting an arbitrary line across the
 * plane. The vertex shader re-runs the lattice's own wave formula on those
 * coordinates so the bar rides the same swell the dots do, instead of
 * floating flat while the surface under it moves.
 */
const linkVertexShader = /* glsl */ `
  uniform float uTime;
  attribute vec3 aOffset;
  attribute vec3 aColor;
  attribute float aT;
  attribute float aSeed;
  attribute float aSpeed;
  varying float vGlow;
  varying vec3 vColor;

  void main() {
    vColor = aColor;
    vec3 p = position + aOffset;

    float a = sin(p.x * 0.075 + uTime * 1.1);
    float b = sin(p.z * 0.061 - uTime * 0.85);
    float c = sin((p.x + p.z) * 0.026 + uTime * 0.5);
    float swell = a * 0.55 + b * 0.5 + c * 0.9;
    // Lifted a hair above the surface so the bar reads as a distinct thing
    // running over the lattice rather than fused into the dots themselves.
    p.y += swell * 6.5 + 0.15;

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;

    // Each link fires a bar down its length, then goes dark for a stretch
    // before firing again -- window is the fraction of the cycle it's lit
    // for. aSeed staggers links so they don't all fire together; aSpeed
    // varies how fast each one crosses.
    float window = 0.4;
    float barLength = 0.12;
    float edge = 0.015;
    float phase = fract(uTime * aSpeed + aSeed);
    float pulse = phase / window;
    float rel = pulse - aT;
    float glow = 0.0;
    if (phase < window) {
      glow = smoothstep(0.0, edge, rel) - smoothstep(barLength, barLength + edge, rel);
    }
    vGlow = glow;
  }
`

const linkFragmentShader = /* glsl */ `
  varying float vGlow;
  varying vec3 vColor;

  void main() {
    if (vGlow < 0.02) discard;
    gl_FragColor = vec4(vColor, vGlow);
  }
`

function buildLinks(): Mesh {
  const spacing = EXTENT / (SIDE - 1)
  const halfWidth = spacing * 0.55

  const positions: number[] = []
  const offsets: number[] = []
  const colors: number[] = []
  const aT: number[] = []
  const aSeed: number[] = []
  const aSpeed: number[] = []
  const indices: number[] = []

  let vertexAt = 0
  for (let link = 0; link < LINK_COUNT; link++) {
    const isRow = Math.random() < 0.5
    const lineIndex = Math.floor(Math.random() * SIDE)
    const seed = Math.random()
    const speed = 0.35 + Math.random() * 0.5
    const fixedCoord = (lineIndex / (SIDE - 1) - 0.5) * EXTENT
    const colorIndex = pickColorIndex()
    const color = new Color(LINK_COLORS[colorIndex]).multiplyScalar(LINK_BRIGHTNESS[colorIndex])

    for (let i = 0; i < SIDE - 1; i++) {
      const t0 = i / (SIDE - 1)
      const t1 = (i + 1) / (SIDE - 1)
      const along0 = (i / (SIDE - 1) - 0.5) * EXTENT
      const along1 = ((i + 1) / (SIDE - 1) - 0.5) * EXTENT

      const x0 = isRow ? along0 : fixedCoord
      const z0 = isRow ? fixedCoord : along0
      const x1 = isRow ? along1 : fixedCoord
      const z1 = isRow ? fixedCoord : along1
      const dx = isRow ? 0 : halfWidth
      const dz = isRow ? halfWidth : 0

      // Four vertices per segment: the two ends of the row/column node, each
      // pushed out to either side by aOffset to give the bar its width.
      positions.push(x0, 0, z0, x0, 0, z0, x1, 0, z1, x1, 0, z1)
      offsets.push(-dx, 0, -dz, dx, 0, dz, -dx, 0, -dz, dx, 0, dz)
      colors.push(color.r, color.g, color.b, color.r, color.g, color.b, color.r, color.g, color.b, color.r, color.g, color.b)
      aT.push(t0, t0, t1, t1)
      aSeed.push(seed, seed, seed, seed)
      aSpeed.push(speed, speed, speed, speed)

      const a = vertexAt
      const b = vertexAt + 1
      const c = vertexAt + 2
      const d = vertexAt + 3
      indices.push(a, b, c, b, d, c)
      vertexAt += 4
    }
  }

  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3))
  geometry.setAttribute('aOffset', new Float32BufferAttribute(offsets, 3))
  geometry.setAttribute('aColor', new Float32BufferAttribute(colors, 3))
  geometry.setAttribute('aT', new Float32BufferAttribute(aT, 1))
  geometry.setAttribute('aSeed', new Float32BufferAttribute(aSeed, 1))
  geometry.setAttribute('aSpeed', new Float32BufferAttribute(aSpeed, 1))
  geometry.setIndex(indices)

  const material = new ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
    },
    vertexShader: linkVertexShader,
    fragmentShader: linkFragmentShader,
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    blending: AdditiveBlending,
  })

  return new Mesh(geometry, material)
}

export interface Background {
  dispose(): void
}

export interface BackgroundOptions {
  /** Overrides `prefers-reduced-motion`. `true` freezes the background to a
   *  single still frame; `false` runs the full animation. Lets a page-level
   *  toggle force either state regardless of the OS setting. */
  reducedMotion?: boolean
}

export function startBackground(canvas: HTMLCanvasElement, opts: BackgroundOptions = {}): Background | null {
  let renderer: WebGLRenderer
  try {
    renderer = new WebGLRenderer({ canvas, antialias: false, alpha: true, powerPreference: 'low-power' })
  } catch {
    return null
  }

  renderer.setClearColor(0x000000, 0)

  const scene = new Scene()
  const camera = new PerspectiveCamera(52, 1, 0.1, 400)
  // The camera's pitch has to clear the vertical field of view: if the
  // downward tilt is shallower than half the FOV, the top of the frame points
  // above the horizon into empty space where there is no plane at all -- not
  // faded, just absent, which measured as flat background colour for the top
  // 20% of the screen. Pitching steeper here, and widening the plane (EXTENT,
  // SIDE above) so the shallow top-of-frame rays still land on geometry
  // instead of running past its edge.
  camera.position.set(0, 20, 18)
  camera.lookAt(0, 0, -6)

  const positions = new Float32Array(SIDE * SIDE * 3)
  let at = 0
  for (let ix = 0; ix < SIDE; ix++) {
    for (let iz = 0; iz < SIDE; iz++) {
      positions[at++] = (ix / (SIDE - 1) - 0.5) * EXTENT
      positions[at++] = 0
      positions[at++] = (iz / (SIDE - 1) - 0.5) * EXTENT
    }
  }

  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3))

  const material = new ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uSize: { value: 2.5 },
      uAmplitude: { value: 1 },
      uCenterGlow: { value: 0 },
      // Off-screen sentinel: further than the 0.4 NDC falloff radius from any
      // point on screen, so the spotlight is invisible until the first move.
      uMouse: { value: new Vector2(10, 10) },
      uColor: { value: new Color(0x67e646) },
    },
    vertexShader,
    fragmentShader,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
  })

  const lattice = new Points(geometry, material)
  scene.add(lattice)

  const reducedMotion = opts.reducedMotion ?? window.matchMedia('(prefers-reduced-motion: reduce)').matches

  const resize = (redraw: boolean): void => {
    const width = canvas.clientWidth || window.innerWidth
    const height = canvas.clientHeight || window.innerHeight
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setSize(width, height, false)
    camera.aspect = width / height
    camera.updateProjectionMatrix()
    if (redraw) renderer.render(scene, camera)
  }

  // The pointer spotlight, in NDC (-1..1). `redraw` is only needed on the
  // static path -- the running animation already re-renders every frame, so
  // the uniform update alone is picked up on the next tick.
  const setMouse = (x: number, y: number, redraw: boolean): void => {
    material.uniforms.uMouse.value.set(x, y)
    if (redraw) renderer.render(scene, camera)
  }
  const onPointerMove = (redraw: boolean) => (e: PointerEvent): void => {
    const rect = canvas.getBoundingClientRect()
    const x = ((e.clientX - rect.left) / rect.width) * 2 - 1
    const y = -(((e.clientY - rect.top) / rect.height) * 2 - 1)
    setMouse(x, y, redraw)
  }
  const onPointerLeave = (redraw: boolean) => (): void => setMouse(10, 10, redraw)

  // "Stop motion" means stop -- a single still frame of the calm, flat
  // lattice, the same image the page showed before any animation existed.
  // uAmplitude at 0 removes the swell entirely rather than freezing it
  // mid-wave, so this doesn't read as a paused animation, just a resting
  // grid. No rotation, no bars, no requestAnimationFrame loop underneath it.
  // Resize still redraws that one frame at the new size so it never stretches.
  if (reducedMotion) {
    material.uniforms.uAmplitude.value = 0
    material.uniforms.uCenterGlow.value = 1
    resize(true)
    const onResize = (): void => resize(true)
    const move = onPointerMove(true)
    const leave = onPointerLeave(true)
    window.addEventListener('resize', onResize)
    canvas.addEventListener('pointermove', move)
    canvas.addEventListener('pointerleave', leave)
    return {
      dispose(): void {
        window.removeEventListener('resize', onResize)
        canvas.removeEventListener('pointermove', move)
        canvas.removeEventListener('pointerleave', leave)
        geometry.dispose()
        material.dispose()
        renderer.dispose()
      },
    }
  }

  const links = buildLinks()
  scene.add(links)
  const linkMaterial = links.material as ShaderMaterial

  const onResize = (): void => resize(false)
  resize(false)
  window.addEventListener('resize', onResize)

  const move = onPointerMove(false)
  const leave = onPointerLeave(false)
  canvas.addEventListener('pointermove', move)
  canvas.addEventListener('pointerleave', leave)

  const speed = 0.6
  material.uniforms.uAmplitude.value = 0.8
  let frame = 0
  let running = true
  const start = performance.now()

  const tick = (): void => {
    if (!running) return
    frame = requestAnimationFrame(tick)
    const t = ((performance.now() - start) / 1000) * speed
    material.uniforms.uTime.value = t
    // The swell alone is not enough to rely on: the three waves periodically
    // drift into phase and the field goes nearly still for a stretch. A
    // constant slow rotation underneath it means there is always movement,
    // whatever the waves happen to be doing. A full turn takes about 3.5
    // minutes -- gentle, but never mistakable for a still image.
    lattice.rotation.y = t * 0.055
    linkMaterial.uniforms.uTime.value = t
    links.rotation.y = lattice.rotation.y
    renderer.render(scene, camera)
  }

  tick()

  // A background nobody is looking at should not cost a phone its battery.
  const onVisibility = (): void => {
    if (document.hidden) {
      running = false
      cancelAnimationFrame(frame)
    } else if (!running) {
      running = true
      tick()
    }
  }
  document.addEventListener('visibilitychange', onVisibility)

  return {
    dispose(): void {
      running = false
      cancelAnimationFrame(frame)
      window.removeEventListener('resize', onResize)
      canvas.removeEventListener('pointermove', move)
      canvas.removeEventListener('pointerleave', leave)
      document.removeEventListener('visibilitychange', onVisibility)
      geometry.dispose()
      material.dispose()
      links.geometry.dispose()
      linkMaterial.dispose()
      renderer.dispose()
    },
  }
}
