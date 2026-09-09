// The claim: two HTLCs, one preimage, four blocks.
//
//   1. the user locks N x 1000 PP, payable to the faucet       [Syrius signs]
//   2. this page locks N GLYPH, payable to the user            [page signs]
//   3. this page unlocks leg 1, revealing the preimage         [page signs]
//   4. leg 2 is unlocked with the same preimage                [page, usually]
//
// Steps 3 and 4 work because `htlc.Unlock` may be called by anyone and pays
// `hashLocked` -- the address in the entry, never the caller. The contract's
// only caller check is `GetHtlcProxyUnlockStatus(hashLocked)`, which defaults to
// true. Step 4 is the one case where that default can be absent: an address that
// has called `DenyProxyUnlock` can only be paid by unlocking from itself, and
// that call is one-way. When it is, the same block is handed to Syrius for the
// user to sign instead -- `hashLocked` is always permitted to unlock itself.
// Step 3 never hits that: the faucet is `hashLocked` on leg 1 and is the account
// signing the unlock, and unlocking to yourself is always permitted.
//
// This page holds the preimage throughout, so this is a faucet the user trusts,
// not a trustless swap. The HTLCs are what make each leg atomic and refundable,
// not what remove the trust.

import { sha256 } from '@noble/hashes/sha2'

import {
  FAUCET_ACCOUNT_INDEX,
  FAUCET_MNEMONIC,
  GLYPHS_EXPIRY_SECONDS,
  LOCK_TIMEOUT_MS,
  PP_EXPIRY_SECONDS,
  PP_PER_GLYPH,
  UNLOCK_TIMEOUT_MS,
  network,
} from './config.ts'
import { packHtlcCreate, packHtlcUnlock } from './znn/abi.ts'
import { BlockPublisher, BLOCK_TYPE_USER_RECEIVE } from './znn/block.ts'
import { ZenonClient, htlcHashLock, type HtlcInfo } from './znn/client.ts'
import { HTLC_CONTRACT, fromBase64, fromHex, toHex } from './znn/primitives.ts'
import { Account } from './znn/wallet.ts'
import * as syrius from './wallet/syrius.ts'

export type Phase =
  | 'idle'
  | 'checking'
  | 'awaiting-approval'
  | 'confirming-lock'
  | 'locking-glyphs'
  | 'unlocking-pp'
  | 'redeeming'
  | 'receiving'
  | 'sweeping'
  | 'done'
  | 'failed'

/**
 * The five blocks a claim is made of, in the order they are published. Named
 * rather than indexed because the step list and the engine have to agree on
 * which block belongs to which line, and a number would let them drift.
 */
export type StepKey = 'pp-lock' | 'glyphs-lock' | 'pp-unlock' | 'glyphs-redeem' | 'pp-settle'

/** Block hash per step, filled in as each one publishes. For explorer links. */
export type StepBlocks = Partial<Record<StepKey, string>>

export interface ClaimState {
  phase: Phase
  /** The sentence under the spinner. Written for someone who is waiting. */
  message: string
  glyphs: number
  ppHtlcId?: string
  glyphsHtlcId?: string
  /** Set once the GLYPH is the user's. */
  redeemedFrom?: 'page' | 'user'
  blocks: StepBlocks
  error?: string
  /** True while a step is outstanding, so the UI can animate. */
  busy: boolean
}

export interface ClaimRecord {
  glyphs: number
  preimage: string
  user: string
  ppHtlcId?: string
  glyphsHtlcId?: string
  /** Kept on the record, not just in memory, so a reload does not lose links. */
  blocks?: StepBlocks
  phase: Phase
}

const STORAGE_KEY = 'zenon-faucet.claim'

export const client = new ZenonClient(network.rpcUrl)
export const faucet = Account.fromMnemonic(FAUCET_MNEMONIC, FAUCET_ACCOUNT_INDEX)
const publisher = new BlockPublisher(client, faucet, network.chainId)

