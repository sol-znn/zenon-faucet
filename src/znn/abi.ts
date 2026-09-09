// A minimal encoder for go-zenon's embedded-contract ABI (`vm/abi`).
//
// Only the encoding direction exists, and only the handful of methods this app
// calls. The rules, read out of `vm/abi/pack.go` and `method.go`:
//
//   - method id = the first 4 bytes of SHA3-256("Name(type,type,...)"), over
//     the raw type strings from the ABI JSON. SHA3, not Keccak.
//   - 32-byte words, Ethereum-style head/tail: static arguments inline,
//     dynamic ones (`bytes`, `string`) as an offset in the head and
//     [length, right-padded data] in the tail.
//   - address, hash, tokenStandard: LEFT-padded to 32.
//   - int/uint/bool: U256, left-padded.
//
// The three htlc ids are pinned to go-zenon's own encoder in scripts/smoke.ts.

import { concat, hash, leftPad, parseAddress, parseZts, uint64ToBytes } from './primitives.ts'

const WORD = 32

export type AbiType =
  | 'address'
  | 'hash'
  | 'tokenStandard'
  | 'int64'
  | 'uint8'
  | 'uint256'
  | 'bool'
  | 'bytes'
  | 'string'

export type AbiValue = string | number | bigint | boolean | Uint8Array

const DYNAMIC: ReadonlySet<AbiType> = new Set<AbiType>(['bytes', 'string'])

function rightPadToWord(b: Uint8Array): Uint8Array {
  const padded = new Uint8Array(Math.ceil(b.length / WORD) * WORD)
  padded.set(b)
  return padded
}

function u256(v: bigint): Uint8Array {
  if (v < 0n) throw new Error(`negative value ${v} is not encodable here`)
  const out = new Uint8Array(WORD)
  let x = v
  for (let i = WORD - 1; i >= 0 && x > 0n; i--) {
    out[i] = Number(x & 0xffn)
    x >>= 8n
  }
  return out
}

function toBigInt(v: AbiValue): bigint {
  if (typeof v === 'bigint') return v
  if (typeof v === 'number') {
    if (!Number.isInteger(v)) throw new Error(`${v} is not an integer`)
    return BigInt(v)
  }
  if (typeof v === 'string') return BigInt(v)
  throw new Error(`cannot read ${typeof v} as a number`)
}

function encodeStatic(type: AbiType, value: AbiValue): Uint8Array {
  switch (type) {
    case 'address':
      return leftPad(typeof value === 'string' ? parseAddress(value) : (value as Uint8Array), WORD)
    case 'tokenStandard':
      return leftPad(typeof value === 'string' ? parseZts(value) : (value as Uint8Array), WORD)
    case 'hash':
      return leftPad(value as Uint8Array, WORD)
    case 'int64':
    case 'uint8':
    case 'uint256':
      return u256(toBigInt(value))
    case 'bool':
      return u256(value ? 1n : 0n)
    default:
      throw new Error(`${type} is not static`)
  }
}

/** [length, right-padded data] -- `packBytesSlice`. */
function encodeDynamic(type: AbiType, value: AbiValue): Uint8Array {
  const raw =
    type === 'string' ? new TextEncoder().encode(String(value)) : (value as Uint8Array)
  return concat(u256(BigInt(raw.length)), rightPadToWord(raw))
}

export function methodId(name: string, types: readonly AbiType[]): Uint8Array {
  return hash(new TextEncoder().encode(`${name}(${types.join(',')})`)).subarray(0, 4)
}

/** ABI-encoded call data: the 4-byte method id followed by the packed arguments. */
export function encodeCall(
  name: string,
  types: readonly AbiType[],
  values: readonly AbiValue[],
): Uint8Array {
  if (types.length !== values.length) {
    throw new Error(`${name} takes ${types.length} arguments, got ${values.length}`)
  }
  const head: Uint8Array[] = []
  const tail: Uint8Array[] = []
  let tailOffset = types.length * WORD

  types.forEach((type, i) => {
    if (DYNAMIC.has(type)) {
      head.push(u256(BigInt(tailOffset)))
      const packed = encodeDynamic(type, values[i])
      tail.push(packed)
      tailOffset += packed.length
    } else {
      head.push(encodeStatic(type, values[i]))
    }
  })

  return concat(methodId(name, types), ...head, ...tail)
}

// ---------------------------------------------------------------------------
// The methods this app calls.
// ---------------------------------------------------------------------------

/** SHA-256. The htlc contract also accepts SHA3 (0); this app never uses it. */
export const HASH_TYPE_SHA256 = 1
/** The preimage length this app commits to, and the keyMaxSize it asks for. */
export const PREIMAGE_SIZE = 32

const CREATE: readonly AbiType[] = ['address', 'int64', 'uint8', 'uint8', 'bytes']
const UNLOCK: readonly AbiType[] = ['hash', 'bytes']
const RECLAIM: readonly AbiType[] = ['hash']
const ISSUE: readonly AbiType[] = [
  'string', 'string', 'string', 'uint256', 'uint256', 'uint8', 'bool', 'bool', 'bool',
]
const MINT: readonly AbiType[] = ['tokenStandard', 'uint256', 'address']
const FUSE: readonly AbiType[] = ['address']

/**
 * `hashLocked` is the address the contract pays on a successful unlock -- and
 * it pays that address whoever calls, which is the property this whole app
 * rests on. `expirationTime` is a unix second, compared against momentum time.
 */
export function packHtlcCreate(
  hashLocked: string,
  expirationTime: number,
  hashLock: Uint8Array,
): Uint8Array {
  return encodeCall('Create', CREATE, [
    hashLocked,
    expirationTime,
    HASH_TYPE_SHA256,
    PREIMAGE_SIZE,
    hashLock,
  ])
}

export function packHtlcUnlock(id: Uint8Array, preimage: Uint8Array): Uint8Array {
  return encodeCall('Unlock', UNLOCK, [id, preimage])
}

export function packHtlcReclaim(id: Uint8Array): Uint8Array {
  return encodeCall('Reclaim', RECLAIM, [id])
}

export function packIssueToken(p: {
  name: string
  symbol: string
  domain: string
  totalSupply: bigint
  maxSupply: bigint
  decimals: number
  isMintable: boolean
  isBurnable: boolean
  isUtility: boolean
}): Uint8Array {
  return encodeCall('IssueToken', ISSUE, [
    p.name, p.symbol, p.domain,
    p.totalSupply, p.maxSupply, p.decimals,
    p.isMintable, p.isBurnable, p.isUtility,
  ])
}

export function packMint(zts: string, amount: bigint, receiveAddress: string): Uint8Array {
  return encodeCall('Mint', MINT, [zts, amount, receiveAddress])
}

export function packFuse(beneficiary: string): Uint8Array {
  return encodeCall('Fuse', FUSE, [beneficiary])
}

export { uint64ToBytes }
