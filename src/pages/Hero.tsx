import type {Component} from 'solid-js'
import {Show} from 'solid-js'
import {
  IoCashSharp,
  IoLockClosedSharp,
  IoServerSharp,
  IoGitBranchSharp,
  IoSaveSharp,
  IoHardwareChipSharp
} from 'solid-icons/io'

import {useWallet} from '../WalletContext'
import Link from '../components/Link'

// The home page - always the marketing/landing view, regardless of wallet
// state. The actual wallet (bearer list, unlock form) lives at /wallet;
// this only ever links there.
const Hero: Component = () => {
  const {state} = useWallet()

  return (
    <div id="hero" class="page">
      <section class="hero-intro">
        <h1>Your LNURLcash wallet</h1>
        <p class="hero-subtitle">
          LNURLwallet is a static page with no backend of its own. It holds
          LNURLcash bearer notes - LNURL-withdraw links whose k1 is the asset -
          from any number of mints, encrypted with a key derived from your seed
          phrase and stored only in this browser's local storage.
        </p>
        <div class="hero-actions">
          <Show
            when={state() !== 'none'}
            fallback={
              <Link href="/setup" class="hero-btn hero-btn-primary">
                Create wallet
              </Link>
            }
          >
            <Link href="/wallet" class="hero-btn hero-btn-primary">
              Go to my wallet
            </Link>
          </Show>
        </div>
      </section>
      <section class="hero-features">
        <div class="hero-feature">
          <IoCashSharp />
          <h3>Bearer notes (LUD-25)</h3>
          <p>
            A note is a plain LNURL-withdraw link whose k1 is the asset -
            whoever holds it controls the sats. Any wallet can cash one out;
            this one can do much more.
          </p>
        </div>
        <div class="hero-feature">
          <IoLockClosedSharp />
          <h3>Encrypted at rest</h3>
          <p>
            Every note is AES-GCM encrypted with a key derived straight from
            your seed phrase before it touches local storage - and that derived
            key itself can be password-encrypted too.
          </p>
        </div>
        <div class="hero-feature">
          <IoServerSharp />
          <h3>Many mints, one wallet</h3>
          <p>
            Notes carry their issuing service with them, so one wallet holds
            LNURLcash from any number of independent mints side by side.
          </p>
        </div>
        <div class="hero-feature">
          <IoGitBranchSharp />
          <h3>Melt, split, combine</h3>
          <p>
            Melt a note into any bolt11 payment, split it into change, or merge
            same-mint notes into one.
          </p>
        </div>
        <div class="hero-feature">
          <IoSaveSharp />
          <h3>Backup &amp; restore</h3>
          <p>
            Download all your bearer notes as one file - still encrypted,
            exactly as stored. Restore them anywhere with your seed phrase.
          </p>
        </div>
        <div class="hero-feature">
          <IoHardwareChipSharp />
          <h3>Optional hardware vault</h3>
          <p>
            Pair an LNURLvault device over USB or Bluetooth and it takes over
            generating and holding your note secrets - this wallet only ever
            keeps a blank mirror of what's on it, never the real thing.
          </p>
        </div>
      </section>
    </div>
  )
}
export default Hero
