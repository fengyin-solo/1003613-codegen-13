<template>
  <section class="page" data-module="duty">
    <header class="page-head">
      <div>
        <h2>值勤排班管理</h2>
        <p class="page-desc">维护值勤排班表，围绕排班编号、值勤日期、值勤时段、值勤岗位做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记值勤排班表</button>
        <button class="btn" type="button" @click="exportRows">导出值勤排班清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <section class="ledger-panel">
      <div class="ledger-head">
        <div>
          <h3>跨站交接台账</h3>
          <p class="page-desc">
            按值勤日期、时段、岗位归纳值勤人员、接班人员与未完成交接记录；已封存班次历史沿用，未封存班次按新规则重算，接班人缺失标「待补」。
          </p>
        </div>
        <form class="ledger-filter" @submit.prevent>
          <input v-model="ledgerDate" placeholder="按值勤日期筛选（如 2026-10-04）" />
          <button class="btn ghost" type="button" @click="ledgerDate = ''">清除日期</button>
        </form>
      </div>

      <p class="status-legend">
        <span class="legend-item">台账分组：{{ filteredGroups.length }}</span>
        <span class="legend-item">未完成交接：{{ ledgerStats.unfinished }}</span>
        <span class="legend-item">接班待补：{{ ledgerStats.missing }}</span>
        <span class="legend-item">已封存：{{ ledgerStats.sealed }}</span>
        <span class="legend-item">新规则重算：{{ ledgerStats.recomputed }}</span>
      </p>

      <table class="data-table ledger-table">
        <thead>
          <tr>
            <th>值勤日期</th>
            <th>值勤时段</th>
            <th>值勤岗位</th>
            <th>值勤人员</th>
            <th>接班人员</th>
            <th>交接记录</th>
            <th>交接状态</th>
            <th>口径</th>
            <th>视图确认</th>
          </tr>
        </thead>
        <tbody>
          <template v-for="group in filteredGroups" :key="group.key">
            <tr
              v-for="(item, index) in group.items"
              :key="item.sourceId"
              :class="{ 'row-warn': item.交接未完成, 'row-sealed': item.封存 }"
            >
              <td v-if="index === 0" :rowspan="group.items.length">{{ group.值勤日期 }}</td>
              <td>{{ item.值勤时段 }}</td>
              <td>{{ item.值勤岗位 }}</td>
              <td>{{ item.值勤人员 || '—' }}</td>
              <td :class="{ 'cell-missing': item.接班人缺项 }">{{ item.接班人员 || '待补' }}</td>
              <td>{{ item.交接记录 || '—' }}</td>
              <td>{{ item.交接状态 }}</td>
              <td>
                <span class="rule-tag">{{ item.口径 }}</span>
              </td>
              <td class="row-actions">
                <button
                  v-if="!confirmedIds.has(item.sourceId)"
                  class="link"
                  type="button"
                  :disabled="confirmingIds.has(item.sourceId)"
                  @click="confirmOne(item.sourceId)"
                >
                  {{ confirmingIds.has(item.sourceId) ? '确认中…' : '视图确认' }}
                </button>
                <span v-else class="confirmed-tag">已生成提醒/清单</span>
              </td>
            </tr>
          </template>
          <tr v-if="!filteredGroups.length">
            <td colspan="9" class="empty-state">暂无符合条件的跨站交接台账记录</td>
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
          <td :colspan="columns.length + 2" class="empty-state">暂无值勤排班数据，可先登记值勤排班表</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条值勤排班记录</span>
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
} from '@/api/local-service'
import {
  confirmHandover,
  runDutyAction,
} from '@/api/handover-service'
import {
  HANDOVER_REMINDER_KEY,
  listRows,
} from '@/data/local-store'
import { buildLedger, groupLedger, type HandoverLedgerItem } from '@/data/handover'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('duty')
const columns = ["排班编号", "值勤日期", "值勤时段", "值勤岗位", "值勤人员", "接班人员", "交接记录", "排班状态"]
const actions = ["确认排班", "记录交接", "申请调班"]
const statuses = ["待确认", "已确认", "值勤中", "已交接", "已调班"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const noticeMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)

