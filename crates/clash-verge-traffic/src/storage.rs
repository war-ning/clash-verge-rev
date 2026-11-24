use std::{
    io::Write as _,
    path::{Path, PathBuf},
};

use anyhow::{Result, bail};
use rusqlite::{Connection as Database, OptionalExtension as _, params};

use crate::{
    DAY, DailyRow, Delta, DetailRow, Identity, MINUTE, Query, Snapshot, TargetRow, Totals, calendar::Calendar,
};

const NAME_COLUMNS: &str = "key,target,ip,process,path,rule,payload,chain,route";
const MAX_PENDING_BYTES: usize = 8 * 1024 * 1024;
const MAX_PENDING_ROWS: i64 = 50_000;

pub struct Store {
    db: Database,
    path: PathBuf,
    calendar: Calendar,
    pending_bytes: usize,
    observed_at: i64,
    saved_at: i64,
    last_maintenance: i64,
    collecting: bool,
    warning: Option<String>,
}

impl Store {
    pub fn open(path: &Path, timezone: &str) -> Result<Self> {
        let existing = path.exists();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let db = Database::open(path)?;
        db.busy_timeout(std::time::Duration::from_millis(500))?;
        let version: i64 = db.pragma_query_value(None, "user_version", |row| row.get(0))?;
        if existing && version != 2 {
            bail!("Unsupported statistics database; existing file was preserved");
        }
        db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA temp_store=MEMORY; PRAGMA cache_size=-2048; PRAGMA wal_autocheckpoint=512; PRAGMA foreign_keys=ON;
            CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS identities(id INTEGER PRIMARY KEY,key TEXT UNIQUE NOT NULL,target TEXT NOT NULL,ip TEXT NOT NULL,process TEXT NOT NULL,path TEXT NOT NULL,rule TEXT NOT NULL,payload TEXT NOT NULL,chain TEXT NOT NULL,route TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS usage(grain INTEGER NOT NULL,at INTEGER NOT NULL,hour_start INTEGER NOT NULL,hour_end INTEGER NOT NULL,date TEXT NOT NULL,identity INTEGER NOT NULL REFERENCES identities(id),upload INTEGER NOT NULL,download INTEGER NOT NULL,last INTEGER NOT NULL,PRIMARY KEY(grain,at,identity)) WITHOUT ROWID;
            CREATE INDEX IF NOT EXISTS usage_identity_time ON usage(identity,at);
            CREATE TABLE IF NOT EXISTS daily(date TEXT NOT NULL,route TEXT NOT NULL,upload INTEGER NOT NULL,download INTEGER NOT NULL,PRIMARY KEY(date,route)) WITHOUT ROWID;
            CREATE TABLE IF NOT EXISTS coverage(at INTEGER PRIMARY KEY,gap INTEGER NOT NULL);
            CREATE TEMP TABLE names(id INTEGER PRIMARY KEY,key TEXT UNIQUE NOT NULL,target TEXT NOT NULL,ip TEXT NOT NULL,process TEXT NOT NULL,path TEXT NOT NULL,rule TEXT NOT NULL,payload TEXT NOT NULL,chain TEXT NOT NULL,route TEXT NOT NULL);
            CREATE TEMP TABLE pending(at INTEGER NOT NULL,hour_start INTEGER NOT NULL,hour_end INTEGER NOT NULL,date TEXT NOT NULL,identity INTEGER NOT NULL,upload INTEGER NOT NULL,download INTEGER NOT NULL,last INTEGER NOT NULL,PRIMARY KEY(at,identity)) WITHOUT ROWID;
            CREATE TEMP TABLE pending_coverage(at INTEGER PRIMARY KEY,gap INTEGER NOT NULL);")?;
        if !existing {
            let calendar = Calendar::new(timezone)?;
            db.execute("INSERT INTO settings VALUES('timezone',?1)", [calendar.timezone.name()])?;
            db.pragma_update(None, "user_version", 2)?;
        }
        let zone: String = db.query_row("SELECT value FROM settings WHERE key='timezone'", [], |row| row.get(0))?;
        let saved_at = db
            .query_row("SELECT value FROM settings WHERE key='savedAt'", [], |row| {
                row.get::<_, String>(0)
            })
            .optional()?
            .and_then(|value| value.parse().ok())
            .unwrap_or(0);
        Ok(Self {
            db,
            path: path.to_owned(),
            calendar: Calendar::new(&zone)?,
            pending_bytes: 0,
            observed_at: 0,
            saved_at,
            last_maintenance: 0,
            collecting: false,
            warning: None,
        })
    }

    pub fn backup(&mut self, path: &Path, now: i64) -> Result<()> {
        self.flush(now)?;
        let mut destination = Database::open(path)?;
        let backup = rusqlite::backup::Backup::new(&self.db, &mut destination)?;
        backup.run_to_completion(128, std::time::Duration::from_millis(10), None)?;
        Ok(())
    }
    pub const fn set_collecting(&mut self, value: bool) {
        self.collecting = value;
    }
    pub fn set_warning(&mut self, value: Option<String>) {
        self.warning = value;
    }

    pub fn append(&mut self, deltas: Vec<Delta>, coverage: Option<(i64, i64, bool)>, now: i64) -> Result<()> {
        let estimate = deltas
            .iter()
            .map(|delta| delta.identity.estimated_bytes())
            .sum::<usize>();
        let pending_rows: i64 = self
            .db
            .query_row("SELECT COUNT(*) FROM pending", [], |row| row.get(0))?;
        if estimate > MAX_PENDING_BYTES
            || self.pending_bytes + estimate > MAX_PENDING_BYTES
            || pending_rows + deltas.len() as i64 > MAX_PENDING_ROWS
        {
            self.flush(now)?;
            if estimate > MAX_PENDING_BYTES || deltas.len() as i64 > MAX_PENDING_ROWS {
                bail!("Connection snapshot exceeds the statistics memory limit");
            }
        }
        let tx = self.db.transaction()?;
        if !deltas.is_empty() {
            let mut insert_name = tx.prepare_cached(
                "INSERT OR IGNORE INTO names(key,target,ip,process,path,rule,payload,chain,route) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",
            )?;
            let mut select_name = tx.prepare_cached("SELECT id FROM names WHERE key=?1")?;
            let mut upsert_pending = tx.prepare_cached(
                "INSERT INTO pending VALUES(?1,?2,?3,?4,?5,?6,?7,?8) ON CONFLICT(at,identity) DO UPDATE SET upload=upload+excluded.upload,download=download+excluded.download,last=MAX(last,excluded.last)",
            )?;
            for delta in deltas {
                let at = delta.at.div_euclid(MINUTE) * MINUTE;
                let (hour, end, date) = self.calendar.bucket(delta.at)?;
                let identity = delta.identity;
                let key = serde_json::to_string(&identity)?;
                insert_name.execute(params![
                    key,
                    identity.target,
                    identity.ip,
                    identity.process,
                    identity.path,
                    identity.rule,
                    identity.rule_payload,
                    identity.chain,
                    identity.route
                ])?;
                let id: i64 = select_name.query_row([key], |row| row.get(0))?;
                upsert_pending.execute(params![
                    at,
                    hour,
                    end,
                    date,
                    id,
                    i64::try_from(delta.upload)?,
                    i64::try_from(delta.download)?,
                    delta.at
                ])?;
            }
        }
        if let Some((start, end, complete)) = coverage {
            tx.execute(
                "INSERT INTO pending_coverage VALUES(?1,?2) ON CONFLICT(at) DO UPDATE SET gap=gap+excluded.gap",
                params![end.div_euclid(MINUTE) * MINUTE, if complete { 0 } else { end - start }],
            )?;
        }
        tx.commit()?;
        self.pending_bytes += estimate;
        self.observed_at = now;
        Ok(())
    }

    pub fn flush(&mut self, now: i64) -> Result<()> {
        let tx = self.db.transaction()?;
        tx.execute_batch(&format!("INSERT OR IGNORE INTO identities({NAME_COLUMNS}) SELECT {NAME_COLUMNS} FROM names;
            INSERT INTO usage SELECT 0,p.at,p.hour_start,p.hour_end,p.date,i.id,p.upload,p.download,p.last FROM pending p JOIN names n ON n.id=p.identity JOIN identities i ON i.key=n.key WHERE true
              ON CONFLICT(grain,at,identity) DO UPDATE SET upload=upload+excluded.upload,download=download+excluded.download,last=MAX(last,excluded.last);
            INSERT INTO daily SELECT p.date,n.route,SUM(p.upload),SUM(p.download) FROM pending p JOIN names n ON n.id=p.identity GROUP BY p.date,n.route
              ON CONFLICT(date,route) DO UPDATE SET upload=upload+excluded.upload,download=download+excluded.download;
            INSERT INTO coverage SELECT at,gap FROM pending_coverage WHERE true ON CONFLICT(at) DO UPDATE SET gap=gap+excluded.gap;
            DELETE FROM pending; DELETE FROM names; DELETE FROM pending_coverage;"))?;
        tx.execute(
            "INSERT INTO settings VALUES('savedAt',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            [now.to_string()],
        )?;
        tx.commit()?;
        self.pending_bytes = 0;
        self.saved_at = now;
        if now - self.last_maintenance >= 3_600_000 {
            self.maintain(now)?;
            self.last_maintenance = now;
        }
        Ok(())
    }

    pub fn maintain(&mut self, now: i64) -> Result<()> {
        let cutoff = self.calendar.retention(now)?;
        let cutoff_date = self.calendar.date(cutoff)?.to_string();
        let tx = self.db.transaction()?;
        tx.execute("INSERT INTO usage SELECT 1,hour_start,hour_start,hour_end,date,identity,SUM(upload),SUM(download),MAX(last) FROM usage WHERE grain=0 AND hour_end<=?1 GROUP BY hour_start,hour_end,date,identity ON CONFLICT(grain,at,identity) DO UPDATE SET upload=upload+excluded.upload,download=download+excluded.download,last=MAX(last,excluded.last)", [now-DAY])?;
        tx.execute(
            "DELETE FROM usage WHERE (grain=0 AND hour_end<=?1) OR at<?2",
            params![now - DAY, cutoff],
        )?;
        tx.execute("DELETE FROM daily WHERE date<?1", [cutoff_date])?;
        tx.execute("DELETE FROM coverage WHERE at<?1", [cutoff])?;
        tx.execute(
            "DELETE FROM identities WHERE NOT EXISTS(SELECT 1 FROM usage WHERE identity=identities.id)",
            [],
        )?;
        tx.commit()?;
        self.db.execute_batch("PRAGMA wal_checkpoint(PASSIVE);")?;
        Ok(())
    }

    pub fn clear(&mut self, now: i64) -> Result<()> {
        self.db.execute_batch("BEGIN IMMEDIATE; DELETE FROM pending; DELETE FROM names; DELETE FROM pending_coverage; DELETE FROM usage; DELETE FROM identities; DELETE FROM daily; DELETE FROM coverage; DELETE FROM settings WHERE key='savedAt'; COMMIT;")?;
        self.pending_bytes = 0;
        self.saved_at = now;
        self.observed_at = 0;
        self.collecting = false;
        self.warning = None;
        Ok(())
    }

    fn bytes(&self) -> u64 {
        [
            self.path.clone(),
            PathBuf::from(format!("{}-wal", self.path.display())),
            PathBuf::from(format!("{}-shm", self.path.display())),
        ]
        .iter()
        .filter_map(|path| std::fs::metadata(path).ok())
        .map(|meta| meta.len())
        .sum()
    }

    pub fn read(&self, query: &Query, now: i64) -> Result<Snapshot> {
        if !["proxy", "direct", "unknown"].contains(&query.route.as_str())
            || query.search.len() > 512
            || query.target.as_ref().is_some_and(|target| target.len() > 4096)
        {
            bail!("Invalid statistics filter");
        }
        let metric = match query.metric.as_str() {
            "upload" => "SUM(upload)",
            "download" => "SUM(download)",
            "total" => "SUM(upload)+SUM(download)",
            _ => bail!("Invalid statistics metric"),
        };
        let (start, end) = self.calendar.range(&query.period, now)?;
        let group_key = if query.by_process { "process" } else { "target" };
        let cte = format!("WITH saved AS (
                SELECT identity,SUM(upload) upload,SUM(download) download,MAX(last) last
                FROM usage WHERE grain IN (0,1) AND at>=?1 AND at<?2 GROUP BY identity
            ), buffered AS (
                SELECT identity,SUM(upload) upload,SUM(download) download,MAX(last) last
                FROM pending WHERE at>=?1 AND at<?2 GROUP BY identity
            ), records AS (
                SELECT s.upload,s.download,s.last,i.target,i.ip,i.process,i.path,i.rule,i.payload,i.chain,i.route
                FROM saved s JOIN identities i ON i.id=s.identity
                UNION ALL
                SELECT b.upload,b.download,b.last,n.target,n.ip,n.process,n.path,n.rule,n.payload,n.chain,n.route
                FROM buffered b JOIN names n ON n.id=b.identity
            ), filtered AS (
                SELECT * FROM records WHERE route=?3
                AND (?4='' OR instr(lower(target||char(10)||ip||char(10)||process||char(10)||path||char(10)||rule||char(10)||payload||char(10)||chain),lower(?4))>0)
                AND (?5 IS NULL OR {group_key}=?5)
            )");
        let args = params![start, end, query.route, query.search.trim(), query.target];
        let (totals, matched_targets) = self.db.query_row(
            &format!(
                "{cte} SELECT COALESCE(SUM(upload),0),COALESCE(SUM(download),0),COUNT(DISTINCT {group_key}) FROM filtered"
            ),
            args,
            |row| {
                Ok((
                    Totals {
                        upload: row.get(0)?,
                        download: row.get(1)?,
                    },
                    row.get(2)?,
                ))
            },
        )?;
        let offset = i64::from(query.page) * 50;
        let targets = self.db.prepare(&format!("{cte} SELECT {group_key},SUM(upload) upload,SUM(download) download,MAX(last) FROM filtered GROUP BY {group_key} ORDER BY {metric} DESC,{group_key} LIMIT 50 OFFSET {offset}"))?.query_map(args,|row|Ok(TargetRow{target:row.get(0)?,upload:row.get(1)?,download:row.get(2)?,last_seen:row.get(3)?}))?.collect::<rusqlite::Result<Vec<_>>>()?;
        let mut details = Vec::new();
        let mut matched_details = 0;
        if query.target.is_some() {
            matched_details = self.db.query_row(&format!("{cte} SELECT COUNT(*) FROM (SELECT 1 FROM filtered GROUP BY target,ip,process,path,rule,payload,chain,route)"),args,|row|row.get(0))?;
            details = self.db.prepare(&format!("{cte} SELECT target,ip,process,path,rule,payload,chain,route,SUM(upload) upload,SUM(download) download,MAX(last) FROM filtered GROUP BY target,ip,process,path,rule,payload,chain,route ORDER BY {metric} DESC,ip,process,path,rule,payload,chain LIMIT 50 OFFSET {offset}"))?.query_map(args,|row|Ok(DetailRow{identity:Identity{target:row.get(0)?,ip:row.get(1)?,process:row.get(2)?,path:row.get(3)?,rule:row.get(4)?,rule_payload:row.get(5)?,chain:row.get(6)?,route:row.get(7)?},upload:row.get(8)?,download:row.get(9)?,last_seen:row.get(10)?}))?.collect::<rusqlite::Result<Vec<_>>>()?;
        }
        let (chart_start, _) = self.calendar.range("week", now)?;
        let first_date = self.calendar.date(start.min(chart_start))?.to_string();
        let daily = self.db.prepare("SELECT date,SUM(upload),SUM(download) FROM (SELECT date,upload,download FROM daily WHERE route=?1 AND date>=?2 UNION ALL SELECT p.date,p.upload,p.download FROM pending p JOIN names n ON n.id=p.identity WHERE n.route=?1 AND p.date>=?2) GROUP BY date ORDER BY date DESC")?.query_map(params![query.route,first_date],|row|Ok(DailyRow{date:row.get(0)?,upload:row.get(1)?,download:row.get(2)?}))?.collect::<rusqlite::Result<Vec<_>>>()?;
        let gap_millis = self.db.query_row("SELECT COALESCE(SUM(gap),0) FROM (SELECT at,gap FROM coverage UNION ALL SELECT at,gap FROM pending_coverage) WHERE at>=?1 AND at<?2",params![start,end],|row|row.get(0))?;
        Ok(Snapshot {
            start,
            end,
            timezone: self.calendar.timezone.name().into(),
            collecting: self.collecting,
            observed_at: self.observed_at,
            saved_at: self.saved_at,
            pending: self.pending_bytes > 0,
            warning: self.warning.clone(),
            totals,
            targets,
            matched_targets,
            details,
            matched_details,
            daily,
            gap_millis,
            database_bytes: self.bytes(),
        })
    }

    pub fn export(&self, query: &Query, path: &Path, now: i64) -> Result<()> {
        let mut export_query = query.clone();
        export_query.page = 0;
        let first = self.read(&export_query, now)?;
        let temporary = path.with_extension("statistics-pending");
        let file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        let result = (|| -> Result<()> {
            let mut writer = std::io::BufWriter::new(file);
            let mut metadata = serde_json::to_value(&first)?;
            if let Some(object) = metadata.as_object_mut() {
                object.remove("targets");
                object.remove("details");
            }
            writer.write_all(b"{\"schemaVersion\":2,\"query\":")?;
            serde_json::to_writer(&mut writer, query)?;
            writer.write_all(b",\"metadata\":")?;
            serde_json::to_writer(&mut writer, &metadata)?;
            writer.write_all(b",\"rows\":[")?;
            let mut first_row = true;
            let count = if query.target.is_some() {
                first.matched_details
            } else {
                first.matched_targets
            };
            for page in 0..count.div_ceil(50) {
                export_query.page = u32::try_from(page)?;
                let snapshot = self.read(&export_query, now)?;
                let rows = if query.target.is_some() {
                    serde_json::to_value(snapshot.details)?
                } else {
                    serde_json::to_value(snapshot.targets)?
                };
                if let Some(rows) = rows.as_array() {
                    for row in rows {
                        if !first_row {
                            writer.write_all(b",")?;
                        }
                        first_row = false;
                        serde_json::to_writer(&mut writer, row)?;
                    }
                }
            }
            writer.write_all(b"]}")?;
            writer.flush()?;
            writer.get_ref().sync_all()?;
            drop(writer);
            std::fs::rename(&temporary, path)?;
            Ok(())
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(&temporary);
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temporary(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "verge-traffic-{}-{}-{name}.sqlite",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ))
    }

    #[test]
    fn pending_flush_compaction_restart_and_clear_preserve_totals() -> Result<()> {
        let path = temporary("accounting");
        let at = chrono::DateTime::parse_from_rfc3339("2026-11-19T00:00:00Z")?.timestamp_millis();
        let mut store = Store::open(&path, "Asia/Kolkata")?;
        let row = |route: &str, download| Delta {
            at,
            upload: 10,
            download,
            identity: Identity {
                target: "example.com".into(),
                route: route.into(),
                ..Identity::default()
            },
        };
        store.append(
            vec![row("proxy", 100), row("direct", 900)],
            Some((at - 1000, at, true)),
            at,
        )?;
        assert_eq!(store.read(&Query::default(), at)?.totals.download, 100);
        store.flush(at)?;
        store.flush(at)?;
        assert_eq!(store.read(&Query::default(), at)?.totals.download, 100);
        store.maintain(at + 2 * DAY)?;
        store.maintain(at + 2 * DAY)?;
        let query = Query {
            period: "week".into(),
            ..Query::default()
        };
        assert_eq!(store.read(&query, at + 2 * DAY)?.totals.download, 100);
        drop(store);
        let mut reopened = Store::open(&path, "UTC")?;
        let result = reopened.read(&query, at + 2 * DAY)?;
        assert_eq!(result.timezone, "Asia/Kolkata");
        assert_eq!(result.daily[0].download, 100);
        reopened.clear(at + 2 * DAY)?;
        assert_eq!(reopened.read(&query, at + 2 * DAY)?.totals.download, 0);
        drop(reopened);
        std::fs::remove_file(path)?;
        Ok(())
    }

    #[test]
    fn long_tail_is_ranked_before_pagination_and_search_does_not_change_daily_scope() -> Result<()> {
        let path = temporary("ranking");
        let at = 1_794_998_400_000;
        let mut store = Store::open(&path, "UTC")?;
        let deltas = (0..80)
            .map(|i| Delta {
                at,
                upload: 0,
                download: i,
                identity: Identity {
                    target: format!("host-{i:02}"),
                    process: "browser.exe".into(),
                    route: "proxy".into(),
                    ..Identity::default()
                },
            })
            .collect();
        store.append(deltas, None, at)?;
        let query = Query::default();
        let result = store.read(&query, at)?;
        assert_eq!(result.matched_targets, 80);
        assert_eq!(result.targets[0].target, "host-79");
        let by_process = Query {
            by_process: true,
            ..query.clone()
        };
        let grouped = store.read(&by_process, at)?;
        assert_eq!(grouped.matched_targets, 1);
        assert_eq!(grouped.targets[0].target, "browser.exe");
        assert_eq!(grouped.targets[0].download, (0..80).sum::<u64>());
        let details = store.read(
            &Query {
                target: Some("browser.exe".into()),
                ..by_process
            },
            at,
        )?;
        assert_eq!(details.matched_details, 80);
        assert_eq!(details.details[0].identity.target, "host-79");
        let result = store.read(
            &Query {
                search: "host-79".into(),
                ..query
            },
            at,
        )?;
        assert_eq!(result.totals.download, 79);
        assert_eq!(result.daily[0].download, (0..80).sum::<u64>());
        drop(store);
        std::fs::remove_file(path)?;
        Ok(())
    }
}