/**
 * Where the locked PlasmaPoints are paid. It is `hashLocked` on the user's HTLC,
 * so the contract pays it whoever calls the unlock.
 *
 * Derived from the faucet wallet rather than configured, and that is the whole
 * point: the faucet sells GLYPH for PP, so the PP it charges has to land in the
 * account that is paying the GLYPH out. Written down separately this is one
 * literal away from a faucet that gives GLYPH away for nothing -- and if the
 * literal happens to be the claimant's own address, the unlock hands the PP
 * straight back and the swap has cost them nothing at all.
 */
export const RECIPIENT = faucet.address

/** Reads the balance the Claim button is spending against. */
export async function faucetGlyphs(): Promise<bigint> {
  return client.balanceOf(faucet.address, network.glyphsZts)
}

export async function userBalance(address: string, zts: string): Promise<bigint> {
  return client.balanceOf(address, zts)
}

/**
 * Sends PlasmaPoints from the faucet wallet. Devnet only, and the reason is
 * arithmetic rather than policy: this build issues its own PP, so the faucet
 * wallet owns the entire supply and no other account has any. Without this the
 * Claim button can never be pressed on a fresh chain.
 */
export async function sendPp(to: string, amount: bigint): Promise<string> {
  const hash = await publisher.send({
    toAddress: to,
    amount,
    tokenStandard: network.ppZts,
  })
  await client.waitForConfirmation(hash)
  return hash
}

function loadRecord(): ClaimRecord | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? (JSON.parse(raw) as ClaimRecord) : null
  } catch {
    return null
  }
}

/**
 * Written before anything is verified, and after every step that publishes.
 *
 * A new account block is unreadable for a momentum or two, so "pending" is the
 * normal answer immediately after publishing. Saving only on success loses the
 * id -- and a reload that cannot see an outstanding claim offers to start a new
 * one, which locks a second lot of PP that only expiry returns.
 */
function saveRecord(record: ClaimRecord | null): void {
  try {
    if (record) localStorage.setItem(STORAGE_KEY, JSON.stringify(record))
    else localStorage.removeItem(STORAGE_KEY)
  } catch {
    /* a page that cannot persist still works; it just cannot resume */
  }
}

export function outstandingClaim(): ClaimRecord | null {
  const record = loadRecord()
  return record && record.phase !== 'done' && record.phase !== 'failed' ? record : null
}

export function forgetClaim(): void {
  saveRecord(null)
}

export class ClaimError extends Error {}

function unixNow(): number {
  return Math.floor(Date.now() / 1000)
}

/**
 * Whatever signs for the user. In the page this is the Syrius extension; in
 * scripts/smoke.ts it is a local key, which is what lets the whole claim be
 * driven against a real chain without a browser or an extension in the loop.
 */
export type UserSigner = (spec: syrius.WalletSendSpec) => Promise<string>

const syriusSigner: UserSigner = (spec) => syrius.sendAccountBlock(spec, network.chainId)

export interface RunOptions {
  glyphs: number
  /** The address Syrius currently has selected. */
  user: string
  onState: (state: ClaimState) => void
  signal?: AbortSignal
  signAsUser?: UserSigner
}

/**
 * Drives one claim to completion, reporting every transition.
 *
 * Throws only when the claim cannot go on. Anything it has already published is
 * recorded first, so a failure never loses an id.
 */
