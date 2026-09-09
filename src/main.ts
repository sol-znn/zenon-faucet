import './style.css'

import type { Background } from './bg.ts'
import {
  ClaimError,
  faucetGlyphs,
  forgetClaim,
  outstandingClaim,
  resumeClaim,
  runClaim,
  sendPp,
  userBalance,
  type ClaimRecord,
  type ClaimState,
  type Phase,
  type StepBlocks,
  type StepKey,
} from './claim.ts'
import { MAX_GLYPHS, PP_PER_GLYPH, UNLOCK_TIMEOUT_MS, network } from './config.ts'
import * as syrius from './wallet/syrius.ts'

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T

const ui = {
  bg: el<HTMLCanvasElement>('bg'),
  less: el<HTMLButtonElement>('less'),
  more: el<HTMLButtonElement>('more'),
  n: el<HTMLOutputElement>('n'),
  cost: el<HTMLElement>('cost'),
  wallet: el<HTMLElement>('wallet'),
  connect: el<HTMLButtonElement>('connect'),
  claim: el<HTMLButtonElement>('claim'),
  supply: el<HTMLElement>('supply'),
  status: el<HTMLElement>('status'),
  line: el<HTMLElement>('line'),
  msg: el<HTMLElement>('msg'),
  msgdots: el<HTMLElement>('msgdots'),
  steps: el<HTMLOListElement>('steps'),
  stepsBox: el<HTMLDetailsElement>('stepsBox'),
  stepsSummary: el<HTMLElement>('stepsSummary'),
  cancel: el<HTMLButtonElement>('cancel'),
  done: el<HTMLElement>('done'),
  doneMsg: el<HTMLElement>('doneMsg'),
  again: el<HTMLButtonElement>('again'),
  errorBox: el<HTMLElement>('errorBox'),
  error: el<HTMLElement>('error'),
  retry: el<HTMLButtonElement>('retry'),
  dev: el<HTMLElement>('dev'),
  devText: el<HTMLElement>('devText'),
  fund: el<HTMLButtonElement>('fund'),
  netName: el<HTMLElement>('netName'),
  netTag: el<HTMLElement>('netTag'),
  motion: el<HTMLButtonElement>('motion'),
  foot: el<HTMLElement>('foot'),
}

const num = new Intl.NumberFormat('en-US')

let glyphs = 1
let address: string | null = null
let chainId: number | null = null
let running = false

// Loaded on its own so three.js lands in a second chunk: the card and the
// faucet balance are the page, and neither should wait on a decoration.
//
// Motion defaults on and ignores `prefers-reduced-motion` for that default --
// the toggle button is the actual accessibility affordance. Clicking it stops
// the canvas to a single still frame of the lattice, not a slowed-down loop,
// and the choice persists across visits.
const MOTION_KEY = 'faucet:reduced-motion'

function storedReducedMotion(): boolean | null {
  try {
    const v = localStorage.getItem(MOTION_KEY)
    return v === null ? null : v === 'true'
  } catch {
    return null
  }
}

let background: Background | null = null

// Icon-only: a pause glyph while running (click stops it), a play glyph while
// stopped (click resumes it) -- the standard transport-control pairing, so
// the icon alone carries what the click does without a text label.
const PAUSE_ICON =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><rect x="5" y="4" width="5" height="16" rx="1"/><rect x="14" y="4" width="5" height="16" rx="1"/></svg>'
const PLAY_ICON =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M7 4l13 8-13 8z"/></svg>'

// The initial call races the dynamic import against a possible early click:
// if someone hits the button before three.js has even loaded, two calls are
// in flight at once. Without a guard, whichever `import()` resolves last wins
// and silently overwrites `background`, leaking the other call's renderer and
// event listeners -- two backgrounds both drawing to the same canvas. A token
// makes a call that's been superseded by a newer one a no-op instead.
let motionToken = 0

