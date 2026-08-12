use std::sync::{Arc, Mutex};
use super::snapshot::load_snapshot;

pub struct WarmIsolate {
    pub isolate: v8::OwnedIsolate,
}

pub struct WarmPool {
    isolates: Arc<Mutex<Vec<WarmIsolate>>>,
}

impl WarmPool {
    pub fn new(snapshot_path: &str, size: usize) -> Self {
        let mut vec = Vec::new();
        for _ in 0..size {
            let iso = load_snapshot(snapshot_path);
            vec.push(WarmIsolate { isolate: iso });
        }
        WarmPool {
            isolates: Arc::new(Mutex::new(vec)),
        }
    }

    pub fn get(&self) -> WarmIsolate {
        let mut guard = self.isolates.lock().unwrap();
        guard.pop().expect("No warm isolates available")
    }

    pub fn put(&self, iso: WarmIsolate) {
        let mut guard = self.isolates.lock().unwrap();
        guard.push(iso);
    }
}