export async function runClaim(options: RunOptions): Promise<ClaimState> {
  const { glyphs, user, onState, signal } = options
  const signAsUser = options.signAsUser ?? syriusSigner
  const state: ClaimState = { phase: 'checking', message: '', glyphs, blocks: {}, busy: true }

  const report = (phase: Phase, message: string, busy = true): void => {
    state.phase = phase
    state.message = message
    state.busy = busy
    onState({ ...state })
  }

  const fail = (message: string): never => {
    state.error = message
    report('failed', message, false)
    throw new ClaimError(message)
  }

  if (!Number.isInteger(glyphs) || glyphs < 1) fail('choose at least one GLYPH')
  const ppAmount = BigInt(glyphs) * PP_PER_GLYPH
  const glyphAmount = BigInt(glyphs)

  // ---- preconditions ------------------------------------------------------
  report('checking', 'checking balances and the chain')

  const momentum = await client.frontierMomentum()
  if (momentum.chainIdentifier !== network.chainId) {
    fail(`this page is built for chain ${network.chainId}; the node reports ${momentum.chainIdentifier}`)
  }
  // Also the check that keeps the two legs distinct: the faucet is the PP leg's
  // payee, so a claim by the faucet itself would pay both legs to one account.
  if (user === faucet.address) {
    fail('Syrius has the faucet’s own account selected — switch to another one')
  }

  const held = await faucetGlyphs()
  if (held < glyphAmount) {
    fail(`the faucet has ${held} GLYPH left, which is fewer than the ${glyphs} you asked for`)
  }
  const userPp = await client.balanceOf(user, network.ppZts)
  if (userPp < ppAmount) {
    fail(`you need ${ppAmount} PP to claim ${glyphs} GLYPH; that account holds ${userPp}`)
  }

  // Nothing to check about the PP leg's payee: it is the faucet, and the faucet
  // is the account that signs its unlock. `DenyProxyUnlock` only ever refuses a
  // *third party*, so an address unlocking an entry that pays itself is always
  // permitted. The GLYPH leg pays the user, and that one is checked -- at the
  // point of unlocking it, where the payee is finally known.

  // ---- the secret ---------------------------------------------------------
  const preimage = crypto.getRandomValues(new Uint8Array(32))
  const hashLock = sha256(preimage)
  const record: ClaimRecord = {
    glyphs,
    preimage: toHex(preimage),
    user,
    phase: 'awaiting-approval',
  }
  saveRecord(record)

  // ---- leg 1: the user locks PP -------------------------------------------
  report('awaiting-approval', 'approve the lock in Syrius')
  const ppHtlcId = await signAsUser({
    toAddress: HTLC_CONTRACT,
    amount: ppAmount,
    tokenStandard: network.ppZts,
    data: packHtlcCreate(RECIPIENT, unixNow() + PP_EXPIRY_SECONDS, hashLock),
  })
  // Recorded before it is verified: the id is the block hash and the wallet
  // answers the instant it publishes, well before a momentum confirms it.
  record.ppHtlcId = ppHtlcId
  record.phase = 'confirming-lock'
  saveRecord(record)
  state.ppHtlcId = ppHtlcId

  report('confirming-lock', 'waiting for your lock to be confirmed')
  const ppInfo = await client.waitForHtlc(ppHtlcId, { signal, timeoutMs: LOCK_TIMEOUT_MS })
  verifyPpLeg(ppInfo, { hashLock, ppAmount, fail })

  // Whoever actually signed is who gets paid. The extension re-reads its
  // selected account at signing time and announces a change only sometimes, so
  // the account that signed is not always the one this page was told about --
  // and paying the GLYPH to the address we assumed would be paying a stranger.
  const payee = ppInfo.timeLocked
  if (payee !== user) {
    record.user = payee
    saveRecord(record)
  }

  return finishClaim({
    record,
    state,
    report,
    payee,
    glyphAmount,
    preimage,
    hashLock,
    signal,
    signAsUser,
  })
}

function verifyPpLeg(
  info: HtlcInfo,
  ctx: { hashLock: Uint8Array; ppAmount: bigint; fail: (m: string) => never },
): void {
  // The wallet signs what it is given, but it is not this page's process. What
  // it actually published is read back off the chain rather than assumed.
  if (info.hashLocked !== RECIPIENT) {
    ctx.fail(`the lock pays ${info.hashLocked}, not the faucet`)
  }
  if (info.tokenStandard !== network.ppZts) {
    ctx.fail(`the lock is denominated in ${info.tokenStandard}, not PP`)
  }
  if (BigInt(info.amount) !== ctx.ppAmount) {
    ctx.fail(`the lock holds ${info.amount} PP, not the ${ctx.ppAmount} this claim is for`)
  }
  if (htlcHashLock(info) !== toHex(ctx.hashLock)) {
    ctx.fail('the lock carries a different hashlock, so this page cannot open it')
  }
}

