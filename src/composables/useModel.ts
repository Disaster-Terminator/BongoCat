import type { MonitorPoint } from '@/utils/monitor'
import type { Monitor } from '@tauri-apps/api/window'

import { LogicalSize } from '@tauri-apps/api/dpi'
import { resolveResource, sep } from '@tauri-apps/api/path'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { message } from 'ant-design-vue'
import { isNil, round } from 'es-toolkit'
import { nth } from 'es-toolkit/compat'
import { ref } from 'vue'

import live2d from '../utils/live2d'

import { useCatStore } from '@/stores/cat'
import { useModelStore } from '@/stores/model'
import { peekCursorMonitor, refreshMonitorCache } from '@/utils/monitor'

const MOUSE_PARAMETER_IDS = ['ParamMouseX', 'ParamMouseY', 'ParamAngleX', 'ParamAngleY'] as const
const MOUSE_FOLLOW_SPEED = 40
const MOUSE_FOLLOW_STOP_EPSILON = 0.001
const MAX_MOUSE_FOLLOW_DT_MS = 48
const DEFAULT_MOUSE_RATIO = 0.5
const parameterRanges = new Map<string, { min: number, max: number }>()
const modelSize = ref<ModelSize>()
let targetMouseXRatio = DEFAULT_MOUSE_RATIO
let targetMouseYRatio = DEFAULT_MOUSE_RATIO
let renderedMouseXRatio = DEFAULT_MOUSE_RATIO
let renderedMouseYRatio = DEFAULT_MOUSE_RATIO
let hasRenderedMouseRatio = false
let mouseFollowFrameId: number | undefined
let lastMouseFollowAt = 0
let lastResolvedMouseMonitor: Monitor | undefined

function clampRatio(value: number) {
  return Math.max(0, Math.min(1, value))
}

function getFollowAlpha(dtSeconds: number) {
  return 1 - Math.exp(-MOUSE_FOLLOW_SPEED * dtSeconds)
}

export interface ModelSize {
  width: number
  height: number
}

function stopMouseFollowLoop() {
  if (mouseFollowFrameId) {
    cancelAnimationFrame(mouseFollowFrameId)
    mouseFollowFrameId = void 0
  }

  lastMouseFollowAt = 0
}

function resetMouseFollowState() {
  stopMouseFollowLoop()
  targetMouseXRatio = DEFAULT_MOUSE_RATIO
  targetMouseYRatio = DEFAULT_MOUSE_RATIO
  renderedMouseXRatio = DEFAULT_MOUSE_RATIO
  renderedMouseYRatio = DEFAULT_MOUSE_RATIO
  hasRenderedMouseRatio = false
  lastResolvedMouseMonitor = void 0
}

