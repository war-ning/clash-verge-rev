//! 历史流量统计：回答「什么东西吃了我的代理流量、吃了多少」。
//!
//! 按**目标域名**与**进程名**两个维度、按小时分桶落盘；每条记录同时带上它走的
//! **策略组**——策略组不是独立维度，而是跟在名称后面的一列（复合键，见 [`compose_key`]），
//! 因此同一个域名走不同策略组会分成两条，一眼能看出哪些流量真的走了代理。
//!
//! 数据源是 mihomo `/connections` WebSocket——它每约 1 秒推送一次**当前活动连接的全量快照**，
//! 每条连接携带其生命周期内的累计上下行字节。本模块对累计值按连接 id 做差分后累加到时间桶。
//!
//! # 精度边界
//!
//! - 连接关闭时 mihomo 不单独通报，只是从下一帧快照中消失，因此每条连接**最后一次快照之后**
//!   的流量无法归因；存活短于一个采样周期的连接可能被整条漏掉。
//! - 上述缺口由「未归因」桶兜底：用快照里的全局累计计数（`uploadTotal`/`downloadTotal`）做差，
//!   减去本次归因到各连接的增量，余数记入 [`UNATTRIBUTED_KEY`]，使各维度合计与全局总量对得上。
//! - mihomo 内核重启会把全局累计计数清零，检测到回退即跳过该样本并重置基线。

use crate::{
    config::{Config, IVerge},
    core::handle,
    process::AsyncHandler,
    utils::{
        connections_stream::{self, ConnectionsSnapshotEvent, MihomoWsEventStream},
        dirs,
        xlsx::{self, Cell, Sheet},
    },
};
use anyhow::Result;
use chrono::{Local, NaiveDate, TimeZone as _, Timelike as _};
use clash_verge_logging::{Type, logging};
use once_cell::sync::OnceCell;
use parking_lot::{Mutex, RwLock};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicI64, Ordering},
    },
    time::Duration,
};
use tokio::sync::watch;

/// 流断开后的重连间隔。
const RECONNECT_DELAY: Duration = Duration::from_secs(1);
/// 传给流消费函数的空闲轮询间隔（当前实现未真正使用，保留签名一致）。
const IDLE_POLL_INTERVAL: Duration = Duration::from_millis(200);
/// `/connections` 约 1 秒一帧，超过该时长收不到有效帧即判定流已僵死并重连。
const STALE_TIMEOUT: Duration = Duration::from_secs(10);
/// 内存增量落盘间隔。
const FLUSH_INTERVAL_SECS: i64 = 60;

const DEFAULT_RETENTION_DAYS: u32 = 30;
const MIN_RETENTION_DAYS: u32 = 1;
const MAX_RETENTION_DAYS: u32 = 365;

/// 每个小时桶、每个维度保留的条目上限，其余合并进 [`OTHER_KEY`]。
/// 键是「名称 × 策略组」复合键，域名维度基数最大，故取相对宽松的上限。
const MAX_KEYS_PER_BUCKET: usize = 150;

/// 超出 Top-N 后被合并的条目。
pub const OTHER_KEY: &str = "__other__";
/// 无法归因到具体连接的残差。
pub const UNATTRIBUTED_KEY: &str = "__unattributed__";
/// 该维度字段缺失（如未开启 find-process-mode 时的进程名）。
pub const UNKNOWN_KEY: &str = "__unknown__";

/// 落盘文件格式版本，版本不匹配的旧文件会被忽略而非报错。
/// v3 起 host 维度 key 改为 `host\u{1}group\u{1}process` 3-part，新增 group 维度。
const STATS_FILE_VERSION: u32 = 3;

// ---------------------------------------------------------------------------
// 基础数据类型
// ---------------------------------------------------------------------------

/// 上下行字节对。序列化为 `[up, down]` 两元数组以压缩体积。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TrafficPair(pub u64, pub u64);

impl TrafficPair {
    const fn up(self) -> u64 {
        self.0
    }

    const fn down(self) -> u64 {
        self.1
    }

    const fn total(self) -> u64 {
        self.0.saturating_add(self.1)
    }

    const fn is_zero(self) -> bool {
        self.0 == 0 && self.1 == 0
    }

    const fn add(&mut self, up: u64, down: u64) {
        self.0 = self.0.saturating_add(up);
        self.1 = self.1.saturating_add(down);
    }
}

/// 统计维度：只回答「什么东西吃了流量」。
///
/// 每条记录的 key 是 `<名称>\u{1}<策略组>` 复合键（见 [`compose_key`]），
/// 因此同一域名经不同策略组出去会分成两条，展示时策略组单独成列。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StatsDimension {
    /// 目标域名，缺失时回落到目标 IP。
    Host,
    /// 触发连接的进程名。
    Process,
    /// 代理策略组。
    Group,
}

/// 查询时的时间粒度。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StatsGranularity {
    Hour,
    Day,
}

type DimensionMap = HashMap<String, TrafficPair>;

/// 单个小时桶内两个维度各自的统计。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct DimensionBuckets {
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    host: DimensionMap,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    process: DimensionMap,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    group: DimensionMap,
}

impl DimensionBuckets {
    const fn map(&self, dimension: StatsDimension) -> &DimensionMap {
        match dimension {
            StatsDimension::Host => &self.host,
            StatsDimension::Process => &self.process,
            StatsDimension::Group => &self.group,
        }
    }

    fn is_empty(&self) -> bool {
        self.host.is_empty() && self.process.is_empty() && self.group.is_empty()
    }

    /// 把另一份增量合并进来。
    fn merge(&mut self, other: &Self) {
        merge_map(&mut self.host, &other.host);
        merge_map(&mut self.process, &other.process);
        merge_map(&mut self.group, &other.group);
    }

    /// Top-N 截断，被截掉的条目合并进 [`OTHER_KEY`]（总量守恒）。
    fn truncate(&mut self) {
        truncate_map(&mut self.host, MAX_KEYS_PER_BUCKET);
        truncate_map(&mut self.process, MAX_KEYS_PER_BUCKET);
        truncate_map(&mut self.group, MAX_KEYS_PER_BUCKET);
    }
}

fn merge_map(target: &mut DimensionMap, source: &DimensionMap) {
    for (key, pair) in source {
        target.entry(key.clone()).or_default().add(pair.up(), pair.down());
    }
}