interface FinishArgs {
  record: ClaimRecord
  state: ClaimState
  report: (phase: Phase, message: string, busy?: boolean) => void
  payee: string
  glyphAmount: bigint
  preimage: Uint8Array
  hashLock: Uint8Array
  signal?: AbortSignal
  signAsUser: UserSigner
}

/** How far back to look for an unlock somebody already signed. */
const UNLOCK_LOOKBACK = 20

/**
 * Files a published block under the step it belongs to, on both the record and
 * the live state -- the record so a reload keeps the link, the state so the UI
 * can show it now. Saving on every block is the same bargain `saveRecord` makes
 * everywhere else: a hash that is not written down the instant it exists is a
 * hash that a refresh turns into a claim nobody can point at.
 */
function noteBlock(record: ClaimRecord, state: ClaimState, key: StepKey, hash?: string): void {
  if (!hash) return
  record.blocks = { ...record.blocks, [key]: hash }
  state.blocks = { ...state.blocks, [key]: hash }
  saveRecord(record)
}

/**
 * The block in which `signer` unlocked this entry, if there is one.
 *
 * The first 36 bytes of the call data are the method id and the id argument, and
 * neither depends on the preimage -- so this matches an unlock for this HTLC
 * whoever built it and whatever they revealed. Deliberately reads unconfirmed
 * blocks too: a block that has been published but not yet processed is exactly
 * the state that looks, from a balance or an HTLC entry, identical to never
 * having published one at all.
 */
async function unlockBlock(signer: string, htlcId: string): Promise<string | null> {
  const want = packHtlcUnlock(fromHex(htlcId), new Uint8Array(0)).subarray(0, 36)
  try {
    const blocks = await client.recentAccountBlocks(signer, UNLOCK_LOOKBACK)
    const hit = blocks.find((b) => {
      if (b.toAddress !== HTLC_CONTRACT || !b.data) return false
      const data = fromBase64(b.data)
      return data.length >= want.length && want.every((byte, i) => data[i] === byte)
    })
    return hit?.hash ?? null
  } catch {
    // Never a reason to stop: the caller's fallback is to publish, which is
    // what it would have done without this check at all.
    return null
  }
}

interface SettleLeg {
  htlcId: string
  /** Whose chain to look on for an unlock that is already in flight. */
  signer: string
  publish: () => Promise<string>
  /** Told whether an unlock was already there, so the wait can say so. */
  announce: (alreadyInFlight: boolean) => void
  signal?: AbortSignal
}

/**
 * Unlocks one leg, and is safe to call on a leg that is already halfway.
 *
 * This is what makes Retry cheap. Three situations are indistinguishable from
 * the outside and only one of them wants a block:
 *
 *   - the entry is gone            -- settled, by us or by anyone. Nothing to do.
 *   - the entry is there, and an unlock naming it is already on the signer's
 *     chain                        -- published, still being processed. Wait.
 *   - the entry is there and nothing has been signed for it  -- publish.
 *
 * The middle one is the case a retry lands in most often, because the usual
 * reason to press Retry is a wait that timed out rather than a block that
 * failed. Publishing a second unlock there spends plasma to race a block that
 * was always going to win, and on a wallet mining its own PoW that race costs
 * more than the wait it is trying to shorten.
 *
 * Answers the block that did the unlocking in every case it can, including the
 * one where somebody else did it, so the step keeps its explorer link across a
 * reload rather than only in the visit that published it.
 */
