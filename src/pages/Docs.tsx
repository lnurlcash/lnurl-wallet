import type {Component} from 'solid-js'
import {A} from '@solidjs/router'

const Docs: Component = () => {
  return (
    <div id="docs" class="page">
      <h2>Documentation</h2>

      <div class="docs-card">
        <h3>What LNURLwallet is</h3>
        <p>
          LNURLwallet is a static page with no backend, database or account
          system of its own. Everything it holds lives in your browser's local
          storage, and every network request it makes goes directly from your
          browser to the LNURLcash service that issued a note. One wallet holds
          notes from any number of independent services side by side.
        </p>
      </div>

      <div class="docs-card">
        <h3>
          LNURLcash bearer notes (
          <a
            href="https://github.com/lnurl/luds/blob/lnurlcash/25.md"
            target="_blank"
            rel="noreferrer"
          >
            LUD-25 draft
          </a>
          )
        </h3>
        <p>
          A bearer note is an ordinary{' '}
          <a
            href="https://github.com/lnurl/luds/blob/luds/03.md"
            target="_blank"
            rel="noreferrer"
          >
            LUD-03
          </a>{' '}
          withdrawRequest link whose <code>k1</code> <em>is</em> the asset -
          whoever knows it controls the sats behind it, like a banknote. See
          the spec linked above for the full protocol: melt, rotate, split,
          merge, minting, and offline verification signatures.
        </p>
        <p>What this wallet does beyond what the spec mandates:</p>
        <ul>
          <li>
            <strong>Generates every rotate/split/merge secret itself</strong>,
            never the service - disclosed to the service only as its hash, so
            the service is never a prior holder of a note it registers this
            way.
          </li>
          <li>
            <strong>Rotates a received note immediately</strong> after the
            informational GET that verifies it - whoever handed it over
            already knows the old secret, so their copy needs burning
            regardless.
          </li>
          <li>
            With a connected <strong>LNURLvault</strong> and a receipt-capable
            mint, the vault generates and holds the secret before the invoice
            exists; this wallet confirms the note only once the settled
            receipt's signature checks out against the pinned mint key.
            Without that, it falls back to a secret from its own seed-derived
            cash ladder.
          </li>
          <li>
            Requires <code>commentAllowed: 64</code> on new mints and commits
            the note's hash as the callback <code>comment</code>, refusing
            mints that don't support it before any invoice is created.
          </li>
        </ul>
      </div>

      <div class="docs-card">
        <h3>Offline verification</h3>
        <p>
          A bearer note is otherwise an opaque secret - an offline recipient
          can't tell who issued it, by whom, or for how much, until they're
          back online. The spec's signature scheme (see LUD-25 above) closes
          that gap; this wallet's own handling of it:
        </p>
        <ul>
          <li>
            Signing keys are <strong>pinned to a service's full origin</strong>
            (scheme + port), tracked on the{' '}
            <A href="/mint">Trusted mints</A> section of the Mint page. The
            first lookup against a brand new key asks whether to trust it; a
            later, different key is staged for review rather than silently
            replacing the pin, since an unsigned response cannot authorise its
            own replacement.
          </li>
          <li>
            Verification tries both the spec text's signature byte order and
            the recovery-id-leading order at least one real implementation
            has sent, rather than hard-failing real notes over it.
          </li>
          <li>
            A mint you already hold a note from is trusted automatically and
            can't be removed; anything added by hand can be. The list travels
            with your <A href="/settings">backup</A> in plain (a signing key
            isn't a secret), but restored keys stay unconfirmed until a live
            lookup corroborates them.
          </li>
        </ul>
      </div>

      <div class="docs-card">
        <h3>How your notes are stored: encrypted, locally</h3>
        <p>
          At setup the wallet generates a 12-word BIP39 seed phrase in your
          browser, and derives an AES-256 encryption key directly from it
          (sha256 over the BIP39 seed bytes plus a fixed context string) - no
          separate identity keypair in between.
        </p>
        <ul>
          <li>
            The <strong>seed phrase is never stored</strong> - write it down; it
            is the only way to recover the wallet on another device.
          </li>
          <li>
            Every <strong>bearer note is AES-GCM encrypted</strong> with the
            seed-derived key before it is written to local storage. Plaintext
            secrets never touch disk.
          </li>
          <li>
            The <strong>derived key itself is stored encrypted too</strong>:
            during setup you are asked for a password, and the key is saved as
            AES-GCM ciphertext under a PBKDF2 (210k iterations) stretch of that
            password. Unlocking decrypts it into memory only. (You can opt out,
            but then anyone using this browser profile can spend your notes.)
          </li>
          <li>
            Nothing is ever sent anywhere except the note operations you
            trigger, straight to the issuing service.
          </li>
        </ul>
        <p>
          A wallet created before this scheme shipped instead derives its key
          through a LUD-05 linking keypair the wallet never actually presents to
          any service - the Settings page's "Upgrade encryption" action re-derives
          and re-encrypts everything under the simpler seed-direct key, once,
          with the seed phrase re-entered to prove it belongs to that wallet.
        </p>
      </div>

      <div class="docs-card">
        <h3>Backup</h3>
        <p>
          The Settings page downloads a single JSON file containing{' '}
          <strong>all your bearer notes exactly as stored - encrypted</strong>.
          The file never contains a plaintext secret. If your encryption key is
          password-encrypted, its ciphertext is included as well, so backup +
          password restores everything on a new device; if you opted out of the
          password, the key is excluded and the seed phrase is your recovery
          path.
        </p>
        <h3>Restore</h3>
        <p>
          Restoring merges the file's notes into local storage, skipping ones
          already present. Ciphertexts only become readable again once the same
          seed (and thus the same derived key) is active - restore order doesn't
          matter: seed first or file first both work.
        </p>
        <p class="warning">
          A backup protects against a lost device, not against theft of the note
          itself: the issuing service settles for whoever presents a k1 first.
          Rotation is your tool against stale copies - after restoring an old
          backup, refresh (rotate) anything you still hold.
        </p>
        <h3>Forget this wallet</h3>
        <p>
          The Settings page can also wipe this wallet from the device entirely -
          the encryption key <em>and</em> every bearer note, after confirming.
          Unlike locking, this isn't undone by restoring the same seed
          afterward: the notes' ciphertext is deleted too, not just re-locked
          behind the key. Download a backup first if there's anything on this
          device worth keeping - it's the only way back.
        </p>
      </div>

      <div class="docs-card">
        <h3>Trust model</h3>
        <p>
          LNURLcash is custodial per service: the issuing service holds the
          actual sats and honors whoever bears the k1. This wallet spreads that
          trust across as many services as you like, keeps your copies encrypted
          at rest, and keeps secrets off the wire wherever the protocol allows -
          but it cannot make a service honest. Mint from services you trust.
        </p>
      </div>
    </div>
  )
}
export default Docs
