<script setup lang="ts">
import type { AcpAgentAvatar } from '@md/shared/types'

const props = withDefaults(defineProps<{
  avatar?: AcpAgentAvatar
  size?: number
}>(), {
  size: 20,
})

const style = computed(() => ({
  width: `${props.size}px`,
  height: `${props.size}px`,
  borderRadius: `${Math.round(props.size * 0.3)}px`,
  backgroundColor: props.avatar?.color ?? `#5B5BD6`,
  fontSize: `${Math.max(9, Math.round(props.size * 0.52))}px`,
}))
</script>

<template>
  <span
    class="inline-flex shrink-0 select-none items-center justify-center font-bold leading-none text-white"
    :style="style"
  >
    {{ avatar?.letter ?? 'A' }}
  </span>
</template>
