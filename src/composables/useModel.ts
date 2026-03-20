import type { Model } from '@/stores/model'
import type { MonitorPoint } from '@/utils/monitor'
import type { Monitor } from '@tauri-apps/api/window'

import { PhysicalSize } from '@tauri-apps/api/dpi'
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
const LOW_FPS_FRAME_MS = 20
const LOW_FPS_SPEED_FACTOR = 1.6
const MAX_LOW_FPS_SPEED_BOOST = 40
const DISTANCE_SPEED_FACTOR = 140
const MAX_DISTANCE_SPEED_BOOST = 70
const LARGE_DISTANCE_THRESHOLD = 0.12
const LARGE_DISTANCE_MIN_ALPHA = 0.75
const REVERSAL_INPUT_THRESHOLD = 0.015
const REVERSAL_SPEED_BOOST = 55
const REVERSAL_MIN_ALPHA = 0.82
const REVERSAL_BOOST_TICKS = 2
const MAX_MOUSE_FOLLOW_ALPHA = 0.92
const parameterRanges = new Map<string, { min: number, max: number }>()
const modelSize = ref<ModelSize>()
let targetMouseXRatio = DEFAULT_MOUSE_RATIO
let targetMouseYRatio = DEFAULT_MOUSE_RATIO
let renderedMouseXRatio = DEFAULT_MOUSE_RATIO
let renderedMouseYRatio = DEFAULT_MOUSE_RATIO
let hasRenderedMouseRatio = false
let lastResolvedMouseMonitor: Monitor | undefined
let mouseFollowAttached = false
let readMouseMirror = () => false
let suppressScaleWriteback = false
let hasCompletedInitialWindowSizeSync = false
let lastTargetInputDeltaX = 0
let lastTargetInputDeltaY = 0
let reversalBoostTicksRemaining = 0

function clampRatio(value: number) {
  return Math.max(0, Math.min(1, value))
}

function getFollowAlpha(followSpeed: number, dtSeconds: number) {
  return 1 - Math.exp(-followSpeed * dtSeconds)
}

export interface ModelSize {
  width: number
  height: number
}

