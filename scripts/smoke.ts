// The whole claim, driven against the running devnet, with no browser.
//
//   node --experimental-strip-types scripts/smoke.ts
//
// The only thing this substitutes for is the Syrius extension: `signAsUser`
// signs the user's blocks with a local devnet key instead of prompting. That is
// the one seam -- everything downstream of it is the code the page runs, on the
// chain the page talks to, and the assertions are read back off the ledger
// rather than out of the engine's own return value.
//
// It also pins the ABI method ids against go-zenon's encoder, because an id
// that drifts produces a call the contract rejects for a reason that names
// nothing useful.

import {
  ClaimError,
  RECIPIENT,
  client,
  faucet,
  forgetClaim,
  runClaim,
  sendPp,
  type ClaimState,
  type UserSigner,
} from '../src/claim.ts'
import { PP_PER_GLYPH, network } from '../src/config.ts'
import { methodId } from '../src/znn/abi.ts'
import { BlockPublisher } from '../src/znn/block.ts'
import { toHex } from '../src/znn/primitives.ts'
import { Account } from '../src/znn/wallet.ts'
import { FAUCET_MNEMONIC } from '../src/config.ts'

/** Devnet index 9 stands in for a visitor. It is not the faucet's account. */
const USER_INDEX = 9
const GLYPHS = 2

let checks = 0
let failures = 0