async function settleLeg(leg: SettleLeg): Promise<string | undefined> {
  const existing = await unlockBlock(leg.signer, leg.htlcId)
  if ((await client.htlcById(leg.htlcId)) === null) return existing ?? undefined

  leg.announce(existing !== null)
  const hash = existing ?? (await leg.publish())

  await client.waitForHtlcCleared(leg.htlcId, {
    signal: leg.signal,
    timeoutMs: UNLOCK_TIMEOUT_MS,
  })
  return hash
}

/** Everything after the user's lock is confirmed. Also the resume path. */
async function finishClaim(args: FinishArgs): Promise<ClaimState> {
  const { record, state, report, payee, glyphAmount, preimage, signal } = args

  // ---- leg 2: the page locks GLYPH ----------------------------------------
  let justLocked = false
  if (!record.glyphsHtlcId) {
    report('locking-glyphs', 'locking your GLYPH')
    const id = await publisher.send(
      {
        toAddress: HTLC_CONTRACT,
        amount: glyphAmount,
        tokenStandard: network.glyphsZts,
        data: packHtlcCreate(payee, unixNow() + GLYPHS_EXPIRY_SECONDS, args.hashLock),
      },
      { signal },
    )
    record.glyphsHtlcId = id
    record.phase = 'locking-glyphs'
    state.glyphsHtlcId = id
    noteBlock(record, state, 'glyphs-lock', id)
    justLocked = true
  }
  const glyphsHtlcId = record.glyphsHtlcId!
  state.glyphsHtlcId = glyphsHtlcId
  // An id *is* the hash of the block that created the entry, so the two locking
  // steps need no separate bookkeeping to link -- but a record written by an
  // older build has no `blocks` at all, and this fills it in on resume.
  noteBlock(record, state, 'pp-lock', record.ppHtlcId)
  noteBlock(record, state, 'glyphs-lock', glyphsHtlcId)

  // Only wait for the entry when this call is what published it. On a resume it
  // may be gone because an earlier visit already unlocked it -- and waiting for
  // an entry that has been settled is a four-minute wait for something that is
  // never coming back, ending in "did not appear on chain in time" about an
  // HTLC that appeared, paid out, and closed.
  if (justLocked) {
    await client.waitForHtlc(glyphsHtlcId, { signal, timeoutMs: LOCK_TIMEOUT_MS })
  }

  // ---- leg 1 settles, and the preimage becomes public ----------------------
  const ppHtlcId = record.ppHtlcId
  if (ppHtlcId) {
    const unlocked = await settleLeg({
      htlcId: ppHtlcId,
      signer: faucet.address,
      publish: () =>
        publisher.send(
          { toAddress: HTLC_CONTRACT, data: packHtlcUnlock(fromHex(ppHtlcId), preimage) },
          { signal },
        ),
      announce: (inFlight) =>
        report(
          'unlocking-pp',
          inFlight
            ? 'your PlasmaPoints are already on their way to the faucet'
            : 'releasing your PlasmaPoints to the faucet',
        ),
      signal,
    })
    noteBlock(record, state, 'pp-unlock', unlocked)
  }
  record.phase = 'redeeming'
  saveRecord(record)

  // ---- leg 2 settles -------------------------------------------------------
  if (await client.htlcById(glyphsHtlcId)) {
    const unlockData = packHtlcUnlock(fromHex(glyphsHtlcId), preimage)
    // An address that has explicitly denied proxy unlock can only be paid by an
    // unlock it signs itself. The block is identical -- a different account
    // signs it, and it is that account's chain a retry looks on.
    const proxyAllowed = await client.proxyUnlockAllowed(payee)
    state.redeemedFrom = proxyAllowed ? 'page' : 'user'

    const redeemed = await settleLeg({
      htlcId: glyphsHtlcId,
      signer: proxyAllowed ? faucet.address : payee,
      publish: () =>
        proxyAllowed
          ? publisher.send({ toAddress: HTLC_CONTRACT, data: unlockData }, { signal })
          : args.signAsUser({
              toAddress: HTLC_CONTRACT,
              amount: 0n,
              tokenStandard: network.glyphsZts,
              data: unlockData,
            }),
      announce: (inFlight) =>
        report(
          'redeeming',
          inFlight
            ? 'your GLYPH is already being redeemed'
            : proxyAllowed
              ? 'redeeming your GLYPH'
              : 'your account requires you to redeem it yourself — approve it in Syrius',
        ),
      signal,
    })
    noteBlock(record, state, 'glyphs-redeem', redeemed)
  }

  // ---- the receives --------------------------------------------------------
  // The contract pays by sending, and nothing on Zenon credits an account
  // without a receive block. Syrius normally publishes the user's on its own;
  // this is an offer to do it now rather than a step the claim depends on.
  report('receiving', 'settling the GLYPH into your wallet')
  await tryReceive(payee, args.signAsUser, args.signal)

  // The faucet's side of the same rule, and it has no wallet watching for it:
  // unswept, the PP this claim just charged is an unreceived send rather than a
  // balance -- not spendable, and not there for the next claim.
  report('sweeping', 'settling the PlasmaPoints into the faucet')
  noteBlock(record, state, 'pp-settle', await sweepFaucet(args.signal))

  record.phase = 'done'
  saveRecord(record)
  state.redeemedFrom ??= 'page'
  report('done', `Claimed ${record.glyphs} GLYPH`, false)
  return { ...state }
}

