<template>
  <section class="page" data-module="checkpoint">
    <header class="page-head">
      <div>
        <h2>防火检查站管理</h2>
        <p class="page-desc">维护防火检查站，围绕站点编号、站点位置、值守人员、检查项目做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记防火检查站</button>
        <button class="btn" type="button" @click="exportRows">导出防火检查站清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <section class="reminder-panel">
      <div class="reminder-head">
        <div>
          <h3>检查站换岗提醒</h3>
          <p class="page-desc">
            由值勤排班视图确认生成，重复确认不重复建项；交接进度随排班动作同步刷新，待补接班班次在此高亮提醒。
          </p>
        </div>
        <div class="reminder-actions">
          <span class="progress-line">总交接进度：{{ progressText }}</span>
          <button class="btn ghost" type="button" @click="refreshProgress">刷新交接进度</button>
        </div>
      </div>

      <p class="status-legend">
        <span class="legend-item">提醒总数：{{ reminders.length }}</span>
        <span class="legend-item">已完成换岗：{{ progressCount.done }}</span>
        <span class="legend-item">接班待补：{{ progressCount.missing }}</span>
        <span class="legend-item">待换岗：{{ progressCount.waiting }}</span>
        <span class="legend-item">调班关闭：{{ progressCount.closed }}</span>
      </p>

      <table class="data-table reminder-table">
        <thead>
          <tr>
            <th>提醒编号</th>
            <th>检查站</th>
            <th>值班日期</th>
            <th>换岗时段</th>
            <th>交班人员</th>
            <th>接班人员</th>
            <th>交接进度</th>
            <th>提醒内容</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in reminders" :key="String(row.id)" :class="{ 'row-warn': isWarn(row) }">
            <td>{{ row['提醒编号'] }}</td>
            <td>{{ row['站点位置'] }}<span class="sub-text">（{{ row['检查站编号'] }}）</span></td>
            <td>{{ row['值班日期'] }}</td>
            <td>{{ row['换岗时段'] }}</td>
            <td>{{ row['交班人员'] }}</td>
            <td :class="{ 'cell-missing': String(row['接班人员']).includes('待补') }">{{ row['接班人员'] }}</td>
            <td>
              <span class="progress-tag" :data-status="row['交接进度']">{{ row['交接进度'] }}</span>
            </td>
            <td>{{ row['提醒内容'] }}</td>
          </tr>
          <tr v-if="!reminders.length">
            <td colspan="8" class="empty-state">暂无换岗提醒，请在「值勤排班」页对台账执行视图确认</td>
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
          <td :colspan="columns.length + 2" class="empty-state">暂无防火检查站数据，可先登记防火检查站</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条防火检查站记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
      <span v-else-if="noticeMessage" class="ok-text">{{ noticeMessage }}</span>
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
import { syncHandoverProgress } from '@/api/handover-service'
import { HANDOVER_REMINDER_KEY, listRows } from '@/data/local-store'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('checkpoint')
const columns = ["站点编号", "站点位置", "值守人员", "检查项目", "通行车辆数", "收缴火种数", "值班日期", "运行状态"]
const actions = ["升级检查", "关闭站点", "安排换岗"]
const statuses = ["正常检查", "临时关闭", "升级检查", "等待换岗"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const noticeMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const reminderTick = ref(0)

const reminders = computed<EntryRow[]>(() => {
  void reminderTick.value
  return listRows(HANDOVER_REMINDER_KEY).slice().sort((a, b) => {
    const byDate = String(a['值班日期']).localeCompare(String(b['值班日期']))
    if (byDate !== 0) return byDate
    return Number(b.id) - Number(a.id)
  })
})

const progressCount = computed(() => {
  const count = { done: 0, missing: 0, waiting: 0, closed: 0 }
  for (const row of reminders.value) {
    const progress = String(row['交接进度'])
    if (progress === '已完成换岗') count.done += 1
    else if (progress === '接班待补') count.missing += 1
    else if (progress === '调班关闭') count.closed += 1
    else count.waiting += 1
  }
  return count
})

const progressText = computed(() => {
  const totalCount = reminders.value.length
  if (!totalCount) return '暂无台账'
  return `${progressCount.value.done}/${totalCount} 已闭环`
})

const stats = computed(() => [
  { label: '站点总数', value: rows.value.length },
  { label: '正常检查数', value: rows.value.filter((row) => String(row.status) === '正常检查').length },
  { label: '待补接班提醒', value: progressCount.value.missing },
])

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function isWarn(row: EntryRow): boolean {
  return ['接班待补', '调班关闭'].includes(String(row['交接进度']))
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '防火检查站登记入口尚未接入审批流'
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

function refreshProgress() {
  errorMessage.value = ''
  noticeMessage.value = ''
  try {
    syncHandoverProgress()
    reminderTick.value += 1
    noticeMessage.value = '检查站换岗提醒的交接进度已按最新排班同步刷新'
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '交接进度刷新失败'
  }
}

function reload() {
  errorMessage.value = ''
  reminderTick.value += 1
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '防火检查站列表读取失败'
  }
}

onMounted(reload)
</script>

<style scoped>
.reminder-panel {
  border: 1px solid var(--border, #d0d7de);
  border-radius: 8px;
  padding: 12px 14px;
  margin: 4px 0 18px;
  background: #fafbfc;
}
.reminder-head {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  align-items: flex-end;
  flex-wrap: wrap;
}
.reminder-head h3 {
  margin: 0 0 4px;
  font-size: 16px;
}
.reminder-actions {
  display: flex;
  gap: 12px;
  align-items: center;
}
.progress-line {
  font-size: 13px;
  color: #1a7f37;
  font-weight: 600;
}
.reminder-table .row-warn td {
  background: #fff8f0;
}
.sub-text {
  color: #6e7781;
  font-size: 12px;
}
.cell-missing {
  color: #cf222e;
  font-weight: 600;
}
.progress-tag {
  display: inline-block;
  padding: 1px 8px;
  border-radius: 10px;
  font-size: 12px;
  background: #ddf4ff;
  color: #0969da;
  white-space: nowrap;
}
.progress-tag[data-status='已完成换岗'] {
  background: #dafbe1;
  color: #1a7f37;
}
.progress-tag[data-status='接班待补'],
.progress-tag[data-status='调班关闭'] {
  background: #ffebe9;
  color: #cf222e;
}
</style>
