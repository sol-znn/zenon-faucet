import { defineConfig, loadEnv } from 'vite'

/**
 * A faucet is a static page. No proxy, no server code -- the only thing it
 * talks to is the node named in src/network.ts.
 *
 * What it does need from the environment is the wallet it signs with, and the
 * chain it signs against. Both are substituted here rather than committed:
 * `.env` locally, repository secrets in CI. `loadEnv` with an empty prefix
 * reads the `.env` files *and* the ambient process env, which is what lets the
 * GitHub Actions job pass the mnemonic in without writing a file.
 *
 * Only the keys named below are read out of that env and only those reach the
 * bundle -- an empty prefix loads everything, so picking explicitly is the
 * difference between injecting one secret and injecting the whole runner.
 */
export default defineConfig(({ mode, command }) => {
  const env = loadEnv(mode, process.cwd(), '')

  const mnemonic = (env.FAUCET_MNEMONIC ?? '').trim().replace(/\s+/g, ' ')
  const building = command === 'build'

  // Fail the build rather than ship a bundle whose wallet cannot sign. In dev
  // the error is left to runtime, so `npm run dev` still starts and the page
  // can explain itself.
  if (building && !mnemonic) {
    throw new Error(
      'FAUCET_MNEMONIC is not set.\n' +
        '  local: cp .env.example .env\n' +
        '  CI:    set the FAUCET_MNEMONIC repository secret',
    )
  }
  if (building && mnemonic.split(' ').length !== 24) {
    throw new Error(
      `FAUCET_MNEMONIC should be 24 words, got ${mnemonic.split(' ').length}. ` +
        'The phrase is validated properly at runtime by Account.fromMnemonic; ' +
        'this is just the shape check that catches a truncated secret early.',
    )
  }

  const accountIndex = (env.FAUCET_ACCOUNT_INDEX ?? '').trim()
  if (accountIndex && (!Number.isInteger(Number(accountIndex)) || Number(accountIndex) < 0)) {
    throw new Error(
      `FAUCET_ACCOUNT_INDEX must be a non-negative integer, got ${JSON.stringify(accountIndex)}`,
    )
  }

  const networkOverride = {
    ...(env.FAUCET_NETWORK_NAME ? { name: env.FAUCET_NETWORK_NAME } : {}),
    ...(env.FAUCET_RPC_URL ? { rpcUrl: env.FAUCET_RPC_URL } : {}),
    ...(env.FAUCET_CHAIN_ID ? { chainId: Number(env.FAUCET_CHAIN_ID) } : {}),
    ...(env.FAUCET_PP_ZTS ? { ppZts: env.FAUCET_PP_ZTS } : {}),
    ...(env.FAUCET_GLYPHS_ZTS ? { glyphsZts: env.FAUCET_GLYPHS_ZTS } : {}),
  }

  return {
    // GitHub Pages serves a project site from /<repo>/, so asset URLs have to
    // be prefixed. The workflow sets this from the repository name; '/' is
    // right for `npm run dev` and for a user/org site.
    base: env.FAUCET_BASE_PATH || '/',

    define: {
      __FAUCET_MNEMONIC__: JSON.stringify(mnemonic),
      __FAUCET_ACCOUNT_INDEX__: JSON.stringify(accountIndex),
      __FAUCET_NETWORK__: JSON.stringify(networkOverride),
    },

    build: {
      target: 'es2022',
      rollupOptions: {
        output: {
          // Everything from node_modules goes into chunks scripts/obfuscate.ts
          // skips, so the obfuscator only ever transforms our own src/ -- the
          // one place the mnemonic literal is substituted.
          //
          // The saving is not incidental. `three` is ~500kB of renderer whose
          // hot loops the obfuscator would slow down, and @scure/bip39 carries
          // the 2048-word English list, which is the worst possible input to a
          // string-array transform: encrypting a dictionary that needs no
          // protection roughly tripled the bundle when this was one chunk.
          manualChunks: (id: string) => {
            if (!id.includes('node_modules')) return undefined
            return id.includes('node_modules/three') ? 'three' : 'vendor'
          },
        },
      },
    },

    server: { port: 5180 },
  }
})