/**
 * Receives what the contract paid the faucet.
 *
 * Best-effort on purpose. It runs after both legs have settled, so the claim is
 * already finished by the time it can fail, and the money is not at risk either
 * way -- an unswept send stays addressed to the faucet until some later sweep
 * picks it up. Failing the claim over the faucet's own bookkeeping would tell
 * the user their swap went wrong when it did not.
 */
async function sweepFaucet(signal?: AbortSignal): Promise<string | undefined> {
  let ppReceive: string | undefined
  try {
    const pending = await client.unreceivedBlocks(faucet.address)
    for (const block of pending.list ?? []) {
      const hash = await publisher.receive(block.hash, { signal })
      // The PP this claim charged is the one the step links to; anything else
      // pending is swept in the same pass because it is free to do so here.
      if (block.address === HTLC_CONTRACT && block.tokenStandard === network.ppZts) {
        ppReceive = hash
      }
      // Each receive extends the same chain, so the next needs this one in a
      // momentum before it can name it as its parent.
      await client.waitForConfirmation(hash, { signal })
    }
  } catch {
    /* still addressed to the faucet; the next claim's sweep will take it */
  }
  return ppReceive
}

/**
 * Offers the receive block to Syrius. Not every build will sign one, and a
 * refusal costs nothing: the GLYPH is already the user's and any wallet will
 * pick the block up by itself.
 */
async function tryReceive(
  payee: string,
  signAsUser: UserSigner,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    const pending = await client.unreceivedBlocks(payee)
    const block = (pending.list ?? []).find(
      (b) => b.address === HTLC_CONTRACT && b.tokenStandard === network.glyphsZts,
    )
    if (!block) return false
    await signAsUser({
      toAddress: HTLC_CONTRACT,
      amount: 0n,
      tokenStandard: network.glyphsZts,
      data: new Uint8Array(0),
      blockType: BLOCK_TYPE_USER_RECEIVE,
      fromBlockHash: block.hash,
    })
    await client.waitForConfirmation(block.hash, { signal }).catch(() => {})
    return true
  } catch {
    return false
  }
}

/**
 * Whether this claim has nothing left to do on chain, answered with the block
 * that redeemed the GLYPH -- the evidence itself, so the step can link to it.
 *
 * Both entries gone is necessary but not sufficient: an unlock and a reclaim
 * leave an HTLC in exactly the same state -- absent -- and only one of them paid
 * the user. So the GLYPH leg needs positive evidence of an unlock, looked for on
 * whichever chain would have signed it: the faucet's normally, the user's own
 * when they redeemed it themselves. Without that second half, a claim whose
 * GLYPH leg had expired and been reclaimed would report as settled and show the
 * user a tick for money that went back to the faucet.
 */
