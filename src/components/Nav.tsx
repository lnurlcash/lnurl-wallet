import {Show, For, createSignal} from 'solid-js'
import {A, useNavigate} from '@solidjs/router'
import {
  IoMenuSharp,
  IoCloseSharp,
  IoWalletSharp,
  IoAddCircleSharp,
  IoLockClosedSharp,
  IoBookSharp,
  IoCogSharp,
  IoHardwareChipSharp,
  IoReceiptSharp,
  IoAtCircleSharp
} from 'solid-icons/io'
import {useWallet} from '../WalletContext'
import {useDevice} from '../DeviceContext'
import {allAddons} from '../addons/registry'
import {enabledAddonIds} from '../addons/enabled'
import {ADDON_ICONS} from '../addons/icons'

// enabled addons (bundled or custom) that asked for a nav entry (see
// addons/types.ts's AddonNavEntry) - 'left' joins Wallet/Mint/Vault
// (.nav-links), 'right' joins Docs/Activity/Settings (.nav-persistent),
// same as any other link there. Disabled addons contribute nothing here
// regardless of what their manifest declares.
const addonsWithNav = (position: 'left' | 'right') =>
  allAddons().filter(
    a =>
      enabledAddonIds().has(a.manifest.id) &&
      a.manifest.nav?.position === position
  )

const Nav = () => {
  const {state, encrypted, lock} = useWallet()
  const {connectionState} = useDevice()
  const navigate = useNavigate()
  const [menuOpen, setMenuOpen] = createSignal(false)

  const closeMenu = () => setMenuOpen(false)

  const lock_action = () => {
    closeMenu()
    lock()
    navigate('/wallet')
  }

  return (
    <nav>
      <button
        class="nav-toggle"
        title={menuOpen() ? 'Close menu' : 'Open menu'}
        onClick={() => setMenuOpen(v => !v)}
      >
        {menuOpen() ? <IoCloseSharp /> : <IoMenuSharp />}
      </button>
      <A href="/" class="nav-brand" onClick={closeMenu}>
        LNURLwallet
      </A>
      {/* wraps both groups so they collapse into one dropdown on mobile -
      Docs always renders regardless of wallet state, so this is never
      empty when opened (see .nav-menu in style.scss) */}
      <div class="nav-menu" classList={{open: menuOpen()}} onClick={closeMenu}>
        <div class="nav-links">
          {/* shown whenever there's a wallet on this device, even locked -
          that's where the unlock form lives now that "/" is the landing
          page (see pages/Hero.tsx and pages/Wallet.tsx) */}
          <Show when={state() !== 'none'}>
            <A href="/wallet" class="nav-link">
              <IoWalletSharp />
              &nbsp;Wallet
            </A>
          </Show>
          {/* not gated on state()/offlineMode() - trusted-mint management
          lives at the bottom of this page too now (see pages/Mint.tsx) and
          stays usable without an unlocked wallet or a network connection,
          same as /backup below. Melt has no nav link of its own anymore -
          it's a dialog on the Wallet page now (see its own "Melt" button),
          same as Send/Receive */}
          <A
            href="/mint"
            class="nav-link"
            title="Mint a note, or manage trusted mints"
          >
            <IoAddCircleSharp />
            &nbsp;Mint
          </A>
          <A
            href="/vault"
            class="nav-link"
            title={
              connectionState() === 'connected'
                ? 'LNURLvault - connected'
                : 'LNURLvault - pair a hardware device'
            }
          >
            <IoHardwareChipSharp />
            &nbsp;Vault
          </A>
          {/* claiming/checking a registered username needs this wallet's
          own seed-derived key branch (see cashSecrets.ts's
          cashAddressBranch) - gated the same as Wallet, unlike Mint/Vault
          above, since a device with no wallet has no branch to claim with */}
          <Show when={state() !== 'none'}>
            <A
              href="/addresses"
              class="nav-link"
              title="Claim a username at a trusted mint"
            >
              <IoAtCircleSharp />
              &nbsp;Addresses
            </A>
          </Show>
          <Show when={state() !== 'none'}>
            <For each={addonsWithNav('left')}>
              {addon => {
                const Icon = ADDON_ICONS[addon.manifest.nav!.icon]
                return (
                  <A
                    href={
                      addon.manifest.nav!.route ??
                      `/addons/${addon.manifest.id}`
                    }
                    class="nav-link"
                  >
                    {Icon && <Icon />}
                    &nbsp;{addon.manifest.nav!.label}
                  </A>
                )
              }}
            </For>
          </Show>
        </div>
        <div class="nav-persistent">
          {/* not gated on state() === 'unlocked' - restoring a backup (now
          one of the cards on this page) is exactly what a device with no
          wallet yet (state() === 'none') needs this link for, and hiding it
          there was the whole bug this comment used to guard against on the
          old standalone /backup link: after "Forget this wallet" there was
          no way back to it at all */}
          <A href="/docs" title="Documentation">
            <IoBookSharp />
            <span class="nav-label">&nbsp;Docs</span>
          </A>
          <Show when={state() !== 'none'}>
            <A
              href="/activity"
              title="Activity log - a history of every mint, split, combine, melt and transfer"
            >
              <IoReceiptSharp />
              <span class="nav-label">&nbsp;Activity</span>
            </A>
          </Show>
          <A
            href="/settings"
            title="Settings - auto-lock, currency, offline mode, backup, restore &amp; addons"
          >
            <IoCogSharp />
            <span class="nav-label">&nbsp;Settings</span>
          </A>
          <Show when={state() !== 'none'}>
            <For each={addonsWithNav('right')}>
              {addon => {
                const Icon = ADDON_ICONS[addon.manifest.nav!.icon]
                return (
                  <A
                    href={
                      addon.manifest.nav!.route ??
                      `/addons/${addon.manifest.id}`
                    }
                  >
                    {Icon && <Icon />}
                    <span class="nav-label">
                      &nbsp;{addon.manifest.nav!.label}
                    </span>
                  </A>
                )
              }}
            </For>
          </Show>
          <Show when={state() === 'unlocked' && encrypted()}>
            <a href="#lock" title="Lock wallet" onClick={lock_action}>
              <IoLockClosedSharp />
              <span class="nav-label">&nbsp;Lock</span>
            </a>
          </Show>
        </div>
      </div>
    </nav>
  )
}
export default Nav