function check(ok: boolean, label: string, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${detail ? `  ${detail}` : ''}`)
}

function section(title: string): void {
  console.log(`\n${title}`)
}

async function main(): Promise<void> {
  section('abi')
  check(
    toHex(methodId('Create', ['address', 'int64', 'uint8', 'uint8', 'bytes'])) === '5c7e7110',
    'htlc Create id matches go-zenon',
  )
  check(toHex(methodId('Unlock', ['hash', 'bytes'])) === 'd33791d3', 'htlc Unlock id matches go-zenon')
  check(toHex(methodId('Reclaim', ['hash'])) === '7e003c8d', 'htlc Reclaim id matches go-zenon')

  section('chain')
  const momentum = await client.frontierMomentum()
  check(momentum.chainIdentifier === network.chainId, `node is chain ${network.chainId}`)
  check(!!network.ppZts && !!network.glyphsZts, 'both token ids are configured', `${network.ppZts} ${network.glyphsZts}`)

  const pp = await client.tokenByZts(network.ppZts)
  const glyphs = await client.tokenByZts(network.glyphsZts)
  check(pp?.symbol === 'PP', 'PP resolves on chain', pp ? `${pp.name} decimals ${pp.decimals}` : '')
  check(glyphs?.symbol === 'GLYPH', 'GLYPH resolves on chain', glyphs ? `decimals ${glyphs.decimals}` : '')
  check(pp?.decimals === 0 && glyphs?.decimals === 0, 'both tokens are 0-decimal, so amounts are counts')

  section('accounts')
  const user = Account.fromMnemonic(FAUCET_MNEMONIC, USER_INDEX)
  const userPublisher = new BlockPublisher(client, user, network.chainId)
  console.log(`  faucet ${faucet.address}`)
  console.log(`  user   ${user.address}`)
  check(user.address !== faucet.address, 'the stand-in user is not the faucet')
  // The check that was missing when the PP leg paid a hardcoded address: every
  // other assertion here passed while the recipient was a third party, and would
  // have passed just as happily while it was the claimant's own account -- a
  // swap that hands the PP straight back and gives the GLYPH away for free.
  check(RECIPIENT === faucet.address, 'the PP leg pays the faucet', RECIPIENT)

  // Anything the user was sent earlier and never received.
  await userPublisher.receiveAll()

  const needed = BigInt(GLYPHS) * PP_PER_GLYPH
  let userPp = await client.balanceOf(user.address, network.ppZts)
  if (userPp < needed) {
    console.log(`  funding the user with ${needed} PP…`)
    await sendPp(user.address, needed - userPp)
    for (let i = 0; i < 20 && userPp < needed; i++) {
      await userPublisher.receiveAll()
      userPp = await client.balanceOf(user.address, network.ppZts)
      if (userPp < needed) await new Promise((r) => setTimeout(r, 3_000))
    }
  }
  check(userPp >= needed, `the user holds the ${needed} PP a claim costs`, `${userPp}`)

  const before = {
    faucetGlyphs: await client.balanceOf(faucet.address, network.glyphsZts),
    faucetPp: await client.balanceOf(faucet.address, network.ppZts),
    userGlyphs: await client.balanceOf(user.address, network.glyphsZts),
    userPp,
  }

  section('claim')
  // The one seam: a local key where the extension would be.
  const signAsUser: UserSigner = async (spec) =>
    spec.blockType === 3 && spec.fromBlockHash
      ? userPublisher.receive(spec.fromBlockHash)
      : userPublisher.send({
          toAddress: spec.toAddress,
          amount: spec.amount,
          tokenStandard: spec.tokenStandard,
          data: spec.data,
        })

  forgetClaim()
  const seen: string[] = []
  let final: ClaimState
  try {
    final = await runClaim({
      glyphs: GLYPHS,
      user: user.address,
      signAsUser,
      onState: (state) => {
        if (seen.at(-1) !== state.phase) {
          seen.push(state.phase)
          console.log(`  · ${state.phase.padEnd(17)} ${state.message}`)
        }
      },
    })
  } catch (err) {
    check(false, 'the claim ran to completion', err instanceof ClaimError ? err.message : String(err))
    return report()
  }

  check(final.phase === 'done', 'the claim reached done', final.message)
  check(!!final.ppHtlcId, 'the PP leg was recorded', final.ppHtlcId?.slice(0, 12))
  check(!!final.glyphsHtlcId, 'the GLYPH leg was recorded', final.glyphsHtlcId?.slice(0, 12))

  section('ledger')
  check((await client.htlcById(final.ppHtlcId!)) === null, 'the PP entry is gone, so it was unlocked')
  check((await client.htlcById(final.glyphsHtlcId!)) === null, 'the GLYPH entry is gone, so it was unlocked')

  // The GLYPH arrives as a send from the contract and is only spendable once
  // received -- which is a block only the user's own wallet can publish.
  for (let i = 0; i < 20; i++) {
    if ((await userPublisher.receiveAll()) > 0) break
    await new Promise((r) => setTimeout(r, 3_000))
  }

  const after = {
    faucetGlyphs: await client.balanceOf(faucet.address, network.glyphsZts),
    faucetPp: await client.balanceOf(faucet.address, network.ppZts),
    userGlyphs: await client.balanceOf(user.address, network.glyphsZts),
    userPp: await client.balanceOf(user.address, network.ppZts),
  }

  check(
    after.userGlyphs - before.userGlyphs === BigInt(GLYPHS),
    `the user gained ${GLYPHS} GLYPH`,
    `${before.userGlyphs} → ${after.userGlyphs}`,
  )
  check(
    before.userPp - after.userPp === needed,
    `the user spent ${needed} PP`,
    `${before.userPp} → ${after.userPp}`,
  )
  check(
    after.faucetGlyphs - before.faucetGlyphs === -BigInt(GLYPHS),
    'the faucet paid out of its own balance',
    `${before.faucetGlyphs} → ${after.faucetGlyphs}`,
  )
  // The claim sweeps the faucet's own receives, so this should be a balance.
  // The pending arm is the fallback for a sweep that timed out: the PP left the
  // HTLC and is addressed to the faucet either way, which is the real assertion.
  const faucetPending = await client.unreceivedBlocks(faucet.address)
  const paid = (faucetPending.list ?? []).some(
    (b) => b.tokenStandard === network.ppZts && BigInt(b.amount) === needed,
  )
  check(
    after.faucetPp - before.faucetPp === needed || paid,
    `the faucet was paid the ${needed} PP`,
    `${before.faucetPp} → ${after.faucetPp}${paid ? ' (unswept)' : ''}`,
  )

  report()
}

function report(): void {
  console.log(`\n${checks - failures}/${checks} checks passed`)
  if (failures > 0) process.exit(1)
}

main().catch((err) => {
  console.error(`\nfailed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`)
  process.exit(1)
})
