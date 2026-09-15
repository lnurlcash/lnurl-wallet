import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

let mod: typeof import('./notifications')

const stubNotification = (
  permission: NotificationPermission,
  requestResult: NotificationPermission = permission
) => {
  const ctor = vi.fn(function (this: unknown) {
    // constructor body intentionally empty - tests only assert it was
    // called, never that a real notification appeared
  }) as unknown as {
    new (title: string, options?: NotificationOptions): Notification
    permission: NotificationPermission
    requestPermission: () => Promise<NotificationPermission>
  }
  ctor.permission = permission
  ctor.requestPermission = vi.fn().mockResolvedValue(requestResult)
  vi.stubGlobal('Notification', ctor)
  return ctor
}

beforeEach(async () => {
  vi.resetModules()
  mod = await import('./notifications')
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('notificationsSupported / notificationPermission', () => {
  it('is unsupported with no Notification global', () => {
    vi.stubGlobal('Notification', undefined)
    expect(mod.notificationsSupported()).toBe(false)
    expect(mod.notificationPermission()).toBe('denied')
  })

  it('reflects the current Notification.permission', () => {
    stubNotification('granted')
    expect(mod.notificationsSupported()).toBe(true)
    expect(mod.notificationPermission()).toBe('granted')
  })
})

describe('requestNotificationPermission', () => {
  it('resolves false with no Notification API at all', async () => {
    vi.stubGlobal('Notification', undefined)
    expect(await mod.requestNotificationPermission()).toBe(false)
  })

  it('resolves true immediately when already granted, without prompting', async () => {
    const ctor = stubNotification('granted')
    expect(await mod.requestNotificationPermission()).toBe(true)
    expect(ctor.requestPermission).not.toHaveBeenCalled()
  })

  it('resolves false immediately when already denied, without prompting', async () => {
    const ctor = stubNotification('denied')
    expect(await mod.requestNotificationPermission()).toBe(false)
    expect(ctor.requestPermission).not.toHaveBeenCalled()
  })

  it('prompts when default, and reflects the result', async () => {
    const ctor = stubNotification('default', 'granted')
    expect(await mod.requestNotificationPermission()).toBe(true)
    expect(ctor.requestPermission).toHaveBeenCalledOnce()
  })

  it('resolves false if requestPermission itself throws', async () => {
    const ctor = stubNotification('default')
    ctor.requestPermission = vi.fn().mockRejectedValue(new Error('nope'))
    expect(await mod.requestNotificationPermission()).toBe(false)
  })
})

describe('sendNotification', () => {
  it('never constructs one without granted permission', () => {
    const ctor = stubNotification('default')
    mod.sendNotification('title')
    expect(ctor).not.toHaveBeenCalled()
  })

  it('constructs one when permission is granted', () => {
    const ctor = stubNotification('granted')
    mod.sendNotification('title', {body: 'body'})
    expect(ctor).toHaveBeenCalledWith('title', {body: 'body'})
  })

  it('never throws even if the constructor itself does', () => {
    const ctor = stubNotification('granted')
    vi.mocked(ctor).mockImplementation(() => {
      throw new Error('platform refused')
    })
    expect(() => mod.sendNotification('title')).not.toThrow()
  })
})
