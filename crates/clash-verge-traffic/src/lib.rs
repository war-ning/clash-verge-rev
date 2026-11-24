mod calendar;
mod collector;
mod storage;
mod worker;

pub use collector::Sampler;
pub use storage::Store;
pub use worker::Worker;

use serde::{Deserialize, Serialize};

pub const MINUTE: i64 = 60_000;
pub const DAY: i64 = 86_400_000;

pub fn system_timezone() -> anyhow::Result<String> {
    iana_time_zone::get_timezone().map_err(Into::into)
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Identity {
    pub target: String,
    pub ip: String,
    pub process: String,
    pub path: String,
    pub rule: String,
    pub rule_payload: String,
    pub chain: String,
    pub route: String,
}

impl Identity {
    fn estimated_bytes(&self) -> usize {
        [
            &self.target,
            &self.ip,
            &self.process,
            &self.path,
            &self.rule,
            &self.rule_payload,
            &self.chain,
            &self.route,
        ]
        .into_iter()
        .map(String::len)
        .sum::<usize>()
            + 256
    }
}

#[derive(Clone, Debug)]
pub struct Connection {
    pub id: String,
    pub start: i64,
    pub upload: u64,
    pub download: u64,
    pub identity: Identity,
}

#[derive(Clone, Debug)]
pub struct Observation {
    pub at: i64,
    pub epoch: u64,
    pub connections: Vec<Connection>,
}

#[derive(Clone, Debug)]
pub struct Delta {
    pub at: i64,
    pub identity: Identity,
    pub upload: u64,
    pub download: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Query {
    pub period: String,
    pub route: String,
    #[serde(default)]
    pub search: String,
    #[serde(default)]
    pub target: Option<String>,
    #[serde(default)]
    pub by_process: bool,
    #[serde(default = "default_metric")]
    pub metric: String,
    #[serde(default)]
    pub page: u32,
}

fn default_metric() -> String {
    "total".into()
}

impl Default for Query {
    fn default() -> Self {
        Self {
            period: "today".into(),
            route: "proxy".into(),
            search: String::new(),
            target: None,
            by_process: false,
            metric: default_metric(),
            page: 0,
        }
    }
}

#[derive(Clone, Debug, Default, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Totals {
    pub upload: u64,
    pub download: u64,
}

#[derive(Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TargetRow {
    pub target: String,
    pub upload: u64,
    pub download: u64,
    pub last_seen: i64,
}

#[derive(Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DetailRow {
    #[serde(flatten)]
    pub identity: Identity,
    pub upload: u64,
    pub download: u64,
    pub last_seen: i64,
}

#[derive(Debug, Serialize, specta::Type)]
pub struct DailyRow {
    pub date: String,
    pub upload: u64,
    pub download: u64,
}

#[derive(Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub start: i64,
    pub end: i64,
    pub timezone: String,
    pub collecting: bool,
    pub observed_at: i64,
    pub saved_at: i64,
    pub pending: bool,
    pub warning: Option<String>,
    pub totals: Totals,
    pub targets: Vec<TargetRow>,
    pub matched_targets: u64,
    pub details: Vec<DetailRow>,
    pub matched_details: u64,
    pub daily: Vec<DailyRow>,
    pub gap_millis: i64,
    pub database_bytes: u64,
}
