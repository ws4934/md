<script setup lang="ts">
import { ResizableHandle } from '@/components/ui/resizable'

withDefaults(defineProps<{
  disabled?: boolean
  testId?: string
}>(), {
  disabled: false,
})

const emit = defineEmits<{
  dragging: [active: boolean]
  reset: []
}>()

// Must be a stable reference: reka re-registers the handle whenever this prop changes identity,
// and a re-registration mid-drag orphans the active drag (stopDragging never fires).
const HIT_AREA_MARGINS = { fine: 4, coarse: 8 }
</script>

<template>
  <ResizableHandle
    :disabled="disabled"
    :hit-area-margins="HIT_AREA_MARGINS"
    :data-testid="testId"
    class="desktop-split-handle z-20 shrink-0 focus-visible:ring-0 focus-visible:ring-offset-0"
    @dragging="(active: boolean) => emit('dragging', active)"
    @dblclick="emit('reset')"
  />
</template>
