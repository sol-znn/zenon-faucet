// Building, signing and publishing an account block.
//
// The hash computation is `chain/nom.AccountBlock.ComputeHash`, field for field
// and width for width. The order is a consensus rule: a field in the wrong
// place, or an amount serialised at a different width, produces a hash the node
// disagrees with, and it reports that as a bad signature -- an error that points
// at the key rather than at the encoding. So this mirrors the original line by
// line instead of being written more tidily, and scripts/smoke.ts checks the
// result against blocks the running chain has already accepted.

import type { Account } from './wallet.ts'
import { ZenonClient, type RequiredPow } from './client.ts'
import { minePoWNonce, powDataHash } from './pow.ts'
import {
  EMPTY_HASH,
  EMPTY_HASH_DIGEST,
  ZERO_ZTS,
  bigIntToBytes,
  concat,
  formatAddress,
  formatZts,
  fromBase64,
  fromHex,
  hash,
  leftPad,
  parseAddress,
  parseZts,
  toBase64,
  toHex,
  uint64ToBytes,
} from './primitives.ts'

/** The only two block types a user account can produce. */
export const BLOCK_TYPE_USER_SEND = 2
export const BLOCK_TYPE_USER_RECEIVE = 3

/** The only version go-zenon's verifier accepts. */
const BLOCK_VERSION = 1

const ZERO_NONCE = '0000000000000000'
const ZERO_HASH_HEX = toHex(EMPTY_HASH)
const EMPTY_ADDRESS = formatAddress(new Uint8Array(20))
const ZERO_ZTS_STRING = formatZts(ZERO_ZTS)

/** An account block in the shape `ledger.publishRawTransaction` expects. */
export interface BlockJson {
  version: number
  chainIdentifier: number
  blockType: number
  hash: string
  previousHash: string
  height: number
  momentumAcknowledged: { hash: string; height: number }
  address: string
  toAddress: string
  /** A decimal string: go-zenon's `AccountBlockMarshal` reads amounts as text. */
  amount: string
  tokenStandard: string
  fromBlockHash: string
  descendantBlocks: never[]
  /** Base64. */
  data: string
  fusedPlasma: number
  difficulty: number
  nonce: string
  basePlasma: number
  usedPlasma: number
  changesHash: string
  publicKey: string
  signature: string
}

export interface SendSpec {
  toAddress: string
  /** Base units. PlasmaPoints and GLYPH both have 0 decimals, so this is a count. */
  amount?: bigint
  tokenStandard?: string
  data?: Uint8Array
}

export interface PublishOptions {
  /** Called while a nonce is being mined, if one is needed at all. */
  onMining?: (hashes: number) => void
  signal?: AbortSignal
}

/**
 * `chain/nom.AccountBlock.ComputeHash`.
 *
 * Note what is absent: basePlasma, usedPlasma, changesHash, publicKey and
 * signature are all set on the block and none is committed to.
 */
export function computeBlockHash(b: BlockJson): Uint8Array {
  return hash(
    uint64ToBytes(b.version),
    uint64ToBytes(b.chainIdentifier),
    uint64ToBytes(b.blockType),
    fromHex(b.previousHash),
    uint64ToBytes(b.height),
    concat(fromHex(b.momentumAcknowledged.hash), uint64ToBytes(b.momentumAcknowledged.height)),
    parseAddress(b.address),
    parseAddress(b.toAddress),
    bigIntToBytes(BigInt(b.amount || '0')),
    parseZts(b.tokenStandard),
    fromHex(b.fromBlockHash),
    // Every block this app builds has no descendants: batching is for contract
    // calls that spawn other calls, which a client never authors.
    EMPTY_HASH_DIGEST,
    hash(b.data ? fromBase64(b.data) : new Uint8Array(0)),
    uint64ToBytes(b.fusedPlasma),
    uint64ToBytes(b.difficulty),
    // Left-padded to 8: the nonce is eight bytes and a shorter hex string is
    // its leading zeros elided.
    leftPad(fromHex(b.nonce || ZERO_NONCE), 8),
  )
}

/**
 * Signs and publishes account blocks from the page's own wallet.
 *
 * A published `htlc.Create` hash is also the HTLC's id -- `CreateHtlcMethod`
 * stores `Id: sendBlock.Hash` -- so the id is known the moment the block is
 * built, well before it reaches a momentum.
 */
