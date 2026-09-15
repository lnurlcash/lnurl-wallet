// thin wrapper around the browser Notification API (TODO.md: "add
// notification enable notifications on PWA when enabling the background
// scans so a successful scan of a note each not can be a notification") -
// used by AddressAutoScanner.tsx to surface a note it found while the
// holder wasn't looking at the tab. Deliberately just `new Notification`
// from the page, not a service-worker-registered one: this auto-scanner
// only ever runs while the app/tab is actually open (see its own top
// comment on why true background execution - Periodic Background Sync -
// isn't built yet), so there's no need for the SW-routed form a closed-app
// background task would require.
// checks the bare global, not window.Notification - identical in a real
// browser (every global is also a window property there), but this stays
// correct in a context with no window at all too, which a Periodic
// Background Sync handler (self, not window) would eventually be
export const notificationsSupported = (): boolean =>
  typeof Notification !== 'undefined'

export const notificationPermission = (): NotificationPermission =>
  notificationsSupported() ? Notification.permission : 'denied'

// call from a direct user gesture (e.g. turning an auto-scan toggle ON) -
// most browsers silently ignore/reject a permission request made outside
// one. Resolves false on anything but an explicit "granted", including
// "denied" and an environment with no Notification API at all.
export const requestNotificationPermission = async (): Promise<boolean> => {
  if (!notificationsSupported()) return false
  if (Notification.permission === 'granted') return true
  if (Notification.permission === 'denied') return false
  try {
    const result = await Notification.requestPermission()
    return result === 'granted'
  } catch {
    return false
  }
}

// never throws - a Notification construction can still fail per-platform
// (e.g. some mobile browsers require a service-worker registration even
// for a foreground notification) and this is always best-effort; the
// caller's own toast is the guaranteed feedback path, this is a bonus
export const sendNotification = (
  title: string,
  options?: NotificationOptions
): void => {
  if (notificationPermission() !== 'granted') return
  try {
    new Notification(title, options)
  } catch {
    // best-effort only - see top comment
  }
}
