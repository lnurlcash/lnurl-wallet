import {isCp1} from './lnurlcash'

// who SendToDialog names as a send's output
export type Recipient =
  {kind: 'cp1'; cp1: string} | {kind: 'username'; username: string}

// a username may be typed bare or as a full address, as long as the
// address is at this same mint - anything else isn't an internal send
const USERNAME_RE = /^[a-z0-9_.-]{1,32}$/

export const parseRecipient = (raw: string, host: string): Recipient | null => {
  const value = raw.trim().toLowerCase()
  if (isCp1(value)) return {kind: 'cp1', cp1: value}
  const at = value.lastIndexOf('@')
  const username = at < 0 ? value : value.slice(0, at)
  if (at >= 0 && value.slice(at + 1) !== host) return null
  return USERNAME_RE.test(username) ? {kind: 'username', username} : null
}
