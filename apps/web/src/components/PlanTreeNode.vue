<script setup lang="ts">
import { ref, watch } from 'vue';
import type { WorkItem } from '@workbench/contracts';
import type { PlanNode } from '../lib/plan-tree';
import { itemNames, periodOf } from '../lib/insights';
const props = defineProps<{ node: PlanNode; level: number; depth: number }>();
const emit = defineEmits<{ open: [item: WorkItem] }>();
const expanded = ref(props.depth > props.level);
watch(
  () => props.depth,
  (depth) => {
    expanded.value = depth > props.level;
  },
);
const mark = { annual: '年', monthly: '月', weekly: '周', daily: '日' };
</script>
<template>
  <details
    v-if="node.item.type !== 'daily'"
    class="wb-tree-node"
    :data-tree-id="node.item.id"
    :open="expanded"
    @toggle="expanded = ($event.target as HTMLDetailsElement).open"
  >
    <summary>
      <span class="wb-tree-mark" :class="node.item.type">{{ mark[node.item.type] }}</span
      ><button class="wb-tree-title" type="button" @click.prevent="emit('open', node.item)">
        {{ node.item.title || '未命名' + itemNames[node.item.type] }}</button
      ><small>{{ periodOf(node.item) }}</small
      ><span class="wb-tree-progress" :class="{ done: node.completed }">{{ node.progress }}%</span>
    </summary>
    <div v-if="expanded" class="wb-tree-children">
      <PlanTreeNode
        v-for="child in node.children"
        :key="child.item.id"
        :node="child"
        :level="level + 1"
        :depth="depth"
        @open="emit('open', $event)"
      />
      <p v-if="!node.children.length" class="wb-tree-none">当前筛选没有下级事项</p>
    </div>
  </details>
  <button
    v-else
    class="wb-tree-leaf"
    :data-tree-id="node.item.id"
    :class="{ done: node.completed }"
    type="button"
    @click="emit('open', node.item)"
  >
    <span class="wb-tree-mark daily">{{ node.completed ? '✓' : '日' }}</span
    ><span
      >{{ node.item.title || '未命名日待办'
      }}<small
        >{{ node.item.date }} · {{ node.item.time || `${node.item.minutes ?? 0} 分钟预计`
        }}<template v-if="node.item.note"> · {{ node.item.note }}</template></small
      ></span
    ><span>{{ node.completed ? '已完成' : '未完成' }}</span>
  </button>
</template>