export class BlockPublisher {
  private readonly client: ZenonClient
  private readonly account: Account
  private readonly chainIdentifier: number

  constructor(client: ZenonClient, account: Account, chainIdentifier: number) {
    this.client = client
    this.account = account
    this.chainIdentifier = chainIdentifier
  }

  async send(spec: SendSpec, options: PublishOptions = {}): Promise<string> {
    return this.publish(
      {
        blockType: BLOCK_TYPE_USER_SEND,
        toAddress: spec.toAddress,
        amount: (spec.amount ?? 0n).toString(),
        tokenStandard: spec.tokenStandard ?? ZERO_ZTS_STRING,
        fromBlockHash: ZERO_HASH_HEX,
        data: spec.data ?? new Uint8Array(0),
      },
      options,
    )
  }

  /**
   * Publishing the receive block is what turns an incoming send into spendable
   * balance. Nothing on Zenon credits an account without one.
   */
  async receive(fromBlockHash: string, options: PublishOptions = {}): Promise<string> {
    return this.publish(
      {
        blockType: BLOCK_TYPE_USER_RECEIVE,
        toAddress: EMPTY_ADDRESS,
        amount: '0',
        tokenStandard: ZERO_ZTS_STRING,
        fromBlockHash,
        data: new Uint8Array(0),
      },
      options,
    )
  }

  /** Receives every pending block, and answers how many there were. */
  async receiveAll(options: PublishOptions = {}): Promise<number> {
    const pending = await this.client.unreceivedBlocks(this.account.address)
    const list = pending.list ?? []
    for (const block of list) {
      const hash = await this.receive(block.hash, options)
      // Each receive extends the same account chain, so the next one needs this
      // one in a momentum before it can name it as its parent.
      await this.client.waitForConfirmation(hash, { signal: options.signal })
    }
    return list.length
  }

  private async publish(
    core: {
      blockType: number
      toAddress: string
      amount: string
      tokenStandard: string
      fromBlockHash: string
      data: Uint8Array
    },
    options: PublishOptions,
  ): Promise<string> {
    const [frontier, momentum] = await Promise.all([
      this.client.frontierAccountBlock(this.account.address),
      this.client.frontierMomentum(),
    ])

    const dataBase64 = toBase64(core.data)
    const block: BlockJson = {
      version: BLOCK_VERSION,
      chainIdentifier: this.chainIdentifier,
      blockType: core.blockType,
      hash: ZERO_HASH_HEX,
      previousHash: frontier ? frontier.hash : ZERO_HASH_HEX,
      height: frontier ? frontier.height + 1 : 1,
      momentumAcknowledged: { hash: momentum.hash, height: momentum.height },
      address: this.account.address,
      toAddress: core.toAddress,
      amount: core.amount,
      tokenStandard: core.tokenStandard,
      fromBlockHash: core.fromBlockHash,
      descendantBlocks: [],
      data: dataBase64,
      fusedPlasma: 0,
      difficulty: 0,
      nonce: ZERO_NONCE,
      basePlasma: 0,
      usedPlasma: 0,
      changesHash: ZERO_HASH_HEX,
      publicKey: '',
      signature: '',
    }

    const pow: RequiredPow = await this.client.requiredPow(
      this.account.address,
      core.blockType,
      core.toAddress,
      dataBase64,
    )

    if (pow.requiredDifficulty > 0) {
      // The configured wallet has QSR fused, so this branch is not normally
      // reached. It exists because the alternative -- a page that stops working
      // the moment fused plasma no longer covers a block -- fails silently.
      block.fusedPlasma = pow.availablePlasma
      block.difficulty = pow.requiredDifficulty
      block.nonce = toHex(
        await minePoWNonce(
          pow.requiredDifficulty,
          powDataHash(block.address, block.previousHash),
          options,
        ),
      )
    } else {
      block.fusedPlasma = pow.basePlasma
    }
    block.basePlasma = pow.basePlasma
    block.usedPlasma = pow.basePlasma

    const digest = computeBlockHash(block)
    block.hash = toHex(digest)
    block.publicKey = toBase64(this.account.publicKey)
    block.signature = toBase64(this.account.sign(digest))

    await this.client.publish(block)
    return block.hash
  }
}
