import {omit} from 'solid-js'
import type {JSX} from '@solidjs/web'
import {useLinkState, useNavigate} from '@solidjs/router'

export type LinkProps = Omit<
  JSX.AnchorHTMLAttributes<HTMLAnchorElement>,
  'href' | 'onClick'
> & {
  // an app route, e.g. "/settings" or "/setup?tab=restore"
  href: string
  onClick?: (e: MouseEvent) => void
}

// What @solidjs/router 1.x's <A> did under a hash router, which 2.x dropped
// in favor of plain anchors - and a plain anchor can't get both halves of
// this right at once here. A `#/path` href is what keeps new-tab/copy-link
// working (and the app working under any GitHub Pages subpath), but the
// router's automatic link handling reads an anchor's URL *pathname*, which
// a hash route never touches: it would mark every link `aria-current` on
// "/" and none anywhere else. So this renders the hash href itself, takes
// link state from the route path via useLinkState, and sends a plain click
// through navigate() (scroll to top, like 1.x) while modified/middle
// clicks fall through to the browser's own handling of the href.
export const Link = (props: LinkProps) => {
  const navigate = useNavigate()
  const link = useLinkState(() => props.href)
  const rest = omit(props, 'href', 'onClick')
  const onClick = (e: MouseEvent) => {
    props.onClick?.(e)
    if (
      e.defaultPrevented ||
      e.button !== 0 ||
      e.metaKey ||
      e.ctrlKey ||
      e.shiftKey ||
      e.altKey
    )
      return
    e.preventDefault()
    navigate(props.href)
  }
  return (
    <a
      {...rest}
      href={`#${props.href}`}
      aria-current={link.current() ? 'page' : undefined}
      onClick={onClick}
    />
  )
}

export default Link
