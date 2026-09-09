// Issues PlasmaPoints and GLYPH on the devnet and records their ids.
//
//   node --experimental-strip-types scripts/devnet-setup.ts
//
// Idempotent: a token this wallet already owns with the right symbol is adopted
// rather than reissued, so re-running after a partial failure costs nothing.
// `make devnet-down-wipe` is what invalidates the result -- a fresh chain has
// neither token, and the ids will differ because they are derived from the hash
// of the block that issued them.

import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import { packIssueToken } from '../src/znn/abi.ts'
import { BlockPublisher } from '../src/znn/block.ts'
import { ZenonClient } from '../src/znn/client.ts'
import { formatZts, fromHex, hash, TOKEN_CONTRACT, ZNN_ZTS } from '../src/znn/primitives.ts'
import { Account } from '../src/znn/wallet.ts'
import { FAUCET_ACCOUNT_INDEX, FAUCET_MNEMONIC } from '../src/config.ts'
import { network } from '../src/network.ts'

/** `constants.TokenIssueAmount` -- 1 ZNN, burned by the issue. */
const ISSUE_FEE = 100_000_000n

/** `constants.TokenMaxSupplyBig` -- 2^255 - 1. */
const MAX_SUPPLY = (1n << 255n) - 1n

interface TokenSpec {
  name: string
  symbol: string
  domain: string
  totalSupply: bigint
  decimals: number
}

/** Mirrors mainnet's PlasmaPoints, which is 0-decimal, mintable and utility. */
const PP: TokenSpec = {
  name: 'PlasmaPoints',
  symbol: 'PP',
  domain: 'zenon.network',
  totalSupply: 13_321_356n,
  decimals: 0,
}

/** GLYPH does not exist on mainnet. 0 decimals: a glyph is a whole thing. */
const GLYPH: TokenSpec = {
  name: 'Glyph',
  symbol: 'GLYPH',
  domain: 'zenon.network',
  totalSupply: 100_000n,
  decimals: 0,
}

const NETWORK_FILE = fileURLToPath(new URL('../src/network.ts', import.meta.url))

function log(...parts: unknown[]): void {
  console.log(...parts)
}

/**
 * `newTokenID(sendBlock.Hash)` -- the first 10 bytes of sha3-256 over the hash
 * of the block that issued it. Computed here so the id is known before the
 * contract has processed the call.
 */
function tokenIdFromIssueHash(issueHash: string): string {
  return formatZts(hash(fromHex(issueHash)).subarray(0, 10))
}

async function findOwnedToken(
  client: ZenonClient,
  owner: string,
  spec: TokenSpec,
): Promise<string | null> {
  const info = await client.accountInfo(owner)
  for (const [zts, entry] of Object.entries(info.balanceInfoMap ?? {})) {
    if (entry.token?.symbol === spec.symbol && entry.token?.owner === owner) return zts
  }
  return null
}

async function issue(
  client: ZenonClient,
  publisher: BlockPublisher,
  owner: string,
  spec: TokenSpec,
): Promise<string> {
  const existing = await findOwnedToken(client, owner, spec)
  if (existing) {
    log(`  ${spec.symbol}: already issued as ${existing}`)
    return existing
  }

  log(`  ${spec.symbol}: issuing…`)
  const issueHash = await publisher.send({
    toAddress: TOKEN_CONTRACT,
    amount: ISSUE_FEE,
    tokenStandard: ZNN_ZTS,
    data: packIssueToken({
      ...spec,
      maxSupply: MAX_SUPPLY,
      isMintable: true,
      isBurnable: true,
      isUtility: true,
    }),
  })
  await client.waitForConfirmation(issueHash)

  const zts = tokenIdFromIssueHash(issueHash)
  log(`  ${spec.symbol}: issued in ${issueHash.slice(0, 12)}… as ${zts}`)

  // The contract pays the whole supply back as a send, which is not spendable
  // until the receiving account publishes a receive block for it.
  for (let attempt = 0; attempt < 20; attempt++) {
    const received = await publisher.receiveAll()
    if (received > 0) break
    await new Promise((resolve) => setTimeout(resolve, 3_000))
  }

  const info = await client.tokenByZts(zts)
  if (!info) throw new Error(`${spec.symbol} was issued as ${zts} but the node does not know it`)
  if (info.symbol !== spec.symbol) {
    throw new Error(`${zts} is ${info.symbol}, not ${spec.symbol} -- the id derivation is wrong`)
  }
  return zts
}

async function writeNetworkFile(ppZts: string, glyphsZts: string): Promise<void> {
  const source = await readFile(NETWORK_FILE, 'utf8')
  const updated = source
    .replace(/ppZts: '[^']*'/, `ppZts: '${ppZts}'`)
    .replace(/glyphsZts: '[^']*'/, `glyphsZts: '${glyphsZts}'`)
  if (updated === source && !source.includes(ppZts)) {
    throw new Error(`could not find the ppZts/glyphsZts fields in ${NETWORK_FILE}`)
  }
  await writeFile(NETWORK_FILE, updated)
}

async function main(): Promise<void> {
  const client = new ZenonClient(network.rpcUrl)
  const account = Account.fromMnemonic(FAUCET_MNEMONIC, FAUCET_ACCOUNT_INDEX)

  const momentum = await client.frontierMomentum()
  if (momentum.chainIdentifier !== network.chainId) {
    throw new Error(
      `${network.rpcUrl} is chain ${momentum.chainIdentifier}, not the configured ${network.chainId}`,
    )
  }
  log(`node    ${network.rpcUrl} (chain ${momentum.chainIdentifier}, height ${momentum.height})`)
  log(`wallet  ${account.address} (index ${FAUCET_ACCOUNT_INDEX})`)

  const znn = await client.balanceOf(account.address, ZNN_ZTS)
  log(`        ${znn} ZNN base units`)
  if (znn < ISSUE_FEE * 2n) {
    throw new Error(`the wallet needs at least 2 ZNN to issue two tokens; it has ${znn} base units`)
  }

  // Anything already sent to this account and never received.
  const swept = await publisherFor(client, account).receiveAll()
  if (swept > 0) log(`        received ${swept} pending block(s)`)

  const publisher = publisherFor(client, account)
  const ppZts = await issue(client, publisher, account.address, PP)
  const glyphsZts = await issue(client, publisher, account.address, GLYPH)

  await writeNetworkFile(ppZts, glyphsZts)
  log('')
  log(`PP      ${ppZts}  balance ${await client.balanceOf(account.address, ppZts)}`)
  log(`GLYPH   ${glyphsZts}  balance ${await client.balanceOf(account.address, glyphsZts)}`)
  log('')
  log(`written to src/network.ts`)
}

function publisherFor(client: ZenonClient, account: Account): BlockPublisher {
  return new BlockPublisher(client, account, network.chainId)
}

main().catch((err) => {
  console.error(`\nfailed: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
