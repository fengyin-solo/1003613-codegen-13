<template>
  <section class="page" data-module="patrol">
    <header class="page-head">
      <div>
        <h2>巡护任务管理</h2>
        <p class="page-desc">维护巡护任务，围绕任务编号、巡护区域、巡护路线、巡护员做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记巡护任务</button>
        <button class="btn" type="button" @click="exportRows">导出巡护任务清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <section class="handover-panel">
      <div class="handover-head">
        <div>
          <h3>巡护任务交接清单</h3>
          <p class="page-desc">
            由值勤排班视图确认与换岗提醒同事务生成，任何一侧落库失败整体回退；清单状态随排班交接动作同步。
          </p>
        </div>
        <span class="progress-line">已交接 {{ checklistCount.done }} / 共 {{ checklists.length }}</span>
      </div>
      <table class="data-table handover-table">
        <thead>
          <tr>
            <th>清单编号</th>
            <th>来源排班</th>
            <th>巡护区域</th>
            <th>巡护日期</th>
            <th>交接时段</th>
            <th>交班巡护员</th>
            <th>接班巡护员</th>
            <th>交接事项</th>
            <th>清单状态</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in checklists" :key="String(row.id)" :class="{ 'row-warn': isWarn(row) }">
            <td>{{ row['清单编号'] }}</td>
            <td>{{ row['来源排班'] }}</td>
            <td>{{ row['巡护区域'] }}</td>
            <td>{{ row['巡护日期'] }}</td>
            <td>{{ row['交接时段'] }}</td>
            <td>{{ row['交班巡护员'] }}</td>
            <td :class="{ 'cell-missing': String(row['接班巡护员']).includes('待补') }">{{ row['接班巡护员'] }}</td>
            <td>{{ row['交接事项'] }}</td>
            <td><span class="state-tag" :data-status="row['清单状态']">{{ row['清单状态'] }}</span></td>
          </tr>
          <tr v-if="!checklists.length">
            <td colspan="9" class="empty-state">暂无巡护任务交接清单，请在「值勤排班」页对台账执行视图确认</td>
          </tr>
        </tbody>
      </table>
    </section>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无巡护任务数据，可先登记巡护任务</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条巡护任务记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import { HANDOVER_CHECKLIST_KEY, listRows } from '@/data/local-store'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('patrol')
const columns = ["任务编号", "巡护区域", "巡护路线", "巡护员", "巡护日期", "巡护时段", "发现火情数", "任务状态"]
const actions = ["开始巡护", "确认完成", "取消任务"]
const statuses = ["待执行", "执行中", "已完成", "已取消"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const checklistTick = ref(0)

const checklists = computed<EntryRow[]>(() => {
  void checklistTick.value
  return listRows(HANDOVER_CHECKLIST_KEY).slice().sort((a, b) => Number(b.id) - Number(a.id))
})

const checklistCount = computed(() => ({
  done: checklists.value.filter((row) => row['清单状态'] === '已交接').length,
}))

const stats = computed(() => [
  { label: '今日任务数', value: rows.value.length },
  { label: '已完成任务', value: rows.value.filter((row) => String(row.status) === '已完成').length },
  { label: '待交接清单', value: checklists.value.filter((row) => row['清单状态'] !== '已交接').length },
])

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function isWarn(row: EntryRow): boolean {
  return ['接班待补', '调班关闭'].includes(String(row['清单状态']))
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '巡护任务登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  checklistTick.value += 1
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '巡护任务列表读取失败'
  }
}

onMounted(reload)
</script>

<style scoped>
.handover-panel {
  border: 1px solid var(--border, #d0d7de);
  border-radius: 8px;
  padding: 12px 14px;
  margin: 4px 0 18px;
  background: #fafbfc;
}
.handover-head {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  align-items: flex-end;
  flex-wrap: wrap;
}
.handover-head h3 {
  margin: 0 0 4px;
  font-size: 16px;
}
.progress-line {
  font-size: 13px;
  color: #1a7f37;
  font-weight: 600;
}
.handover-table .row-warn td {
  background: #fff8f0;
}
.cell-missing {
  color: #cf222e;
  font-weight: 600;
}
.state-tag {
  display: inline-block;
  padding: 1px 8px;
  border-radius: 10px;
  font-size: 12px;
  background: #ddf4ff;
  color: #0969da;
  white-space: nowrap;
}
.state-tag[data-status='已交接'] {
  background: #dafbe1;
  color: #1a7f37;
}
.state-tag[data-status='接班待补'],
.state-tag[data-status='调班关闭'] {
  background: #ffebe9;
  color: #cf222e;
}
</style>