/// 保留合计最大的 `capacity` 项，其余合并进 [`OTHER_KEY`]。
///
/// [`OTHER_KEY`] 与 [`UNATTRIBUTED_KEY`] 是聚合项，即便排名靠后也不会被丢弃。
fn truncate_map(map: &mut DimensionMap, capacity: usize) {
    if map.len() <= capacity {
        return;
    }

    let mut entries: Vec<(String, TrafficPair)> = map.drain().collect();
    // 合计降序；相同合计按 key 升序，保证结果稳定可测。
    entries.sort_by(|left, right| right.1.total().cmp(&left.1.total()).then_with(|| left.0.cmp(&right.0)));

    let mut kept: DimensionMap = HashMap::with_capacity(capacity + 1);
    let mut overflow = TrafficPair::default();
    for (index, (key, pair)) in entries.into_iter().enumerate() {
        if index < capacity || key == OTHER_KEY || key == UNATTRIBUTED_KEY {
            kept.insert(key, pair);
        } else {
            overflow.add(pair.up(), pair.down());
        }
    }

    if !overflow.is_zero() {
        kept.entry(OTHER_KEY.to_owned())
            .or_default()
            .add(overflow.up(), overflow.down());
    }

    *map = kept;
}

// ---------------------------------------------------------------------------
// 落盘格式
// ---------------------------------------------------------------------------

/// 一天一个 JSON 文件，文件名形如 `2026-08-03.json`（本地日期）。
#[derive(Debug, Clone, Serialize, Deserialize)]
struct DayFile {
    v: u32,
    date: String,
    /// 写入时的本地时区偏移（分钟），便于跨时区/夏令时排查数据。
    tz_offset_min: i32,
    /// 小时（0-23）-> 各维度统计。
    #[serde(default)]
    buckets: HashMap<u32, DimensionBuckets>,
}

impl DayFile {
    fn new(date: NaiveDate) -> Self {
        Self {
            v: STATS_FILE_VERSION,
            date: date.format("%Y-%m-%d").to_string(),
            tz_offset_min: Local::now().offset().local_minus_utc() / 60,
            buckets: HashMap::new(),
        }
    }
}

// ---------------------------------------------------------------------------
// 设置
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct StatsSettings {
    enabled: bool,
    retention_days: u32,
    record_host: bool,
    record_process: bool,
}

impl StatsSettings {
    fn from_verge(verge: &IVerge) -> Self {
        Self {
            enabled: verge.enable_traffic_stats.unwrap_or(true),
            retention_days: verge
                .traffic_stats_retention_days
                .unwrap_or(DEFAULT_RETENTION_DAYS)
                .clamp(MIN_RETENTION_DAYS, MAX_RETENTION_DAYS),
            record_host: verge.traffic_stats_record_host.unwrap_or(true),
            record_process: verge.traffic_stats_record_process.unwrap_or(true),
        }
    }
}

impl Default for StatsSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            retention_days: DEFAULT_RETENTION_DAYS,
            record_host: true,
            record_process: true,
        }
    }
}

// ---------------------------------------------------------------------------
// 内存累加器
// ---------------------------------------------------------------------------

/// 尚未落盘的增量：本地日期 -> 小时 -> 各维度统计。
type PendingBuckets = HashMap<NaiveDate, HashMap<u32, DimensionBuckets>>;

#[derive(Debug, Default)]
struct Accumulator {
    /// 连接 id -> 上一帧快照里的累计值，用于差分。
    seen: HashMap<String, TrafficPair>,
    /// 上一帧的全局累计计数，用于算未归因残差。
    last_totals: Option<TrafficPair>,
    pending: PendingBuckets,
    dirty: bool,
}

impl Accumulator {
    /// 消费一帧快照，把增量累加到 `date`/`hour` 对应的桶。
    fn ingest(&mut self, snapshot: ConnectionsSnapshotEvent, settings: StatsSettings, date: NaiveDate, hour: u32) {
        let mut delta = DimensionBuckets::default();
        let mut new_seen: HashMap<String, TrafficPair> = HashMap::with_capacity(snapshot.connections.len());
        let mut attributed = TrafficPair::default();

        for conn in snapshot.connections {
            let previous = self.seen.get(&conn.id).copied();
            // 首次见到的连接：把它已累计的全量计入，比记 0 更接近真值
            // （这部分字节同样包含在全局累计计数里，两侧口径一致）。
            let (up, down) = match previous {
                Some(prev) => (
                    conn.upload.saturating_sub(prev.up()),
                    conn.download.saturating_sub(prev.down()),
                ),
                None => (conn.upload, conn.download),
            };
            new_seen.insert(conn.id, TrafficPair(conn.upload, conn.download));

            if up == 0 && down == 0 {
                continue;
            }
            attributed.add(up, down);
            // 策略组随名称一起进 key，这样同一域名走不同策略组能分开看。
            let group = conn.group.as_deref();
            let group_name = group.unwrap_or(UNKNOWN_KEY);
            if settings.record_host {
                add_key(
                    &mut delta.host,
                    conn.host.as_deref(),
                    group,
                    conn.process.as_deref(),
                    up,
                    down,
                );
            }
            if settings.record_process {
                add_key(
                    &mut delta.process,
                    conn.process.as_deref(),
                    group,
                    None,
                    up,
                    down,
                );
            }
            // 策略组维度总是记录（group 字段总是可用）。
            add_named_key(&mut delta.group, group_name, up, down);
        }

        // 快照里不再出现的连接即已关闭，其基线随之丢弃。
        self.seen = new_seen;

        let totals = TrafficPair(snapshot.upload_total, snapshot.download_total);
        self.accumulate_residual(&mut delta, settings, totals, attributed);
        self.last_totals = Some(totals);

        if delta.is_empty() {
            return;
        }
        self.pending
            .entry(date)
            .or_default()
            .entry(hour)
            .or_default()
            .merge(&delta);
        self.dirty = true;
    }

    /// 把「全局增量 − 已归因增量」记入未归因桶。
    fn accumulate_residual(
        &self,
        delta: &mut DimensionBuckets,
        settings: StatsSettings,
        totals: TrafficPair,
        attributed: TrafficPair,
    ) {
        let Some(previous) = self.last_totals else {
            // 首帧没有基线，无法算增量。
            return;
        };
        // 计数回退 = 内核重启，跳过本次残差，下一帧以新基线重新开始。
        if totals.up() < previous.up() || totals.down() < previous.down() {
            return;
        }

        let up = (totals.up() - previous.up()).saturating_sub(attributed.up());
        let down = (totals.down() - previous.down()).saturating_sub(attributed.down());
        if up == 0 && down == 0 {
            return;
        }

        if settings.record_host {
            add_named_key(&mut delta.host, UNATTRIBUTED_KEY, up, down);
        }
        if settings.record_process {
            add_named_key(&mut delta.process, UNATTRIBUTED_KEY, up, down);
        }
        add_named_key(&mut delta.group, UNATTRIBUTED_KEY, up, down);
    }

    fn take_pending(&mut self) -> PendingBuckets {
        self.dirty = false;
        std::mem::take(&mut self.pending)
    }

    /// 丢弃连接基线（流断开后旧 id 的累计值不再可比）。
    fn reset_baseline(&mut self) {
        self.seen.clear();
        self.last_totals = None;
    }

    fn reset_all(&mut self) {
        self.seen.clear();
        self.last_totals = None;
        self.pending.clear();
        self.dirty = false;
    }
}

/// 名称与策略组的分隔符：控制字符，域名与进程名里都不可能出现。
const KEY_SEPARATOR: char = '\u{1}';

