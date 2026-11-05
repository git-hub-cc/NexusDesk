use regex::{Regex, RegexBuilder};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    io::Read,
    path::Path,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    path: String,
    title: String,
    relative_path: String,
    snippet: String,
    score: f32,
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SearchOptions {
    extensions: String,
    case_sensitive: bool,
    regex: bool,
    whole_word: bool,
    include_ignored: bool,
}

#[derive(Default)]
pub struct SearchState(pub Mutex<HashMap<String, Arc<AtomicBool>>>);

fn matcher(query: &str, options: &SearchOptions) -> Result<Regex, String> {
    let pattern = if options.regex {
        query.to_owned()
    } else {
        regex::escape(query)
    };
    let pattern = if options.whole_word {
        format!(r"\b(?:{pattern})\b")
    } else {
        pattern
    };
    RegexBuilder::new(&pattern)
        .case_insensitive(!options.case_sensitive)
        .size_limit(4 * 1024 * 1024)
        .build()
        .map_err(|e| format!("无效的搜索表达式：{e}"))
}

fn matching_snippet(content: &str, pattern: &Regex) -> String {
    let Some(found) = pattern.find(content) else {
        return String::new();
    };
    let start = content[..found.start()]
        .char_indices()
        .rev()
        .nth(40)
        .map_or(0, |(i, _)| i);
    let text: String = content[start..].chars().take(200).collect();
    format!(
        "{}{}{}",
        if start > 0 { "…" } else { "" },
        text,
        if start + text.len() < content.len() {
            "…"
        } else {
            ""
        }
    )
}

fn search(
    root: &Path,
    query: &str,
    options: &SearchOptions,
    cancelled: &AtomicBool,
) -> Result<Vec<SearchResult>, String> {
    let pattern = matcher(query, options)?;
    let extensions: Vec<String> = options
        .extensions
        .split(|c: char| c == ',' || c == ';' || c.is_whitespace())
        .map(|s| {
            s.trim_start_matches("*.")
                .trim_start_matches('.')
                .to_lowercase()
        })
        .filter(|s| !s.is_empty())
        .collect();
    let results = Mutex::new(Vec::<SearchResult>::new());
    let error = Mutex::new(None);
    let walker = ignore::WalkBuilder::new(root)
        .hidden(false)
        .require_git(false)
        .git_ignore(!options.include_ignored)
        // Project search follows .gitignore, not personal Git exclusions.
        .git_exclude(false)
        .git_global(false)
        .follow_links(false)
        .filter_entry(|entry| entry.file_name() != ".git")
        .threads(std::thread::available_parallelism().map_or(1, |n| n.get()))
        .build_parallel();
    walker.run(|| {
        // Each worker gets its own regex scratch space.
        let pattern = pattern.clone();
        let results = &results;
        let error = &error;
        let extensions = &extensions;
        Box::new(move |entry| {
            if cancelled.load(Ordering::Relaxed) {
                return ignore::WalkState::Quit;
            }
            let entry = match entry {
                Ok(entry) => entry,
                Err(err) => {
                    error.lock().unwrap().get_or_insert_with(|| err.to_string());
                    return ignore::WalkState::Quit;
                }
            };
            if !entry.file_type().is_some_and(|kind| kind.is_file()) {
                return ignore::WalkState::Continue;
            }
            let path = entry.path();
            let title = entry.file_name().to_string_lossy().to_string();
            if !extensions.is_empty()
                && !extensions
                    .iter()
                    .any(|ext| title.to_lowercase().ends_with(&format!(".{ext}")))
            {
                return ignore::WalkState::Continue;
            }
            let title_match = pattern.is_match(&title);
            // Read in chunks so cancellation can interrupt large files. Skip binary contents.
            let mut bytes = Vec::new();
            if let Ok(mut file) = std::fs::File::open(path) {
                let mut chunk = [0u8; 64 * 1024];
                loop {
                    if cancelled.load(Ordering::Relaxed) {
                        return ignore::WalkState::Quit;
                    }
                    match file.read(&mut chunk) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            if chunk[..n].contains(&0) {
                                bytes.clear();
                                break;
                            }
                            bytes.extend_from_slice(&chunk[..n]);
                        }
                    }
                }
            }
            let content = std::str::from_utf8(&bytes).unwrap_or_default();
            if title_match || pattern.is_match(content) {
                let raw_path = path.to_string_lossy();
                let result = SearchResult {
                    path: raw_path
                        .strip_prefix(r"\\?\")
                        .unwrap_or(&raw_path)
                        .to_string(),
                    title,
                    relative_path: path
                        .strip_prefix(root)
                        .unwrap_or(path)
                        .to_string_lossy()
                        .to_string(),
                    snippet: matching_snippet(content, &pattern),
                    score: if title_match { 20.0 } else { 1.0 },
                };
                // Only merging a match takes the lock; file reads and matching run in parallel.
                let mut results = results.lock().unwrap();
                let index = results.partition_point(|existing| {
                    existing.score > result.score
                        || (existing.score == result.score
                            && existing.relative_path < result.relative_path)
                });
                if index < 50 {
                    results.insert(index, result);
                    results.truncate(50);
                }
            }
            ignore::WalkState::Continue
        })
    });
    if cancelled.load(Ordering::Relaxed) {
        return Ok(Vec::new());
    }
    if let Some(error) = error.into_inner().unwrap() {
        return Err(error);
    }
    Ok(results.into_inner().unwrap())
}

