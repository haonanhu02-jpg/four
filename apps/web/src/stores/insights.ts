import { reactive, ref } from 'vue';
import { defineStore } from 'pinia';
import type {
  AlignmentCode,
  AlignmentList,
  ExecutionList,
  Overview,
  WorkItemType,
} from '@workbench/contracts';
import { request, errorMessage } from '../lib/api';
import { useWorkbenchStore } from './workbench';
import { localInsights } from '../lib/local-insights';
import { todayIn } from '../lib/dates';

export const useInsightsStore = defineStore('insights', () => {
  const board = useWorkbenchStore();
  const overview = ref<Overview | null>(null);
  const execution = ref<ExecutionList | null>(null);
  const alignment = ref<AlignmentList | null>(null);
  const errors = reactive({ overview: '', execution: '', alignment: '' });
  const busy = reactive({ overview: false, execution: false, alignment: false });
  const filters = reactive({
    annualId: '',
    type: '' as '' | Exclude<WorkItemType, 'annual'>,
    completion: 'all' as 'all' | 'complete' | 'incomplete',
    rule: '' as '' | AlignmentCode,
  });
  const updating = ref(false);
  let owner = '';
  let sequence = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let executionSequence = 0;
  let alignmentSequence = 0;
  const headers = () => ({ 'X-Workbench-Account': owner });
  const periodQuery = () =>
    new URLSearchParams(Object.entries(board.selection).map(([k, v]) => [k, String(v)]));
  const local = () => localInsights(Object.values(board.records), board.selection, todayIn());
  const useLocal = () => board.isGuest || board.offline || board.hasUnsaved;

  async function loadExecution(offset = 0) {
    if (useLocal()) {
      executionSequence++;
      busy.execution = false;
      execution.value = local().execution(filters, offset);
      errors.execution = '';
      return;
    }
    const generation = ++executionSequence;
    const context = sequence;
    busy.execution = true;
    errors.execution = '';
    const q = new URLSearchParams({
      year: String(board.selection.year),
      completion: filters.completion,
      limit: '20',
      offset: String(offset),
    });
    if (filters.type) q.set('type', filters.type);
    if (filters.annualId) q.set('annualId', filters.annualId);
    try {
      const data = await request<ExecutionList>(`/api/annual-execution?${q}`, undefined, {
        headers: headers(),
      });
      if (generation === executionSequence && context === sequence) {
        if (offset > 0 && offset >= data.total)
          return await loadExecution(Math.max(0, Math.floor((data.total - 1) / 20) * 20));
        execution.value = data;
      }
    } catch (caught) {
      if (generation === executionSequence && context === sequence)
        errors.execution = errorMessage(caught);
    } finally {
      if (generation === executionSequence) busy.execution = false;
    }
  }
  async function loadAlignment(offset = 0) {
    if (useLocal()) {
      alignmentSequence++;
      busy.alignment = false;
      alignment.value = local().alignment(filters.rule, offset);
      errors.alignment = '';
      return;
    }
    const generation = ++alignmentSequence;
    const context = sequence;
    busy.alignment = true;
    errors.alignment = '';
    const q = periodQuery();
    q.set('limit', '20');
    q.set('offset', String(offset));
    if (filters.rule) q.set('rule', filters.rule);
    try {
      const data = await request<AlignmentList>(`/api/alignment-check?${q}`, undefined, {
        headers: headers(),
      });
      if (generation === alignmentSequence && context === sequence) {
        if (offset > 0 && offset >= data.total)
          return await loadAlignment(Math.max(0, Math.floor((data.total - 1) / 20) * 20));
        alignment.value = data;
      }
    } catch (caught) {
      if (generation === alignmentSequence && context === sequence)
        errors.alignment = errorMessage(caught);
    } finally {
      if (generation === alignmentSequence) busy.alignment = false;
    }
  }
  async function refresh() {
    if (!owner) return;
    if (useLocal()) {
      sequence++;
      executionSequence++;
      alignmentSequence++;
      busy.overview = false;
      busy.execution = false;
      busy.alignment = false;
      overview.value = local().overview;
      execution.value = local().execution(filters, execution.value?.offset ?? 0);
      alignment.value = local().alignment(filters.rule, alignment.value?.offset ?? 0);
      errors.overview = '';
      errors.execution = '';
      errors.alignment = '';
      updating.value = false;
      return;
    }
    clearTimeout(timer);
    const generation = ++sequence;
    updating.value = true;
    busy.overview = true;
    errors.overview = '';
    const summary = (async () => {
      try {
        const data = await request<Overview>(`/api/overview?${periodQuery()}`, undefined, {
          headers: headers(),
        });
        if (generation !== sequence) return;
        overview.value = data;
      } catch (caught) {
        if (generation === sequence) errors.overview = errorMessage(caught);
      } finally {
        if (generation === sequence) busy.overview = false;
      }
    })();
    await Promise.all([
      summary,
      loadExecution(execution.value?.offset ?? 0),
      loadAlignment(alignment.value?.offset ?? 0),
    ]);
    if (generation === sequence) updating.value = false;
  }
  function schedule(reset = false) {
    if (!owner) return;
    clearTimeout(timer);
    sequence++;
    updating.value = true;
    if (reset) {
      overview.value = null;
      execution.value = null;
      alignment.value = null;
      filters.annualId = '';
      filters.type = '';
      filters.completion = 'all';
      filters.rule = '';
    }
    timer = setTimeout(() => void refresh(), 300);
  }
  async function initialize(userId: string) {
    dispose();
    owner = userId;
    overview.value = null;
    execution.value = null;
    alignment.value = null;
    filters.annualId = '';
    filters.type = '';
    filters.completion = 'all';
    filters.rule = '';
    await refresh();
  }
  function dispose() {
    owner = '';
    sequence++;
    executionSequence++;
    alignmentSequence++;
    clearTimeout(timer);
  }
  return {
    overview,
    execution,
    alignment,
    errors,
    busy,
    filters,
    updating,
    initialize,
    schedule,
    refresh,
    loadExecution,
    loadAlignment,
    dispose,
  };
});