function getParameterRange(id: string) {
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

function applyRenderedMouseRatios() {
  if (!live2d.model) return

  for (const id of MOUSE_PARAMETER_IDS) {
    const { min, max } = getParameterRange(id)

    if (isNil(min) || isNil(max)) continue

    const isXAxis = id.endsWith('X')
    const ratio = isXAxis ? renderedMouseXRatio : renderedMouseYRatio
    let value = isXAxis
      ? max - (ratio * (max - min))
      : min + (ratio * (max - min))

    if (isXAxis && readMouseMirror()) {
      value *= -1
    }

    live2d.setParameterValue(id, value)
  }
}

function stopMouseFollowLoop() {
  if (!mouseFollowAttached) return

  live2d.removeFrameListener(stepMouseFollow)
  mouseFollowAttached = false
}

function stepMouseFollow(deltaMs: number) {
  if (!hasRenderedMouseRatio || !live2d.model) {
    stopMouseFollowLoop()
    return
  }

  const nextDeltaMs = deltaMs > 0 ? deltaMs : 16.667
  const dtSeconds = Math.min(nextDeltaMs, MAX_MOUSE_FOLLOW_DT_MS) / 1000
  const deltaX = targetMouseXRatio - renderedMouseXRatio
  const deltaY = targetMouseYRatio - renderedMouseYRatio
  const distance = Math.max(Math.abs(deltaX), Math.abs(deltaY))
  const lowFpsBoost = Math.min(
    MAX_LOW_FPS_SPEED_BOOST,
    Math.max(0, nextDeltaMs - LOW_FPS_FRAME_MS) * LOW_FPS_SPEED_FACTOR,
  )
  const distanceBoost = Math.min(
    MAX_DISTANCE_SPEED_BOOST,
    distance * DISTANCE_SPEED_FACTOR,
  )
  const reversalBoost = reversalBoostTicksRemaining > 0 ? REVERSAL_SPEED_BOOST : 0
  const followSpeed = MOUSE_FOLLOW_SPEED + lowFpsBoost + distanceBoost + reversalBoost
  let alpha = getFollowAlpha(followSpeed, dtSeconds)

  if (distance >= LARGE_DISTANCE_THRESHOLD) {
    alpha = Math.max(alpha, LARGE_DISTANCE_MIN_ALPHA)
  }

  if (reversalBoostTicksRemaining > 0) {
    alpha = Math.max(alpha, REVERSAL_MIN_ALPHA)
    reversalBoostTicksRemaining -= 1
  }

  alpha = Math.min(alpha, MAX_MOUSE_FOLLOW_ALPHA)

  renderedMouseXRatio += deltaX * alpha
  renderedMouseYRatio += deltaY * alpha

  const xSettled = Math.abs(targetMouseXRatio - renderedMouseXRatio) <= MOUSE_FOLLOW_STOP_EPSILON
  const ySettled = Math.abs(targetMouseYRatio - renderedMouseYRatio) <= MOUSE_FOLLOW_STOP_EPSILON

  if (xSettled) {
    renderedMouseXRatio = targetMouseXRatio
  }

  if (ySettled) {
    renderedMouseYRatio = targetMouseYRatio
  }

  applyRenderedMouseRatios()

  if (xSettled && ySettled) {
    stopMouseFollowLoop()
  }
}

function ensureMouseFollowLoop() {
  if (mouseFollowAttached) return

  live2d.addFrameListener(stepMouseFollow)
  mouseFollowAttached = true
}

function resetMouseFollowState() {
  stopMouseFollowLoop()
  targetMouseXRatio = DEFAULT_MOUSE_RATIO
  targetMouseYRatio = DEFAULT_MOUSE_RATIO
  renderedMouseXRatio = DEFAULT_MOUSE_RATIO
  renderedMouseYRatio = DEFAULT_MOUSE_RATIO
  hasRenderedMouseRatio = false
  lastResolvedMouseMonitor = void 0
  lastTargetInputDeltaX = 0
  lastTargetInputDeltaY = 0
  reversalBoostTicksRemaining = 0
}

export function useModel() {
  const appWindow = getCurrentWebviewWindow()
  const modelStore = useModelStore()
  const catStore = useCatStore()

  readMouseMirror = () => catStore.model.mouseMirror

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
    const nextTargetMouseXRatio = clampRatio((cursorPoint.x - position.x) / size.width)
    const nextTargetMouseYRatio = clampRatio((cursorPoint.y - position.y) / size.height)
    const nextTargetDeltaX = nextTargetMouseXRatio - targetMouseXRatio
    const nextTargetDeltaY = nextTargetMouseYRatio - targetMouseYRatio
    const xReversed = Math.abs(lastTargetInputDeltaX) > REVERSAL_INPUT_THRESHOLD
      && Math.abs(nextTargetDeltaX) > REVERSAL_INPUT_THRESHOLD
      && Math.sign(lastTargetInputDeltaX) !== Math.sign(nextTargetDeltaX)
    const yReversed = Math.abs(lastTargetInputDeltaY) > REVERSAL_INPUT_THRESHOLD
      && Math.abs(nextTargetDeltaY) > REVERSAL_INPUT_THRESHOLD
      && Math.sign(lastTargetInputDeltaY) !== Math.sign(nextTargetDeltaY)

    if (xReversed || yReversed) {
      reversalBoostTicksRemaining = REVERSAL_BOOST_TICKS
    }

    lastTargetInputDeltaX = nextTargetDeltaX
    lastTargetInputDeltaY = nextTargetDeltaY
    targetMouseXRatio = nextTargetMouseXRatio
    targetMouseYRatio = nextTargetMouseYRatio

    return true
  }

  async function handleLoad(
    model: Model | undefined = modelStore.currentModel,
    options: { showError?: boolean } = {},
  ) {
    try {
      if (!model) return false

      hasCompletedInitialWindowSizeSync = false

      const { path } = model

      await resolveResource(path)

      const { width, height, ...rest } = await live2d.load(path)

      modelSize.value = { width, height }
      parameterRanges.clear()

      live2d.resizeModel(modelSize.value)
      applyRenderedMouseRatios()

      Object.assign(modelStore, rest)

      return true
    } catch (error) {
      modelSize.value = void 0
      parameterRanges.clear()

      if (options.showError ?? true) {
        message.error(String(error))
      }

      return false
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

    if (!hasCompletedInitialWindowSizeSync || suppressScaleWriteback) {
      suppressScaleWriteback = false
      return
    }

    const { width } = modelSize.value
    const size = await appWindow.innerSize()
    const nextScale = round((size.width / width) * 100)

    if (catStore.window.scale !== nextScale) {
      catStore.window.scale = nextScale
    }
  }

  async function syncWindowSize() {
    if (!modelSize.value) return

    const { width, height } = modelSize.value
    const nextWidth = Math.round(width * (catStore.window.scale / 100))
    const nextHeight = Math.round(height * (catStore.window.scale / 100))
    const size = await appWindow.innerSize()

    hasCompletedInitialWindowSizeSync = true

    if (size.width === nextWidth && size.height === nextHeight) {
      return
    }

    suppressScaleWriteback = true

    try {
      await appWindow.setSize(
        new PhysicalSize({
          width: nextWidth,
          height: nextHeight,
        }),
      )
    } catch (error) {
      suppressScaleWriteback = false
      throw error
    }
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
    syncWindowSize,
    handleKeyChange,
    handleMouseChange,
    handleMouseMove,
    handleAxisChange,
  }
}
