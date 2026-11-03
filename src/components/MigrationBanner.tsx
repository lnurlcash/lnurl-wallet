import type {Component} from 'solid-js'
import {Show, createMemo, createSignal} from 'solid-js'
import {A, useLocation} from '@solidjs/router'
import {IoCloseSharp} from 'solid-icons/io'

import {useWallet} from '../WalletContext'
import {msatToSats} from '../helpers'
import {addressesToMigrate, notesToMigrate} from '../lud26Migration'

const DISMISSED_KEY = 'lnurlcash_lud26_banner_dismissed'

const readDismissed = (): boolean => {
  try {
    return sessionStorage.getItem(DISMISSED_KEY) === '1'
  } catch {
    return false
  }
}

// App-wide reminder of what LUD-26 left to do by hand (see
// lud26Migration.ts), pointing at the page that does it. Hidden on those
// pages themselves, which carry their own, actionable version, and
// dismissible for the rest of the session.
const MigrationBanner: Component = () => {
  const {state, bearers} = useWallet()
  const location = useLocation()
  const [dismissed, setDismissed] = createSignal(readDismissed())

  const addresses = createMemo(() =>
    state() === 'unlocked' ? addressesToMigrate() : []
  )
  const notes = createMemo(() =>
    state() === 'unlocked' ? notesToMigrate(bearers()) : []
  )
  const notesSats = () =>
    msatToSats(notes().reduce((sum, b) => sum + b.amount, 0))
  const onOwnPage = () =>
    location.pathname.startsWith('/wallet') ||
    location.pathname.startsWith('/address')

  const dismiss = () => {
    setDismissed(true)
    try {
      sessionStorage.setItem(DISMISSED_KEY, '1')
    } catch {
      // private mode: dismissed for this page view only
    }
  }

  return (
    <Show
      when={
        !dismissed() &&
        !onOwnPage() &&
        (addresses().length > 0 || notes().length > 0)
      }
    >
      <div class="page migration-banner">
        <div class="warning">
          <button
            class="icon-btn migration-banner-close"
            title="Hide until the next session"
            onClick={dismiss}
          >
            <IoCloseSharp />
          </button>
          <strong>Your wallet needs a step after the LUD-26 upgrade.</strong>
          <Show when={addresses().length > 0}>
            <p>
              {addresses().length} Lightning Address
              {addresses().length === 1 ? ' is' : 'es are'} still on the old
              keys. Payments keep arriving, but move{' '}
              {addresses().length === 1 ? 'it' : 'each'} to a new key on the{' '}
              <A href="/address">Addresses</A> page (Manage → Move to a new
              key), then run a full rescan there.
            </p>
          </Show>
          <Show when={notes().length > 0}>
            <p>
              {notes().length} note{notes().length === 1 ? '' : 's'} (
              {notesSats()} sats) {notes().length === 1 ? 'is' : 'are'} not on
              your seed's new derivation, so restoring from your seed alone
              might not find {notes().length === 1 ? 'it' : 'them'}. Refresh{' '}
              {notes().length === 1 ? 'it' : 'them'} on the{' '}
              <A href="/wallet">Wallet</A> page.
            </p>
          </Show>
        </div>
      </div>
    </Show>
  )
}
export default MigrationBanner
