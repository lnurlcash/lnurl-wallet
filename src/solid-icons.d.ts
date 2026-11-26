// solid-icons 2.0 supports Solid 2 at runtime (its components ship as JSX
// source, compiled by this app's own @solidjs/vite-plugin), but its type
// declarations still import `JSX` from "solid-js" - which Solid 2 no longer
// exports (it moved to @solidjs/web). That leaves IconProps extending an
// unresolved type, so every standard SVG attribute (class, aria-*, ...)
// stops type-checking on an icon. Re-attach them from @solidjs/web's own
// JSX namespace. Drop this once solid-icons ships fixed types.
import type {JSX} from '@solidjs/web'

declare module 'solid-icons/lib' {
  interface IconProps extends JSX.SvgSVGAttributes<SVGSVGElement> {}
}
