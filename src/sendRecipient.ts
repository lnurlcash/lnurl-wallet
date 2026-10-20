import {decodeCx1, isCp1, type InternalTransferHint} from './lnurlcash'

// who SendToDialog names as a send's output
export type Recipient =
  | {kind: 'cp1'; cp1: string}
  | {kind: 'cx1'; hint: InternalTransferHint}
  | {kind: 'username'; username: string}

// a username may be typed bare or as a full address, as long as the
// address is at this same mint - anything else isn't an internal send
const USERNAME_RE = /^[a-z0-9_.-]{1,32}$/

export const parseRecipient = (raw: string, host: string): Recipient | null => {
  const value = raw.trim().toLowerCase()
  if (isCp1(value)) return {kind: 'cp1', cp1: value}
  // a cx1 alone, or with the same ":<index>" suffix a payRequest's own
  // text/cpub entry carries (internalTransfer.ts's
  // parseInternalTransferHint) - no index means start at 0, since
  // payInternalTransfer walks past any index already in use anyway
  const sep = value.lastIndexOf(':')
  const cx1 = decodeCx1(sep < 0 ? value : value.slice(0, sep))
  if (cx1) {
    const startIndex = sep < 0 ? 0 : Number(value.slice(sep + 1))
    if (!Number.isInteger(startIndex) || startIndex < 0) return null
    return {kind: 'cx1', hint: {cx1, startIndex}}
  }
  const at = value.lastIndexOf('@')
  const username = at < 0 ? value : value.slice(0, at)
  if (at >= 0 && value.slice(at + 1) !== host) return null
  return USERNAME_RE.test(username) ? {kind: 'username', username} : null
}
