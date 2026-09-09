// Which chain this build talks to, and the two token standards on it.
//
// The token standards are chain-specific: a ZTS is derived from the hash of the
// block that issued it (`newTokenID(sendBlock.Hash)`), so devnet's PP is a
// different token from mainnet's PP and always will be. `npm run setup:devnet`
// issues both and rewrites the two ids below.

export interface Network {
  name: string
  rpcUrl: string
  chainId: number
  /** PlasmaPoints -- what the user locks. */
  ppZts: string
  /** GLYPH -- what the user is paid. */
  glyphsZts: string
}

/**
 * Every field is overridable at build time, because the defaults below are a
 * local devnet and a deployed page cannot use them: GitHub Pages is HTTPS, and
 * a page served over HTTPS may not call `http://localhost` -- the browser
 * blocks it as mixed content before the request is made. So the deploy sets
 * `FAUCET_RPC_URL` and friends to whatever chain that build is for.
 *
 * Same substitution mechanism as the mnemonic: Vite's `define` in the browser,
 * `process.env` for the Node scripts. See src/config.ts for why it is written
 * this way.
 */
declare const __FAUCET_NETWORK__: Partial<Network> | undefined

function override(): Partial<Network> {
  if (typeof __FAUCET_NETWORK__ === 'object' && __FAUCET_NETWORK__) return __FAUCET_NETWORK__

  const env = globalThis.process?.env
  if (!env) return {}
  return {
    ...(env.FAUCET_NETWORK_NAME ? { name: env.FAUCET_NETWORK_NAME } : {}),
    ...(env.FAUCET_RPC_URL ? { rpcUrl: env.FAUCET_RPC_URL } : {}),
    ...(env.FAUCET_CHAIN_ID ? { chainId: Number(env.FAUCET_CHAIN_ID) } : {}),
    ...(env.FAUCET_PP_ZTS ? { ppZts: env.FAUCET_PP_ZTS } : {}),
    ...(env.FAUCET_GLYPHS_ZTS ? { glyphsZts: env.FAUCET_GLYPHS_ZTS } : {}),
  }
}

/** The local devnet `npm run setup:devnet` provisions. Overridden per build. */
const DEFAULTS: Network = {
  name: 'devnet',
  rpcUrl: 'http://localhost:35997',
  chainId: 69,
  ppZts: 'zts1529re5wj5fp40mkgnac2uz',
  glyphsZts: 'zts15m4ym7lqwvt0qn706863hl',
}

export const network: Network = { ...DEFAULTS, ...override() }

/** Mainnet's PlasmaPoints and GLYPH, for reference. */
export const MAINNET_PP_ZTS = 'zts1hz3ys62vnc8tdajnwrz6pp'
export const MAINNET_GLYPHS_ZTS = 'zts1nrvf92dp6dg894g20glyph'
