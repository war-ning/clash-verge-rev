use anyhow::{Context as _, Result, bail};
use chrono::{DateTime, Days, LocalResult, NaiveDate, TimeZone as _};
use chrono_tz::Tz;

use crate::{DAY, MINUTE};

pub struct Calendar {
    pub timezone: Tz,
}

impl Calendar {
    pub fn new(timezone: &str) -> Result<Self> {
        Ok(Self {
            timezone: timezone.parse().context("Unknown reporting timezone")?,
        })
    }

    fn midnight(&self, date: NaiveDate) -> Result<i64> {
        let local = date.and_hms_opt(0, 0, 0).context("Invalid reporting date")?;
        match self.timezone.from_local_datetime(&local) {
            LocalResult::Single(value) => Ok(value.timestamp_millis()),
            LocalResult::Ambiguous(first, second) => Ok(first.timestamp_millis().min(second.timestamp_millis())),
            LocalResult::None => {
                // Some zones advance their clock at midnight.
                for minutes in 1..=1440 {
                    if let Some(value) = self
                        .timezone
                        .from_local_datetime(&(local + chrono::Duration::minutes(minutes)))
                        .earliest()
                    {
                        return Ok(value.timestamp_millis());
                    }
                }
                bail!("Reporting date has no local time")
            }
        }
    }

    pub fn date(&self, at: i64) -> Result<NaiveDate> {
        Ok(DateTime::from_timestamp_millis(at)
            .context("Invalid sample timestamp")?
            .with_timezone(&self.timezone)
            .date_naive())
    }

    pub fn bucket(&self, at: i64) -> Result<(i64, i64, String)> {
        let date = self.date(at)?;
        let start = self.midnight(date)?;
        let end = self.midnight(date.checked_add_days(Days::new(1)).context("Date overflow")?)?;
        let hour = start + (at - start).div_euclid(3_600_000) * 3_600_000;
        Ok((hour, (hour + 3_600_000).min(end), date.to_string()))
    }

    pub fn range(&self, period: &str, now: i64) -> Result<(i64, i64)> {
        if period == "hour" {
            return Ok(((now - 3_600_000).div_euclid(MINUTE) * MINUTE, now + 1));
        }
        let days = match period {
            "today" => 1,
            "week" => 7,
            "month" => 30,
            _ => bail!("Invalid statistics period"),
        };
        let date = self
            .date(now)?
            .checked_sub_days(Days::new(days - 1))
            .context("Date overflow")?;
        Ok((self.midnight(date)?, now + 1))
    }

    pub fn retention(&self, now: i64) -> Result<i64> {
        Ok(self.range("month", now)?.0.min(now - DAY))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn half_hour_offsets_and_dst_buckets_never_cross_the_reporting_day() -> Result<()> {
        for (zone, text) in [
            ("Asia/Kolkata", "2026-11-18T18:40:00Z"),
            ("America/New_York", "2026-11-01T05:30:00Z"),
            ("America/New_York", "2026-11-01T06:30:00Z"),
            ("America/New_York", "2026-03-08T07:30:00Z"),
        ] {
            let at = DateTime::parse_from_rfc3339(text)?.timestamp_millis();
            let calendar = Calendar::new(zone)?;
            let (start, end, date) = calendar.bucket(at)?;
            assert!(start <= at && at < end);
            assert_eq!(calendar.date(start)?.to_string(), date);
            assert_eq!(calendar.date(end - 1)?.to_string(), date);
        }
        Ok(())
    }
}
