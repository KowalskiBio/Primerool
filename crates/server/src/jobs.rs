//! In-memory background jobs for routes whose NCBI round-trip outlasts a
//! reverse proxy's timeout (nginx's ~60s default 504s a held-open
//! request): the POST starts the work and returns a job id at once, and
//! the client polls a status route instead. Jobs die with the process (a
//! deploy mid-run surfaces as a 404 to the poller), and finished jobs are
//! pruned when an hour old or past the size cap, whichever hits first.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

const JOB_TTL: Duration = Duration::from_secs(3600);
const JOB_CAP: usize = 128;

/// A job's stored outcome — `None` until the spawned task finishes; the
/// `String` error is the whole job's failure message.
struct JobCell<T> {
    outcome: Option<Result<T, String>>,
    created: Instant,
}

pub struct JobStore<T> {
    jobs: Mutex<HashMap<String, JobCell<T>>>,
}

impl<T> Default for JobStore<T> {
    fn default() -> Self {
        Self { jobs: Mutex::new(HashMap::new()) }
    }
}

impl<T: Clone> JobStore<T> {
    fn new_job_id() -> String {
        static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos();
        format!("{nanos:x}-{n:x}-{}", std::process::id())
    }

    /// Registers a new running job and returns its id.
    pub fn insert(&self) -> String {
        let id = Self::new_job_id();
        let mut jobs = self.jobs.lock().expect("job store poisoned");
        Self::prune(&mut jobs, Instant::now());
        jobs.insert(id.clone(), JobCell { outcome: None, created: Instant::now() });
        id
    }

    pub fn finish(&self, id: &str, outcome: Result<T, String>) {
        if let Some(cell) = self.jobs.lock().expect("job store poisoned").get_mut(id) {
            cell.outcome = Some(outcome);
        }
    }

    /// `None` for an unknown (or expired) id, `Some(None)` while running,
    /// else the outcome.
    pub fn status(&self, id: &str) -> Option<Option<Result<T, String>>> {
        self.jobs.lock().expect("job store poisoned").get(id).map(|cell| cell.outcome.clone())
    }

    /// Drops finished jobs older than `JOB_TTL`, then oldest-first once
    /// the store exceeds `JOB_CAP` — running jobs are never dropped.
    fn prune(jobs: &mut HashMap<String, JobCell<T>>, now: Instant) {
        jobs.retain(|_, cell| cell.outcome.is_none() || now.duration_since(cell.created) < JOB_TTL);
        if jobs.len() > JOB_CAP {
            let mut finished: Vec<(Instant, String)> = jobs.iter().filter(|(_, c)| c.outcome.is_some()).map(|(id, c)| (c.created, id.clone())).collect();
            finished.sort();
            for (_, id) in finished.into_iter().take(jobs.len() - JOB_CAP) {
                jobs.remove(&id);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn job_store_lifecycle_and_prune() {
        let store = JobStore::<u32>::default();

        let a = store.insert();
        let b = store.insert();
        assert_ne!(a, b);
        // Both known and still running before any outcome lands.
        assert_eq!(store.status(&a), Some(None));
        assert_eq!(store.status(&b), Some(None));
        assert_eq!(store.status("nope"), None);

        store.finish(&a, Ok(7));
        assert_eq!(store.status(&a), Some(Some(Ok(7))));

        // A finished job past the TTL is pruned on the next insert; a
        // running job never is, however old.
        let mut jobs = store.jobs.lock().unwrap();
        let old = Instant::now() - Duration::from_secs(JOB_TTL.as_secs() + 1);
        for id in [&a, &b] {
            if let Some(cell) = jobs.get_mut(id) {
                cell.created = old;
            }
        }
        JobStore::prune(&mut jobs, Instant::now());
        assert!(!jobs.contains_key(&a), "finished job past TTL must be pruned");
        assert!(jobs.contains_key(&b), "running job must survive pruning");
    }
}