async function applyMotion(reduced: boolean): Promise<void> {
  const token = ++motionToken
  ui.motion.setAttribute('aria-pressed', String(reduced))
  const label = reduced ? 'Start motion' : 'Stop motion'
  ui.motion.setAttribute('aria-label', label)
  ui.motion.title = label
  ui.motion.innerHTML = reduced ? PLAY_ICON : PAUSE_ICON
  try {
    const { startBackground } = await import('./bg.ts')
    if (token !== motionToken) return
    background?.dispose()
    background = startBackground(ui.bg, { reducedMotion: reduced })
  } catch {
    /* no background; the flat one underneath is fine */
  }
}

ui.motion.addEventListener('click', () => {
  const reduced = ui.motion.getAttribute('aria-pressed') !== 'true'
  try {
    localStorage.setItem(MOTION_KEY, String(reduced))
  } catch {
    /* the choice just won't survive a reload */
  }
  applyMotion(reduced)
})

// Motion defaults on, regardless of `prefers-reduced-motion` -- the toggle is
// there for anyone who wants it off, but a first visit doesn't assume it.
applyMotion(storedReducedMotion() ?? false)

// ---------------------------------------------------------------------------
// the step list
// ---------------------------------------------------------------------------

/**
 * The five blocks, in the order they are published, and which phase each is
 * waiting on. Showing them all from the start means the wait has a shape --
 * somebody watching knows how much is left rather than only what is happening.
 */
const STEPS: { key: StepKey; label: (n: number) => string; phases: Phase[] }[] = [
  {
    key: 'pp-lock',
    label: (n) => `You lock ${num.format(n * Number(PP_PER_GLYPH))} PP`,
    phases: ['checking', 'awaiting-approval', 'confirming-lock'],
  },
  {
    key: 'glyphs-lock',
    label: (n) => `Faucet locks ${num.format(n)} GLYPH`,
    phases: ['locking-glyphs'],
  },
  { key: 'pp-unlock', label: () => 'PlasmaPoints released to the faucet', phases: ['unlocking-pp'] },
  { key: 'glyphs-redeem', label: () => 'GLYPH redeemed for you', phases: ['redeeming', 'receiving'] },
  { key: 'pp-settle', label: () => 'PlasmaPoints settled into the faucet', phases: ['sweeping'] },
]

const EXPLORER_BLOCK_URL = 'https://zenonhub.io/explorer/block/'

const LINK_ICON =
  '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 6H5a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-5"/><path d="M14 4h6v6"/><path d="M11 13L20 4"/></svg>'

/**
 * The block a step published, on zenonhub.
 *
 * Always rendered, on whatever chain this build talks to. zenonhub only indexes
 * mainnet, so a devnet hash 404s — which is the right trade: a deployed page is
 * a mainnet page, and hiding the links everywhere else would mean the one
 * feature nobody can check before shipping it.
 */
function explorerLink(hash: string): HTMLAnchorElement {
  const a = document.createElement('a')
  a.className = 'txlink'
  a.href = EXPLORER_BLOCK_URL + hash
  a.target = '_blank'
  a.rel = 'noopener noreferrer'
  a.title = `${hash.slice(0, 10)}… on zenonhub`
  a.setAttribute('aria-label', `view block ${hash.slice(0, 10)} on zenonhub`)
  a.innerHTML = LINK_ICON
  return a
}

function renderSteps(phase: Phase, blocks: StepBlocks = {}): void {
  const active = STEPS.findIndex((s) => s.phases.includes(phase))
  ui.steps.replaceChildren(
    ...STEPS.map((step, i) => {
      const li = document.createElement('li')
      const text = document.createElement('span')
      text.textContent = step.label(glyphs)
      li.append(text)

      // Only once the block exists. A step that has not published anything gets
      // no icon rather than a dead one.
      const hash = blocks[step.key]
      if (hash) li.append(explorerLink(hash))

      if (phase === 'done' || (active >= 0 && i < active)) li.className = 'done'
      else if (i === active) li.className = 'active'
      return li
    }),
  )
}

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

function short(a: string): string {
  return `${a.slice(0, 8)}…${a.slice(-4)}`
}

