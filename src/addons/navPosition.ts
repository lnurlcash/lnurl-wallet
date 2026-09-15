import {createSignal} from 'solid-js'
import type {Addon} from './types'

// TODO.md: "add customizable position to addons, left / right" - an
// addon's manifest still DECLARES a default (see AddonNavEntry's own
// `position`), but a holder can override it per addon here, same
// module-level-signal + localStorage pattern as enabled.ts. Absent
// entirely for an addon that hasn't been overridden - effectiveNavPosition
// below falls back to the manifest's own default in that case.
const STORAGE_KEY = 'lnurlcash_addon_nav_position'

export type NavPosition = 'left' | 'right'

const isNavPosition = (v: unknown): v is NavPosition =>
  v === 'left' || v === 'right'

const readStored = (): Record<string, NavPosition> => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {}
    }
    const out: Record<string, NavPosition> = {}
    for (const [id, value] of Object.entries(
      parsed as Record<string, unknown>
    )) {
      if (isNavPosition(value)) out[id] = value
    }
    return out
  } catch {
    return {}
  }
}

const [navPositionOverrides, setNavPositionOverridesSignal] =
  createSignal<Record<string, NavPosition>>(readStored())
export {navPositionOverrides}

// pass null to clear the override and fall back to the addon's own
// manifest default again
export const setAddonNavPosition = (
  id: string,
  position: NavPosition | null
): void => {
  const next = {...navPositionOverrides()}
  if (position === null) delete next[id]
  else next[id] = position
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    // no persistent storage available - the in-memory signal below still
    // works for the rest of this session
  }
  setNavPositionOverridesSignal(next)
}

// the position Nav.tsx should actually place this addon's link at -
// undefined for an addon that never asked for a nav entry at all, same as
// before an override existed: a stray leftover override (e.g. from an
// addon that used to declare `nav` and no longer does) must never
// resurrect a link with no manifest.nav to read icon/label/route from
export const effectiveNavPosition = (addon: Addon): NavPosition | undefined => {
  if (!addon.manifest.nav) return undefined
  return (
    navPositionOverrides()[addon.manifest.id] ?? addon.manifest.nav.position
  )
}