const ledgerDate = ref('')
const confirmingIds = ref<Set<number>>(new Set())
const ledgerVersion = ref(0)

const ledgerItems = computed<HandoverLedgerItem[]>(() => {
  // 依赖 rows 与 ledgerVersion：确认落库后重新归纳，未封存班次随之按新规则重算。
  void ledgerVersion.value
  return buildLedger(rows.value)
})

const filteredGroups = computed(() => {
  const groups = groupLedger(ledgerItems.value)
  const date = ledgerDate.value.trim()
  return date ? groups.filter((group) => group.值勤日期 === date) : groups
})

const confirmedIds = computed<Set<number>>(() => {
  void ledgerVersion.value
  const ids = new Set<number>()
  for (const row of listRows(HANDOVER_REMINDER_KEY)) {
    ids.add(Number(row['来源排班Id']))
  }
  return ids
})

const ledgerStats = computed(() => {
  const items = ledgerItems.value
  return {
    unfinished: items.filter((item) => item.交接未完成).length,
    missing: items.filter((item) => item.接班人缺项).length,
    sealed: items.filter((item) => item.封存).length,
    recomputed: items.filter((item) => !item.封存).length,
  }
})

const today = new Date().toISOString().slice(0, 10)
const stats = computed(() => {
  const todayDuty = new Set(
    rows.value.filter((row) => String(row['值勤日期']) === today).map((row) => String(row['值勤人员'])),
  )
  return [
    { label: '今日值勤人数', value: todayDuty.size },
    { label: '待交接次数', value: ledgerStats.value.unfinished },
    { label: '待补接班班次', value: ledgerStats.value.missing },
  ]
})

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function flash(message: string, ok: boolean) {
  errorMessage.value = ok ? '' : message
  noticeMessage.value = ok ? message : ''
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '值勤排班表登记入口尚未接入审批流'
}

async function confirmOne(sourceId: number) {
  if (confirmingIds.value.has(sourceId)) {
    return
  }
  confirmingIds.value = new Set(confirmingIds.value).add(sourceId)
  flash('', true)
  try {
    const result = await confirmHandover(sourceId)
    flash(result.message, result.ok)
  } finally {
    const next = new Set(confirmingIds.value)
    next.delete(sourceId)
    confirmingIds.value = next
    reload()
  }
}

function runAction(action: string, row: EntryRow) {
  flash('', true)
  // 排班动作与检查站提醒的进度刷新在同一服务内事务化处理。
  const result = runDutyAction(action, Number(row.id))
  if (!result.ok) {
    flash(result.message, false)
    return
  }
  flash(result.message, true)
  reload()
}

function reload() {
  ledgerVersion.value += 1
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    flash(error instanceof Error ? error.message : '值勤排班列表读取失败', false)
  }
}

onMounted(reload)
</script>

<style scoped>
.ledger-panel {
  border: 1px solid var(--border, #d0d7de);
  border-radius: 8px;
  padding: 12px 14px;
  margin: 4px 0 18px;
  background: #fafbfc;
}
.ledger-head {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  align-items: flex-end;
  flex-wrap: wrap;
}
.ledger-head h3 {
  margin: 0 0 4px;
  font-size: 16px;
}
.ledger-filter {
  display: flex;
  gap: 8px;
}
.ledger-filter input {
  width: 220px;
  padding: 6px 8px;
  border: 1px solid var(--border, #d0d7de);
  border-radius: 4px;
}
.ledger-table .row-warn td {
  background: #fff8f0;
}
.ledger-table .row-sealed td {
  color: #57606a;
}
.cell-missing {
  color: #cf222e;
  font-weight: 600;
}
.rule-tag {
  font-size: 12px;
  color: #57606a;
  white-space: nowrap;
}
.confirmed-tag {
  font-size: 12px;
  color: #1a7f37;
  white-space: nowrap;
}
.ok-text {
  color: #1a7f37;
}
</style>