function renderAmount(): void {
  ui.n.textContent = String(glyphs)
  ui.cost.textContent = num.format(glyphs * Number(PP_PER_GLYPH))
  ui.less.disabled = running || glyphs <= 1
  ui.more.disabled = running || glyphs >= MAX_GLYPHS

  // The step labels carry the amount, so they follow it -- but only while the
  // list is idle. `setBusy(false)` runs after `renderDone` has already drawn the
  // finished list, and redrawing it here would blank the five explorer links a
  // quarter-second after showing them.
  if (!running && ui.done.hidden) renderSteps('idle')
}

const SYRIUS_RELEASES_URL = 'https://github.com/sol-znn/syrius-extension/releases'

/**
 * The one box for anything that stopped, with the one button that continues it.
 *
 * Retry is offered whenever there is still an outstanding record, which is what
 * "money is on chain" looks like from here. Every step past the user's lock is
 * idempotent: `resumeClaim` re-reads both legs, waits on an unlock that is
 * already published, and signs only what nobody has signed yet.
 *
 * `tone` is the difference between a claim that broke and a claim the user
 * stopped. Both leave exactly the same thing to do; only one of them is bad news.
 */
function showError(message: string | null, tone: 'error' | 'notice' = 'error'): void {
  ui.errorBox.hidden = message === null
  ui.errorBox.classList.toggle('notice', tone === 'notice')
  ui.error.textContent = message ?? ''
  ui.retry.hidden = message === null || outstandingClaim() === null
}

function setBusy(state: boolean): void {
  running = state
  ui.claim.disabled = state || !address
  renderAmount()
}

/**
 * Aborts whatever claim is in flight. Held at module scope because the button
 * that fires it and the call that owns it are in different places.
 *
 * Cancelling stops this page waiting; it does not and cannot undo a block that
 * is already published. What it buys is the ability to walk away from a wait --
 * a resume on load starts by itself, and without this the only way out of one
 * that is going to take six minutes is to close the tab.
 */
let inFlight: AbortController | null = null

/**
 * How long a claim runs before Cancel appears at all.
 *
 * A claim that is going normally does not want this button on screen: it takes
 * under a minute, every step is doing something, and an out offered that early
 * reads as a suggestion that something is wrong. So it stays hidden until the
 * run has been going longer than the budget a single redeem gets — past that,
 * whatever is happening has already outlasted the longest wait in the flow, and
 * walking away is a reasonable thing to want.
 */
const CANCEL_AFTER_MS = UNLOCK_TIMEOUT_MS

ui.cancel.addEventListener('click', () => {
  ui.cancel.disabled = true
  inFlight?.abort()
})

/**
 * Runs one claim attempt: the shared shape of a fresh claim, a resume on load,
 * and a retry. Owns the abort controller, so exactly one is cancellable at a
 * time and the Cancel button never points at a finished run.
 */
async function attempt(
  run: (signal: AbortSignal) => Promise<ClaimState>,
  whenStopped: (err: unknown) => string,
): Promise<void> {
  const controller = new AbortController()
  inFlight = controller
  seenBlocks = 0
  ui.cancel.disabled = false
  ui.cancel.hidden = true
  const offerCancel = setTimeout(() => {
    ui.cancel.hidden = false
  }, CANCEL_AFTER_MS)
  setBusy(true)
  showError(null)
  try {
    renderDone(await run(controller.signal))
  } catch (err) {
    ui.status.hidden = true
    if (controller.signal.aborted) {
      showError(
        'stopped. Nothing was undone — whatever this claim has already published is still on chain, and Retry picks it up from there.',
        'notice',
      )
    } else {
      showError(whenStopped(err))
    }
  } finally {
    clearTimeout(offerCancel)
    ui.cancel.hidden = true
    if (inFlight === controller) inFlight = null
    setBusy(false)
  }
}

