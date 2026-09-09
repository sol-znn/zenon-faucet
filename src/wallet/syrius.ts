// The Syrius browser extension, as this page uses it.
//
// The extension's own HTLC screens cannot do this swap -- they hardcode SHA3
// and cap expiry -- and that reads as "the extension cannot do this". It is the
// wrong conclusion. Those screens are a feature; the extension underneath them
// is a signer, and it will sign any account block a page hands it. An HTLC call
// is only a send to an embedded contract carrying encoded arguments, so:
//
//   - this page decides toAddress, amount, tokenStandard and data;
//   - the extension supplies the account, the public key, the chain position,
//     the plasma or proof-of-work, and the signature.
//
// It never needs to know what an HTLC is.

import { EMPTY_HASH, ZERO_ZTS, formatAddress, formatZts, toBase64, toHex } from '../znn/primitives.ts'

const ZERO_HASH_HEX = toHex(EMPTY_HASH)
const EMPTY_ADDRESS = formatAddress(new Uint8Array(20))
const ZERO_ZTS_STRING = formatZts(ZERO_ZTS)

export interface ZenonProvider {
  version?: string
  isSyriusExtension?: boolean
  connect(): Promise<unknown>
  disconnect(): Promise<unknown>
  getAccounts(): Promise<string[]>
  getChainId(): Promise<number | string>
  getNodeUrl(): Promise<string>
  sendAccountBlock(block: unknown): Promise<SendAccountBlockResult>
  on?(event: string, handler: (...args: unknown[]) => void): void
  removeListener?(event: string, handler: (...args: unknown[]) => void): void
}

/**
 * v0.2.0 changed this from `{signedTransaction}` to `{hash, block}`, and the
 * legacy shim forwards the new shape under the old name -- so it is not a
 * faithful shim for this one call, and the failure lands after money is locked.
 * Both are read, and the hash is taken from whichever arrived.
 */
export interface SendAccountBlockResult {
  hash?: string
  block?: { hash?: string }
  signedTransaction?: { hash?: string }
}

declare global {
  interface Window {
    zenon?: ZenonProvider
  }
}

export class WalletError extends Error {
  readonly code: number
  constructor(code: number, message: string) {
    super(message)
    this.code = code
    this.name = 'WalletError'
  }
}

/**
 * Distinct from the JSON-RPC codes below on purpose: `provider()` throws this
 * itself, before any request reaches the extension, and it must survive
 * `translate()` unchanged. It used to share 4900 with "the extension didn't
 * answer" and `connect()`'s catch ran it through `translate()` a second time,
 * which matches that case and silently overwrites "no wallet found, install
 * Syrius" with "Syrius did not answer" -- exactly backwards for someone who
 * doesn't have it installed at all.
 */
export const WALLET_NOT_FOUND_CODE = -1

/**
 * Rejections arrive as `{code, message}` -- a plain object, not an Error -- so
 * they are translated into something with a stack and a readable sentence.
 */
function translate(err: unknown): WalletError {
  const raw = err as { code?: number; message?: string } | undefined
  const code = typeof raw?.code === 'number' ? raw.code : 0
  const detail = raw?.message ?? String(err)
  switch (code) {
    case 4001:
      return new WalletError(code, 'you declined the request in Syrius')
    case 4100:
      return new WalletError(code, 'Syrius is not connected to this page')
    case 4200:
      return new WalletError(code, 'this version of Syrius does not support that request')
    case 4900:
      return new WalletError(code, 'Syrius did not answer')
    default:
      return new WalletError(code, detail)
  }
}

/**
 * Presence is advisory, never required.
 *
 * The honest test of whether a wallet is there is to ask it and see whether it
 * answers, so nothing here is gated on a detection flag -- the flag only decides
 * what the page *says*. Older extension builds announced themselves by appending
 * a script element, which a strict CSP silently refuses, making the wallet
 * undetectable on exactly the sites that take their own security seriously.
 */
export function providerPresent(): boolean {
  return typeof window.zenon?.sendAccountBlock === 'function'
}

function provider(): ZenonProvider {
  const p = window.zenon
  if (!p) {
    throw new WalletError(
      WALLET_NOT_FOUND_CODE,
      'no Zenon wallet was found in this browser. Install the Syrius extension and reload.',
    )
  }
  return p
}