async function claimSettled(record: ClaimRecord): Promise<string | null> {
  if (!record.ppHtlcId || !record.glyphsHtlcId) return null

  const [ppEntry, glyphsEntry] = await Promise.all([
    client.htlcById(record.ppHtlcId),
    client.htlcById(record.glyphsHtlcId),
  ])
  if (ppEntry !== null || glyphsEntry !== null) return null

  const [byPage, byUser] = await Promise.all([
    unlockBlock(faucet.address, record.glyphsHtlcId),
    unlockBlock(record.user, record.glyphsHtlcId),
  ])
  return byPage ?? byUser
}

/** Picks up a claim a reload interrupted, from the record and the chain. */
export async function resumeClaim(
  record: ClaimRecord,
  onState: (state: ClaimState) => void,
  signal?: AbortSignal,
  signAsUser: UserSigner = syriusSigner,
): Promise<ClaimState> {
  const state: ClaimState = {
    phase: 'checking',
    message: '',
    glyphs: record.glyphs,
    ppHtlcId: record.ppHtlcId,
    glyphsHtlcId: record.glyphsHtlcId,
    blocks: { ...record.blocks },
    busy: true,
  }
  const report = (phase: Phase, message: string, busy = true): void => {
    state.phase = phase
    state.message = message
    state.busy = busy
    onState({ ...state })
  }
  const fail = (message: string): never => {
    state.error = message
    report('failed', message, false)
    throw new ClaimError(message)
  }

  const preimage = fromHex(record.preimage)
  const hashLock = sha256(preimage)
  if (!record.ppHtlcId) fail('that claim never locked anything; start a new one')

  report('checking', 'picking up where the last visit left off')

  // There may be nothing left to do. A claim finishes on chain whether or not
  // the page that started it was still watching -- the wait that timed out a
  // moment before this one gave up, another tab, an earlier visit. Walking the
  // steps again would publish nothing and arrive here anyway, several minutes
  // later; this reads the chain once and says so.
  const redeemedIn = await claimSettled(record)
  if (redeemedIn) {
    // Fill the step list in from the chain rather than from what this visit did,
    // so a claim finished in another tab still shows every block it published.
    noteBlock(record, state, 'pp-lock', record.ppHtlcId)
    noteBlock(record, state, 'glyphs-lock', record.glyphsHtlcId)
    noteBlock(record, state, 'pp-unlock', (await unlockBlock(faucet.address, record.ppHtlcId!)) ?? undefined)
    noteBlock(record, state, 'glyphs-redeem', redeemedIn)

    report('receiving', 'this claim already settled — collecting what it paid')
    await tryReceive(record.user, signAsUser, signal)

    report('sweeping', 'settling the PlasmaPoints into the faucet')
    noteBlock(record, state, 'pp-settle', await sweepFaucet(signal))

    record.phase = 'done'
    saveRecord(record)
    state.redeemedFrom = 'page'
    report('done', `Claimed ${record.glyphs} GLYPH`, false)
    return { ...state }
  }

  report('confirming-lock', 'checking what this claim still has on chain')
  const ppInfo = await client.htlcById(record.ppHtlcId!)
  // The entry is only absent because it was already unlocked, which is a later
  // step of this same claim. While it is still there it has to clear the same
  // checks the first attempt made -- resuming past a leg that failed
  // verification would lock GLYPH against it.
  if (ppInfo) {
    verifyPpLeg(ppInfo, {
      hashLock,
      ppAmount: BigInt(record.glyphs) * PP_PER_GLYPH,
      fail,
    })
  }
  const payee = ppInfo ? ppInfo.timeLocked : record.user

  return finishClaim({
    record,
    state,
    report,
    payee,
    glyphAmount: BigInt(record.glyphs),
    preimage,
    hashLock,
    signal,
    signAsUser,
  })
}
