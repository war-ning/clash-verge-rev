use super::{Coverage, Record, Settings};
use std::collections::HashMap;
use tauri_plugin_mihomo::models::Connections;

#[derive(Default)]
pub(super) struct Sampler {
    previous: Option<(i64, u64, u64)>,
    connections: HashMap<(String, String), (u64, u64)>,
}

fn nonempty(value: &str) -> Option<String> {
    (!value.is_empty()).then(|| value.to_owned())
}

impl Sampler {
    pub(super) fn sample(
        &mut self,
        snapshot: &Connections,
        now: i64,
        offset: i32,
        settings: &Settings,
    ) -> Option<(Vec<Record>, Coverage)> {
        let previous = self
            .previous
            .replace((now, snapshot.upload_total, snapshot.download_total));
        let connections: HashMap<_, _> = snapshot
            .connections
            .as_deref()
            .unwrap_or_default()
            .iter()
            .map(|row| ((row.id.to_string(), row.start.to_string()), (row.upload, row.download)))
            .collect();
        let old = std::mem::replace(&mut self.connections, connections);
        let (start, previous_up, previous_down) = previous?;
        if now <= start
            || now - start > 5_000
            || snapshot.upload_total < previous_up
            || snapshot.download_total < previous_down
        {
            return None;
        }
        let up = snapshot.upload_total - previous_up;
        let down = snapshot.download_total - previous_down;
        let at = now.div_euclid(60_000) * 60_000;
        let mut records = Vec::new();
        let mut attributed_up = 0_u64;
        let mut attributed_down = 0_u64;
        for row in snapshot.connections.as_deref().unwrap_or_default() {
            let key = (row.id.to_string(), row.start.to_string());
            let (old_up, old_down) = old.get(&key).copied().unwrap_or_else(|| {
                // Only a recorded start inside this interval can justify charging first-seen counters.
                let started_in_interval = chrono::DateTime::parse_from_rfc3339(&row.start)
                    .is_ok_and(|date| (start..=now).contains(&date.timestamp_millis()));
                if started_in_interval {
                    (0, 0)
                } else {
                    (row.upload, row.download)
                }
            });
            if row.upload < old_up || row.download < old_down {
                continue;
            }
            let upload = row.upload - old_up;
            let download = row.download - old_down;
            if upload == 0 && download == 0 {
                continue;
            }
            attributed_up = attributed_up.saturating_add(upload);
            attributed_down = attributed_down.saturating_add(download);
            let terminal = row.chains.first().map(|value| value.as_str());
            let route = match terminal {
                Some("DIRECT") => "direct",
                Some("REJECT" | "REJECT-DROP" | "PASS" | "COMPATIBLE") | None => "unknown",
                Some(_) => "proxy",
            };
            let metadata = &row.metadata;
            records.push(Record {
                at,
                target: settings
                    .record_targets
                    .then(|| nonempty(&metadata.host).or_else(|| nonempty(&metadata.destination_ip)))
                    .flatten(),
                process: settings.record_processes.then(|| nonempty(&metadata.process)).flatten(),
                path: settings
                    .record_processes
                    .then(|| nonempty(&metadata.process_path))
                    .flatten(),
                group: row.chains.last().and_then(|value| nonempty(value)),
                route: route.to_owned(),
                unattributed: false,
                upload,
                download,
            });
        }
        let consistent = attributed_up <= up && attributed_down <= down;
        if !consistent {
            // There is no evidence supporting a proportional allocation to identities.
            records.clear();
            attributed_up = 0;
            attributed_down = 0;
        }
        if up > attributed_up || down > attributed_down {
            records.push(Record {
                at,
                target: None,
                process: None,
                path: None,
                group: None,
                route: "unknown".into(),
                unattributed: true,
                upload: up - attributed_up,
                download: down - attributed_down,
            });
        }
        Some((
            records,
            Coverage {
                start,
                end: now,
                offset,
                consistent,
            },
        ))
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    fn snapshot(up: u64, connection_up: u64) -> Connections {
        serde_json::from_value(serde_json::json!({"uploadTotal": up, "downloadTotal": 0,
            "connections": [{"id": "one", "start": "2026-10-19T00:00:00Z", "upload": connection_up,
                "download": 0, "chains": ["DIRECT", "Work"], "metadata": {"process": "browser.exe"}}]}))
        .unwrap()
    }

    #[test]
    fn baselines_residuals_and_resets_do_not_recount_lifetime_bytes() {
        let mut sampler = Sampler::default();
        let settings = Settings::default();
        assert!(sampler.sample(&snapshot(1_000, 800), 1_000, 0, &settings).is_none());
        let (rows, coverage) = sampler.sample(&snapshot(1_100, 870), 2_000, 0, &settings).unwrap();
        assert!(coverage.consistent);
        assert_eq!(rows.iter().map(|row| row.upload).sum::<u64>(), 100);
        assert_eq!(rows.iter().find(|row| row.unattributed).unwrap().upload, 30);
        assert_eq!(rows[0].route, "direct");
        assert_eq!(rows[0].group.as_deref(), Some("Work"));
        assert!(sampler.sample(&snapshot(10, 5), 3_000, 0, &settings).is_none());
        assert_eq!(
            sampler
                .sample(&snapshot(20, 10), 4_000, 0, &settings)
                .unwrap()
                .0
                .iter()
                .map(|row| row.upload)
                .sum::<u64>(),
            10
        );
        sampler = Sampler::default();
        assert!(sampler.sample(&snapshot(200, 100), 5_000, 0, &settings).is_none());
    }

    #[test]
    fn gaps_and_inconsistent_counters_never_fabricate_identity_totals() {
        let mut sampler = Sampler::default();
        let settings = Settings::default();
        sampler.sample(&snapshot(0, 0), 1_000, 0, &settings);
        let (rows, coverage) = sampler.sample(&snapshot(10, 20), 2_000, 0, &settings).unwrap();
        assert!(!coverage.consistent);
        assert_eq!(rows.len(), 1);
        assert!(rows[0].unattributed);
        assert_eq!(rows[0].upload, 10);
        assert!(sampler.sample(&snapshot(500, 500), 20_000, 0, &settings).is_none());
    }

    #[test]
    fn a_connection_started_inside_the_interval_keeps_its_known_identity() {
        let mut sampler = Sampler::default();
        let settings = Settings::default();
        let start = chrono::DateTime::parse_from_rfc3339("2026-10-19T00:00:00Z")
            .unwrap()
            .timestamp_millis();
        sampler.sample(&Connections::default(), start - 1_000, 0, &settings);
        let (rows, _) = sampler.sample(&snapshot(100, 70), start + 1_000, 0, &settings).unwrap();
        assert_eq!(
            rows.iter().find(|row| !row.unattributed).unwrap().process.as_deref(),
            Some("browser.exe")
        );
        assert_eq!(rows.iter().find(|row| !row.unattributed).unwrap().upload, 70);
        assert_eq!(rows.iter().find(|row| row.unattributed).unwrap().upload, 30);
    }
}
