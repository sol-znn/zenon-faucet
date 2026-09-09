// Zenon primitives: bytes, addresses, token standards, hashes.
//
// Everything here mirrors go-zenon's `common/types` byte for byte, because
// these values feed the account-block hash and a single field encoded at the
// wrong width produces a hash the node disagrees with. The node reports that
// as a bad signature, which points at the key rather than at the encoding --
// so the encodings are kept literal and checked against the chain in
// scripts/smoke.ts rather than made tidier.

import { bech32 } from 'bech32'
import { sha3_256 } from '@noble/hashes/sha3'

export const HASH_SIZE = 32
export const ADDRESS_CORE_SIZE = 20
export const ZTS_SIZE = 10

/** go-zenon's `crypto.Hash`: standard SHA3-256, not Keccak. */
export function hash(...parts: Uint8Array[]): Uint8Array {
  return sha3_256(concat(...parts))
}

export const EMPTY_HASH = new Uint8Array(HASH_SIZE)
/** sha3-256 of nothing -- what an account block with no descendants commits to. */
export const EMPTY_HASH_DIGEST = hash(new Uint8Array(0))

export function concat(...parts: Uint8Array[]): Uint8Array {
  let n = 0
  for (const p of parts) n += p.length
  const out = new Uint8Array(n)
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

export function toHex(b: Uint8Array): string {
  let s = ''
  for (const x of b) s += x.toString(16).padStart(2, '0')
  return s
}

export function fromHex(s: string): Uint8Array {
  const clean = s.startsWith('0x') || s.startsWith('0X') ? s.slice(2) : s
  if (clean.length % 2 !== 0) throw new Error(`hex of odd length: ${s}`)
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16)
    if (Number.isNaN(byte)) throw new Error(`not hex: ${s}`)
    out[i] = byte
  }
  return out
}

export function toBase64(b: Uint8Array): string {
  let s = ''
  for (const x of b) s += String.fromCharCode(x)
  return btoa(s)
}

export function fromBase64(s: string): Uint8Array {
  const raw = atob(s)
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

/** Big-endian uint64, go-zenon's `common.Uint64ToBytes`. */
export function uint64ToBytes(v: number | bigint): Uint8Array {
  const out = new Uint8Array(8)
  new DataView(out.buffer).setBigUint64(0, BigInt(v), false)
  return out
}

/** Left-padded 32-byte big-endian, go-zenon's `common.BigIntToBytes`. */
export function bigIntToBytes(v: bigint): Uint8Array {
  const out = new Uint8Array(32)
  let x = v < 0n ? 0n : v
  for (let i = 31; i >= 0 && x > 0n; i--) {
    out[i] = Number(x & 0xffn)
    x >>= 8n
  }
  return out
}

export function leftPad(b: Uint8Array, size: number): Uint8Array {
  if (b.length >= size) return b.slice(b.length - size)
  const out = new Uint8Array(size)
  out.set(b, size - b.length)
  return out
}

function bech32Encode(hrp: string, data: Uint8Array): string {
  return bech32.encode(hrp, bech32.toWords(data))
}

function bech32Decode(s: string, hrp: string, size: number): Uint8Array {
  const decoded = bech32.decode(s)
  if (decoded.prefix !== hrp) throw new Error(`expected prefix ${hrp}, got ${decoded.prefix}`)
  const core = Uint8Array.from(bech32.fromWords(decoded.words))
  if (core.length !== size) throw new Error(`expected ${size} bytes, got ${core.length}`)
  return core
}

/** 20 bytes: a leading type byte (0 = user, 1 = embedded contract) then 19 of digest. */
export function parseAddress(s: string): Uint8Array {
  return bech32Decode(s, 'z', ADDRESS_CORE_SIZE)
}

export function formatAddress(core: Uint8Array): string {
  return bech32Encode('z', core)
}

export function isAddress(s: string): boolean {
  try {
    parseAddress(s)
    return true
  } catch {
    return false
  }
}

/**
 * sha3-256 of the public key, truncated to 19 bytes behind a zero user byte.
 *
 * The truncation is to 19, not 20 -- the type byte occupies the first slot.
 * Taking 20 produces a well-formed address for a key that cannot sign for it.
 */
export function addressFromPublicKey(publicKey: Uint8Array): Uint8Array {
  const digest = sha3_256(publicKey).subarray(0, 19)
  return concat(new Uint8Array([0]), digest)
}

export function parseZts(s: string): Uint8Array {
  return bech32Decode(s, 'zts', ZTS_SIZE)
}

export function formatZts(core: Uint8Array): string {
  return bech32Encode('zts', core)
}

export const ZERO_ZTS = new Uint8Array(ZTS_SIZE)
export const ZNN_ZTS = 'zts1znnxxxxxxxxxxxxx9z4ulx'
export const QSR_ZTS = 'zts1qsrxxxxxxxxxxxxxmrhjll'

export const HTLC_CONTRACT = 'z1qxemdeddedxhtlcxxxxxxxxxxxxxxxxxygecvw'
export const PLASMA_CONTRACT = 'z1qxemdeddedxplasmaxxxxxxxxxxxxxxxxsctrp'
export const TOKEN_CONTRACT = 'z1qxemdeddedxt0kenxxxxxxxxxxxxxxxxh9amk0'

/**
 * A hashlock arrives from the node as base64 (go-zenon marshals `[]byte` that
 * way) but some tooling hands back hex. The two cannot be told apart by trying
 * one, because a 64-character hex string is also valid base64 and decodes
 * without complaint into 48 meaningless bytes. Both are decoded and the one
 * that yields a digest-sized result wins.
 */
export function decodeDigest(s: string): Uint8Array {
  try {
    const b = fromBase64(s)
    if (b.length === HASH_SIZE) return b
  } catch {
    /* fall through */
  }
  try {
    const b = fromHex(s)
    if (b.length === HASH_SIZE) return b
  } catch {
    /* fall through */
  }
  throw new Error(`hashlock ${s} is neither base64 nor hex`)
}
