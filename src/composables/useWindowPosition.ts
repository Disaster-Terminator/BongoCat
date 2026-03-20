import { PhysicalPosition } from '@tauri-apps/api/dpi'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { onMounted, ref, watch } from 'vue'

import { useCatStore } from '@/stores/cat'
import { getCursorMonitor } from '@/utils/monitor'

const appWindow = getCurrentWebviewWindow()
const WINDOW_POSITION_WARNING_INTERVAL_MS = 5000
let lastWindowPositionWarningAt = 0

function reportWindowPositionWarning(error: unknown) {
  if (!import.meta.env.DEV) return

  const now = Date.now()

  if (now - lastWindowPositionWarningAt < WINDOW_POSITION_WARNING_INTERVAL_MS) return

  lastWindowPositionWarningAt = now
  console.warn('[useWindowPosition] Failed to set window position', error)
}

export function useWindowPosition() {
  const catStore = useCatStore()
  const isMounted = ref(false)

  const setWindowPosition = async () => {
    try {
      const monitor = await getCursorMonitor()

      if (!monitor) return

      const { position, size } = monitor
      const windowSize = await appWindow.outerSize()

      switch (catStore.window.position) {
        case 'topLeft':
          return await appWindow.setPosition(new PhysicalPosition(position.x, position.y))
        case 'topRight':
          return await appWindow.setPosition(new PhysicalPosition(position.x + size.width - windowSize.width, position.y))
        case 'bottomLeft':
          return await appWindow.setPosition(new PhysicalPosition(position.x, position.y + size.height - windowSize.height))
        default:
          return await appWindow.setPosition(new PhysicalPosition(position.x + size.width - windowSize.width, position.y + size.height - windowSize.height))
      }
    } catch (error) {
      reportWindowPositionWarning(error)
    }
  }

  onMounted(() => {
    isMounted.value = true
    void setWindowPosition()

    appWindow.onScaleChanged(() => {
      void setWindowPosition()
    })
  })

  watch(() => catStore.window.position, () => {
    void setWindowPosition()
  })

  return {
    isMounted,
    setWindowPosition,
  }
}
