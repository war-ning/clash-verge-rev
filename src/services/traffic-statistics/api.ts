import { invoke } from '@tauri-apps/api/core'
import { writeText } from '@tauri-apps/plugin-clipboard-manager'
import { save } from '@tauri-apps/plugin-dialog'

import { mutate } from '@/services/mutate'

import type { TrafficQuery, TrafficSnapshot } from './model'

export interface StatisticsApi {
  read: (query: TrafficQuery) => Promise<TrafficSnapshot>
  clear: () => Promise<void>
  copy: (value: string) => Promise<void>
  export: (query: TrafficQuery) => Promise<void>
}

export const statisticsApi: StatisticsApi = {
  read: (query) => invoke('read_traffic_statistics', { query }),
  clear: async () => {
    await mutate(() => invoke('clear_traffic_statistics'), {
      id: 'traffic-statistics',
      errorNotice: false,
    })
  },
  copy: async (value) => {
    await mutate(() => writeText(value), {
      id: 'clipboard',
      errorNotice: false,
    })
  },
  export: async (query) => {
    const path = await save({
      defaultPath: 'proxy-traffic.json',
      filters: [{ name: 'JSON', extensions: ['json'] }],
    })
    if (!path) return
    await mutate(() => invoke('export_traffic_statistics', { query, path }), {
      id: 'traffic-statistics-export',
      errorNotice: false,
    })
  },
}
