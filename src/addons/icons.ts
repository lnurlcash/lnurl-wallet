import type {Component} from 'solid-js'
import {
  IoPricetagsSharp,
  IoSwapHorizontalSharp,
  IoCodeSlashSharp,
  IoKeySharp,
  IoGlobeSharp,
  IoRadioSharp,
  IoGiftSharp,
  IoGitMergeSharp,
  IoPeopleSharp,
  IoTimerSharp,
  IoTelescopeSharp,
  IoDiceSharp,
  IoFingerPrintSharp,
  IoSnowSharp,
  IoGitBranchSharp
} from 'solid-icons/io'

// manifests reference an icon by name, never a component - keeps a
// manifest pure data, and keeps the set of icons addons can show to a
// fixed, reviewed allowlist rather than an arbitrary import
export const ADDON_ICONS: Record<string, Component> = {
  pricetags: IoPricetagsSharp,
  swap: IoSwapHorizontalSharp,
  code: IoCodeSlashSharp,
  key: IoKeySharp,
  globe: IoGlobeSharp,
  radio: IoRadioSharp,
  gift: IoGiftSharp,
  gitmerge: IoGitMergeSharp,
  people: IoPeopleSharp,
  timer: IoTimerSharp,
  telescope: IoTelescopeSharp,
  dice: IoDiceSharp,
  fingerprint: IoFingerPrintSharp,
  snow: IoSnowSharp,
  gitbranch: IoGitBranchSharp
}