export function useModel() {
  const getAppWindow = () => getCurrentWebviewWindow()
  const modelStore = useModelStore()
  const catStore = useCatStore()

  const getParameterRange = (id: string) => {
    const cachedRange = parameterRanges.get(id)

    if (cachedRange) {
      return cachedRange
    }

    const { min, max } = live2d.getParameterRange(id)

    if (isNil(min) || isNil(max)) {
      return { min, max }
    }

    const nextRange = { min, max }

    parameterRanges.set(id, nextRange)

    return nextRange
  }

  const applyRenderedMouseRatios = () => {
    if (!live2d.model) return

    for (const id of MOUSE_PARAMETER_IDS) {
      const { min, max } = getParameterRange(id)

      if (isNil(min) || isNil(max)) continue

      const isXAxis = id.endsWith('X')
      const ratio = isXAxis ? renderedMouseXRatio : renderedMouseYRatio
      let value = max - (ratio * (max - min))

      if (isXAxis && catStore.model.mouseMirror) {
        value *= -1
      }

      live2d.setParameterValue(id, value)
    }
  }

  const stepMouseFollow = (timestamp: number) => {
    mouseFollowFrameId = void 0

    if (!hasRenderedMouseRatio || !live2d.model) {
      lastMouseFollowAt = timestamp
      return
    }

    const deltaMs = lastMouseFollowAt
      ? Math.min(Math.max(timestamp - lastMouseFollowAt, 0), MAX_MOUSE_FOLLOW_DT_MS)
      : 16.667
    const alpha = getFollowAlpha(deltaMs / 1000)

    lastMouseFollowAt = timestamp
    renderedMouseXRatio += (targetMouseXRatio - renderedMouseXRatio) * alpha
    renderedMouseYRatio += (targetMouseYRatio - renderedMouseYRatio) * alpha

    const xSettled = Math.abs(targetMouseXRatio - renderedMouseXRatio) <= MOUSE_FOLLOW_STOP_EPSILON
    const ySettled = Math.abs(targetMouseYRatio - renderedMouseYRatio) <= MOUSE_FOLLOW_STOP_EPSILON

    if (xSettled) {
      renderedMouseXRatio = targetMouseXRatio
    }

    if (ySettled) {
      renderedMouseYRatio = targetMouseYRatio
    }

    applyRenderedMouseRatios()

    if (!xSettled || !ySettled) {
      mouseFollowFrameId = requestAnimationFrame(stepMouseFollow)
    }
  }

  const ensureMouseFollowLoop = () => {
    if (mouseFollowFrameId) return

    lastMouseFollowAt = performance.now()
    mouseFollowFrameId = requestAnimationFrame(stepMouseFollow)
  }

  const updateMouseTargetRatios = (cursorPoint: MonitorPoint) => {
    const resolvedMonitor = peekCursorMonitor(cursorPoint)

    if (resolvedMonitor) {
      lastResolvedMouseMonitor = resolvedMonitor
    } else {
      void refreshMonitorCache()
    }

    const monitor = resolvedMonitor ?? lastResolvedMouseMonitor

    if (!monitor) return false

    const { size, position } = monitor

    targetMouseXRatio = clampRatio((cursorPoint.x - position.x) / size.width)
    targetMouseYRatio = clampRatio((cursorPoint.y - position.y) / size.height)

    return true
  }

  async function handleLoad() {
    try {
      if (!modelStore.currentModel) return

      const { path } = modelStore.currentModel

      await resolveResource(path)

      const { width, height, ...rest } = await live2d.load(path)

      modelSize.value = { width, height }
      parameterRanges.clear()

      handleResize()
      applyRenderedMouseRatios()

      Object.assign(modelStore, rest)
    } catch (error) {
      message.error(String(error))
    }
  }

  function handleDestroy() {
    parameterRanges.clear()
    resetMouseFollowState()
    live2d.destroy()
  }

  async function handleResize() {
    if (!modelSize.value) return

    live2d.resizeModel(modelSize.value)

    const { width, height } = modelSize.value
    const appWindow = getAppWindow()

    if (round(innerWidth / innerHeight, 1) !== round(width / height, 1)) {
      await appWindow.setSize(
        new LogicalSize({
          width: innerWidth,
          height: Math.ceil(innerWidth * (height / width)),
        }),
      )
    }

    const size = await appWindow.size()

    catStore.window.scale = round((size.width / width) * 100)
  }

  const handlePress = (key: string) => {
    const path = modelStore.supportKeys[key]

    if (!path) return

    if (catStore.model.single) {
      const dirName = nth(path.split(sep()), -2)!

      const filterKeys = Object.entries(modelStore.pressedKeys).filter(([, value]) => {
        return value.includes(dirName)
      })

      for (const [key] of filterKeys) {
        handleRelease(key)
      }
    }

    modelStore.pressedKeys[key] = path
  }

  const handleRelease = (key: string) => {
    delete modelStore.pressedKeys[key]
  }

  function handleKeyChange(isLeft = true, pressed = true) {
    const id = isLeft ? 'CatParamLeftHandDown' : 'CatParamRightHandDown'

    live2d.setParameterValue(id, pressed)
  }

  function handleMouseChange(key: string, pressed = true) {
    const id = key === 'Left' ? 'ParamMouseLeftDown' : 'ParamMouseRightDown'

    live2d.setParameterValue(id, pressed)
  }

  function handleMouseMove(cursorPoint: MonitorPoint) {
    if (!updateMouseTargetRatios(cursorPoint)) {
      return
    }

    if (!hasRenderedMouseRatio) {
      renderedMouseXRatio = targetMouseXRatio
      renderedMouseYRatio = targetMouseYRatio
      hasRenderedMouseRatio = true

      applyRenderedMouseRatios()
      return
    }

    const xSettled = Math.abs(targetMouseXRatio - renderedMouseXRatio) <= MOUSE_FOLLOW_STOP_EPSILON
    const ySettled = Math.abs(targetMouseYRatio - renderedMouseYRatio) <= MOUSE_FOLLOW_STOP_EPSILON

    if (xSettled && ySettled) {
      renderedMouseXRatio = targetMouseXRatio
      renderedMouseYRatio = targetMouseYRatio
      applyRenderedMouseRatios()
      stopMouseFollowLoop()
      return
    }

    ensureMouseFollowLoop()
  }

  async function handleAxisChange(id: string, value: number) {
    const { min, max } = live2d.getParameterRange(id)

    live2d.setParameterValue(id, Math.max(min, value * max))
  }

  return {
    modelSize,
    handlePress,
    handleRelease,
    handleLoad,
    handleDestroy,
    handleResize,
    handleKeyChange,
    handleMouseChange,
    handleMouseMove,
    handleAxisChange,
  }
}
