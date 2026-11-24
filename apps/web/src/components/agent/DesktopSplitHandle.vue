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
</script>

<template>
  <ResizableHandle
    :disabled="disabled"
    :hit-area-margins="{ fine: 4, coarse: 8 }"
    :data-testid="testId"
    class="desktop-split-handle z-20 shrink-0 focus-visible:ring-0 focus-visible:ring-offset-0"
    @dragging="(active: boolean) => emit('dragging', active)"
    @dblclick="emit('reset')"
  />
</template>
