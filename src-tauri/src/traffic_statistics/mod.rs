mod collector;
mod storage;

use anyhow::{Result, bail};
use chrono::{Local, Utc};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, sync::OnceLock};
use tokio::sync::Mutex;

const HOUR: i64 = 3_600_000;
pub const MANUAL_UPDATES: bool = true;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub enabled: bool,
    pub retention_days: u32,
    pub record_targets: bool,
    pub record_processes: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            enabled: false,
            retention_days: 30,
            record_targets: true,
            record_processes: true,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    pub at: i64,
    pub target: Option<String>,
    pub process: Option<String>,
    pub path: Option<String>,
    pub group: Option<String>,
    pub route: String,
    pub unattributed: bool,
    pub upload: u64,
    pub download: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Coverage {
    pub start: i64,
    pub end: i64,
    pub offset: i32,
    pub consistent: bool,
}

#[derive(Default, Serialize, Deserialize)]
struct Hour {
    records: Vec<Record>,
    coverage: Vec<Coverage>,
    #[serde(skip)]
    index: std::collections::HashMap<RecordKey, usize>,
}

type RecordKey = (
    i64,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    String,
    bool,
);

impl Record {
    fn key(&self) -> RecordKey {
        (
            self.at,
            self.target.clone(),
            self.process.clone(),
            self.path.clone(),
            self.group.clone(),
            self.route.clone(),
            self.unattributed,
        )
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    records: Vec<Record>,
    coverage: Vec<Coverage>,
    groups: Vec<String>,
    settings: Settings,
    warnings: Vec<String>,
    saved_at: i64,
    collecting: bool,
    durable: bool,
}

struct State {
    store: storage::Store,
    settings: Settings,
    hours: BTreeMap<i64, Hour>,
    dirty: std::collections::BTreeSet<i64>,
    sampler: collector::Sampler,
    revision: u64,
    saved_at: i64,
    collecting: bool,
    warnings: Vec<String>,
    write_error: Option<String>,
}

static STATE: OnceLock<Mutex<State>> = OnceLock::new();
static INITIALIZATION_ERROR: OnceLock<String> = OnceLock::new();

fn state() -> Result<&'static Mutex<State>> {
    STATE.get().ok_or_else(|| {
        anyhow::anyhow!(
            INITIALIZATION_ERROR
                .get()
                .cloned()
                .unwrap_or_else(|| "Statistics are not initialized; retry after startup".into())
        )
    })
}

impl State {
    fn flush(&mut self) -> Result<()> {
        for hour in self.dirty.clone() {
            if let Some(data) = self.hours.get(&hour) {
                self.store.write_hour(hour, data)?;
            }
            self.dirty.remove(&hour);
        }
        self.saved_at = Utc::now().timestamp_millis();
        self.write_error = None;
        Ok(())
    }

    fn record(&mut self, records: Vec<Record>, coverage: Coverage) {
        let hour_key = coverage.end.div_euclid(HOUR) * HOUR;
        let hour = self.hours.entry(hour_key).or_default();
        if hour.index.is_empty() && !hour.records.is_empty() {
            hour.index
                .extend(hour.records.iter().enumerate().map(|(index, row)| (row.key(), index)));
        }
        for record in records {
            let key = record.key();
            if let Some(index) = hour.index.get(&key) {
                let existing = &mut hour.records[*index];
                existing.upload += record.upload;
                existing.download += record.download;
            } else {
                hour.index.insert(key, hour.records.len());
                hour.records.push(record);
            }
        }
        if let Some(previous) = hour.coverage.last_mut().filter(|previous| {
            let contiguous = coverage.start == previous.end;
            contiguous && previous.offset == coverage.offset && previous.consistent == coverage.consistent
        }) {
            previous.end = coverage.end;
        } else {
            hour.coverage.push(coverage);
        }
        self.dirty.insert(hour_key);
    }
}

