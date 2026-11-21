use std::collections::HashMap;
use std::path::Path;
use std::sync::{Condvar, Mutex};

#[derive(Default)]
struct Operations {
    next_id: u64,
    writes: HashMap<u64, Vec<String>>,
    scans: HashMap<u64, (Vec<String>, bool)>,
}

static OPERATIONS: Mutex<Option<Operations>> = Mutex::new(None);
static CHANGED: Condvar = Condvar::new();

fn overlaps(left: &str, right: &str) -> bool {
    let contains = |parent: &str, child: &str| {
        child == parent
            || child
                .strip_prefix(parent)
                .is_some_and(|suffix| suffix.starts_with('/'))
    };
    contains(left, right) || contains(right, left)
}

fn intersects(left: &[String], right: &[String]) -> bool {
    left.iter().any(|a| right.iter().any(|b| overlaps(a, b)))
}

fn keys<'a>(paths: impl IntoIterator<Item = &'a Path>) -> Vec<String> {
    paths
        .into_iter()
        .map(|path| super::fs::index_path_key(&path.to_string_lossy()))
        .collect()
}

pub fn canonical_key_path(path: &Path) -> std::path::PathBuf {
    if let Ok(path) = path.canonicalize() {
        return path;
    }
    match (path.parent(), path.file_name()) {
        (Some(parent), Some(name)) => canonical_key_path(parent).join(name),
        _ => path.to_path_buf(),
    }
}

pub struct Write(u64);

impl Write {
    pub fn begin<'a>(paths: impl IntoIterator<Item = &'a Path>) -> Result<Self, String> {
        let paths = keys(paths);
        let mut guard = OPERATIONS.lock().unwrap();
        let operations = guard.get_or_insert_with(Operations::default);
        if operations
            .writes
            .values()
            .any(|active| intersects(active, &paths))
        {
            return Err("相关路径正在进行文件操作，请稍后重试".into());
        }
        for (scope, dirty) in operations.scans.values_mut() {
            *dirty |= intersects(scope, &paths);
        }
        operations.next_id += 1;
        let id = operations.next_id;
        operations.writes.insert(id, paths);
        Ok(Self(id))
    }
}

impl Drop for Write {
    fn drop(&mut self) {
        OPERATIONS
            .lock()
            .unwrap()
            .as_mut()
            .unwrap()
            .writes
            .remove(&self.0);
        CHANGED.notify_all();
    }
}

pub struct Scan(u64);

impl Scan {
    pub fn begin<'a>(paths: impl IntoIterator<Item = &'a Path>) -> Self {
        let paths = keys(paths);
        let mut guard = OPERATIONS.lock().unwrap();
        loop {
            let operations = guard.get_or_insert_with(Operations::default);
            if !operations
                .writes
                .values()
                .any(|active| intersects(active, &paths))
            {
                operations.next_id += 1;
                let id = operations.next_id;
                operations.scans.insert(id, (paths, false));
                return Self(id);
            }
            guard = CHANGED.wait(guard).unwrap();
        }
    }

    pub fn apply<T>(&self, operation: impl FnOnce() -> T) -> Option<T> {
        let guard = OPERATIONS.lock().unwrap();
        let (_, dirty) = guard.as_ref().unwrap().scans.get(&self.0).unwrap();
        if *dirty { None } else { Some(operation()) }
    }
}

impl Drop for Scan {
    fn drop(&mut self) {
        OPERATIONS
            .lock()
            .unwrap()
            .as_mut()
            .unwrap()
            .scans
            .remove(&self.0);
    }
}
