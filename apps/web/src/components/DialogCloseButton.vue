<script setup lang="ts">
withDefaults(defineProps<{ label: string; disabled?: boolean }>(), { disabled: false });
</script>

<template>
  <button
    type="button"
    class="wb-dialog-close"
    :aria-label="label"
    :title="label"
    :disabled="disabled"
  >
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" focusable="false">
      <path
        d="m5 5 10 10M15 5 5 15"
        stroke="currentColor"
        stroke-width="1.7"
        stroke-linecap="round"
      />
    </svg>
  </button>
</template>
