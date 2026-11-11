use crate::core::fs::FileNode;
use rusqlite::{Connection, Result, params};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

#[cfg(test)]
mod tests {
    #[test]
    fn wal_readers_can_read_during_an_uncommitted_write() {
        let root = std::env::temp_dir().join(format!(
            "nexusdesk-wal-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let conn = super::init_db(Some(root.to_str().unwrap())).unwrap();
        let mode: String = conn
            .query_row("PRAGMA journal_mode", [], |r| r.get(0))
            .unwrap();
        let synchronous: i64 = conn
            .query_row("PRAGMA synchronous", [], |r| r.get(0))
            .unwrap();
        assert_eq!(mode, "wal");
        assert_eq!(synchronous, 1);
        let reader = rusqlite::Connection::open(root.join(".nexus/index.db")).unwrap();
        reader.busy_timeout(std::time::Duration::ZERO).unwrap();
        let tx = conn.unchecked_transaction().unwrap();
        super::upsert_file_meta(&tx, "note.md", Some("note"), None, 1).unwrap();
        let count: i64 = reader
            .query_row("SELECT COUNT(*) FROM file_meta", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0);
        tx.commit().unwrap();
        let count: i64 = reader
            .query_row("SELECT COUNT(*) FROM file_meta", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1);
        drop(reader);
        drop(conn);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn collected_index_can_be_applied_without_source_files() {
        let root = std::env::temp_dir().join(format!(
            "nexusdesk-snapshot-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(root.join("nested")).unwrap();
        let path = root.join("nested/note.md");
        std::fs::write(&path, "---\ntype: tool\n---\n[[../target.md#Title]]").unwrap();
        let files = crate::core::fs::collect_workspace_metadata(&root).unwrap();
        std::fs::remove_dir_all(&root).unwrap();
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE file_meta(path TEXT UNIQUE, logical_type TEXT, tags TEXT, last_modified INTEGER);
            CREATE TABLE links(source_path TEXT, target_path TEXT, anchor TEXT);").unwrap();
        let tx = conn.unchecked_transaction().unwrap();
        crate::core::fs::apply_workspace_metadata(&files, &tx).unwrap();
        tx.commit().unwrap();
        let category: String = conn
            .query_row("SELECT logical_type FROM file_meta", [], |r| r.get(0))
            .unwrap();
        assert_eq!(category, "tool");
        assert_eq!(
            super::get_links(&conn, path.to_str().unwrap(), false).unwrap(),
            vec![(
                root.join("target.md").to_string_lossy().replace('\\', "/"),
                "Title".into()
            )]
        );
    }

    #[test]
    fn relations_refresh_after_replacing_links_and_normalize_targets() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE links (source_path TEXT, target_path TEXT, anchor TEXT);")
            .unwrap();
        let source = std::path::Path::new("/notes/sub/source.md");
        crate::core::fs::index_links(
            source,
            "[[../target.md#Title]] [[../target.md#Title]] [[#Local]] [[../other.md|Alias]]",
            &conn,
        )
        .unwrap();
        let outgoing = super::get_links(&conn, "/notes/sub/source.md", false).unwrap();
        assert_eq!(outgoing.len(), 3);
        assert!(outgoing.contains(&("/notes/target.md".into(), "Title".into())));
        assert!(outgoing.contains(&("/notes/sub/source.md".into(), "Local".into())));
        assert_eq!(
            super::get_links(&conn, "/notes/target.md", true).unwrap(),
            vec![("/notes/sub/source.md".into(), "Title".into())]
        );
        crate::core::fs::index_links(source, "[[../other.md#New]]", &conn).unwrap();
        assert!(
            super::get_links(&conn, "/notes/target.md", true)
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            super::get_links(&conn, "/notes/sub/source.md", false).unwrap(),
            vec![("/notes/other.md".into(), "New".into())]
        );
        crate::core::fs::index_links(source, "No links", &conn).unwrap();
        assert!(
            super::get_links(&conn, "/notes/sub/source.md", false)
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn relations_match_windows_path_separators() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE links (source_path TEXT, target_path TEXT, anchor TEXT);")
            .unwrap();
        super::replace_links(
            &conn,
            r"C:\notes\source.md",
            &[(r"C:\notes\target.md".into(), "Title".into())],
        )
        .unwrap();
        assert_eq!(
            super::get_links(&conn, "C:/notes/target.md", true).unwrap(),
            vec![("C:/notes/source.md".into(), "Title".into())]
        );
        assert_eq!(
            super::get_links(&conn, "C:/notes/source.md", false).unwrap(),
            vec![("C:/notes/target.md".into(), "Title".into())]
        );
    }

    #[test]
    fn index_path_conflict_returns_error_without_panicking() {
        let root = std::env::temp_dir().join(format!(
            "nexusdesk-index-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&root).unwrap();
        std::fs::write(
            root.join("missing-type.md"),
            "---\ntitle: Example\n---\nText",
        )
        .unwrap();
        std::fs::write(root.join("scalar.md"), "---\nhello\n---\nText").unwrap();
        std::fs::write(root.join("valid.md"), "---\ntype: tool\n---\nText").unwrap();
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE file_meta (path TEXT UNIQUE, logical_type TEXT, tags TEXT, last_modified INTEGER);").unwrap();
        crate::core::fs::sync_workspace_to_db(&root, &conn).unwrap();
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM file_meta", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 3);
        let category: String = conn
            .query_row(
                "SELECT logical_type FROM file_meta WHERE logical_type IS NOT NULL",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(category, "tool");
        std::fs::write(root.join(".nexus"), "existing file").unwrap();
        let result = super::init_db(Some(root.to_str().unwrap()));
        assert!(result.is_err());
        drop(result);
        std::fs::remove_dir_all(&root).unwrap();
    }
}

pub fn init_db(
    custom_path: Option<&str>,
) -> std::result::Result<Connection, Box<dyn std::error::Error>> {
    let mut db_path = match custom_path {
        Some(p) => PathBuf::from(p),
        None => dirs::home_dir().ok_or("Cannot find home directory")?,
    };
    db_path.push(".nexus");

    if !db_path.exists() {
        fs::create_dir_all(&db_path)?;
    }

    db_path.push("index.db");
    let conn = Connection::open(db_path)?;
    conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;")?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS file_meta (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            path TEXT UNIQUE NOT NULL,
            logical_type TEXT,
            tags TEXT,
            last_modified INTEGER
        )",
        [],
    )?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS links (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            source_path TEXT NOT NULL,
            target_path TEXT NOT NULL,
            anchor TEXT
        )",
        [],
    )?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS logical_folders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE NOT NULL
        )",
        [],
    )?;

    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS logical_refs (path TEXT PRIMARY KEY, category TEXT NOT NULL);",
    )?;
    conn.execute_batch("CREATE TABLE IF NOT EXISTS logical_copies (path TEXT NOT NULL, category TEXT NOT NULL, PRIMARY KEY(path, category));")?;
    conn.execute_batch("CREATE TABLE IF NOT EXISTS logical_hidden (path TEXT NOT NULL, category TEXT NOT NULL, PRIMARY KEY(path, category));")?;
    let has_accessed = conn
        .prepare("PRAGMA table_info(file_meta)")?
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<Result<Vec<_>>>()?
        .iter()
        .any(|name| name == "last_accessed");
    if !has_accessed {
        conn.execute_batch("ALTER TABLE file_meta ADD COLUMN last_accessed INTEGER;")?;
    }
    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS file_meta_accessed ON file_meta(last_accessed DESC);",
    )?;
    crate::core::local_history::init(&conn)?;
    Ok(conn)
}

pub fn upsert_file_meta(
    conn: &Connection,
    path: &str,
    logical_type: Option<&str>,
    tags: Option<&str>,
    last_modified: i64,
) -> Result<()> {
    conn.execute(
        "INSERT INTO file_meta (path, logical_type, tags, last_modified)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(path) DO UPDATE SET
         logical_type = excluded.logical_type,
         tags = excluded.tags,
         last_modified = excluded.last_modified",
        params![path, logical_type, tags, last_modified],
    )?;
    Ok(())
}

pub fn replace_links(conn: &Connection, source: &str, targets: &[(String, String)]) -> Result<()> {
    conn.execute("DELETE FROM links WHERE source_path=?1", [source])?;
    for (target, anchor) in targets {
        conn.execute(
            "INSERT INTO links(source_path,target_path,anchor) VALUES (?1,?2,?3)",
            params![source, target, anchor],
        )?;
    }
    Ok(())
}

pub fn get_links(conn: &Connection, path: &str, reverse: bool) -> Result<Vec<(String, String)>> {
    let (result, filter) = if reverse {
        ("source_path", "target_path")
    } else {
        ("target_path", "source_path")
    };
    let collation = if cfg!(windows) { " COLLATE NOCASE" } else { "" };
    let sql = format!(
        "SELECT DISTINCT REPLACE({result}, '\\', '/'), anchor FROM links WHERE REPLACE({filter}, '\\', '/')=?1{collation} ORDER BY 1, 2"
    );
    let mut stmt = conn.prepare(&sql)?;
    stmt.query_map([path.replace('\\', "/")], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect()
}

pub fn insert_logical_folder(conn: &Connection, name: &str) -> Result<()> {
    conn.execute(
        "INSERT OR IGNORE INTO logical_folders (name) VALUES (?1)",
        params![name],
    )?;
    Ok(())
}

pub fn get_logical_tree(conn: &Connection) -> Result<Vec<FileNode>> {
    let mut type_map: HashMap<String, Vec<FileNode>> = HashMap::new();

    let mut folder_stmt = conn.prepare("SELECT name FROM logical_folders")?;
    let folder_iter = folder_stmt.query_map([], |row| row.get::<_, String>(0))?;
    for folder in folder_iter {
        if let Ok(name) = folder {
            type_map.entry(name).or_insert_with(Vec::new);
        }
    }

    let mut stmt = conn.prepare("SELECT path, logical_type FROM file_meta WHERE logical_type IS NOT NULL AND logical_type != '' AND path NOT IN (SELECT path FROM logical_refs)")?;
    let file_iter = stmt.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;

    for file in file_iter {
        if let Ok((path, logical_type)) = file {
            let name = PathBuf::from(&path)
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();
            let node = FileNode {
                missing: !std::path::Path::new(&path).exists(),
                id: path,
                name,
                children: None,
                is_leaf: true,
            };
            type_map
                .entry(logical_type)
                .or_insert_with(Vec::new)
                .push(node);
        }
    }

    let mut refs = conn.prepare("SELECT path, category FROM logical_refs WHERE category != '' UNION SELECT path, category FROM logical_copies ORDER BY path")?;
    for reference in refs.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })? {
        let (path, category) = reference?;
        // Explicit references take precedence over legacy frontmatter categories.
        let source = PathBuf::from(&path);
        let is_dir = source.is_dir();
        type_map.entry(category).or_default().push(FileNode {
            missing: !source.exists(),
            id: path,
            name: source
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string(),
            children: if is_dir {
                Some(crate::core::fs::read_dir_shallow(&source).unwrap_or_default())
            } else {
                None
            },
            is_leaf: !is_dir,
        });
    }
    let mut root_nodes = Vec::new();
    for (logical_type, mut children) in type_map {
        children.sort_by(|a, b| {
            if a.is_leaf == b.is_leaf {
                a.name.cmp(&b.name)
            } else if a.is_leaf {
                std::cmp::Ordering::Greater
            } else {
                std::cmp::Ordering::Less
            }
        });

        root_nodes.push(FileNode {
            id: format!("logical_{}", logical_type),
            name: logical_type,
            children: Some(children),
            is_leaf: false,
            missing: false,
        });
    }

