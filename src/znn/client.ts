// A JSON-RPC client for a go-zenon node, covering the calls this app makes.

import { decodeDigest, toHex } from './primitives.ts'

export interface Momentum {
  hash: string
  height: number
  timestamp: number
  chainIdentifier: number
}

export interface TokenInfo {
  name: string
  symbol: string
  domain: string
  decimals: number
  tokenStandard: string
  owner: string
  totalSupply: string
  maxSupply: string
  isMintable: boolean
  isBurnable: boolean
  isUtility: boolean
}

export interface AccountBlockJson {
  hash: string
  address: string
  toAddress: string
  blockType: number
  height: number
  /** Base64. */
  data: string
  /** A decimal string -- see `common.StringToBigInt`. */
  amount: string
  tokenStandard: string
  fromBlockHash: string
  descendantBlocks?: AccountBlockJson[]
  confirmationDetail?: { momentumHeight: number; momentumTimestamp: number } | null
}

export interface HtlcInfo {
  id: string
  timeLocked: string
  hashLocked: string
  tokenStandard: string
  amount: string
  expirationTime: number
  hashType: number
  keyMaxSize: number
  hashLock: string
}

export interface RequiredPow {
  availablePlasma: number
  basePlasma: number
  requiredDifficulty: number
}

export class RpcError extends Error {
  readonly code: number
  constructor(code: number, message: string) {
    super(message)
    this.code = code
    this.name = 'RpcError'
  }
  /** The node's way of saying "no such entry" -- an expected answer, not a fault. */
  get isNotFound(): boolean {
    return /data non existent/i.test(this.message)
  }
}

export class ZenonClient {
  readonly url: string
  private id = 0

  constructor(url: string) {
    this.url = url
  }