async function renderWallet(): Promise<void> {
  if (!address) {
    if (syrius.providerPresent()) {
      ui.connect.textContent = 'Connect Syrius'
      ui.wallet.replaceChildren(ui.connect)
    } else {
      // No point offering a button that can only fail: send them to install it
      // instead of trying to connect and explaining why that didn't work.
      const install = document.createElement('a')
      install.className = 'ghost'
      install.href = SYRIUS_RELEASES_URL
      install.target = '_blank'
      install.rel = 'noopener noreferrer'
      install.textContent = 'Get Syrius Extension'
      ui.wallet.replaceChildren(install)
    }
    ui.claim.disabled = true
    ui.dev.hidden = true
    return
  }

  // Rebuilt only the first time this address shows up. A periodic or
  // node-change-triggered re-render reads the same account far more often
  // than it reads a different one, and replacing the row every time would
  // blank the balance back to "…" on a cadence someone can see -- exactly
  // the flicker `refreshBalance` below exists to avoid.
  const existing = ui.wallet.querySelector<HTMLElement>('.account')
  if (existing?.dataset.address !== address) {
    const row = document.createElement('div')
    row.className = 'account'
    row.dataset.address = address
    const addr = document.createElement('span')
    addr.className = 'addr'
    addr.textContent = short(address)
    addr.title = address
    const bal = document.createElement('span')
    bal.className = 'bal'
    bal.textContent = '…'
    row.append(addr, bal)
    ui.wallet.replaceChildren(row)
  }
  ui.claim.disabled = running

  // Whether Syrius is even on the right chain is exactly as perishable as the
  // balances -- switching networks in the extension doesn't always fire an
  // event this page catches -- so it's re-checked on every call here, not
  // only the first, and cleared the moment it stops being true rather than
  // lingering once the extension is switched back.
  const mismatched = chainId !== null && chainId !== network.chainId
  if (mismatched) {
    showError(
      `Syrius is on chain ${chainId} and this page is built for chain ${network.chainId} (${network.name}). Switch networks in the extension.`,
    )
    ui.claim.disabled = true
    chainMismatchShown = true
  } else if (chainMismatchShown) {
    showError(null)
    chainMismatchShown = false
  }

  await refreshBalance()
}

/** Tracks whether the error box is currently showing *this* function's own
 * message, so a later call can clear it without stomping some other error
 * (a claim failure, say) that happens to be on screen at the same time. */
let chainMismatchShown = false

/**
 * Re-reads the connected account's PP balance in place, without tearing down
 * and rebuilding the wallet row -- the address span and its title stay put, so
 * a periodic refresh doesn't flicker the whole row every time it lands.
 *
 * A no-op when nothing is connected, or when the row `renderWallet` built for
 * the current address is no longer on screen (an account switch or disconnect
 * mid-flight left it stale) -- either way there's nothing to update.
 */
let balancesInFlight = false
async function refreshBalance(): Promise<void> {
  if (!address) return
  const bal = ui.wallet.querySelector<HTMLElement>('.bal')
  if (!bal) return
  try {
    const pp = await userBalance(address, network.ppZts)
    bal.textContent = `${num.format(Number(pp))} PP`
    renderDev(pp)
  } catch {
    bal.textContent = 'balance unavailable'
  }
}

/**
 * The faucet's own GLYPH balance, the connected account's PP balance, and
 * whether Syrius is still even on the chain this page talks to -- all three
 * are read off the same round trip to the wallet and the node, so they go
 * stale together and get refreshed together.
 *
 * Re-reading the chain id here (rather than only the two balances) is what
 * catches a network switch made in the extension between events: Syrius
 * announces `chainChanged` for that, and `readWallet` below already reacts to
 * it, but an announcement that doesn't fire -- or fires while this tab is in
 * the background and gets missed -- would otherwise leave the mismatch
 * banner (or its absence) wrong until the next thing that happens to call
 * `renderWallet`.
 */
async function refreshBalances(): Promise<void> {
  if (balancesInFlight) return
  balancesInFlight = true
  try {
    if (address) await readWallet()
    await refreshSupply()
  } finally {
    balancesInFlight = false
  }
}

