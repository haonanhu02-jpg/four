<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId } from 'vue';
const props = defineProps<{
  modelValue: string;
  label: string;
  options: readonly { value: string; label: string }[];
}>();
const emit = defineEmits<{ 'update:modelValue': [value: string] }>();
const root = ref<HTMLElement>(),
  menu = ref<HTMLElement>(),
  trigger = ref<HTMLButtonElement>();
const open = ref(false),
  active = ref(0),
  id = useId();
const selected = computed(
  () => props.options.find((o) => o.value === props.modelValue)?.label ?? props.modelValue,
);
async function show() {
  open.value = true;
  active.value = Math.max(
    0,
    props.options.findIndex((o) => o.value === props.modelValue),
  );
  await nextTick();
  menu.value?.focus();
}
function choose(index: number) {
  const v = props.options[index];
  if (!v) return;
  emit('update:modelValue', v.value);
  open.value = false;
  trigger.value?.focus();
}
function key(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    open.value = false;
    trigger.value?.focus();
  } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
    e.preventDefault();
    active.value =
      e.key === 'Home'
        ? 0
        : e.key === 'End'
          ? props.options.length - 1
          : (active.value + (e.key === 'ArrowDown' ? 1 : -1) + props.options.length) %
            props.options.length;
  } else if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    choose(active.value);
  } else if (e.key === 'Tab') open.value = false;
}
function outside(e: Event) {
  if (!root.value?.contains(e.target as Node)) open.value = false;
}
onMounted(() => document.addEventListener('pointerdown', outside));
onBeforeUnmount(() => document.removeEventListener('pointerdown', outside));
</script>
<template>
  <div
    ref="root"
    class="wb-choice"
    @focusout="
      (e: FocusEvent) => {
        if (!root?.contains(e.relatedTarget as Node)) open = false;
      }
    "
  >
    <button
      ref="trigger"
      type="button"
      class="wb-choice-trigger"
      :aria-label="label"
      aria-haspopup="listbox"
      :aria-expanded="open"
      :aria-controls="id"
      @click="open ? (open = false) : show()"
      @keydown.down.prevent="show"
      @keydown.up.prevent="show"
    >
      {{ selected }}<span aria-hidden="true">⌄</span>
    </button>
    <div
      v-if="open"
      :id="id"
      ref="menu"
      class="wb-choice-menu"
      role="listbox"
      :aria-label="label"
      tabindex="-1"
      :aria-activedescendant="`${id}-${active}`"
      @keydown="key"
    >
      <button
        v-for="(option, index) in options"
        :id="`${id}-${index}`"
        :key="option.value"
        class="wb-choice-option"
        :class="{ 'is-active': index === active }"
        type="button"
        role="option"
        :aria-selected="modelValue === option.value"
        tabindex="-1"
        @pointermove="active = index"
        @click="choose(index)"
      >
        {{ option.label }}<span v-if="modelValue === option.value" aria-hidden="true">✓</span>
      </button>
    </div>
  </div>
</template>
