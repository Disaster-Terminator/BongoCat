import { invoke } from '@tauri-apps/api/core'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { isNumber } from 'es-toolkit/compat'
import { onUnmounted, watch, watchEffect } from 'vue'

import { INVOKE_KEY, LISTEN_KEY } from '../constants'

import { useModel } from './useModel'
import { useTauriListen } from './useTauriListen'

import { useAppStore } from '@/stores/app'
import { useCatStore } from '@/stores/cat'
import { useModelStore } from '@/stores/model'
import { inBetween } from '@/utils/is'
import { refreshMonitorCache } from '@/utils/monitor'
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
const DEVICE_WARNING_INTERVAL_MS = 5000
const deviceWarningAt = new Map<string, number>()
type WindowBounds = CursorPoint & { width: number, height: number }

function reportDeviceWarning(key: string, error: unknown) {
  if (!import.meta.env.DEV) return

  const now = Date.now()
  const lastWarningAt = deviceWarningAt.get(key) ?? 0

  if (now - lastWarningAt < DEVICE_WARNING_INTERVAL_MS) return

  deviceWarningAt.set(key, now)
  console.warn(`[useDevice] ${key}`, error)
}

export function useDevice() {
  const appWindow = getCurrentWebviewWindow()
  const appStore = useAppStore()
  const modelStore = useModelStore()
  const releaseTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const catStore = useCatStore()
  const { handlePress, handleRelease, handleMouseChange, handleMouseMove } = useModel()
  let lastCursorPoint: CursorPoint | undefined
  let latestHoverCursorPoint: CursorPoint | undefined
  let isHoverHidden = false
  let hoverEffectFrameId: number | undefined
  let windowBounds: WindowBounds | undefined
  let requestedIgnoreCursorEvents = false
  let appliedIgnoreCursorEvents: boolean | undefined
  let ignoreCursorEventsSyncing = false

  const startListening = () => {
    void refreshMonitorCache()
    invoke(INVOKE_KEY.START_DEVICE_LISTENING)
  }

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

  const syncWindowBounds = () => {
    const state = appStore.windowState[appWindow.label]

    if (!state) return

    const { x, y, width, height } = state

    if (isNumber(x) && isNumber(y) && isNumber(width) && isNumber(height)) {
      windowBounds = { x, y, width, height }
    }
  }

  const refreshWindowBounds = async () => {
    try {
      const [position, size] = await Promise.all([
        appWindow.outerPosition(),
        appWindow.innerSize(),
      ])

      windowBounds = {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
      }
    } catch (error) {
      reportDeviceWarning('hover-window-bounds', error)
    }
  }

  watchEffect(syncWindowBounds)
  void refreshWindowBounds()

  const flushIgnoreCursorEvents = () => {
    requestedIgnoreCursorEvents = isHoverHidden || catStore.window.passThrough

    if (ignoreCursorEventsSyncing) return

    ignoreCursorEventsSyncing = true

    void (async () => {
      try {
        while (appliedIgnoreCursorEvents !== requestedIgnoreCursorEvents) {
          const nextValue = requestedIgnoreCursorEvents

          await appWindow.setIgnoreCursorEvents(nextValue)

          appliedIgnoreCursorEvents = nextValue
        }
      } catch (error) {
        reportDeviceWarning('ignore-cursor-events', error)
      } finally {
        ignoreCursorEventsSyncing = false

        if (appliedIgnoreCursorEvents !== requestedIgnoreCursorEvents) {
          flushIgnoreCursorEvents()
        }
      }
    })()
  }

  const setHoverHidden = (hidden: boolean) => {
    if (isHoverHidden === hidden) return

    isHoverHidden = hidden

    if (hidden) {
      document.body.style.setProperty('opacity', '0')
    } else {
      document.body.style.removeProperty('opacity')
    }

    flushIgnoreCursorEvents()
  }

  const resetHideOnHover = () => {
    document.body.style.removeProperty('opacity')
    setHoverHidden(false)
  }

  const updateHideOnHover = (cursorPoint: CursorPoint) => {
    if (!catStore.window.hideOnHover) return

    if (!windowBounds) {
      void refreshWindowBounds()
      return
    }

    const isInWindow = inBetween(cursorPoint.x, windowBounds.x, windowBounds.x + windowBounds.width)
      && inBetween(cursorPoint.y, windowBounds.y, windowBounds.y + windowBounds.height)

    setHoverHidden(isInWindow)
  }

  const flushHoverEffect = () => {
    hoverEffectFrameId = void 0

    if (!latestHoverCursorPoint) return

    try {
      updateHideOnHover(latestHoverCursorPoint)
    } catch (error) {
      reportDeviceWarning('hover-effect', error)
    }
  }

  const scheduleHoverEffect = () => {
    if (hoverEffectFrameId) return

    hoverEffectFrameId = requestAnimationFrame(flushHoverEffect)
  }

  const handleCursorMove = (cursorPoint: CursorPoint) => {
    const nextCursorPoint = { x: cursorPoint.x, y: cursorPoint.y }

    lastCursorPoint = nextCursorPoint

    try {
      handleMouseMove(nextCursorPoint)
    } catch (error) {
      reportDeviceWarning('mouse-move', error)
    }

    if (!catStore.window.hideOnHover) return

    latestHoverCursorPoint = nextCursorPoint
    scheduleHoverEffect()
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
    if (!enabled) {
      resetHideOnHover()
      return
    }

    if (!windowBounds) {
      void refreshWindowBounds()
    }

    if (lastCursorPoint) {
      latestHoverCursorPoint = lastCursorPoint
      scheduleHoverEffect()
    }
  })

  watch(() => catStore.window.passThrough, () => {
    flushIgnoreCursorEvents()
  }, { immediate: true })

  onUnmounted(() => {
    if (hoverEffectFrameId) {
      cancelAnimationFrame(hoverEffectFrameId)
      hoverEffectFrameId = void 0
    }

    for (const [key, timer] of releaseTimers.entries()) {
      handleRelease(key)
      clearTimeout(timer)
    }

    releaseTimers.clear()
    lastCursorPoint = void 0
    latestHoverCursorPoint = void 0
    resetHideOnHover()
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