#[tauri::command]
pub fn cancel_search(
    request_id: String,
    state: tauri::State<'_, Arc<SearchState>>,
) -> Result<(), String> {
    if let Some(token) = state.0.lock().map_err(|e| e.to_string())?.get(&request_id) {
        token.store(true, Ordering::Relaxed);
    }
    Ok(())
}

#[tauri::command]
pub async fn search_everywhere(
    root: String,
    paths: Option<Vec<String>>,
    query: String,
    request_id: String,
    options: SearchOptions,
    state: tauri::State<'_, Arc<SearchState>>,
) -> Result<Vec<SearchResult>, String> {
    if query.chars().count() > 256 {
        return Err("搜索词不能超过 256 个字符".into());
    }
    if query.trim().is_empty() {
        return Ok(Vec::new());
    }
    let token = Arc::new(AtomicBool::new(false));
    let state = state.inner().clone();
    state
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .insert(request_id.clone(), token.clone());
    let result = tauri::async_runtime::spawn_blocking(move || {
        let mut results = Vec::new();
        for path in paths.unwrap_or_else(|| vec![root]) {
            if token.load(Ordering::Relaxed) { return Ok(Vec::new()); }
            let path = Path::new(&path).canonicalize().map_err(|e| e.to_string())?;
            let mut matches = search(&path, &query, &options, &token)?;
            if path.is_file() {
                for result in &mut matches { result.relative_path = result.path.clone(); }
            }
            results.extend(matches);
        }
        results.sort_by(|a, b| b.score.total_cmp(&a.score).then_with(|| a.path.cmp(&b.path)));
        let mut seen = std::collections::HashSet::new();
        results.retain(|result| seen.insert(result.path.clone()));
        results.truncate(50);
        Ok(results)
    })
    .await
    .map_err(|e| e.to_string());
    state
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&request_id);
    result?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn matching_options() {
        let mut options = SearchOptions::default();
        assert!(matcher("a.b", &options).unwrap().is_match("A.B"));
        assert!(!matcher("a.b", &options).unwrap().is_match("axb"));
        options.case_sensitive = true;
        assert!(!matcher("abc", &options).unwrap().is_match("ABC"));
        options.regex = true;
        options.whole_word = true;
        let re = matcher("ab+", &options).unwrap();
        assert!(re.is_match("abb"));
        assert!(!re.is_match("cabba"));
        assert!(matcher("[", &options).is_err());
        assert!(
            matching_snippet(
                &format!("{}needle", "中".repeat(100)),
                &matcher("needle", &SearchOptions::default()).unwrap()
            )
            .contains("needle")
        );
    }
    #[test]
    fn parallel_search_keeps_deterministic_top_50() {
        let root = std::env::temp_dir().join(format!(
            "noteide-search-top50-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        // Create in reverse order so discovery order cannot define the top 50.
        for i in (0..120).rev() {
            std::fs::write(root.join(format!("file-{i:03}.md")), "needle").unwrap();
        }
        for i in (0..10).rev() {
            std::fs::write(root.join(format!("needle-{i:03}.md")), "title match").unwrap();
        }
        let expected: Vec<String> = (0..10)
            .map(|i| format!("needle-{i:03}.md"))
            .chain((0..40).map(|i| format!("file-{i:03}.md")))
            .collect();
        for _ in 0..3 {
            let results = search(
                &root,
                "needle",
                &SearchOptions::default(),
                &AtomicBool::new(false),
            )
            .unwrap();
            assert_eq!(
                results
                    .iter()
                    .map(|r| r.relative_path.clone())
                    .collect::<Vec<_>>(),
                expected
            );
            assert!(results[..10].iter().all(|r| r.score == 20.0));
            assert!(results[10..].iter().all(|r| r.score == 1.0));
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn ignores_filters_and_cancels() {
        let root = std::env::temp_dir().join(format!(
            "noteide-search-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(root.join("nested")).unwrap();
        std::fs::create_dir_all(root.join(".git/info")).unwrap();
        for (name, content) in [
            (".gitignore", "ignored.*\n"),
            (".git/info/exclude", "/02code.md\n"),
            ("02code.md", ""),
            ("ignored.md", "needle"),
            ("keep.md", "needle"),
            ("keep.txt", "needle"),
            ("nested/.gitignore", "*\n!keep.md\n"),
            ("nested/drop.md", "needle"),
            ("nested/keep.md", "needle"),
        ] {
            std::fs::write(root.join(name), content).unwrap();
        }
        let options = SearchOptions {
            extensions: "*.md".into(),
            ..Default::default()
        };
        let results = search(&root, "02code.md", &options, &AtomicBool::new(false)).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].title, "02code.md");
        assert!(results[0].snippet.is_empty());
        assert_eq!(
            search(&root, "needle", &options, &AtomicBool::new(false))
                .unwrap()
                .len(),
            2
        );
        std::fs::write(root.join(".gitignore"), "*.md\nnested/\n").unwrap();
        assert!(
            search(&root, "needle", &options, &AtomicBool::new(false))
                .unwrap()
                .is_empty()
        );
        let include_ignored = SearchOptions { extensions: options.extensions.clone(), include_ignored: true, ..Default::default() };
        assert_eq!(
            search(&root, "needle", &include_ignored, &AtomicBool::new(false))
                .unwrap()
                .len(),
            4
        );
        assert!(
            search(&root, "needle", &options, &AtomicBool::new(true))
                .unwrap()
                .is_empty()
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}
