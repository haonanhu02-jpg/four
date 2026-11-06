<script setup lang="ts">
import { computed, ref } from 'vue';
import type { WorkItem } from '@workbench/contracts';
import { useWorkbenchStore } from '../stores/workbench';
import { planTree } from '../lib/plan-tree';
import PlanTreeNode from './PlanTreeNode.vue';
const emit = defineEmits<{ open: [item: WorkItem] }>();
const board = useWorkbenchStore();
const filter = ref('all'),
  search = ref(''),
  depth = ref(1);
const tree = computed(() =>
  planTree(Object.values(board.records), board.selection.year, filter.value, search.value),
);
</script>
<template>
  <section class="wb-section wb-plan-tree" aria-label="层级清单">
    <header class="wb-section-header">
      <span class="wb-level">清</span>
      <div>
        <h2>全量清单 · 逐层查看</h2>
        <p>年度 → 月度 → 周任务 → 每日工作，点击标题打开详情。</p>
      </div>
    </header>
    <div class="wb-tree-controls">
      <div class="wb-filter-tabs" aria-label="清单完成筛选">
        <button
          v-for="(label, key) in { all: '全部', incomplete: '未完成', complete: '已完成' }"
          :key="key"
          type="button"
          :aria-pressed="filter === key"
          @click="filter = key"
        >
          {{ label }}
        </button>
      </div>
      <label class="wb-table-search"
        >搜索<input
          v-model="search"
          type="search"
          aria-label="搜索层级清单"
          placeholder="目标、任务或工作情况"
      /></label>
      <div class="wb-filter-tabs" aria-label="清单展开层级">
        <span>展开到</span
        ><button
          v-for="(label, index) in ['年', '月', '周', '日']"
          :key="label"
          type="button"
          :aria-pressed="depth === index + 1"
          @click="depth = index + 1"
        >
          {{ label }}
        </button>
      </div>
    </div>
    <p class="wb-tree-hint">完成筛选保留匹配事项的上级路径。跨月、跨年排期按原年度来源展示。</p>
    <div v-if="tree.roots.length" class="wb-tree-roots">
      <PlanTreeNode
        v-for="node in tree.roots"
        :key="node.item.id"
        :node="node"
        :level="1"
        :depth="search.trim() ? 4 : depth"
        @open="emit('open', $event)"
      />
    </div>
    <div v-if="tree.extra.length" class="wb-tree-extra">
      <h3>本年度排期的其他事项</h3>
      <p>包含未关联上级、或来自其他年度目标的事项，可打开详情补充关联。</p>
      <PlanTreeNode
        v-for="node in tree.extra"
        :key="node.item.id"
        :node="node"
        :level="1"
        :depth="search.trim() ? 4 : depth"
        @open="emit('open', $event)"
      />
    </div>
    <div v-if="!tree.roots.length && !tree.extra.length" class="wb-empty">
      <span class="wb-empty-symbol">清</span>
      <h3>没有匹配的事项</h3>
      <p>可调整年份、完成筛选或搜索条件。</p>
    </div>
  </section>
</template>
