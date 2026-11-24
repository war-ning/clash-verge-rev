import { CssBaseline, ThemeProvider, createTheme } from '@mui/material'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { initializeLanguage } from '@/services/i18n'
import type { StatisticsApi } from '@/services/traffic-statistics/api'
import type { TrafficSnapshot } from '@/services/traffic-statistics/model'

import { StatisticsPage } from './page'

let cleared = false
const api: StatisticsApi = {
  read: async (query) => {
    const now = Date.now()
    const records = cleared
      ? []
      : Array.from({ length: 80 }, (_, i) => ({
          target: 'cdn-' + i + '.example.com',
          process: ['chrome.exe', 'Code.exe', 'msedge.exe', ''][i % 4],
          path: '',
          ip: '192.0.2.1',
          rule: 'RuleSet',
          rulePayload: 'proxy-rules',
          chain: 'Node → Proxy',
          route: i % 5 === 0 ? 'direct' : 'proxy',
          upload: (80 - i) * 64000,
          download: (80 - i) * 1024 * 1024,
          lastSeen: now,
        })).filter((row) => row.route === query.route)
    const groups = new Map<string, TrafficSnapshot['targets'][number]>()
    const details = records.filter((row) => {
      const key = query.byProcess ? row.process : row.target
      return (
        (query.target === null || key === query.target) &&
        [row.target, row.process, row.rule]
          .join(' ')
          .toLowerCase()
          .includes(query.search.toLowerCase())
      )
    })
    for (const row of details) {
      const key = query.byProcess ? row.process : row.target
      const group = groups.get(key) ?? {
        target: key,
        upload: 0,
        download: 0,
        lastSeen: now,
      }
      group.upload += row.upload
      group.download += row.download
      groups.set(key, group)
    }
    const metric = (row: { upload: number; download: number }) =>
      query.metric === 'total' ? row.upload + row.download : row[query.metric]
    const targets = [...groups.values()].sort((a, b) => metric(b) - metric(a))
    details.sort((a, b) => metric(b) - metric(a))
    const sum = (rows: typeof records) =>
      rows.reduce(
        (total, row) => ({
          upload: total.upload + row.upload,
          download: total.download + row.download,
        }),
        { upload: 0, download: 0 },
      )
    const wholeRoute = sum(records)
    const offset = query.page * 50
    return {
      start: new Date().setHours(0, 0, 0, 0),
      end: now,
      timezone: 'Asia/Shanghai',
      collecting: true,
      observedAt: now,
      savedAt: now - 30000,
      pending: true,
      warning: null,
      totals: sum(details),
      targets: targets.slice(offset, offset + 50),
      matchedTargets: targets.length,
      details: query.target === null ? [] : details.slice(offset, offset + 50),
      matchedDetails: query.target === null ? 0 : details.length,
      daily: [1, 0.93, 0.66, 0.77, 0.56, 0.88, 0.63].map((ratio, index) => ({
        date: new Date(now - index * 86400000).toISOString().slice(0, 10),
        upload: wholeRoute.upload * ratio,
        download: wholeRoute.download * ratio,
      })),
      gapMillis: 0,
      databaseBytes: 245760,
    } satisfies TrafficSnapshot
  },
  clear: async () => {
    cleared = true
  },
  copy: async (value) => navigator.clipboard.writeText(value),
  export: async () => {},
}

void initializeLanguage().then(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <ThemeProvider
        theme={createTheme({
          palette: {
            mode: window.matchMedia('(prefers-color-scheme: dark)').matches
              ? 'dark'
              : 'light',
          },
        })}
      >
        <CssBaseline />
        <StatisticsPage api={api} preview />
      </ThemeProvider>
    </StrictMode>,
  )
})