/**
 * Devnet only. This build issues its own PP, so the faucet wallet owns the whole
 * supply and a freshly connected account has none -- the button is what makes
 * the page clickable end to end on a chain nobody else has used.
 */
function renderDev(pp: bigint): void {
  const needed = BigInt(glyphs) * PP_PER_GLYPH
  ui.dev.hidden = network.name !== 'devnet' || pp >= needed
  ui.devText.textContent = pp === 0n ? 'this account holds no PP' : `${pp} PP is not enough`
  ui.fund.textContent = `Send me ${num.format(Number(needed))} PP`
}

async function refreshSupply(): Promise<void> {
  try {
    const held = await faucetGlyphs()
    ui.supply.innerHTML = ''
    const strong = document.createElement('strong')
    strong.textContent = num.format(Number(held))
    ui.supply.append(strong, ` GLYPH left in the faucet`)
    if (held === 0n) ui.claim.disabled = true
  } catch {
    ui.supply.textContent = 'the faucet balance could not be read'
  }
}

// How many blocks the running claim had published as of the last renderState
// call -- each new one is PP or GLYPH moving, so it's a wallet action in its
// own right and earns the same refresh a connect or a finished claim gets,
// rather than making someone wait for the next poll to see it land.
let seenBlocks = 0

function renderState(state: ClaimState): void {
  showError(null)
  ui.status.hidden = false
  ui.line.hidden = false
  // Back to the undressed, always-open list: a claim in progress is the one
  // thing on screen, and a step nobody can see is a wait with no shape.
  ui.stepsBox.classList.add('live')
  ui.stepsBox.open = true
  ui.done.hidden = true
  ui.msg.textContent = state.message
  ui.msgdots.hidden = !state.busy
  renderSteps(state.phase, state.blocks)

  const published = Object.keys(state.blocks).length
  if (published > seenBlocks) {
    seenBlocks = published
    refreshBalances()
  }
}

/**
 * The step list survives the claim it describes, but it stops being the screen.
 *
 * It is the only place the blocks are named, so throwing it away at the moment
 * somebody is told it worked would throw away the receipts too. Folded into a
 * closed disclosure it stays one click from the tick without competing with it.
 */
function renderDone(state: ClaimState): void {
  ui.status.hidden = false
  ui.line.hidden = true
  ui.cancel.hidden = true
  renderSteps('done', state.blocks)

  const published = Object.keys(state.blocks).length
  ui.stepsSummary.textContent =
    published === 1 ? '1 transaction' : `${published} transactions`
  ui.stepsBox.classList.remove('live')
  ui.stepsBox.open = false

  ui.done.hidden = false
  ui.doneMsg.textContent = state.message
  refreshBalances()
}

// ---------------------------------------------------------------------------
// actions
// ---------------------------------------------------------------------------

async function readWallet(): Promise<void> {
  const state = await syrius.readState()
  address = state.address
  chainId = state.chainId
  await renderWallet()
}

ui.connect.addEventListener('click', async () => {
  showError(null)
  ui.connect.disabled = true
  try {
    const state = await syrius.connect()
    address = state.address
    chainId = state.chainId
    await renderWallet()
  } catch (err) {
    showError(err instanceof Error ? err.message : String(err))
  } finally {
    ui.connect.disabled = false
  }
})

ui.less.addEventListener('click', () => {
  glyphs = Math.max(1, glyphs - 1)
  renderAmount()
  if (address) renderWallet()
})

ui.more.addEventListener('click', () => {
  glyphs = Math.min(MAX_GLYPHS, glyphs + 1)
  renderAmount()
  if (address) renderWallet()
})

ui.fund.addEventListener('click', async () => {
  if (!address) return
  ui.fund.disabled = true
  const was = ui.fund.textContent
  ui.fund.textContent = 'sending…'
  try {
    await sendPp(address, BigInt(glyphs) * PP_PER_GLYPH)
    // The send has to be received by that account before it is spendable, and
    // only its own wallet can do that -- Syrius does it by itself.
    ui.devText.textContent = 'sent — Syrius will receive it in a moment'
    setTimeout(() => renderWallet(), 12_000)
  } catch (err) {
    showError(err instanceof Error ? err.message : String(err))
  } finally {
    ui.fund.disabled = false
    ui.fund.textContent = was
  }
})