/**
 * A Vue-style reactive object, or anything else exotic, cannot cross
 * `postMessage`: it is structured clone, and a Proxy fails it outright with
 * "could not be cloned", naming no field. The round trip happens here, at the
 * transport boundary, rather than at each call site -- the content script
 * serialises to JSON downstream anyway, so anything a round trip drops was never
 * going to reach the wallet, and a value that cannot survive it throws where the
 * error names the request instead of arriving in the approval window as a field
 * quietly gone missing.
 */
function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export interface WalletState {
  address: string | null
  chainId: number | null
  nodeUrl: string | null
}

export async function connect(): Promise<WalletState> {
  try {
    await provider().connect()
  } catch (err) {
    throw err instanceof WalletError ? err : translate(err)
  }
  return readState()
}

export async function disconnect(): Promise<void> {
  try {
    await provider().disconnect()
  } catch (err) {
    throw err instanceof WalletError ? err : translate(err)
  }
}

/**
 * Reads the wallet without prompting. Everything here is answered from the
 * extension's session state, which is what lets the page restore a connection on
 * load and re-read after an account switch without asking again.
 */
export async function readState(): Promise<WalletState> {
  if (!window.zenon) return { address: null, chainId: null, nodeUrl: null }
  const p = provider()
  const [accounts, chainId, nodeUrl] = await Promise.all([
    p.getAccounts().catch(() => [] as string[]),
    p.getChainId().catch(() => null),
    p.getNodeUrl().catch(() => null),
  ])
  return {
    address: accounts?.[0] ?? null,
    chainId: chainId === null ? null : Number(chainId),
    nodeUrl: nodeUrl ?? null,
  }
}

export interface WalletSendSpec {
  toAddress: string
  amount: bigint
  tokenStandard: string
  data: Uint8Array
  blockType?: number
  /** Only for a receive block, which names the send it is answering. */
  fromBlockHash?: string
}

/**
 * Hands a block to the extension to complete, sign and publish.
 *
 * The template carries every field with a zero value rather than being partial:
 * the extension's `AccountBlockTemplate.fromJson` runs `Hash.parse`,
 * `Address.parse` and `TokenStandard.parse` over whatever is there, so a missing
 * field is a parse error inside the wallet rather than a default.
 */
export async function sendAccountBlock(
  spec: WalletSendSpec,
  chainId: number,
): Promise<string> {
  const template = {
    version: 1,
    chainIdentifier: chainId,
    blockType: spec.blockType ?? 2,
    hash: ZERO_HASH_HEX,
    previousHash: ZERO_HASH_HEX,
    height: 0,
    momentumAcknowledged: { hash: ZERO_HASH_HEX, height: 0 },
    address: EMPTY_ADDRESS,
    toAddress: spec.toAddress,
    amount: spec.amount.toString(),
    tokenStandard: spec.tokenStandard || ZERO_ZTS_STRING,
    fromBlockHash: spec.fromBlockHash ?? ZERO_HASH_HEX,
    descendantBlocks: [],
    data: toBase64(spec.data),
    fusedPlasma: 0,
    difficulty: 0,
    nonce: '',
    basePlasma: 0,
    usedPlasma: 0,
    changesHash: ZERO_HASH_HEX,
    publicKey: '',
    signature: '',
  }

  let result: SendAccountBlockResult
  try {
    result = await provider().sendAccountBlock(plain(template))
  } catch (err) {
    throw err instanceof WalletError ? err : translate(err)
  }

  const hash = result?.hash ?? result?.block?.hash ?? result?.signedTransaction?.hash
  if (!hash) {
    throw new WalletError(-32603, 'Syrius published the block but reported no hash for it')
  }
  return hash
}

/** The extension announces these; the page discards any prepared work on each. */
export function onWalletChange(handler: () => void): () => void {
  const events = ['accountsChanged', 'chainChanged', 'nodeChanged', 'disconnect']
  const p = window.zenon
  if (!p?.on) return () => {}
  for (const event of events) p.on(event, handler)
  return () => {
    for (const event of events) p.removeListener?.(event, handler)
  }
}
