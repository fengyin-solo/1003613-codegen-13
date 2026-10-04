<template>
  <section class="page" data-module="handover">
    <header class="page-head">
      <div>
        <h2>跨站交接台账</h2>
        <p class="page-desc">按值勤日期、时段、岗位归纳值勤人员、接班人员与未完成交接记录；口径调整后未封存班次按新规则重算，已封存历史沿用原记录。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="recalc">按现行口径重算</button>
        <button class="btn" type="button" @click="exportRows">导出交接台账</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

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

    <section v-for="group in groups" :key="group.key" class="ledger-group">
      <h3 class="ledger-title">{{ group.key }}</h3>
      <table class="data-table">
        <thead>
          <tr>
            <th v-for="column in columns" :key="column">{{ column }}</th>
            <th>当前状态</th>
            <th>可执行动作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in group.rows" :key="String(row.id)">
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
        </tbody>
      </table>
    </section>
    <p v-if="!groups.length" class="empty-state">暂无交接台账，可在值勤排班页确认排班后自动生成</p>

    <h3 class="ledger-title">未完成交接记录</h3>
    <table class="data-table">
      <thead>
        <tr>
          <th>台账编号</th>
          <th>值勤日期</th>
          <th>值勤时段</th>
          <th>值勤岗位</th>
          <th>值勤人员</th>
          <th>接班人员</th>
          <th>交接进度</th>
          <th>当前状态</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in unfinished" :key="String(row.id)">
          <td>{{ row['台账编号'] }}</td>
          <td>{{ row['值勤日期'] }}</td>
          <td>{{ row['值勤时段'] }}</td>
          <td>{{ row['值勤岗位'] }}</td>
          <td>{{ row['值勤人员'] }}</td>
          <td>{{ row['接班人员'] }}</td>
          <td>{{ row['交接进度'] }}</td>
          <td>{{ row.status }}</td>
        </tr>
        <tr v-if="!unfinished.length">
          <td colspan="8" class="empty-state">交接全部闭环，没有未完成记录</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条交接台账记录</span>
      <span v-if="message" class="error-text">{{ message }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  recalcHandoverLedger,
  runAction as applyAction,
} from '@/api/local-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('handover')
const columns = ["台账编号", "值勤日期", "值勤时段", "值勤岗位", "值勤人员", "接班人员", "交接进度", "口径版本"]
const actions = ["登记交接", "确认交接", "标记待补"]
const statuses = ["待交接", "交接中", "已交接", "待补充"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const message = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = ["值勤日期", "值勤时段", "值勤岗位"]

const stats = computed(() => [
  { label: '台账条目数', value: rows.value.length },
  { label: '待交接数', value: rows.value.filter((row) => row.status === '待交接' || row.status === '交接中').length },
  { label: '待补充数', value: rows.value.filter((row) => row.status === '待补充').length },
])

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

// 按值勤日期、时段、岗位归纳：同一天的同一时段同一岗位归成一组
const groups = computed(() => {
  const buckets = new Map<string, EntryRow[]>()
  for (const row of rows.value) {
    const key = `${row['值勤日期'] ?? '—'} · ${row['值勤时段'] ?? '—'} · ${row['值勤岗位'] ?? '—'}`
    const bucket = buckets.get(key)
    if (bucket) {
      bucket.push(row)
    } else {
      buckets.set(key, [row])
    }
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, groupRows]) => ({ key, rows: groupRows }))
})

// 未完成交接记录：没闭环（未封存）的条目都列出来
const unfinished = computed(() => rows.value.filter((row) => String(row.status) !== '已交接'))

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function recalc() {
  message.value = ''
  const result = recalcHandoverLedger()
  if (!result.ok) {
    message.value = result.message
    return
  }
  reload()
}

function runAction(action: string, row: EntryRow) {
  message.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    message.value = result.message
    return
  }
  reload()
}

function reload() {
  message.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    message.value = error instanceof Error ? error.message : '交接台账读取失败'
  }
}

onMounted(reload)
</script>
