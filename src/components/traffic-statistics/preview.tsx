import {
  CssBaseline,
  Button,
  MenuItem,
  Stack,
  TextField,
  ThemeProvider,
  createTheme,
} from '@mui/material'
import { StrictMode, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'

import { initializeLanguage } from '@/services/i18n'
import type { StatisticsApi } from '@/services/traffic-statistics/api'
import type {
  StatisticsSettings,
  StatisticsSnapshot,
  TrafficRecord,
} from '@/services/traffic-statistics/model'
import { HOUR } from '@/services/traffic-statistics/query'

import { initialQuery } from './dates'
import { StatisticsPage } from './page'

function syntheticSnapshot(): StatisticsSnapshot {
  const { start } = initialQuery()
  const records: TrafficRecord[] = []
  const groups = ['Work', 'Media', 'DIRECT']
  const hours = Math.max(1, Math.floor((Date.now() - start) / HOUR))
  for (let hour = 0; hour < hours; hour++) {
    for (let index = 0; index < 83; index++) {
      records.push({
        at: start + hour * HOUR,
        target:
          index === 2
            ? 'a-very-long-analytics-hostname-for-testing-readable-complete-target-identities.example.test'
            : index === 81
              ? null
              : `service-${index}.example.test`,
        process:
          index === 82
            ? null
            : index < 4
              ? 'browser.exe'
              : `application-${index % 8}.exe`,
        path:
          index > 79
            ? null
            : `D:/Applications/${index % 3 === 0 ? 'Work browser installation with a long directory name and spaces' : `Application ${index % 8}`}/${index < 4 ? `instance-${index}/browser.exe` : `application-${index % 8}.exe`}`,
        group: index === 82 ? null : groups[index % 3],
        route: index % 3 === 2 ? 'direct' : 'proxy',
        unattributed: index === 82,
        upload: (84 - index) * (hour + 1) * 1024,
        download: (84 - index) * ((hour % 4) + 1) * 256 * 1024,
      })
    }
  }
  return {
    records,
    groups,
    coverage: [
      {
        start: start + 2_000,
        end: start + Math.max(0, hours - 2) * HOUR,
        offset: -new Date().getTimezoneOffset() * 60,
        consistent: true,
      },
    ],
    settings: {
      enabled: true,
      retentionDays: 30,
      recordTargets: true,
      recordProcesses: true,
    },
    warnings: [],
    savedAt: Date.now(),
    collecting: true,
    durable: true,
  }
}

export function Preview() {
  const [dark, setDark] = useState(false)
  const [scenario, setScenario] = useState('normal')
  const api = useMemo<StatisticsApi>(() => {
    const source = syntheticSnapshot()
    if (scenario === 'zero' || scenario === 'empty') source.records = []
    if (scenario === 'empty') source.coverage = []
    if (scenario === 'partial')
      source.warnings = [
        'Synthetic unreadable-record warning. Readable records remain available.',
      ]
    if (scenario === 'paused') source.settings.enabled = false
    if (scenario === 'unsaved') {
      source.durable = false
      source.warnings = [
        'Synthetic save failure. Retry refresh before exporting.',
      ]
    }
    return {
      read: async (start, end) => {
        if (scenario === 'failure')
          throw new Error(
            'Synthetic read failure; use the scenario control to retry.',
          )
        return {
          ...structuredClone(source),
          records: source.records.filter(
            (row) => row.at >= start && row.at < end,
          ),
        }
      },
      configure: async (settings: StatisticsSettings) => {
        source.settings = structuredClone(settings)
      },
      clear: async () => {
        source.records = []
        source.coverage = []
        source.groups = []
        source.warnings = []
      },
      copy: async (value) => {
        await navigator.clipboard.writeText(value)
      },
      export: async (data) => {
        const url = URL.createObjectURL(
          new Blob([JSON.stringify(data, null, 2)], {
            type: 'application/json',
          }),
        )
        const anchor = document.createElement('a')
        anchor.href = url
        anchor.download = 'traffic-statistics-preview.json'
        anchor.click()
        window.setTimeout(() => URL.revokeObjectURL(url), 1_000)
        return true
      },
    }
  }, [scenario])
  const theme = useMemo(
    () =>
      createTheme({
        palette: {
          mode: dark ? 'dark' : 'light',
          primary: { main: '#5577dd' },
        },
        shape: { borderRadius: 10 },
        typography: { fontFamily: 'Segoe UI, Microsoft YaHei, sans-serif' },
      }),
    [dark],
  )
  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <Stack
        direction="row"
        sx={{
          gap: 1,
          flexWrap: 'wrap',
          p: 1,
          borderBottom: '1px solid',
          borderColor: 'divider',
        }}
      >
        <Button onClick={() => setDark(!dark)}>Light / Dark</Button>
        <TextField
          size="small"
          select
          label="Preview scenario"
          value={scenario}
          onChange={(event) => setScenario(event.target.value)}
          sx={{ minWidth: 180 }}
        >
          {[
            'normal',
            'zero',
            'empty',
            'partial',
            'paused',
            'failure',
            'unsaved',
          ].map((value) => (
            <MenuItem key={value} value={value}>
              {value}
            </MenuItem>
          ))}
        </TextField>
      </Stack>
      <StatisticsPage api={api} preview />
    </ThemeProvider>
  )
}

if (import.meta.env.DEV)
  void initializeLanguage('zh').then(() =>
    createRoot(document.getElementById('root')!).render(
      <StrictMode>
        <Preview />
      </StrictMode>,
    ),
  )