ui.claim.addEventListener('click', () => {
  if (!address) return
  const user = address
  attempt(
    (signal) => runClaim({ glyphs, user, onState: renderState, signal }),
    // A ClaimError is already a sentence written for the person reading it --
    // a precondition that did not hold, or a lock that did not verify. Anything
    // else is a fault, and gets a frame that says so.
    (err) =>
      err instanceof ClaimError
        ? err.message
        : `the claim stopped: ${err instanceof Error ? err.message : String(err)}`,
  )
})

/**
 * Finishes a claim that stopped partway. The same call backs the Retry button
 * and the pick-up-on-load path, because they are the same job: what is left to
 * do is read off the record and the chain, not off which of the two asked.
 */
function finishOutstanding(record: ClaimRecord, frame: (detail: string) => string): void {
  glyphs = record.glyphs
  attempt((signal) => resumeClaim(record, renderState, signal), (err) =>
    frame(err instanceof Error ? err.message : String(err)),
  )
}

ui.retry.addEventListener('click', () => {
  const record = outstandingClaim()
  // Only reachable if the record went away underneath the button -- another tab
  // finishing the same claim, or storage being cleared. Nothing left to retry.
  if (!record) {
    showError(null)
    return
  }
  finishOutstanding(record, (detail) => `the retry stopped: ${detail}`)
})

ui.again.addEventListener('click', () => {
  forgetClaim()
  ui.done.hidden = true
  ui.status.hidden = true
  ui.line.hidden = false
  ui.stepsBox.classList.add('live')
  ui.stepsBox.open = true
  showError(null)
  renderAmount()
})

// ---------------------------------------------------------------------------
// start
// ---------------------------------------------------------------------------

ui.netName.textContent = 'zenoglyphs'
ui.netTag.textContent = 'chmod -w, forever'

// Lights up green within a small radius of the footer -- close enough to
// forgive a pixel or two, not a generous hover zone around it.
const FOOT_RADIUS = 20
window.addEventListener('pointermove', (e) => {
  const rect = ui.foot.getBoundingClientRect()
  const dx = Math.max(rect.left - e.clientX, 0, e.clientX - rect.right)
  const dy = Math.max(rect.top - e.clientY, 0, e.clientY - rect.bottom)
  ui.foot.classList.toggle('near', Math.hypot(dx, dy) <= FOOT_RADIUS)
})

renderAmount()
refreshSupply()
readWallet()

// The extension announces these, and any of them invalidates what the page is
// showing: a different account has different balances and is a different payee.
syrius.onWalletChange(() => {
  if (!running) readWallet()
})

// A reload during a claim leaves PP locked on chain with the preimage in local
// storage. Picking it up is the difference between finishing and waiting out
// the expiry.
const pending = outstandingClaim()
if (pending) {
  finishOutstanding(pending, (detail) => `the interrupted claim could not be finished: ${detail}`)
}

// ---------------------------------------------------------------------------
// keeping the numbers current
// ---------------------------------------------------------------------------

/**
 * Both balances move without this page doing anything -- someone else claiming
 * drains the faucet, and a wallet can receive PP from outside this tab entirely
 * (the devnet funding button included). A claim's own blocks already trigger a
 * refresh the moment they publish; this is the backstop for everything else,
 * so the numbers on screen don't quietly go stale between clicks.
 *
 * Paused while a tab is hidden -- there is nothing to show anyone until they
 * come back, and it would only be spending RPC calls on an unwatched page --
 * and picked back up immediately on return rather than waiting out the rest
 * of the interval.
 */
const BALANCE_POLL_MS = 15_000

setInterval(() => {
  if (document.hidden) return
  refreshBalances()
}, BALANCE_POLL_MS)

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refreshBalances()
})
