import { writeText } from '@tauri-apps/plugin-clipboard-manager'
import { save } from '@tauri-apps/plugin-dialog'

import {
  clearTrafficStatistics,
  exportTrafficStatistics,
  readTrafficStatistics,
} from '@/services/cmds'
import { mutate } from '@/services/mutate'

import type { TrafficQuery, TrafficSnapshot } from './model'

export interface StatisticsApi {
  read: (query: TrafficQuery) => Promise<TrafficSnapshot>
  clear: () => Promise<void>
  copy: (value: string) => Promise<void>
  export: (query: TrafficQuery) => Promise<void>
}

export const statisticsApi: StatisticsApi = {
  read: readTrafficStatistics,
  clear: async () => {
    await mutate(clearTrafficStatistics, {
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
    await mutate(() => exportTrafficStatistics(query, path), {
      id: 'traffic-statistics-export',
      errorNotice: false,
    })
  },
}