  async call<T>(method: string, params: unknown[] = []): Promise<T> {
    const response = await fetch(this.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++this.id, method, params }),
    })
    if (!response.ok) throw new Error(`${method}: the node answered HTTP ${response.status}`)
    const body = (await response.json()) as { result?: T; error?: { code: number; message: string } }
    if (body.error) throw new RpcError(body.error.code, body.error.message)
    return body.result as T
  }

  /** `null` rather than a throw, because "no entry" is a normal answer here. */
  private async callOrNull<T>(method: string, params: unknown[]): Promise<T | null> {
    try {
      return await this.call<T>(method, params)
    } catch (err) {
      if (err instanceof RpcError && err.isNotFound) return null
      throw err
    }
  }

  frontierMomentum(): Promise<Momentum> {
    return this.call('ledger.getFrontierMomentum')
  }

  frontierAccountBlock(address: string): Promise<AccountBlockJson | null> {
    return this.callOrNull('ledger.getFrontierAccountBlock', [address])
  }

  accountBlockByHash(hash: string): Promise<AccountBlockJson | null> {
    return this.callOrNull('ledger.getAccountBlockByHash', [hash])
  }

  unreceivedBlocks(address: string, pageSize = 50): Promise<{ list: AccountBlockJson[] | null }> {
    return this.call('ledger.getUnreceivedBlocksByAddress', [address, 0, pageSize])
  }

  /**
   * The newest `count` blocks on an account's chain, oldest first.
   *
   * Unlike `getFrontierAccountBlock` this includes blocks that no momentum has
   * confirmed yet, which is the whole reason it is here: a block that has been
   * published but not yet processed is exactly the state that looks, from the
   * outside, identical to never having published it at all.
   */
  async recentAccountBlocks(address: string, count = 20): Promise<AccountBlockJson[]> {
    const info = await this.accountInfo(address)
    const height = info.accountHeight ?? 0
    if (height === 0) return []
    const from = Math.max(1, height - count + 1)
    const page = await this.call<{ list: AccountBlockJson[] | null }>(
      'ledger.getAccountBlocksByHeight',
      [address, from, Math.min(count, height)],
    )
    return page.list ?? []
  }

  accountInfo(address: string): Promise<{
    address: string
    accountHeight: number
    balanceInfoMap: Record<string, { token: TokenInfo; balance: string }>
  }> {
    return this.call('ledger.getAccountInfoByAddress', [address])
  }

  requiredPow(
    address: string,
    blockType: number,
    toAddress: string,
    dataBase64: string,
  ): Promise<RequiredPow> {
    return this.call('embedded.plasma.getRequiredPoWForAccountBlock', [
      { address, blockType, toAddress, data: dataBase64 },
    ])
  }

  publish(block: unknown): Promise<null> {
    return this.call('ledger.publishRawTransaction', [block])
  }

  htlcById(id: string): Promise<HtlcInfo | null> {
    return this.callOrNull('embedded.htlc.getById', [id])
  }

  /**
   * Whether the contract will let somebody other than `address` unlock an HTLC
   * that pays `address`. The default is true and only an explicit
   * `DenyProxyUnlock` makes it false -- but that call is one-way, so an address
   * that has made it can never go back to the default.
   */
  proxyUnlockAllowed(address: string): Promise<boolean> {
    return this.call('embedded.htlc.getProxyUnlockStatus', [address])
  }

  tokenByZts(zts: string): Promise<TokenInfo | null> {
    return this.callOrNull('embedded.token.getByZts', [zts])
  }

  async balanceOf(address: string, zts: string): Promise<bigint> {
    const info = await this.accountInfo(address)
    const entry = info.balanceInfoMap?.[zts]
    return entry ? BigInt(entry.balance) : 0n
  }

  /**
   * An account block is unreadable for a momentum or two after it is published,
   * so "not found yet" is the normal first answer rather than a failure.
   * Resolves once the block exists and a momentum has confirmed it.
   */
  async waitForConfirmation(
    hash: string,
    { timeoutMs = 120_000, intervalMs = 2_000, signal }: WaitOptions = {},
  ): Promise<AccountBlockJson> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      signal?.throwIfAborted()
      const block = await this.accountBlockByHash(hash)
      if (block?.confirmationDetail?.momentumHeight) return block
      if (Date.now() > deadline) {
        throw new Error(
          `block ${hash.slice(0, 8)}… was not confirmed within ${Math.round(timeoutMs / 1000)}s`,
        )
      }
      await delay(intervalMs, signal)
    }
  }

  /** Resolves once the entry is readable, which is what "the HTLC exists" means. */
  async waitForHtlc(id: string, options: WaitOptions = {}): Promise<HtlcInfo> {
    const { timeoutMs = 120_000, intervalMs = 2_000, signal } = options
    const deadline = Date.now() + timeoutMs
    for (;;) {
      signal?.throwIfAborted()
      const info = await this.htlcById(id)
      if (info) return info
      if (Date.now() > deadline) {
        throw new Error(`the HTLC ${id.slice(0, 8)}… did not appear on chain in time`)
      }
      await delay(intervalMs, signal)
    }
  }

  /** Resolves once the entry is GONE, which is what a successful unlock leaves. */
  async waitForHtlcCleared(id: string, options: WaitOptions = {}): Promise<void> {
    const { timeoutMs = 120_000, intervalMs = 2_000, signal } = options
    const deadline = Date.now() + timeoutMs
    for (;;) {
      signal?.throwIfAborted()
      if ((await this.htlcById(id)) === null) return
      if (Date.now() > deadline) {
        // Says "within Ns" rather than "failed", because it has not: the unlock
        // is published and may yet land. Retrying re-reads the chain and waits
        // again rather than signing a second one.
        throw new Error(
          `the HTLC ${id.slice(0, 8)}… was still locked ${Math.round(timeoutMs / 1000)}s after the unlock`,
        )
      }
      await delay(intervalMs, signal)
    }
  }
}

export interface WaitOptions {
  timeoutMs?: number
  intervalMs?: number
  signal?: AbortSignal
}

export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal!.reason)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Reads a hashlock off an HtlcInfo, whichever encoding the node used. */
export function htlcHashLock(info: HtlcInfo): string {
  return toHex(decodeDigest(info.hashLock))
}
