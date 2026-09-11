import type {Component} from 'solid-js'
import {
  IoPricetagsSharp,
  IoSwapHorizontalSharp,
  IoCodeSlashSharp,
  IoKeySharp
} from 'solid-icons/io'

// manifests reference an icon by name, never a component - keeps a
// manifest pure data, and keeps the set of icons addons can show to a
// fixed, reviewed allowlist rather than an arbitrary import
export const ADDON_ICONS: Record<string, Component> = {
  pricetags: IoPricetagsSharp,
  swap: IoSwapHorizontalSharp,
  code: IoCodeSlashSharp,
  key: IoKeySharp
}
