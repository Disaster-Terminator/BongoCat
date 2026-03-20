import { invoke } from '@tauri-apps/api/core'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { onUnmounted, watch } from 'vue'

import { INVOKE_KEY, LISTEN_KEY } from '../constants'

import { useModel } from './useModel'
import { useTauriListen } from './useTauriListen'

import { useCatStore } from '@/stores/cat'
import { useModelStore } from '@/stores/model'
import { inBetween } from '@/utils/is'
import { isWindows } from '@/utils/platform'

interface MouseButtonEvent {
  kind: 'MousePress' | 'MouseRelease'
  value: string
}

export interface CursorPoint {
  x: number
  y: number
}

interface MouseMoveEvent {
  kind: 'MouseMove'
  value: CursorPoint
}

interface KeyboardEvent {
  kind: 'KeyboardPress' | 'KeyboardRelease'
  value: string
}

type DeviceEvent = MouseButtonEvent | MouseMoveEvent | KeyboardEvent
const MOUSE_MOVE_FRAME_MS = 16
const DEVICE_WARNING_INTERVAL_MS = 5000
const deviceWarningAt = new Map<string, number>()

function reportDeviceWarning(key: string, error: unknown) {
  if (!import.meta.env.DEV) return

  const now = Date.now()
  const lastWarningAt = deviceWarningAt.get(key) ?? 0

  if (now - lastWarningAt < DEVICE_WARNING_INTERVAL_MS) return

  deviceWarningAt.set(key, now)
  console.warn(`[useDevice] ${key}`, error)
}

