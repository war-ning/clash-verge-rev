import { BasePage } from '@/components/base'
import { StatisticsPage } from '@/components/traffic-statistics/page'
import { statisticsApi } from '@/services/traffic-statistics/api'

export default function TrafficStatisticsPage() {
  return (
    <BasePage contentStyle={{ padding: 0 }}>
      <StatisticsPage api={statisticsApi} />
    </BasePage>
  )
}
