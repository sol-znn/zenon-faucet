// go-zenon's proof-of-work, reimplemented.
//
// This is what buys plasma for an account with no QSR fused. The configured
// page wallet does have QSR fused, so `requiredDifficulty` comes back 0 and none
// of this runs -- it exists so that a wallet whose fused plasma stops covering a
// block degrades into a slow page rather than a broken one.
//
// The arithmetic has to match `common/pow` exactly or every block is rejected.

import { concat, fromHex, hash, parseAddress } from './primitives.ts'
import type { PublishOptions } from './block.ts'

/**
 * The value a nonce is mined against: sha3-256 of the address followed by the
 * previous block hash.
 *
 * Note what is absent -- the block's contents. The work commits to a position on
 * one account chain, not to a payload, so it cannot be precomputed for an
 * account you do not control and must be redone for every block.
 */
export function powDataHash(address: string, previousHash: string): Uint8Array {
  return hash(concat(parseAddress(address), fromHex(previousHash)))
}

/** How many hashes pass between a yield to the host. */
const YIELD_INTERVAL = 1 << 16

/**
 * 2^64 - 2^64/difficulty, little-endian -- `getTargetByDifficulty`.
 */
function targetForDifficulty(difficulty: number): Uint8Array {
  const out = new Uint8Array(8)
  if (difficulty === 0) return out
  const span = 1n << 64n
  const value = span - span / BigInt(difficulty)
  new DataView(out.buffer).setBigUint64(0, value & 0xffffffffffffffffn, true)
  return out
}

/**
 * Compares the first eight bytes of a hash against the target, little-endian.
 * Copied from go-zenon including its equal-means-true ending: a hash that ties
 * the target counts as a hit there, and a stricter comparison here would reject
 * nonces the node accepts.
 */
function greaterDifficulty(x: Uint8Array, target: Uint8Array): boolean {
  for (let i = 7; i >= 0; i--) {
    if (x[i] > target[i]) return true
    if (x[i] < target[i]) return false
  }
  return true
}

/** Adds one to the little-endian counter at the head of the buffer. */
function quickInc(x: Uint8Array): void {
  for (let i = 0; i < 8; i++) {
    x[i] = (x[i] + 1) & 0xff
    if (x[i] !== 0) return
  }
}

/**
 * Searches for a nonce satisfying `difficulty`, mirroring `pow.GetPoWNonce`.
 *
 * The search starts from a random point rather than from zero. Two miners
 * starting at zero on the same account and difficulty do the same work and find
 * the same nonce, which wastes the second one.
 */
export async function minePoWNonce(
  difficulty: number,
  dataHash: Uint8Array,
  options: PublishOptions = {},
): Promise<Uint8Array> {
  if (difficulty === 0) return new Uint8Array(8)
  const target = targetForDifficulty(difficulty)

  // nonce(8) || dataHash(32), hashed whole on every attempt. Building it once
  // and incrementing in place is what makes the loop cheap.
  const calc = new Uint8Array(8 + dataHash.length)
  crypto.getRandomValues(calc.subarray(0, 8))
  calc.set(dataHash, 8)

  let hashes = 0
  for (;;) {
    if (greaterDifficulty(hash(calc), target)) return calc.slice(0, 8)
    quickInc(calc)
    hashes++
    if (hashes % YIELD_INTERVAL === 0) {
      options.signal?.throwIfAborted()
      options.onMining?.(hashes)
      // Hand the thread back. Without this the browser cannot repaint, cannot
      // deliver a cancel, and cannot show the callback above to any effect.
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
  }
}

/**
 * How many attempts a difficulty costs on average. A nonce succeeds with
 * probability 1/difficulty per hash, so the mean is the difficulty itself.
 */
export function expectedHashes(difficulty: number): number {
  return difficulty
}
