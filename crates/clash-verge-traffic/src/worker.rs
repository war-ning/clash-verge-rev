use std::path::PathBuf;

use anyhow::{Result, anyhow};
use tokio::sync::{mpsc, oneshot};

use crate::{Observation, Query, Sampler, Snapshot, Store};

enum Command {
    Observe(Option<Observation>, i64),
    Read(Query, i64, oneshot::Sender<Result<Snapshot>>),
    Clear(i64, oneshot::Sender<Result<()>>),
    Flush(i64, oneshot::Sender<Result<()>>),
    Export(Query, PathBuf, i64, oneshot::Sender<Result<()>>),
    Backup(PathBuf, i64, oneshot::Sender<Result<()>>),
}

#[derive(Clone, Debug)]
pub struct Worker {
    sender: mpsc::Sender<Command>,
}

impl Worker {
    pub fn open(path: PathBuf, timezone: String) -> Result<Self> {
        let (sender, mut receiver) = mpsc::channel(4);
        let (ready_tx, ready_rx) = std::sync::mpsc::sync_channel(1);
        std::thread::Builder::new()
            .name("traffic-statistics".into())
            .spawn(move || {
                let mut store = match Store::open(&path, &timezone) {
                    Ok(store) => store,
                    Err(error) => {
                        let _ = ready_tx.send(Err(error));
                        return;
                    }
                };
                if ready_tx.send(Ok(())).is_err() {
                    return;
                }
                let mut sampler = Sampler::default();
                let mut last_flush = chrono::Utc::now().timestamp_millis();
                let mut failed = false;
                while let Some(command) = receiver.blocking_recv() {
                    match command {
                        Command::Observe(observation, now) => {
                            if now - last_flush >= 60_000 || failed {
                                match store.flush(now) {
                                    Ok(()) => {
                                        last_flush = now;
                                        if failed {
                                            sampler = Sampler::default();
                                        }
                                        failed = false;
                                        store.set_warning(None);
                                    }
                                    Err(error) => {
                                        failed = true;
                                        store.set_warning(Some(error.to_string()));
                                        store.set_collecting(false);
                                        continue;
                                    }
                                }
                            }
                            if let Some(observation) = observation {
                                let (deltas, coverage) = sampler.sample(observation);
                                match store.append(deltas, coverage, now) {
                                    Ok(()) => {
                                        store.set_collecting(true);
                                    }
                                    Err(error) => {
                                        store.set_warning(Some(error.to_string()));
                                        store.set_collecting(false);
                                        failed = true;
                                        sampler = Sampler::default();
                                    }
                                }
                            } else {
                                sampler.gap();
                                store.set_collecting(false);
                            }
                        }
                        Command::Read(query, now, reply) => {
                            let _ = reply.send(store.read(&query, now));
                        }
                        Command::Clear(now, reply) => {
                            let result = store.clear(now);
                            if result.is_ok() {
                                sampler = Sampler::default();
                                failed = false;
                            }
                            let _ = reply.send(result);
                        }
                        Command::Flush(now, reply) => {
                            let _ = reply.send(store.flush(now));
                        }
                        Command::Export(query, path, now, reply) => {
                            let _ = reply.send(store.export(&query, &path, now));
                        }
                        Command::Backup(path, now, reply) => {
                            let _ = reply.send(store.backup(&path, now));
                        }
                    }
                }
                let _ = store.flush(chrono::Utc::now().timestamp_millis());
            })?;
        ready_rx
            .recv()
            .map_err(|_| anyhow!("Statistics worker stopped during startup"))??;
        Ok(Self { sender })
    }

    pub async fn observe(&self, value: Option<Observation>, now: i64) -> Result<()> {
        self.sender
            .send(Command::Observe(value, now))
            .await
            .map_err(|_| anyhow!("Statistics worker stopped"))
    }

    pub async fn read(&self, query: Query, now: i64) -> Result<Snapshot> {
        let (tx, rx) = oneshot::channel();
        self.sender.send(Command::Read(query, now, tx)).await?;
        rx.await?
    }

    pub async fn clear(&self, now: i64) -> Result<()> {
        let (tx, rx) = oneshot::channel();
        self.sender.send(Command::Clear(now, tx)).await?;
        rx.await?
    }

    pub async fn flush(&self, now: i64) -> Result<()> {
        let (tx, rx) = oneshot::channel();
        self.sender.send(Command::Flush(now, tx)).await?;
        rx.await?
    }

    pub async fn export(&self, query: Query, path: PathBuf, now: i64) -> Result<()> {
        let (tx, rx) = oneshot::channel();
        self.sender.send(Command::Export(query, path, now, tx)).await?;
        rx.await?
    }

    pub async fn backup(&self, path: PathBuf, now: i64) -> Result<()> {
        let (tx, rx) = oneshot::channel();
        self.sender.send(Command::Backup(path, now, tx)).await?;
        rx.await?
    }
}
