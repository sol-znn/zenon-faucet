import { network } from './network.ts'

export { network }

/**
 * `__FAUCET_MNEMONIC__` is substituted by Vite's `define` at build time (see
 * vite.config.ts), so in the browser bundle the call below is a literal. The
 * `process.env` arm is for the Node scripts in scripts/, which import this
 * module directly and never go through Vite -- they read the same `.env` via
 * `node --env-file-if-exists`.
 *
 * `typeof` on an undeclared identifier is the one safe way to test for it, so
 * this file loads under both without either arm throwing.
 */
declare const __FAUCET_MNEMONIC__: string | undefined

function resolveMnemonic(): string {
  const injected = typeof __FAUCET_MNEMONIC__ === 'string' ? __FAUCET_MNEMONIC__ : ''
  if (injected) return injected

  const fromNode = globalThis.process?.env?.FAUCET_MNEMONIC ?? ''
  if (fromNode) return fromNode

  throw new Error(
    'FAUCET_MNEMONIC is not set. Copy .env.example to .env for local work; ' +
      'in CI it comes from the repository secret of the same name.',
  )
}

/** How many PlasmaPoints one GLYPH costs. PP has 0 decimals, so this is exact. */
export const PP_PER_GLYPH = 1000n

/** The most GLYPH one claim may ask for. */
export const MAX_GLYPHS = 10

/**
 * The mnemonic for the wallet this page signs with.
 *
 * Not in the source. It is injected at build time from `FAUCET_MNEMONIC` --
 * a `.env` file locally, a GitHub secret in CI (see
 * `.github/workflows/deploy.yml`) -- so that rotating the faucet wallet is a
 * secret change rather than a commit, and so the phrase never enters git
 * history, which is the one place a leak cannot be undone.
 *
 * It is still in the built bundle, and that is unavoidable and by design: the
 * page is the counterparty to the swap and has to sign two blocks with no
 * human present, so whatever it signs with is shipped to whoever loads it.
 * `npm run build` runs the bundle through an obfuscator, which is worth doing
 * -- it defeats the scrapers that grep public assets for BIP-39 wordlists --
 * but it is not secrecy: anyone who opens devtools still has this key.
 *
 * What actually bounds the loss is the account, not the bundle. It holds a
 * faucet's worth of GLYPH and nothing else, and it is rotatable in one push.
 */
export const FAUCET_MNEMONIC = resolveMnemonic()

/**
 * Which BIP-44 account index of `FAUCET_MNEMONIC` this page signs with --
 * `m/44'/73404'/index'`, the same SLIP-0010 ed25519 path znn_cli_dart and
 * Syrius derive with (see `src/znn/wallet.ts`).
 *
 * Not secret -- unlike the mnemonic it is readable in the bundle regardless,
 * so it comes from the `FAUCET_ACCOUNT_INDEX` repository *variable*, not a
 * secret. Defaults to 3, the devnet dev account used by `npm run
 * setup:devnet`.
 */
declare const __FAUCET_ACCOUNT_INDEX__: string | undefined

function resolveAccountIndex(): number {
  const injected = typeof __FAUCET_ACCOUNT_INDEX__ === 'string' ? __FAUCET_ACCOUNT_INDEX__ : ''
  const fromNode = globalThis.process?.env?.FAUCET_ACCOUNT_INDEX ?? ''
  const raw = injected || fromNode

  if (!raw) return 3

  const index = Number(raw)
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(`FAUCET_ACCOUNT_INDEX must be a non-negative integer, got ${JSON.stringify(raw)}`)
  }
  return index
}

export const FAUCET_ACCOUNT_INDEX = resolveAccountIndex()

/**
 * Expiry for the two legs, in seconds.
 *
 * The user's leg is the shorter one. Both numbers only matter when something
 * goes wrong, and they are chosen for what happens then:
 *
 *   - The page reveals the preimage by unlocking the PP leg. From that moment
 *     the preimage is public and the user can unlock the GLYPH leg themselves
 *     out of the block that revealed it. GLYPH_EXPIRY is how long they have to
 *     notice -- so it is the generous one.
 *   - If the page dies before revealing anything, the user's PP is locked until
 *     PP_EXPIRY and only they can reclaim it. So that one is kept short: it is
 *     the user's money sitting still.
 */
export const PP_EXPIRY_SECONDS = 30 * 60
export const GLYPHS_EXPIRY_SECONDS = 60 * 60

/**
 * How long to wait for a lock to appear, and for an unlock to clear it.
 *
 * Sized for mainnet rather than devnet. An unlock is three momentums of work at
 * the very least -- the send, the contract's receive of it, the payout it
 * spawns -- and a wallet with no fused QSR mines proof-of-work in the browser
 * before any of that begins. The client's own 120s default is comfortable on a
 * 1s devnet and marginal on a 10s chain, and the failure it produces there
 * ("the HTLC … was still locked after the unlock") is indistinguishable from a
 * real one while the block is in fact fine and about to land.
 *
 * Both stay well inside `PP_EXPIRY_SECONDS`, so a claim still has room to give
 * up and let the user reclaim rather than waiting past its own refund window.
 */
export const LOCK_TIMEOUT_MS = 4 * 60 * 1000
export const UNLOCK_TIMEOUT_MS = 6 * 60 * 1000
