use std::collections::HashMap;

use crate::{Delta, Observation};

#[derive(Default)]
pub struct Sampler {
    epoch: Option<u64>,
    at: Option<i64>,
    counters: HashMap<(String, i64), (u64, u64)>,
    failed: bool,
}

impl Sampler {
    pub const fn gap(&mut self) {
        self.failed = true;
    }

    pub fn sample(&mut self, observation: Observation) -> (Vec<Delta>, Option<(i64, i64, bool)>) {
        let previous_at = self.at.replace(observation.at);
        let same_epoch = self.epoch.replace(observation.epoch) == Some(observation.epoch);
        let interrupted = std::mem::take(&mut self.failed);
        let previous = std::mem::take(&mut self.counters);
        let mut deltas = Vec::new();
        let mut reset = false;
        for connection in observation.connections {
            let key = (connection.id, connection.start);
            let baseline = same_epoch.then(|| previous.get(&key)).flatten().copied().or_else(|| {
                previous_at
                    .filter(|start| {
                        same_epoch && !interrupted && connection.start > *start && connection.start <= observation.at
                    })
                    .map(|_| (0, 0))
            });
            self.counters.insert(key, (connection.upload, connection.download));
            let Some((up, down)) = baseline else {
                continue;
            };
            if connection.upload < up || connection.download < down {
                reset = true;
                continue;
            }
            if connection.upload != up || connection.download != down {
                deltas.push(Delta {
                    at: observation.at,
                    identity: connection.identity,
                    upload: connection.upload - up,
                    download: connection.download - down,
                });
            }
        }
        let coverage = previous_at.filter(|start| observation.at > *start).map(|start| {
            (
                start,
                observation.at,
                same_epoch && !interrupted && !reset && observation.at - start <= 5_000,
            )
        });
        (deltas, coverage)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Connection, Identity};

    fn observation(at: i64, epoch: u64, down: u64) -> Observation {
        Observation {
            at,
            epoch,
            connections: vec![Connection {
                id: "one".into(),
                start: 0,
                upload: 0,
                download: down,
                identity: Identity {
                    target: "example.com".into(),
                    route: "proxy".into(),
                    ..Identity::default()
                },
            }],
        }
    }

    #[test]
    fn transient_failure_preserves_large_increments_but_restart_does_not_recount() {
        let mut sampler = Sampler::default();
        assert!(sampler.sample(observation(1_000, 1, 100)).0.is_empty());
        sampler.gap();
        let (rows, coverage) = sampler.sample(observation(5_000, 1, 300_000_100));
        assert_eq!(rows[0].download, 300_000_000);
        assert_eq!(coverage, Some((1_000, 5_000, false)));
        assert!(sampler.sample(observation(6_000, 2, 500)).0.is_empty());
        assert_eq!(sampler.sample(observation(7_000, 2, 700)).0[0].download, 200);
        assert!(sampler.sample(observation(8_000, 2, 10)).0.is_empty());
    }
}