/// 把「名称 + 策略组」拼成复合 key（2-part，用于 process 维度）。
fn compose_key(name: &str, group: &str) -> String {
    let mut key = String::with_capacity(name.len() + group.len() + 1);
    key.push_str(name);
    key.push(KEY_SEPARATOR);
    key.push_str(group);
    key
}

/// 把「名称 + 策略组 + 进程」拼成复合 key（3-part，用于 host 维度）。
fn compose_three_part_key(host: &str, group: &str, process: &str) -> String {
    let mut key = String::with_capacity(host.len() + group.len() + process.len() + 2);
    key.push_str(host);
    key.push(KEY_SEPARATOR);
    key.push_str(group);
    key.push(KEY_SEPARATOR);
    key.push_str(process);
    key
}

/// 拆回「名称, 策略组, 进程」。
///
/// - 3-part key（v3 host）：`name\u{1}group\u{1}process` → `(name, Some(group), Some(process))`
/// - 2-part key（v2 / process 维度）：`name\u{1}group` → `(name, Some(group), None)`
/// - 聚合项 key / 策略组维度 key：`name` → `(name, None, None)`
fn split_key(key: &str) -> (&str, Option<&str>, Option<&str>) {
    match key.split_once(KEY_SEPARATOR) {
        Some((name, rest)) => match rest.split_once(KEY_SEPARATOR) {
            Some((group, process)) => (name, Some(group), Some(process)),
            None => (name, Some(rest), None),
        },
        None => (key, None, None),
    }
}

/// 连接存在但该维度字段缺失（如未开 find-process-mode）→ [`UNKNOWN_KEY`]。
fn add_key(
    map: &mut DimensionMap,
    name: Option<&str>,
    group: Option<&str>,
    process: Option<&str>,
    up: u64,
    down: u64,
) {
    let key = match name {
        Some(name) => {
            let grp = group.unwrap_or(UNKNOWN_KEY);
            match process {
                Some(proc) => compose_three_part_key(name, grp, proc),
                None => compose_key(name, grp),
            }
        }
        None => UNKNOWN_KEY.to_owned(),
    };
    map.entry(key).or_default().add(up, down);
}

/// 对不上任何连接的残差 → [`UNATTRIBUTED_KEY`]，与「字段缺失」区分开。
fn add_named_key(map: &mut DimensionMap, name: &str, up: u64, down: u64) {
    map.entry(name.to_owned()).or_default().add(up, down);
}