    root_nodes.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(root_nodes)
}

#[cfg(test)]
mod reference_tests {
    #[test]
    fn missing_references_remain_visible_and_recover_when_restored() {
        let root = std::env::temp_dir().join(format!(
            "nexusdesk-missing-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("linked.tree");
        let conn = super::init_db(Some(root.to_str().unwrap())).unwrap();
        conn.execute(
            "INSERT INTO logical_refs(path, category) VALUES (?1, 'notes')",
            [path.to_str().unwrap()],
        )
        .unwrap();
        let missing = super::get_logical_tree(&conn).unwrap();
        assert!(missing[0].children.as_ref().unwrap()[0].missing);
        std::fs::write(&path, "node").unwrap();
        let restored = super::get_logical_tree(&conn).unwrap();
        assert!(!restored[0].children.as_ref().unwrap()[0].missing);
        std::fs::rename(&path, root.join("renamed.tree")).unwrap();
        let renamed = super::get_logical_tree(&conn).unwrap();
        assert!(renamed[0].children.as_ref().unwrap()[0].missing);
        drop(conn);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn references_include_directories_and_leave_source_unchanged() {
        let root = std::env::temp_dir().join(format!(
            "nexusdesk-reference-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(root.join("folder")).unwrap();
        let file = root.join("folder/note.txt");
        std::fs::write(&file, "same file").unwrap();
        let conn = super::init_db(Some(root.to_str().unwrap())).unwrap();
        conn.execute(
            "INSERT INTO logical_refs(path, category) VALUES (?1, 'notes')",
            [root.join("folder").to_str().unwrap()],
        )
        .unwrap();
        let tree = super::get_logical_tree(&conn).unwrap();
        let directory = &tree[0].children.as_ref().unwrap()[0];
        assert!(!directory.is_leaf);
        let entries = directory.children.as_ref().unwrap();
        assert_eq!(std::path::PathBuf::from(&entries[0].id), file);
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "same file");
        drop(conn);
        std::fs::remove_dir_all(root).unwrap();
    }
}

pub fn touch_file(conn: &Connection, path: &str) -> Result<()> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;
    conn.execute("INSERT INTO file_meta(path,last_accessed) VALUES (?1,MAX(?2,COALESCE((SELECT MAX(last_accessed)+1 FROM file_meta),?2))) ON CONFLICT(path) DO UPDATE SET last_accessed=MAX(?2,COALESCE((SELECT MAX(last_accessed)+1 FROM file_meta),?2))", params![path,now])?;
    Ok(())
}

#[cfg(test)]
mod recent_tests {
    #[test]
    fn migrates_legacy_database_and_indexing_preserves_access() {
        let root = std::env::temp_dir().join(format!(
            "nexusdesk-recent-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(root.join(".nexus")).unwrap();
        let legacy = rusqlite::Connection::open(root.join(".nexus/index.db")).unwrap();
        legacy.execute_batch("CREATE TABLE file_meta(path TEXT UNIQUE, logical_type TEXT, tags TEXT, last_modified INTEGER);").unwrap();
        drop(legacy);
        let conn = super::init_db(Some(root.to_str().unwrap())).unwrap();
        super::touch_file(&conn, "one.md").unwrap();
        super::touch_file(&conn, "two.md").unwrap();
        super::touch_file(&conn, "one.md").unwrap();
        super::upsert_file_meta(&conn, "one.md", Some("note"), None, 100).unwrap();
        let first: String = conn
            .query_row(
                "SELECT path FROM file_meta ORDER BY last_accessed DESC LIMIT 1",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(first, "one.md");
        drop(conn);
        std::fs::remove_dir_all(root).unwrap();
    }
}
