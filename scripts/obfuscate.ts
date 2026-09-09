// Post-build pass over dist/, run by `npm run build`.
//
// What this is for, stated plainly: the faucet mnemonic is in the bundle and
// cannot not be, because the page signs without a human present. Obfuscating
// does not make it secret -- anyone who opens devtools and breakpoints the
// signing path has the key, and no transform applied here changes that.
//
// What it does buy is real but narrow: the phrase stops being a contiguous
// 24-word string sitting in a public asset. `stringArray` + rc4 encoding +
// `splitStrings` means `curl the-bundle.js | grep -f bip39-wordlist` finds
// nothing, which is the shape of essentially all automated key-scraping. It
// raises the cost from "a scraper found it in transit" to "a person sat down
// and read it".
//
// The account is what actually bounds the loss: it holds a faucet's worth of
// GLYPH and nothing else, and rotating it is one secret change and one push.

import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import obfuscator from 'javascript-obfuscator'

const ASSETS = fileURLToPath(new URL('../dist/assets', import.meta.url))

/**
 * Dependency chunks, split out by vite.config.ts and skipped here: they hold
 * no secret, and running them through a string-array transform is all cost.
 * `three` would lose frame rate; `vendor` carries @scure/bip39's 2048-word
 * English list, and encrypting a dictionary that anyone can download from the
 * spec is the single most expensive thing this script could do.
 *
 * What is left is our own src/, which is where the mnemonic literal is
 * substituted -- so the transform lands exactly on the code that needs it.
 */
const SKIP = /^(three|vendor)-/

/**
 * Tuned for hiding one string well, not for making the whole program
 * unreadable, which is a much more expensive and much less useful goal.
 *
 * `stringArrayEncoding: rc4` is the setting that matters -- it is what stops
 * the mnemonic appearing as plain text. Deliberately NOT enabled:
 * `controlFlowFlattening` and `deadCodeInjection`, which multiply size and run
 * time (the docs quote 1.5x and up on each) to frustrate a reader who, per
 * the note above, wins anyway. `selfDefending` and `debugProtection` are also
 * left off: they break source maps, wedge devtools for anyone debugging the
 * live page, and are trivially stripped.
 */
const OPTIONS = {
  compact: true,
  identifierNamesGenerator: 'mangled-shuffled' as const,
  numbersToExpressions: true,
  simplify: true,
  splitStrings: true,
  splitStringsChunkLength: 12,
  stringArray: true,
  stringArrayEncoding: ['rc4'] as ['rc4'],
  stringArrayThreshold: 1,
  stringArrayIndexShift: true,
  stringArrayRotate: true,
  stringArrayShuffle: true,
  stringArrayWrappersCount: 3,
  stringArrayWrappersType: 'function' as const,
  unicodeEscapeSequence: false,
}

const kb = (n: number) => `${(n / 1024).toFixed(1)}kB`

async function main(): Promise<void> {
  let entries: string[]
  try {
    entries = await readdir(ASSETS)
  } catch {
    throw new Error(`no ${ASSETS} -- run \`vite build\` before this script`)
  }

  const targets = entries.filter((f) => f.endsWith('.js') && !SKIP.test(f))
  if (targets.length === 0) throw new Error(`no obfuscatable chunks in ${ASSETS}`)

  for (const file of entries.filter((f) => f.endsWith('.js'))) {
    const path = join(ASSETS, file)
    if (SKIP.test(file)) {
      console.log(`  skip      ${file}  (${kb((await stat(path)).size)})`)
      continue
    }

    const source = await readFile(path, 'utf8')
    const output = obfuscator.obfuscate(source, OPTIONS).getObfuscatedCode()
    await writeFile(path, output, 'utf8')
    console.log(`  obfuscate ${file}  ${kb(source.length)} -> ${kb(output.length)}`)
  }

  // The point of the exercise, verified rather than assumed: if the mnemonic
  // survived as plain text the build is worse than useless, because it would
  // ship while looking like it had been protected.
  const mnemonic = (process.env.FAUCET_MNEMONIC ?? '').trim().replace(/\s+/g, ' ')
  if (mnemonic) {
    const words = mnemonic.split(' ')
    const probes = [mnemonic, words.slice(0, 4).join(' '), words.slice(0, 2).join(' ')]
    for (const file of targets) {
      const text = await readFile(join(ASSETS, file), 'utf8')
      const hit = probes.find((p) => text.includes(p))
      if (hit) {
        throw new Error(
          `the mnemonic is still plain text in dist/assets/${file} ` +
            `(matched ${hit.split(' ').length} consecutive words) -- ` +
            `refusing to leave a build that looks protected and is not`,
        )
      }
    }
    console.log('  verified  no run of mnemonic words survives as plain text')
  } else {
    console.log('  skipped   plain-text check (FAUCET_MNEMONIC not in this env)')
  }
}

await main()
