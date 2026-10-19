import { invoke } from '@tauri-apps/api/core'
import { writeText } from '@tauri-apps/plugin-clipboard-manager'
import { save } from '@tauri-apps/plugin-dialog'
import { writeTextFile } from '@tauri-apps/plugin-fs'

import { mutate } from '@/services/mutate'

import type { StatisticsSettings, StatisticsSnapshot } from './model'

export interface StatisticsApi {
  read: (start: number, end: number) => Promise<StatisticsSnapshot>
  configure: (settings: StatisticsSettings) => Promise<void>
  clear: () => Promise<void>
  copy: (value: string) => Promise<void>
  export: (data: unknown) => Promise<boolean>
}

export const statisticsApi: StatisticsApi = {
  read: (start, end) => invoke('read_traffic_statistics', { start, end }),
  configure: async (settings) => {
    await mutate(() => invoke('configure_traffic_statistics', { settings }), {
      id: 'traffic-statistics',
      errorNotice: false,
    })
  },
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
  export: async (data) => {
    const result = await mutate(
      async () => {
        const path = await save({
          defaultPath: 'traffic-statistics.json',
          filters: [{ name: 'JSON', extensions: ['json'] }],
        })
        if (!path) return false
        await writeTextFile(path, JSON.stringify(data, null, 2))
        return true
      },
      { id: 'traffic-statistics-export', errorNotice: false },
    )
    return result.value
  },
}
