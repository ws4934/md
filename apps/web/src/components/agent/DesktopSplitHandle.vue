<script setup lang="ts">
import { ResizableHandle } from '@/components/ui/resizable'

const props = withDefaults(defineProps<{
  disabled?: boolean
  testId?: string
}>(), {
  disabled: false,
})

const emit = defineEmits<{
  dragging: [active: boolean]
  keyboardResize: []
  reset: []
}>()

// Must be a stable reference: reka re-registers the handle whenever this prop changes identity,
// and a re-registration mid-drag orphans the active drag (stopDragging never fires).
const HIT_AREA_MARGINS = { fine: 4, coarse: 8 }
const RESIZE_KEYS = new Set([`ArrowLeft`, `ArrowRight`, `Home`, `End`, `Enter`])

let isDragging = false

function handleDragging(active: boolean) {
  if (isDragging === active)
    return
  isDragging = active
  emit(`dragging`, active)
}

function handleKeydown(event: KeyboardEvent) {
  if (RESIZE_KEYS.has(event.key))
    emit(`keyboardResize`)
}

watch(() => props.disabled, (disabled) => {
  if (disabled && isDragging) {
    isDragging = false
    emit(`dragging`, false)
  }
})

onBeforeUnmount(() => {
  if (isDragging) {
    isDragging = false
    emit(`dragging`, false)
  }
})
</script>

<template>
  <ResizableHandle
    :disabled="disabled"
    :hit-area-margins="HIT_AREA_MARGINS"
    :data-testid="testId"
    class="desktop-split-handle z-20 shrink-0 focus-visible:ring-0 focus-visible:ring-offset-0"
    @dragging="handleDragging"
    @keydown="handleKeydown"
    @dblclick="emit('reset')"
  />
</template>
