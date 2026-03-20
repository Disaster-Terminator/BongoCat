import type { Monitor } from '@tauri-apps/api/window'

import { availableMonitors, cursorPosition } from '@tauri-apps/api/window'

export interface MonitorPoint {
  x: number
  y: number
}

const MONITOR_WARNING_INTERVAL_MS = 5000
let lastMonitorWarningAt = 0
let cachedMonitors: Monitor[] = []
let activeMonitor: Monitor | undefined
let refreshMonitorsTask: Promise<Monitor[]> | undefined

function reportMonitorWarning(error: unknown) {
  if (!import.meta.env.DEV) return

  const now = Date.now()

  if (now - lastMonitorWarningAt < MONITOR_WARNING_INTERVAL_MS) return

  lastMonitorWarningAt = now
  console.warn('[getCursorMonitor] Failed to resolve monitor', error)
}

function isPointInMonitor(cursorPoint: MonitorPoint, monitor: Monitor) {
  return cursorPoint.x >= monitor.position.x
    && cursorPoint.x < monitor.position.x + monitor.size.width
    && cursorPoint.y >= monitor.position.y
    && cursorPoint.y < monitor.position.y + monitor.size.height
}

function resolveMonitorFromCache(cursorPoint: MonitorPoint) {
  if (activeMonitor && isPointInMonitor(cursorPoint, activeMonitor)) {
    return activeMonitor
  }

  const matchedMonitor = cachedMonitors.find(monitor => isPointInMonitor(cursorPoint, monitor))

  if (!matchedMonitor) return

  activeMonitor = matchedMonitor

  return matchedMonitor
}

export function peekCursorMonitor(cursorPoint: MonitorPoint) {
  return resolveMonitorFromCache(cursorPoint)
}

export async function refreshMonitorCache() {
  if (refreshMonitorsTask) {
    return refreshMonitorsTask
  }

  refreshMonitorsTask = availableMonitors()
    .then((monitors) => {
      cachedMonitors = monitors
      activeMonitor = void 0

      return monitors
    })
    .catch((error) => {
      reportMonitorWarning(error)

      return cachedMonitors
    })
    .finally(() => {
      refreshMonitorsTask = void 0
    })

  return refreshMonitorsTask
}

export async function getCursorMonitor(cursorPoint?: MonitorPoint) {
  try {
    const nextCursorPoint = cursorPoint ?? await cursorPosition()
    const cachedMonitor = resolveMonitorFromCache(nextCursorPoint)

    if (cachedMonitor) {
      return cachedMonitor
    }

    await refreshMonitorCache()

    return resolveMonitorFromCache(nextCursorPoint)
  } catch (error) {
    reportMonitorWarning(error)
  }
}