export function useDevice() {
  const modelStore = useModelStore()
  const releaseTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const catStore = useCatStore()
  const { handlePress, handleRelease, handleMouseChange, handleMouseMove } = useModel()
  let latestCursorPoint: CursorPoint | undefined
  let isHoverHidden = false
  let lastMouseMoveAt = 0
  let mouseMoveVersion = 0
  let hoverEffectVersion = 0
  let mouseMoveTimer: ReturnType<typeof setTimeout> | undefined
  let ignoreCursorEventsTask: Promise<void> = Promise.resolve()

  const startListening = () => {
    invoke(INVOKE_KEY.START_DEVICE_LISTENING)
  }

  const getAppWindow = () => getCurrentWebviewWindow()

  const getSupportedKey = (key: string) => {
    let nextKey = key

    const unsupportedKey = !modelStore.supportKeys[nextKey]

    if (key.startsWith('F') && unsupportedKey) {
      nextKey = key.replace(/F(\d+)/, 'Fn')
    }

    for (const item of ['Meta', 'Shift', 'Alt', 'Control']) {
      if (key.startsWith(item) && unsupportedKey) {
        const regex = new RegExp(`^(${item}).*`)
        nextKey = key.replace(regex, '$1')
      }
    }

    return nextKey
  }

  const isLatestMouseMove = (version: number) => version === mouseMoveVersion
  const nextHoverEffectGuard = () => {
    hoverEffectVersion += 1

    const version = hoverEffectVersion

    return () => version === hoverEffectVersion
  }

  const syncIgnoreCursorEventsSafe = (
    { isLatest = () => true }: { isLatest?: () => boolean } = {},
  ) => {
    ignoreCursorEventsTask = ignoreCursorEventsTask
      .catch((error) => {
        reportDeviceWarning('ignore-cursor-events', error)
      })
      .then(async () => {
        if (!isLatest()) return

        try {
          await getAppWindow().setIgnoreCursorEvents(isHoverHidden || catStore.window.passThrough)
        } catch (error) {
          reportDeviceWarning('ignore-cursor-events', error)
        }
      })

    return ignoreCursorEventsTask
  }

  const resetHideOnHover = async (
    { isLatest = () => true }: { isLatest?: () => boolean } = {},
  ) => {
    if (!isLatest()) return

    isHoverHidden = false
    document.body.style.removeProperty('opacity')
    await syncIgnoreCursorEventsSafe({ isLatest })
  }

  const updateHideOnHover = async (
    cursorPoint: CursorPoint,
    { isLatest = () => true }: { isLatest?: () => boolean } = {},
  ) => {
    if (!isLatest()) return
    if (!catStore.window.hideOnHover) return

    const appWindow = getAppWindow()
    let position: CursorPoint
    let width: number
    let height: number

    try {
      [position, { width, height }] = await Promise.all([
        appWindow.outerPosition(),
        appWindow.innerSize(),
      ])
    } catch (error) {
      reportDeviceWarning('hover-window-bounds', error)
      return
    }

    if (!isLatest()) return
    if (!catStore.window.hideOnHover) return

    const isInWindow = inBetween(cursorPoint.x, position.x, position.x + width)
      && inBetween(cursorPoint.y, position.y, position.y + height)

    if (!isLatest()) return

    isHoverHidden = isInWindow
    if (isInWindow) {
      document.body.style.setProperty('opacity', '0')
    } else {
      document.body.style.removeProperty('opacity')
    }

    await syncIgnoreCursorEventsSafe({ isLatest })
  }

  const scheduleMouseMove = () => {
    if (mouseMoveTimer) return

    const delay = Math.max(0, MOUSE_MOVE_FRAME_MS - (performance.now() - lastMouseMoveAt))

    mouseMoveTimer = setTimeout(() => {
      mouseMoveTimer = void 0
      void flushMouseMove()
    }, delay)
  }

  const flushMouseMove = () => {
    if (!latestCursorPoint) return

    const cursorPoint = latestCursorPoint
    lastMouseMoveAt = performance.now()
    latestCursorPoint = void 0
    mouseMoveVersion += 1

    const version = mouseMoveVersion

    const isLatest = () => isLatestMouseMove(version)

    void handleMouseMove(cursorPoint, { isLatest }).catch((error) => {
      reportDeviceWarning('mouse-move', error)
    })

    if (catStore.window.hideOnHover) {
      const isLatestHoverEffect = nextHoverEffectGuard()

      void updateHideOnHover(cursorPoint, { isLatest: isLatestHoverEffect }).catch((error) => {
        reportDeviceWarning('hover-effect', error)
      })
    }
  }

  const handleCursorMove = (cursorPoint: CursorPoint) => {
    latestCursorPoint = { x: cursorPoint.x, y: cursorPoint.y }
    scheduleMouseMove()
  }

  const handleAutoRelease = (key: string, delay = 100) => {
    handlePress(key)

    if (releaseTimers.has(key)) {
      clearTimeout(releaseTimers.get(key))
    }

    const timer = setTimeout(() => {
      handleRelease(key)

      releaseTimers.delete(key)
    }, delay)

    releaseTimers.set(key, timer)
  }

  watch(() => catStore.window.hideOnHover, (enabled) => {
    const isLatestHoverEffect = nextHoverEffectGuard()

    if (!enabled) {
      void resetHideOnHover({ isLatest: isLatestHoverEffect })
    }
  })

  watch(() => catStore.window.passThrough, () => {
    void syncIgnoreCursorEventsSafe()
  }, { immediate: true })

  onUnmounted(() => {
    if (mouseMoveTimer) {
      clearTimeout(mouseMoveTimer)
      mouseMoveTimer = void 0
    }

    for (const [key, timer] of releaseTimers.entries()) {
      handleRelease(key)
      clearTimeout(timer)
    }

    releaseTimers.clear()
    mouseMoveVersion += 1
    latestCursorPoint = void 0
    isHoverHidden = false

    const isLatestHoverEffect = nextHoverEffectGuard()

    void resetHideOnHover({ isLatest: isLatestHoverEffect })
  })

  useTauriListen<DeviceEvent>(LISTEN_KEY.DEVICE_CHANGED, ({ payload }) => {
    const { kind, value } = payload

    if (kind === 'KeyboardPress' || kind === 'KeyboardRelease') {
      const nextValue = getSupportedKey(value)

      if (!nextValue) return

      if (nextValue === 'CapsLock') {
        return handleAutoRelease(nextValue)
      }

      if (kind === 'KeyboardPress') {
        if (isWindows) {
          const delay = catStore.model.autoReleaseDelay * 1000

          return handleAutoRelease(nextValue, delay)
        }

        return handlePress(nextValue)
      }

      return handleRelease(nextValue)
    }

    switch (kind) {
      case 'MousePress':
        return handleMouseChange(value)
      case 'MouseRelease':
        return handleMouseChange(value, false)
      case 'MouseMove':
        return handleCursorMove(value)
    }
  })

  return {
    startListening,
  }
}