// ---------------------------------------------------------------------------
// 查询接口类型
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrafficStatsQuery {
    pub dimension: StatsDimension,
    /// 起始时间（Unix 毫秒，含）。
    pub start_ms: i64,
    /// 结束时间（Unix 毫秒，不含）。
    pub end_ms: i64,
    pub granularity: StatsGranularity,
    /// 只返回合计最大的前 N 项，其余合并进 [`OTHER_KEY`]。
    #[serde(default)]
    pub top_n: Option<usize>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrafficStatsEntry {
    /// 复合键原文，唯一标识一条记录（前端用作列表 key 与配色索引）。
    pub key: String,
    /// 展示名：域名、进程名或策略组名。
    pub name: String,
    /// 该条流量走的策略组；聚合项（其他/未归因/未知）或 group 维度没有。
    pub group: Option<String>,
    /// 产生该条流量的进程（host 维度时才有值）。
    pub process: Option<String>,
    pub up: u64,
    pub down: u64,
}

/// 导出表格的文案。
///
/// 后端不做 i18n，表头与聚合项名称一律由前端按当前界面语言传进来，
/// 这样导出的 Excel 和用户看到的页面用词一致。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportLabels {
    pub summary_sheet: String,
    pub detail_sheet: String,
    pub time: String,
    pub name: String,
    pub group: String,
    pub process: String,
    pub up: String,
    pub down: String,
    pub total: String,
    pub share: String,
    pub other: String,
    pub unattributed: String,
    pub unknown: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrafficStatsBucket {
    /// 桶起点（Unix 毫秒，本地时区对齐）。
    pub ts: i64,
    pub items: Vec<TrafficStatsEntry>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrafficStatsResult {
    pub granularity: StatsGranularity,
    pub buckets: Vec<TrafficStatsBucket>,
    /// 时间范围内各 key 的合计，按合计降序。
    pub totals: Vec<TrafficStatsEntry>,
    /// 是否因 Top-N 而产生了 [`OTHER_KEY`] 合并项。
    pub truncated: bool,
}

// ---------------------------------------------------------------------------
// 管理器
// ---------------------------------------------------------------------------

/// 消费循环的退出原因。
enum ConsumeOutcome {
    /// 需要重连。
    Reconnect,
    /// 设置发生变化，回到外层重新判定。
    SettingsChanged,
    /// 应用退出。
    Exit,
}

pub struct TrafficStatsManager {
    settings: Arc<RwLock<StatsSettings>>,
    settings_tx: watch::Sender<StatsSettings>,
    runner_started: AtomicBool,
    accumulator: Mutex<Accumulator>,
    /// 串行化磁盘读写，避免落盘与查询互相覆盖。
    io_lock: tokio::sync::Mutex<()>,
    last_flush: AtomicI64,
}

impl TrafficStatsManager {
    pub fn global() -> &'static Self {
        static INSTANCE: OnceCell<TrafficStatsManager> = OnceCell::new();
        INSTANCE.get_or_init(|| {
            let (tx, _rx) = watch::channel(StatsSettings::default());
            Self {
                settings: Arc::new(RwLock::new(StatsSettings::default())),
                settings_tx: tx,
                runner_started: AtomicBool::new(false),
                accumulator: Mutex::new(Accumulator::default()),
                io_lock: tokio::sync::Mutex::new(()),
                last_flush: AtomicI64::new(0),
            }
        })
    }

    pub async fn init(&self) -> Result<()> {
        let settings = Self::load_settings().await;
        self.apply_settings(settings);

        if let Err(err) = Self::cleanup_expired(settings.retention_days).await {
            logging!(warn, Type::Network, "清理过期流量统计失败: {err}");
        }

        self.ensure_runner();
        Ok(())
    }

    /// 配置变更后重新加载（由 `feat::patch_verge` 调用）。
    pub async fn refresh_settings(&self) -> Result<()> {
        let settings = Self::load_settings().await;
        self.apply_settings(settings);
        self.ensure_runner();
        Ok(())
    }

    async fn load_settings() -> StatsSettings {
        let verge = Config::verge().await;
        StatsSettings::from_verge(&verge.latest_arc())
    }

    /// 只在设置真的变了时才通知采集循环。
    ///
    /// `refresh_settings` 挂在 `patch_verge` 上，改主题、换语言等任何配置变更都会走到这里；
    /// 无条件 `send` 会让采集循环误以为要重来一遍，白白断开重连、丢掉约 1 秒的采集窗口。
    fn apply_settings(&self, settings: StatsSettings) {
        let changed = {
            let mut guard = self.settings.write();
            let changed = *guard != settings;
            *guard = settings;
            drop(guard);
            changed
        };

        if changed {
            let _ = self.settings_tx.send(settings);
        }
    }

    fn current_settings(&self) -> StatsSettings {
        let guard = self.settings.read();
        let settings = *guard;
        drop(guard);
        settings
    }

    fn ensure_runner(&self) {
        if self.runner_started.swap(true, Ordering::SeqCst) {
            return;
        }

        let mut rx = self.settings_tx.subscribe();
        AsyncHandler::spawn(move || async move {
            Self::run_collector(&mut rx).await;
        });
    }

    // -- 采集循环 ---------------------------------------------------------

    /// 外层循环：负责启停、连接与重连。
    async fn run_collector(rx: &mut watch::Receiver<StatsSettings>) {
        loop {
            if handle::Handle::global().is_exiting() {
                break;
            }

            let settings = {
                let guard = rx.borrow_and_update();
                let settings = *guard;
                drop(guard);
                settings
            };
            if !settings.enabled {
                Self::global().reset_accumulator();
                if rx.changed().await.is_err() {
                    break;
                }
                continue;
            }

            let outcome = Self::run_session(rx).await;
            // 断流后旧连接 id 的累计值不再可比，必须丢弃基线，
            // 否则重连后同 id 的新连接会被当成"计数回退"。
            Self::global().reset_accumulator_baseline();

            match outcome {
                ConsumeOutcome::Exit => break,
                ConsumeOutcome::SettingsChanged => {}
                ConsumeOutcome::Reconnect => {
                    tokio::time::sleep(RECONNECT_DELAY).await;
                }
            }
        }

        if let Err(err) = Self::global().flush().await {
            logging!(warn, Type::Network, "退出前落盘流量统计失败: {err}");
        }
    }

    /// 建立一次订阅并消费到结束。
    async fn run_session(rx: &mut watch::Receiver<StatsSettings>) -> ConsumeOutcome {
        let mut stream = match connections_stream::connect_connections_stream().await {
            Ok(stream) => stream,
            Err(err) => {
                logging!(debug, Type::Network, "流量统计连接失败，稍后重试: {err}");
                return ConsumeOutcome::Reconnect;
            }
        };

        let connection_id = stream.connection_id;
        let outcome = Self::consume_stream(&mut stream, rx).await;
        connections_stream::disconnect_connection(connection_id).await;
        outcome
    }

    /// 内层循环：逐帧消费快照。
    async fn consume_stream(
        stream: &mut MihomoWsEventStream<ConnectionsSnapshotEvent>,
        rx: &mut watch::Receiver<StatsSettings>,
    ) -> ConsumeOutcome {
        loop {
            let state = stream
                .next_event(IDLE_POLL_INTERVAL, STALE_TIMEOUT, || {
                    handle::Handle::global().is_exiting()
                })
                .await;

            match state {
                connections_stream::StreamConsumeState::Event(snapshot) => {
                    Self::global().ingest(snapshot);
                    Self::global().flush_if_due().await;
                    if rx.has_changed().unwrap_or(false) {
                        return ConsumeOutcome::SettingsChanged;
                    }
                }
                connections_stream::StreamConsumeState::Stale => {
                    logging!(debug, Type::Network, "流量统计流长时间无数据，触发重连");
                    return ConsumeOutcome::Reconnect;
                }
                connections_stream::StreamConsumeState::Closed => return ConsumeOutcome::Reconnect,
                connections_stream::StreamConsumeState::ExitRequested => return ConsumeOutcome::Exit,
            }
        }
    }

    fn ingest(&self, snapshot: ConnectionsSnapshotEvent) {
        let settings = self.current_settings();
        if !settings.enabled {
            return;
        }

        let now = Local::now();
        let date = now.date_naive();
        let hour = now.hour();

        let mut guard = self.accumulator.lock();
        guard.ingest(snapshot, settings, date, hour);
        drop(guard);
    }

    fn reset_accumulator(&self) {
        let mut guard = self.accumulator.lock();
        guard.reset_all();
        drop(guard);
    }

    fn reset_accumulator_baseline(&self) {
        let mut guard = self.accumulator.lock();
        guard.reset_baseline();
        drop(guard);
    }

    // -- 落盘 -------------------------------------------------------------

    async fn flush_if_due(&self) {
        let dirty = {
            let guard = self.accumulator.lock();
            let dirty = guard.dirty;
            drop(guard);
            dirty
        };
        if !dirty {
            return;
        }

        let now = Local::now().timestamp();
        let last = self.last_flush.load(Ordering::Acquire);
        if last != 0 && now - last < FLUSH_INTERVAL_SECS {
            return;
        }

        if let Err(err) = self.flush().await {
            logging!(warn, Type::Network, "落盘流量统计失败: {err}");
        }
    }

    /// 把内存增量合并进对应日期的文件。
    ///
    /// 单日合并失败只记日志并丢弃该日增量——统计属尽力而为的数据，
    /// 不值得为它把失败的增量无限堆在内存里。
    pub async fn flush(&self) -> Result<()> {
        let guard = self.io_lock.lock().await;
        let pending = {
            let mut acc = self.accumulator.lock();
            let pending = acc.take_pending();
            drop(acc);
            pending
        };

        self.last_flush.store(Local::now().timestamp(), Ordering::Release);
        for (date, hours) in pending {
            if let Err(err) = Self::merge_day_file(date, hours).await {
                logging!(warn, Type::Network, "写入 {date} 的流量统计失败: {err}");
            }
        }
        drop(guard);
        Ok(())
    }

    async fn merge_day_file(date: NaiveDate, hours: HashMap<u32, DimensionBuckets>) -> Result<()> {
        let path = Self::day_file_path(date)?;
        let mut day = Self::read_day_file(&path).await.unwrap_or_else(|| DayFile::new(date));

        for (hour, delta) in hours {
            day.buckets.entry(hour).or_default().merge(&delta);
        }
        for bucket in day.buckets.values_mut() {
            bucket.truncate();
        }

        Self::write_day_file(&path, &day).await
    }

    fn day_file_path(date: NaiveDate) -> Result<PathBuf> {
        Ok(dirs::traffic_stats_dir()?.join(format!("{}.json", date.format("%Y-%m-%d"))))
    }

    /// 读取一天的统计；文件缺失、损坏或版本不符时一律视为无数据。
    async fn read_day_file(path: &Path) -> Option<DayFile> {
        let raw = tokio::fs::read(path).await.ok()?;
        let day = serde_json::from_slice::<DayFile>(&raw).ok()?;
        (day.v == STATS_FILE_VERSION).then_some(day)
    }

    /// 先写临时文件再 rename，避免写到一半掉电毁掉历史数据。
    async fn write_day_file(path: &Path, day: &DayFile) -> Result<()> {
        let raw = serde_json::to_vec(day)?;
        let tmp = path.with_extension("json.tmp");
        tokio::fs::write(&tmp, &raw).await?;
        tokio::fs::rename(&tmp, path).await?;
        Ok(())
    }

    async fn cleanup_expired(retention_days: u32) -> Result<()> {
        let dir = dirs::traffic_stats_dir()?;
        let cutoff = Local::now().date_naive() - chrono::Duration::days(i64::from(retention_days));

        let mut entries = tokio::fs::read_dir(&dir).await?;
        while let Some(entry) = entries.next_entry().await? {
            let path = entry.path();
            let Some(stem) = path.file_stem().and_then(|stem| stem.to_str()) else {
                continue;
            };
            let Ok(date) = NaiveDate::parse_from_str(stem, "%Y-%m-%d") else {
                continue;
            };
            if date < cutoff {
                let _ = tokio::fs::remove_file(&path).await;
            }
        }
        Ok(())
    }

    /// 清空全部历史统计（内存 + 磁盘）。
    pub async fn clear(&self) -> Result<()> {
        let guard = self.io_lock.lock().await;
        self.reset_accumulator();

        let dir = dirs::traffic_stats_dir()?;
        let mut entries = tokio::fs::read_dir(&dir).await?;
        while let Some(entry) = entries.next_entry().await? {
            // 目录上调用 remove_file 会失败，忽略即可。
            let _ = tokio::fs::remove_file(entry.path()).await;
        }
        drop(guard);
        Ok(())
    }

    // -- 查询 -------------------------------------------------------------

    /// 查询指定时间范围与维度的统计。
    pub async fn query(&self, query: &TrafficStatsQuery) -> Result<TrafficStatsResult> {
        // 先落盘，否则最近一个 flush 周期内的数据查不到。
        self.flush().await?;

        let guard = self.io_lock.lock().await;
        let raw = Self::collect_range(query).await;
        drop(guard);

        Ok(finalize_result(raw, query))
    }

    /// 把查询结果导出成 xlsx 写到 `path`。
    pub async fn export(&self, query: &TrafficStatsQuery, path: &str, labels: &ExportLabels) -> Result<()> {
        let result = self.query(query).await?;
        let workbook = build_export_workbook(&result, labels)?;
        tokio::fs::write(path, workbook).await?;
        Ok(())
    }

    /// 读取时间范围内所有日文件，聚合成 `桶起点 -> key -> 流量`。
    async fn collect_range(query: &TrafficStatsQuery) -> HashMap<i64, DimensionMap> {
        let mut aggregated: HashMap<i64, DimensionMap> = HashMap::new();

        let Some(start_date) = timestamp_ms_to_local_date(query.start_ms) else {
            return aggregated;
        };
        let Some(end_date) = timestamp_ms_to_local_date(query.end_ms) else {
            return aggregated;
        };

        let mut date = start_date;
        while date <= end_date {
            if let Ok(path) = Self::day_file_path(date) {
                if let Some(day) = Self::read_day_file(&path).await {
                    merge_day_into(&mut aggregated, &day, date, query);
                }
            }
            let Some(next) = date.succ_opt() else { break };
            date = next;
        }

        aggregated
    }
}

/// 把一天的数据按查询条件并入聚合结果。
fn merge_day_into(
    aggregated: &mut HashMap<i64, DimensionMap>,
    day: &DayFile,
    date: NaiveDate,
    query: &TrafficStatsQuery,
) {
    for (hour, buckets) in &day.buckets {
        let Some(ts) = local_bucket_ts_ms(date, *hour) else {
            continue;
        };
        if ts < query.start_ms || ts >= query.end_ms {
            continue;
        }
        let slot = match query.granularity {
            StatsGranularity::Hour => ts,
            StatsGranularity::Day => local_bucket_ts_ms(date, 0).unwrap_or(ts),
        };
        merge_map(aggregated.entry(slot).or_default(), buckets.map(query.dimension));
    }
}

/// 排序、Top-N 截断，组装成前端要的结构。
///
/// 合计由**截断后的各桶**再聚合得出，保证「合计 == 各桶之和」，
/// 也避免磁盘上已存在的 [`OTHER_KEY`] 与本次合并项撞成两条同名记录。
fn finalize_result(aggregated: HashMap<i64, DimensionMap>, query: &TrafficStatsQuery) -> TrafficStatsResult {
    let mut totals: DimensionMap = HashMap::new();
    for bucket in aggregated.values() {
        merge_map(&mut totals, bucket);
    }

    let mut ranked: Vec<(String, TrafficPair)> = totals.into_iter().collect();
    ranked.sort_by(|left, right| right.1.total().cmp(&left.1.total()).then_with(|| left.0.cmp(&right.0)));

    let limit = query.top_n.unwrap_or(usize::MAX);
    let truncated = ranked.len() > limit;
    let kept: HashSet<String> = ranked.into_iter().take(limit).map(|(key, _)| key).collect();

    let mut recomputed: DimensionMap = HashMap::new();
    let mut buckets: Vec<TrafficStatsBucket> = aggregated
        .into_iter()
        .map(|(ts, map)| {
            let folded = fold_to_top_n(map, &kept, truncated);
            merge_map(&mut recomputed, &folded);
            TrafficStatsBucket {
                ts,
                items: to_sorted_entries(folded),
            }
        })
        .collect();
    buckets.sort_by_key(|bucket| bucket.ts);

    TrafficStatsResult {
        granularity: query.granularity,
        buckets,
        totals: to_sorted_entries(recomputed),
        truncated,
    }
}

/// 未进入 Top-N 的 key 合并进 [`OTHER_KEY`]。
fn fold_to_top_n(map: DimensionMap, kept: &HashSet<String>, truncated: bool) -> DimensionMap {
    if !truncated {
        return map;
    }

    let mut folded: DimensionMap = HashMap::with_capacity(kept.len() + 1);
    for (key, pair) in map {
        let target = if kept.contains(&key) { key } else { OTHER_KEY.to_owned() };
        folded.entry(target).or_default().add(pair.up(), pair.down());
    }
    folded
}

/// 按合计降序展开成列表；合计相同时按 key 升序，保证结果稳定。
fn to_sorted_entries(map: DimensionMap) -> Vec<TrafficStatsEntry> {
    let mut entries: Vec<TrafficStatsEntry> = map
        .into_iter()
        .map(|(key, pair)| {
            let (name, group, process) = split_key(&key);
            TrafficStatsEntry {
                name: name.to_owned(),
                group: group.map(str::to_owned),
                process: process.map(str::to_owned),
                key,
                up: pair.up(),
                down: pair.down(),
            }
        })
        .collect();

    entries.sort_by(|left, right| {
        let left_total = left.up.saturating_add(left.down);
        let right_total = right.up.saturating_add(right.down);
        right_total.cmp(&left_total).then_with(|| left.key.cmp(&right.key))
    });
    entries
}

// ---------------------------------------------------------------------------
// 导出
// ---------------------------------------------------------------------------

/// 聚合项（其他/未归因/未知）在导出里换成人话，其余用原名。
fn export_name<'a>(entry: &'a TrafficStatsEntry, labels: &'a ExportLabels) -> &'a str {
    match entry.key.as_str() {
        key if key == OTHER_KEY => &labels.other,
        key if key == UNATTRIBUTED_KEY => &labels.unattributed,
        key if key == UNKNOWN_KEY => &labels.unknown,
        _ => &entry.name,
    }
}

/// 策略组列；聚合项没有策略组，留空。
fn export_group<'a>(entry: &'a TrafficStatsEntry, labels: &'a ExportLabels) -> &'a str {
    match entry.group.as_deref() {
        None => "",
        Some(group) if group == UNKNOWN_KEY => &labels.unknown,
        Some(group) => group,
    }
}

/// 进程列；聚合项没有进程，留空。
fn export_process<'a>(entry: &'a TrafficStatsEntry, labels: &'a ExportLabels) -> &'a str {
    match entry.process.as_deref() {
        None => "",
        Some(proc) if proc == UNKNOWN_KEY => &labels.unknown,
        Some(proc) => proc,
    }
}

fn format_bucket_time(ts_ms: i64, granularity: StatsGranularity) -> String {
    let pattern = match granularity {
        StatsGranularity::Hour => "%Y-%m-%d %H:00",
        StatsGranularity::Day => "%Y-%m-%d",
    };
    Local
        .timestamp_millis_opt(ts_ms)
        .earliest()
        .map(|dt| dt.format(pattern).to_string())
        .unwrap_or_default()
}

/// 两张表：「汇总」按名称合计，「明细」按时间桶展开。
///
/// 字节数一律写成数值而非格式化文本，Excel 里才能直接求和、排序、做图。
fn build_export_workbook(result: &TrafficStatsResult, labels: &ExportLabels) -> Result<Vec<u8>> {
    let grand_total: u64 = result
        .totals
        .iter()
        .map(|entry| entry.up.saturating_add(entry.down))
        .sum();

    let mut summary = vec![vec![
        Cell::text(labels.name.as_str()),
        Cell::text(labels.group.as_str()),
        Cell::text(labels.process.as_str()),
        Cell::text(labels.up.as_str()),
        Cell::text(labels.down.as_str()),
        Cell::text(labels.total.as_str()),
        Cell::text(labels.share.as_str()),
    ]];
    for entry in &result.totals {
        let total = entry.up.saturating_add(entry.down);
        let share = if grand_total == 0 {
            0.0
        } else {
            (total as f64) / (grand_total as f64) * 100.0
        };
        summary.push(vec![
            Cell::text(export_name(entry, labels)),
            Cell::text(export_group(entry, labels)),
            Cell::text(export_process(entry, labels)),
            Cell::Int(entry.up),
            Cell::Int(entry.down),
            Cell::Int(total),
            Cell::Float((share * 100.0).round() / 100.0),
        ]);
    }

    let mut detail = vec![vec![
        Cell::text(labels.time.as_str()),
        Cell::text(labels.name.as_str()),
        Cell::text(labels.group.as_str()),
        Cell::text(labels.process.as_str()),
        Cell::text(labels.up.as_str()),
        Cell::text(labels.down.as_str()),
        Cell::text(labels.total.as_str()),
    ]];
    for bucket in &result.buckets {
        let time = format_bucket_time(bucket.ts, result.granularity);
        for entry in &bucket.items {
            detail.push(vec![
                Cell::text(time.clone()),
                Cell::text(export_name(entry, labels)),
                Cell::text(export_group(entry, labels)),
                Cell::text(export_process(entry, labels)),
                Cell::Int(entry.up),
                Cell::Int(entry.down),
                Cell::Int(entry.up.saturating_add(entry.down)),
            ]);
        }
    }

    xlsx::build_xlsx(&[
        Sheet {
            name: labels.summary_sheet.clone(),
            rows: summary,
        },
        Sheet {
            name: labels.detail_sheet.clone(),
            rows: detail,
        },
    ])
}

/// 本地日期 + 小时 -> Unix 毫秒。夏令时跳变时取较早的那个瞬间。
fn local_bucket_ts_ms(date: NaiveDate, hour: u32) -> Option<i64> {
    let naive = date.and_hms_opt(hour, 0, 0)?;
    Local
        .from_local_datetime(&naive)
        .earliest()
        .map(|dt| dt.timestamp_millis())
}

fn timestamp_ms_to_local_date(ms: i64) -> Option<NaiveDate> {
    Local.timestamp_millis_opt(ms).earliest().map(|dt| dt.date_naive())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::utils::connections_stream::ConnectionSample;

    const GROUP: &str = "Proxy";
    const HOST: &str = "example.com";
    const PROC: &str = "curl";

    fn sample(id: &str, up: u64, down: u64) -> ConnectionSample {
        ConnectionSample {
            id: id.to_owned(),
            upload: up,
            download: down,
            node: Some("HK-01".to_owned()),
            group: Some(GROUP.to_owned()),
            host: Some(HOST.to_owned()),
            process: Some(PROC.to_owned()),
        }
    }

    fn snapshot(connections: Vec<ConnectionSample>, up_total: u64, down_total: u64) -> ConnectionsSnapshotEvent {
        ConnectionsSnapshotEvent {
            upload_total: up_total,
            download_total: down_total,
            connections,
        }
    }

    fn date() -> NaiveDate {
        NaiveDate::from_ymd_opt(2026, 8, 3).expect("valid date")
    }

    /// 取 host 维度某个 key 的累计值。
    fn host_pair(acc: &Accumulator, hour: u32, key: &str) -> TrafficPair {
        acc.pending
            .get(&date())
            .and_then(|hours| hours.get(&hour))
            .and_then(|buckets| buckets.host.get(key))
            .copied()
            .unwrap_or_default()
    }

    /// 默认样例落在的 host 维度复合键（3-part）。
    fn default_host_key() -> String {
        compose_three_part_key(HOST, GROUP, PROC)
    }

    // -- 复合键 ---------------------------------------------------------

    /// 2-part 复合键能原样拆回名称与策略组，进程为 None。
    #[test]
    fn compose_and_split_round_trip() {
        let key = compose_key("example.com", "国外流量");
        assert_eq!(split_key(&key), ("example.com", Some("国外流量"), None));
    }

    /// 3-part 复合键能拆回名称、策略组、进程。
    #[test]
    fn compose_three_part_and_split() {
        let key = compose_three_part_key("a.com", "Proxy", "curl");
        assert_eq!(split_key(&key), ("a.com", Some("Proxy"), Some("curl")));
    }

    /// 聚合项没有策略组也没有进程，拆出来 group/process 均为 None。
    #[test]
    fn split_key_without_group() {
        assert_eq!(split_key(OTHER_KEY), (OTHER_KEY, None, None));
        assert_eq!(split_key(UNATTRIBUTED_KEY), (UNATTRIBUTED_KEY, None, None));
    }

    /// 同一域名走不同策略组要分成两条，互不合并。
    #[test]
    fn same_host_different_groups_split_into_two_rows() {
        let settings = StatsSettings::default();
        let mut acc = Accumulator::default();

        let mut via_proxy = sample("a", 100, 0);
        via_proxy.group = Some("Proxy".to_owned());
        let mut via_direct = sample("b", 30, 0);
        via_direct.group = Some("DIRECT".to_owned());

        acc.ingest(snapshot(vec![via_proxy, via_direct], 130, 0), settings, date(), 9);

        assert_eq!(
            host_pair(&acc, 9, &compose_three_part_key(HOST, "Proxy", PROC)),
            TrafficPair(100, 0)
        );
        assert_eq!(
            host_pair(&acc, 9, &compose_three_part_key(HOST, "DIRECT", PROC)),
            TrafficPair(30, 0)
        );
    }

    /// 连接没有策略组时（chains 为空）策略组段落记为未知，名称与进程仍保留。
    #[test]
    fn missing_group_keeps_name_with_unknown_group() {
        let settings = StatsSettings::default();
        let mut acc = Accumulator::default();
        let mut conn = sample("a", 100, 0);
        conn.group = None;
        acc.ingest(snapshot(vec![conn], 100, 0), settings, date(), 9);

        assert_eq!(
            host_pair(&acc, 9, &compose_three_part_key(HOST, UNKNOWN_KEY, PROC)),
            TrafficPair(100, 0)
        );
    }

    // -- 差分累加 -------------------------------------------------------

    /// 首次见到的连接把已累计的全量计入。
    #[test]
    fn first_sight_counts_full_value() {
        let mut acc = Accumulator::default();
        acc.ingest(
            snapshot(vec![sample("a", 100, 200)], 100, 200),
            StatsSettings::default(),
            date(),
            9,
        );

        assert_eq!(host_pair(&acc, 9, &default_host_key()), TrafficPair(100, 200));
    }

    /// 连接持续增长时只计差值，不重复计入。
    #[test]
    fn growing_connection_counts_delta_only() {
        let settings = StatsSettings::default();
        let mut acc = Accumulator::default();
        acc.ingest(snapshot(vec![sample("a", 100, 200)], 100, 200), settings, date(), 9);
        acc.ingest(snapshot(vec![sample("a", 150, 260)], 150, 260), settings, date(), 9);

        assert_eq!(host_pair(&acc, 9, &default_host_key()), TrafficPair(150, 260));
    }

    /// 内核重启导致计数回退时不产生负数，也不把回退算成残差。
    #[test]
    fn counter_reset_does_not_go_negative() {
        let settings = StatsSettings::default();
        let mut acc = Accumulator::default();
        acc.ingest(snapshot(vec![sample("a", 500, 500)], 500, 500), settings, date(), 9);
        // 内核重启：同 id 的新连接累计值归零，全局总量也回退。
        acc.ingest(snapshot(vec![sample("a", 10, 10)], 10, 10), settings, date(), 9);

        assert_eq!(host_pair(&acc, 9, &default_host_key()), TrafficPair(500, 500));
        assert_eq!(host_pair(&acc, 9, UNATTRIBUTED_KEY), TrafficPair::default());
    }

    /// 连接消失后不再累加，其基线也被清掉。
    #[test]
    fn closed_connection_stops_accumulating() {
        let settings = StatsSettings::default();
        let mut acc = Accumulator::default();
        acc.ingest(snapshot(vec![sample("a", 100, 100)], 100, 100), settings, date(), 9);
        acc.ingest(snapshot(vec![], 100, 100), settings, date(), 9);

        assert!(acc.seen.is_empty());
        assert_eq!(host_pair(&acc, 9, &default_host_key()), TrafficPair(100, 100));
    }

    /// 跨小时的增量落到各自的桶里。
    #[test]
    fn hour_rollover_splits_buckets() {
        let settings = StatsSettings::default();
        let mut acc = Accumulator::default();
        acc.ingest(snapshot(vec![sample("a", 100, 0)], 100, 0), settings, date(), 9);
        acc.ingest(snapshot(vec![sample("a", 180, 0)], 180, 0), settings, date(), 10);

        assert_eq!(host_pair(&acc, 9, &default_host_key()), TrafficPair(100, 0));
        assert_eq!(host_pair(&acc, 10, &default_host_key()), TrafficPair(80, 0));
    }

    /// 全局增量超出各连接增量之和的部分记入未归因（不带策略组）。
    #[test]
    fn residual_goes_to_unattributed() {
        let settings = StatsSettings::default();
        let mut acc = Accumulator::default();
        acc.ingest(snapshot(vec![sample("a", 100, 0)], 100, 0), settings, date(), 9);
        // 全局涨了 100，但只有 40 能归因到活动连接（60 属于已关闭连接的尾部）。
        acc.ingest(snapshot(vec![sample("a", 140, 0)], 200, 0), settings, date(), 9);

        assert_eq!(host_pair(&acc, 9, &default_host_key()), TrafficPair(140, 0));
        assert_eq!(host_pair(&acc, 9, UNATTRIBUTED_KEY), TrafficPair(60, 0));
    }

    /// 连接自身字段缺失走「未知」，不能和「未归因」混为一谈。
    #[test]
    fn missing_field_goes_to_unknown_not_unattributed() {
        let settings = StatsSettings::default();
        let mut acc = Accumulator::default();
        let mut conn = sample("a", 100, 0);
        conn.host = None;
        acc.ingest(snapshot(vec![conn], 100, 0), settings, date(), 9);

        assert_eq!(host_pair(&acc, 9, UNKNOWN_KEY), TrafficPair(100, 0));
        assert_eq!(host_pair(&acc, 9, UNATTRIBUTED_KEY), TrafficPair::default());
    }

    /// 关掉的维度不落任何数据，另一个维度照常记。
    #[test]
    fn disabled_dimension_is_not_recorded() {
        let settings = StatsSettings {
            record_host: false,
            record_process: true,
            ..StatsSettings::default()
        };
        let mut acc = Accumulator::default();
        acc.ingest(snapshot(vec![sample("a", 100, 0)], 100, 0), settings, date(), 9);

        let buckets = acc
            .pending
            .get(&date())
            .and_then(|hours| hours.get(&9))
            .expect("bucket");
        assert!(buckets.host.is_empty());
        assert_eq!(
            buckets.process.get(&compose_key(PROC, GROUP)).copied(),
            Some(TrafficPair(100, 0))
        );
    }

    // -- 截断与落盘 -----------------------------------------------------

    /// Top-N 截断后总量守恒。
    #[test]
    fn truncate_preserves_total() {
        let mut map: DimensionMap = HashMap::new();
        for index in 0..10_u64 {
            map.insert(format!("host-{index}"), TrafficPair(index, index * 2));
        }
        let before: u64 = map.values().map(|pair| pair.total()).sum();

        truncate_map(&mut map, 3);

        let after: u64 = map.values().map(|pair| pair.total()).sum();
        assert_eq!(before, after);
        // 3 个保留项 + 1 个合并项
        assert_eq!(map.len(), 4);
        assert!(map.contains_key(OTHER_KEY));
        // 合计最大的几项必须留下
        assert!(map.contains_key("host-9"));
    }

    /// 未归因项即便排名靠后也不会被截掉。
    #[test]
    fn truncate_keeps_aggregate_keys() {
        let mut map: DimensionMap = HashMap::new();
        for index in 1..=10_u64 {
            map.insert(format!("host-{index}"), TrafficPair(index * 100, 0));
        }
        map.insert(UNATTRIBUTED_KEY.to_owned(), TrafficPair(1, 0));

        truncate_map(&mut map, 3);

        assert!(map.contains_key(UNATTRIBUTED_KEY));
        assert_eq!(map.get(UNATTRIBUTED_KEY).copied(), Some(TrafficPair(1, 0)));
    }

    /// 条目数未超上限时不产生合并项。
    #[test]
    fn truncate_noop_under_capacity() {
        let mut map: DimensionMap = HashMap::new();
        map.insert("a".to_owned(), TrafficPair(1, 1));
        map.insert("b".to_owned(), TrafficPair(2, 2));

        truncate_map(&mut map, 5);

        assert_eq!(map.len(), 2);
        assert!(!map.contains_key(OTHER_KEY));
    }

    /// 落盘格式必须能原样读回（小时是整数 map key，序列化后会变成字符串）。
    #[test]
    fn day_file_round_trips() {
        let mut day = DayFile::new(date());
        let mut buckets = DimensionBuckets::default();
        buckets
            .host
            .insert(compose_three_part_key(HOST, GROUP, PROC), TrafficPair(1, 2));
        buckets
            .process
            .insert(compose_key(PROC, GROUP), TrafficPair(3, 4));
        buckets
            .group
            .insert(GROUP.to_owned(), TrafficPair(5, 6));
        day.buckets.insert(9, buckets);

        let raw = serde_json::to_vec(&day).expect("serialize");
        let parsed: DayFile = serde_json::from_slice(&raw).expect("deserialize");

        assert_eq!(parsed.v, STATS_FILE_VERSION);
        assert_eq!(parsed.date, "2026-08-03");
        assert_eq!(
            parsed
                .buckets
                .get(&9)
                .and_then(|bucket| bucket.host.get(&compose_three_part_key(HOST, GROUP, PROC)))
                .copied(),
            Some(TrafficPair(1, 2))
        );
        assert_eq!(
            parsed
                .buckets
                .get(&9)
                .and_then(|bucket| bucket.process.get(&compose_key(PROC, GROUP)))
                .copied(),
            Some(TrafficPair(3, 4))
        );
        assert_eq!(
            parsed
                .buckets
                .get(&9)
                .and_then(|bucket| bucket.group.get(GROUP))
                .copied(),
            Some(TrafficPair(5, 6))
        );
    }

    /// 合并两份增量时逐 key 相加。
    #[test]
    fn merge_buckets_adds_per_key() {
        let mut left = DimensionBuckets::default();
        left.host.insert("a".to_owned(), TrafficPair(1, 2));
        let mut right = DimensionBuckets::default();
        right.host.insert("a".to_owned(), TrafficPair(10, 20));
        right.host.insert("b".to_owned(), TrafficPair(5, 5));

        left.merge(&right);

        assert_eq!(left.host.get("a").copied(), Some(TrafficPair(11, 22)));
        assert_eq!(left.host.get("b").copied(), Some(TrafficPair(5, 5)));
    }

    // -- 查询结果 -------------------------------------------------------

    fn query(top_n: Option<usize>) -> TrafficStatsQuery {
        TrafficStatsQuery {
            dimension: StatsDimension::Host,
            start_ms: 0,
            end_ms: 1,
            granularity: StatsGranularity::Hour,
            top_n,
        }
    }

    /// 查询结果要把复合键拆成名称 + 策略组 + 进程三列。
    #[test]
    fn finalize_splits_name_and_group() {
        let mut aggregated: HashMap<i64, DimensionMap> = HashMap::new();
        let mut bucket: DimensionMap = HashMap::new();
        bucket.insert(
            compose_three_part_key("a.com", "Proxy", "curl"),
            TrafficPair(100, 0),
        );
        bucket.insert(UNATTRIBUTED_KEY.to_owned(), TrafficPair(1, 0));
        aggregated.insert(0, bucket);

        let result = finalize_result(aggregated, &query(None));

        let top = result.totals.first().expect("one entry");
        assert_eq!(top.name, "a.com");
        assert_eq!(top.group.as_deref(), Some("Proxy"));
        assert_eq!(top.process.as_deref(), Some("curl"));

        let residual = result
            .totals
            .iter()
            .find(|entry| entry.key == UNATTRIBUTED_KEY)
            .expect("residual entry");
        assert_eq!(residual.name, UNATTRIBUTED_KEY);
        assert!(residual.group.is_none());
        assert!(residual.process.is_none());
    }

    /// Top-N 之外的 key 在每个桶里合并成 OTHER，且合计对得上。
    #[test]
    fn finalize_applies_top_n() {
        let mut aggregated: HashMap<i64, DimensionMap> = HashMap::new();
        let mut bucket: DimensionMap = HashMap::new();
        bucket.insert(
            compose_three_part_key("a.com", "Proxy", "curl"),
            TrafficPair(100, 0),
        );
        bucket.insert(
            compose_three_part_key("b.com", "Proxy", "curl"),
            TrafficPair(50, 0),
        );
        bucket.insert(
            compose_three_part_key("c.com", "Proxy", "curl"),
            TrafficPair(10, 0),
        );
        aggregated.insert(0, bucket);

        let result = finalize_result(aggregated, &query(Some(2)));

        assert!(result.truncated);
        let total: u64 = result
            .totals
            .iter()
            .map(|entry| entry.up + entry.down)
            .sum();
        assert_eq!(total, 160);
        assert_eq!(
            result.totals.first().map(|entry| entry.name.as_str()),
            Some("a.com")
        );
        assert!(result.totals.iter().any(|entry| entry.key == OTHER_KEY));
    }

    /// 项数不超过 Top-N 时不产生 OTHER。
    #[test]
    fn finalize_without_truncation() {
        let mut aggregated: HashMap<i64, DimensionMap> = HashMap::new();
        let mut bucket: DimensionMap = HashMap::new();
        bucket.insert(
            compose_three_part_key("a.com", "Proxy", "curl"),
            TrafficPair(100, 1),
        );
        aggregated.insert(0, bucket);

        let result = finalize_result(aggregated, &query(Some(5)));

        assert!(!result.truncated);
        assert_eq!(result.totals.len(), 1);
        assert_eq!(result.buckets.len(), 1);
    }
}
