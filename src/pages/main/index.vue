<script setup lang="ts">
import { convertFileSrc } from '@tauri-apps/api/core'
import { Menu } from '@tauri-apps/api/menu'
import { sep } from '@tauri-apps/api/path'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { exists, readDir } from '@tauri-apps/plugin-fs'
import { useDebounceFn, useEventListener } from '@vueuse/core'
import { round } from 'es-toolkit'
import { nth } from 'es-toolkit/compat'
import { nextTick, onMounted, onUnmounted, ref, watch } from 'vue'

import { useDevice } from '@/composables/useDevice'
import { useGamepad } from '@/composables/useGamepad'
import { useModel } from '@/composables/useModel'
import { useSharedMenu } from '@/composables/useSharedMenu'
import { useWindowPosition } from '@/composables/useWindowPosition'
import { hideWindow, setAlwaysOnTop, setTaskbarVisibility, showWindow } from '@/plugins/window'
import { useCatStore } from '@/stores/cat'
import { useGeneralStore } from '@/stores/general.ts'
import { useModelStore } from '@/stores/model'
import { isImage } from '@/utils/is'
import { join } from '@/utils/path'
import { clearObject } from '@/utils/shared'

const { startListening } = useDevice()
const appWindow = getCurrentWebviewWindow()
const { modelSize, handleLoad, handleDestroy, handleResize, syncWindowSize, handleKeyChange } = useModel()
const catStore = useCatStore()
const { getSharedMenu } = useSharedMenu()
const modelStore = useModelStore()
const generalStore = useGeneralStore()
const resizing = ref(false)
const backgroundImagePath = ref<string>()
const { stickActive } = useGamepad()
const { isMounted, setWindowPosition } = useWindowPosition()
const isCanvasReady = ref(false)
let loadedModelId: string | undefined
let modelLoadVersion = 0

onUnmounted(handleDestroy)

const debouncedResize = useDebounceFn(async () => {
  await handleResize()
  void setWindowPosition()

  resizing.value = false
}, 100)

useEventListener('resize', () => {
  resizing.value = true

  debouncedResize()
})

function waitForAnimationFrame() {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve())
  })
}

async function ensureCanvasReady() {
  await nextTick()

  let canvas = document.getElementById('live2dCanvas')

  if (!(canvas instanceof HTMLCanvasElement)) {
    await waitForAnimationFrame()
    canvas = document.getElementById('live2dCanvas')
  }

  if (!(canvas instanceof HTMLCanvasElement)) {
    throw new TypeError('[main] #live2dCanvas is not ready')
  }

  isCanvasReady.value = true
}

async function loadCurrentModel(model = modelStore.currentModel) {
  if (!model) return

  const version = ++modelLoadVersion

  await handleLoad()
  if (version !== modelLoadVersion) return

  await syncWindowSize()
  if (version !== modelLoadVersion) return

  const path = join(model.path, 'resources', 'background.png')

  const existed = await exists(path)

  backgroundImagePath.value = existed ? convertFileSrc(path) : void 0
  if (version !== modelLoadVersion) return

  clearObject([modelStore.supportKeys, modelStore.pressedKeys])

  const resourcePath = join(model.path, 'resources')
  const groups = ['left-keys', 'right-keys']

  for await (const groupName of groups) {
    const groupDir = join(resourcePath, groupName)
    const files = await readDir(groupDir).catch(() => [])
    const imageFiles = files.filter(file => isImage(file.name))

    for (const file of imageFiles) {
      const fileName = file.name.split('.')[0]

      modelStore.supportKeys[fileName] = join(groupDir, file.name)
    }
  }

  if (version !== modelLoadVersion) return

  loadedModelId = model.id
  void setWindowPosition()
}

onMounted(async () => {
  startListening()
  await ensureCanvasReady()
  await loadCurrentModel()
})

watch(() => modelStore.currentModel?.id, async (modelId) => {
  if (!isCanvasReady.value || !modelId || modelId === loadedModelId) return

  await loadCurrentModel()
})

watch(() => catStore.window.scale, async () => {
  if (!modelSize.value) return

  await syncWindowSize()
})

watch([modelStore.pressedKeys, stickActive], ([keys, stickActive]) => {
  const dirs = Object.values(keys).map((path) => {
    return nth(path.split(sep()), -2)!
  })

  const hasLeft = dirs.some(dir => dir.startsWith('left'))
  const hasRight = dirs.some(dir => dir.startsWith('right'))

  handleKeyChange(true, stickActive.left || hasLeft)
  handleKeyChange(false, stickActive.right || hasRight)
}, { deep: true })

watch(() => catStore.window.visible, async (value) => {
  value ? showWindow() : hideWindow()
})

watch(() => catStore.window.alwaysOnTop, setAlwaysOnTop, { immediate: true })

watch(() => generalStore.app.taskbarVisible, setTaskbarVisibility, { immediate: true })

function handleMouseDown() {
  appWindow.startDragging()
}

async function handleContextmenu(event: MouseEvent) {
  event.preventDefault()

  if (event.shiftKey) return

  const menu = await Menu.new({
    items: await getSharedMenu(),
  })

  menu.popup()
}

function handleMouseMove(event: MouseEvent) {
  const { buttons, shiftKey, movementX, movementY } = event

  if (buttons !== 2 || !shiftKey) return

  const delta = (movementX + movementY) * 0.5
  const nextScale = Math.max(10, Math.min(catStore.window.scale + delta, 500))

  catStore.window.scale = round(nextScale)
}
</script>

<template>
  <div
    v-show="isMounted"
    class="relative size-screen overflow-hidden children:(absolute size-full)"
    :class="{ '-scale-x-100': catStore.model.mirror }"
    :style="{
      opacity: catStore.window.opacity / 100,
      borderRadius: `${catStore.window.radius}%`,
    }"
    @contextmenu="handleContextmenu"
    @mousedown="handleMouseDown"
    @mousemove="handleMouseMove"
  >
    <img
      v-if="backgroundImagePath"
      class="object-cover"
      :src="backgroundImagePath"
    >

    <canvas id="live2dCanvas" />

    <img
      v-for="path in modelStore.pressedKeys"
      :key="path"
      class="object-cover"
      :src="convertFileSrc(path)"
    >

    <div
      v-show="resizing"
      class="flex items-center justify-center bg-black"
    >
      <span class="text-center text-[10vw] text-white">
        {{ $t('pages.main.hints.redrawing') }}
      </span>
    </div>
  </div>
</template>
