import { PhysicalPosition } from '@tauri-apps/api/dpi'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { cursorPosition, monitorFromPoint } from '@tauri-apps/api/window'

export interface MonitorPoint {
  x: number
  y: number
}

const MONITOR_WARNING_INTERVAL_MS = 5000
let lastMonitorWarningAt = 0

function reportMonitorWarning(error: unknown) {
  if (!import.meta.env.DEV) return

  const now = Date.now()

  if (now - lastMonitorWarningAt < MONITOR_WARNING_INTERVAL_MS) return

  lastMonitorWarningAt = now
  console.warn('[getCursorMonitor] Failed to resolve monitor', error)
}

export async function getCursorMonitor(cursorPoint?: MonitorPoint) {
  try {
    const nextCursorPoint = cursorPoint ?? await cursorPosition()
    const physicalCursorPoint = new PhysicalPosition(nextCursorPoint.x, nextCursorPoint.y)

    const appWindow = getCurrentWebviewWindow()

    const scaleFactor = await appWindow.scaleFactor()

    const { x, y } = physicalCursorPoint.toLogical(scaleFactor)

    const monitor = await monitorFromPoint(x, y)

    if (!monitor) return

    return monitor
  } catch (error) {
    reportMonitorWarning(error)
  }
}
