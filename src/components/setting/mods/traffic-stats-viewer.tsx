import {
  InputAdornment,
  List,
  ListItem,
  ListItemText,
  TextField,
} from '@mui/material'
import { useLockFn } from 'ahooks'
import { forwardRef, useImperativeHandle, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { BaseDialog, DialogRef, Switch, TooltipIcon } from '@/components/base'
import { useVerge } from '@/hooks/use-verge'
import { showNotice } from '@/services/notice-service'

const MIN_RETENTION_DAYS = 1
const MAX_RETENTION_DAYS = 365

export const TrafficStatsViewer = forwardRef<DialogRef>((props, ref) => {
  const { t } = useTranslation()
  const { verge, patchVerge } = useVerge()

  const [open, setOpen] = useState(false)
  const [values, setValues] = useState({
    enabled: true,
    retentionDays: 30,
    recordHost: true,
    recordProcess: true,
  })

  useImperativeHandle(ref, () => ({
    open: () => {
      setOpen(true)
      setValues({
        enabled: verge?.enable_traffic_stats ?? true,
        retentionDays: verge?.traffic_stats_retention_days ?? 30,
        recordHost: verge?.traffic_stats_record_host ?? true,
        recordProcess: verge?.traffic_stats_record_process ?? true,
      })
    },
    close: () => setOpen(false),
  }))

  const onSave = useLockFn(async () => {
    try {
      await patchVerge({
        enable_traffic_stats: values.enabled,
        traffic_stats_retention_days: Math.min(
          Math.max(values.retentionDays, MIN_RETENTION_DAYS),
          MAX_RETENTION_DAYS,
        ),
        traffic_stats_record_host: values.recordHost,
        traffic_stats_record_process: values.recordProcess,
      })
      setOpen(false)
    } catch (err) {
      showNotice.error(err)
    }
  })

  return (
    <BaseDialog
      open={open}
      title={t('settings.modals.trafficStats.title')}
      contentSx={{ width: 450 }}
      okBtn={t('shared.actions.save')}
      cancelBtn={t('shared.actions.cancel')}
      onClose={() => setOpen(false)}
      onCancel={() => setOpen(false)}
      onOk={onSave}
    >
      <List>
        <ListItem sx={{ padding: '5px 2px' }}>
          <ListItemText
            primary={t('settings.modals.trafficStats.fields.enabled')}
          />
          <Switch
            edge="end"
            checked={values.enabled}
            onChange={(_, checked) =>
              setValues((v) => ({ ...v, enabled: checked }))
            }
          />
        </ListItem>

        <ListItem sx={{ padding: '5px 2px' }}>
          <ListItemText
            primary={t('settings.modals.trafficStats.fields.retentionDays')}
          />
          <TextField
            autoComplete="new-password"
            size="small"
            type="number"
            disabled={!values.enabled}
            sx={{ width: 135 }}
            slotProps={{
              input: {
                endAdornment: (
                  <InputAdornment position="end">
                    {t('shared.units.days')}
                  </InputAdornment>
                ),
              },
              htmlInput: { min: MIN_RETENTION_DAYS, max: MAX_RETENTION_DAYS },
            }}
            value={values.retentionDays}
            onChange={(e) =>
              setValues((v) => ({
                ...v,
                retentionDays: Number(e.target.value) || 30,
              }))
            }
          />
        </ListItem>

        <ListItem sx={{ padding: '5px 2px' }}>
          <ListItemText
            primary={t('settings.modals.trafficStats.fields.recordHost')}
          />
          <TooltipIcon
            title={t('settings.modals.trafficStats.tooltips.recordHost')}
            sx={{ opacity: '0.7' }}
          />
          <Switch
            edge="end"
            disabled={!values.enabled}
            checked={values.recordHost}
            onChange={(_, checked) =>
              setValues((v) => ({ ...v, recordHost: checked }))
            }
          />
        </ListItem>

        <ListItem sx={{ padding: '5px 2px' }}>
          <ListItemText
            primary={t('settings.modals.trafficStats.fields.recordProcess')}
          />
          <TooltipIcon
            title={t('settings.modals.trafficStats.tooltips.recordProcess')}
            sx={{ opacity: '0.7' }}
          />
          <Switch
            edge="end"
            disabled={!values.enabled}
            checked={values.recordProcess}
            onChange={(_, checked) =>
              setValues((v) => ({ ...v, recordProcess: checked }))
            }
          />
        </ListItem>
      </List>
    </BaseDialog>
  )
})