pub fn start() {
    crate::process::AsyncHandler::spawn(|| async {
        let (store, settings, hours, warnings) = match storage::Store::open() {
            Ok(opened) => opened,
            Err(error) => {
                let message = format!(
                    "Statistics storage could not be opened: {error:#}. Existing data was preserved; retry after restarting the application."
                );
                log::error!("{message}");
                let _ = INITIALIZATION_ERROR.set(message);
                return;
            }
        };
        if STATE
            .set(Mutex::new(State {
                store,
                settings,
                hours,
                warnings,
                dirty: Default::default(),
                sampler: Default::default(),
                revision: 0,
                saved_at: 0,
                collecting: false,
                write_error: None,
            }))
            .is_err()
        {
            return;
        }
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(1));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut last_flush = Utc::now().timestamp_millis();
        loop {
            interval.tick().await;
            if crate::core::handle::Handle::global().is_exiting() {
                break;
            }
            let Ok(owner) = state() else {
                break;
            };
            let revision = {
                let mut guard = owner.lock().await;
                let now = Utc::now().timestamp_millis();
                if now - last_flush >= 60_000 {
                    let retention_error = guard.expire(now).err();
                    let save_error = guard.flush().err();
                    guard.write_error = save_error.or(retention_error).map(|error| error.to_string());
                    last_flush = now;
                }
                if !guard.settings.enabled {
                    continue;
                }
                guard.revision
            };
            let sample = tokio::time::timeout(
                std::time::Duration::from_secs(3),
                crate::core::handle::Handle::mihomo().get_connections(),
            )
            .await;
            let mut guard = owner.lock().await;
            if revision != guard.revision
                || !guard.settings.enabled
                || crate::core::handle::Handle::global().is_exiting()
            {
                continue;
            }
            match sample {
                Ok(Ok(snapshot)) => {
                    let now = Utc::now().timestamp_millis();
                    let settings = guard.settings.clone();
                    if let Some((records, coverage)) =
                        guard
                            .sampler
                            .sample(&snapshot, now, Local::now().offset().local_minus_utc(), &settings)
                    {
                        guard.record(records, coverage);
                    }
                    guard.collecting = true;
                }
                _ => {
                    guard.sampler = Default::default();
                    guard.collecting = false;
                }
            }
        }
        let _ = flush().await;
    });
}

pub async fn flush() -> Result<()> {
    if let Some(owner) = STATE.get() {
        owner.lock().await.flush()?;
    }
    Ok(())
}

pub async fn read(start: i64, end: i64) -> Result<Snapshot> {
    if end <= start || end - start > 367 * 24 * HOUR {
        bail!("Invalid statistics date range");
    }
    let mut guard = state()?.lock().await;
    let retention_error = guard.expire(Utc::now().timestamp_millis()).err();
    if let Err(error) = guard.flush() {
        guard.write_error = Some(error.to_string());
    }
    if let Some(error) = retention_error {
        guard.write_error = Some(error.to_string());
    }
    let mut records = Vec::new();
    let mut coverage = Vec::new();
    let mut groups = std::collections::BTreeSet::new();
    for hour in guard.hours.values() {
        for row in &hour.records {
            if let Some(group) = &row.group {
                groups.insert(group.clone());
            }
            if row.at >= start && row.at < end {
                records.push(row.clone());
            }
        }
        coverage.extend(
            hour.coverage
                .iter()
                .filter(|range| range.end > start && range.start < end)
                .cloned(),
        );
    }
    let mut warnings = guard.warnings.clone();
    if let Some(error) = &guard.write_error {
        warnings.push(format!("Statistics storage operation failed: {error}"));
    }
    Ok(Snapshot {
        records,
        coverage,
        groups: groups.into_iter().collect(),
        settings: guard.settings.clone(),
        warnings,
        saved_at: guard.saved_at,
        collecting: guard.collecting,
        durable: guard.dirty.is_empty(),
    })
}

pub async fn configure(settings: Settings) -> Result<()> {
    if !(1..=366).contains(&settings.retention_days) {
        bail!("Retention must be between 1 and 366 days");
    }
    let mut guard = state()?.lock().await;
    guard.flush()?;
    guard.store.write_settings(&settings)?;
    guard.settings = settings;
    guard.sampler = Default::default();
    guard.revision += 1;
    guard.collecting = false;
    guard.expire(Utc::now().timestamp_millis())?;
    drop(guard);
    Ok(())
}

pub async fn clear() -> Result<()> {
    let mut guard = state()?.lock().await;
    // A committed generation prevents old buffers/files from being reloaded after clear.
    let settings = guard.settings.clone();
    guard.store.advance_generation(&settings)?;
    guard.hours.clear();
    guard.dirty.clear();
    guard.sampler = Default::default();
    guard.revision += 1;
    guard.collecting = false;
    guard.warnings.clear();
    guard.write_error = None;
    guard.saved_at = Utc::now().timestamp_millis();
    if let Err(error) = guard.store.remove_previous_generations() {
        guard.warnings.push(error.to_string());
        drop(guard);
        return Err(error);
    }
    drop(guard);
    Ok(())
}

impl State {
    fn expire(&mut self, now: i64) -> Result<()> {
        let cutoff = now - i64::from(self.settings.retention_days) * 24 * HOUR;
        let expired: Vec<_> = self.hours.keys().copied().filter(|hour| hour + HOUR < cutoff).collect();
        for hour in expired {
            self.store.remove_hour(hour)?;
            self.hours.remove(&hour);
            self.dirty.remove(&hour);
        }
        Ok(())
    }
}
