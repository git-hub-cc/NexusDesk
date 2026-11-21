use crate::state::AppState;
use rusqlite::{Connection, params};
use tauri::State;

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct GraphSyncCategory {
    pub name: String,
    pub color: Option<String>,
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct GraphSyncFile {
    pub category: String,
    pub path: String,
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct GraphSyncData {
    pub workspace: String,
    pub categories: Vec<GraphSyncCategory>,
    pub files: Vec<GraphSyncFile>,
}

#[derive(serde::Serialize)]
pub struct GraphCategory {
    name: String,
    files: Vec<String>,
    #[serde(rename = "missingFiles")]
    missing_files: Vec<String>,
    color: Option<String>,
}

#[tauri::command]
pub fn set_graph_category_color(category: String, color: Option<String>) -> Result<(), String> {
    if let Some(color) = &color {
        if color.len() != 7
            || !color.starts_with('#')
            || !color[1..].bytes().all(|c| c.is_ascii_hexdigit())
        {
            return Err("Invalid color".into());
        }
    }
    crate::core::db::with_global_db(|conn| set_category_color(conn, &category, color.as_deref()))
}

fn set_category_color(
    conn: &Connection,
    category: &str,
    color: Option<&str>,
) -> Result<(), String> {
    if let Some(color) = color {
        conn.execute(
            "INSERT INTO colors(category,color) VALUES (?1,?2) ON CONFLICT(category) DO UPDATE SET color=excluded.color",
            params![category, color],
        )
        .map_err(|e| e.to_string())?;
    } else {
        conn.execute("DELETE FROM colors WHERE category=?1", [category])
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch("CREATE TABLE IF NOT EXISTS graph_categories (name TEXT PRIMARY KEY COLLATE NOCASE);
        CREATE TABLE IF NOT EXISTS graph_files (category TEXT NOT NULL COLLATE NOCASE, path TEXT NOT NULL, PRIMARY KEY(category, path));")
        .map_err(|e| e.to_string())
}

fn validate_graph_sync_data(root: &std::path::Path, data: &GraphSyncData) -> Result<(), String> {
    if data.workspace != crate::commands::fs_cmds::logical_workspace_id(root) {
        return Err("云端图谱分区属于其他工作区".into());
    }
    let mut names = std::collections::HashSet::new();
    for category in &data.categories {
        if category.name.trim().is_empty() || !names.insert(category.name.to_lowercase()) {
            return Err("云端图谱分类包含无效或重复名称".into());
        }
        if let Some(color) = &category.color {
            if color.len() != 7
                || !color.starts_with('#')
                || !color[1..].bytes().all(|c| c.is_ascii_hexdigit())
            {
                return Err("云端图谱分类颜色无效".into());
            }
        }
    }
    for file in &data.files {
        let relative = std::path::Path::new(&file.path);
        if relative.is_absolute()
            || relative.components().any(|part| {
                matches!(
                    part,
                    std::path::Component::ParentDir
                        | std::path::Component::RootDir
                        | std::path::Component::Prefix(_)
                )
            })
            || !relative
                .extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case("tree"))
            || !names.contains(&file.category.to_lowercase())
        {
            return Err("云端图谱分区包含无效文件关联".into());
        }
    }
    Ok(())
}

#[tauri::command]
pub fn get_graph_sync_data(
    root: String,
    state: State<'_, AppState>,
) -> Result<GraphSyncData, String> {
    let root = std::fs::canonicalize(root).map_err(|error| error.to_string())?;
    let guard = state.db_conn.lock().map_err(|error| error.to_string())?;
    let conn = guard.as_ref().ok_or("请先打开项目")?;
    schema(conn)?;
    let categories = read_categories(conn)?;
    let mut files = Vec::new();
    let mut statement = conn
        .prepare("SELECT category, path FROM graph_files ORDER BY category, path")
        .map_err(|e| e.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| e.to_string())?;
    for row in rows {
        let (category, path) = row.map_err(|e| e.to_string())?;
        if let Some(path) = crate::commands::fs_cmds::relative_workspace_path(&root, &path) {
            if std::path::Path::new(&path)
                .extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case("tree"))
            {
                files.push(GraphSyncFile { category, path });
            }
        }
    }
    Ok(GraphSyncData {
        workspace: crate::commands::fs_cmds::logical_workspace_id(&root),
        categories,
        files,
    })
}

fn read_categories(conn: &Connection) -> Result<Vec<GraphSyncCategory>, String> {
    let mut statement = conn
        .prepare_cached(
            "SELECT graph_categories.name, colors.color FROM graph_categories
             LEFT JOIN colors ON colors.category = graph_categories.name
             ORDER BY graph_categories.name",
        )
        .map_err(|error| error.to_string())?;
    statement
        .query_map([], |row| {
            Ok(GraphSyncCategory {
                name: row.get(0)?,
                color: row.get(1)?,
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn apply_graph_sync_data(
    root: String,
    data: GraphSyncData,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let root = std::fs::canonicalize(root).map_err(|error| error.to_string())?;
    validate_graph_sync_data(&root, &data)?;
    let guard = state.db_conn.lock().map_err(|error| error.to_string())?;
    let conn = guard.as_ref().ok_or("请先打开项目")?;
    schema(conn)?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM graph_files", [])
        .map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM graph_categories", [])
        .map_err(|e| e.to_string())?;
    for category in &data.categories {
        tx.execute(
            "INSERT INTO graph_categories(name) VALUES (?1)",
            [&category.name],
        )
        .map_err(|e| e.to_string())?;
    }
    for file in &data.files {
        let path = root.join(&file.path).to_string_lossy().to_string();
        tx.execute(
            "INSERT INTO graph_files(category,path) VALUES (?1,?2)",
            params![file.category, path],
        )
        .map_err(|e| e.to_string())?;
    }
    for category in &data.categories {
        set_category_color(&tx, &category.name, category.color.as_deref())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    drop(guard);
    use tauri::Emitter;
    let _ = app.emit("nexusdesk-graph-data-changed", ());
    let _ = app.emit("nexusdesk:graph-colors", ());
    Ok(())
}

#[tauri::command]
pub fn get_graph_categories(state: State<'_, AppState>) -> Result<Vec<GraphCategory>, String> {
    let guard = state.db_conn.lock().unwrap();
    let Some(conn) = guard.as_ref() else {
        return Ok(vec![]);
    };
    schema(conn)?;
    let mut categories = Vec::new();
    for GraphSyncCategory { name, color } in read_categories(conn)? {
        let mut files = conn
            .prepare("SELECT path FROM graph_files WHERE category=?1 ORDER BY path")
            .map_err(|e| e.to_string())?;
        let files = files
            .query_map([&name], |row| row.get(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<String>, _>>()
            .map_err(|e| e.to_string())?;
        categories.push(GraphCategory {
            name,
            files,
            missing_files: Vec::new(),
            color,
        });
    }
    drop(guard);
    for category in &mut categories {
        category.missing_files = category
            .files
            .iter()
            .filter(|path| !std::path::Path::new(path).is_file())
            .cloned()
            .collect();
    }
    Ok(categories)
}

#[tauri::command]
pub fn create_graph_category(name: String, state: State<'_, AppState>) -> Result<(), String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("请输入分类名称".into());
    }
    let guard = state.db_conn.lock().unwrap();
    let conn = guard.as_ref().ok_or("请先打开项目")?;
    schema(conn)?;
    conn.execute("INSERT INTO graph_categories(name) VALUES (?1)", [name])
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn link_files(conn: &Connection, category: &str, paths: &[String]) -> Result<(), String> {
    schema(conn)?;
    let exists: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM graph_categories WHERE name=?1)",
            [category],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    if !exists {
        return Err("请将文件拖入图谱分类，不能放在根目录".into());
    }
    let paths = paths
        .iter()
        .map(|path| {
            let path = std::path::Path::new(path);
            if !path.is_file()
                || !path
                    .extension()
                    .is_some_and(|ext| ext.eq_ignore_ascii_case("tree"))
            {
                return Err("图谱分类仅接受 .tree 文件".to_string());
            }
            std::fs::canonicalize(path)
                .map(|path| {
                    let value = path.to_string_lossy().to_string();
                    if let Some(unc) = value.strip_prefix(r"\\?\UNC\") {
                        format!(r"\\{}", unc)
                    } else {
                        value.strip_prefix(r"\\?\").unwrap_or(&value).to_string()
                    }
                })
                .map_err(|e| e.to_string())
        })
        .collect::<Result<Vec<_>, _>>()?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    for path in paths {
        tx.execute(
            "INSERT OR IGNORE INTO graph_files(category, path) VALUES (?1, ?2)",
            params![category, path],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn link_graph_files(
    category: String,
    paths: Vec<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let guard = state.db_conn.lock().unwrap();
    let conn = guard.as_ref().ok_or("请先打开项目")?;
    link_files(conn, &category, &paths)
}

fn edit_category(conn: &Connection, name: &str, new_name: Option<&str>) -> Result<(), String> {
    schema(conn)?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    if let Some(new_name) = new_name {
        let new_name = new_name.trim();
        if new_name.is_empty() {
            return Err("请输入分类名称".into());
        }
        let changed = tx
            .execute(
                "UPDATE graph_categories SET name=?1 WHERE name=?2",
                params![new_name, name],
            )
            .map_err(|e| e.to_string())?;
        if changed == 0 {
            return Err("图谱分类不存在".into());
        }
        tx.execute(
            "UPDATE graph_files SET category=?1 WHERE category=?2",
            params![new_name, name],
        )
        .map_err(|e| e.to_string())?;
    } else {
        tx.execute("DELETE FROM graph_files WHERE category=?1", [name])
            .map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM graph_categories WHERE name=?1", [name])
            .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn edit_graph_category(
    name: String,
    new_name: Option<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let guard = state.db_conn.lock().unwrap();
    let conn = guard.as_ref().ok_or("请先打开项目")?;
    edit_category(conn, &name, new_name.as_deref())
}

#[tauri::command]
pub fn remove_graph_file(
    category: String,
    path: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let guard = state.db_conn.lock().unwrap();
    let conn = guard.as_ref().ok_or("请先打开项目")?;
    schema(conn)?;
    conn.execute(
        "DELETE FROM graph_files WHERE category=?1 AND path=?2",
        params![category, path],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn graph_sync_accepts_relative_tree_memberships_and_rejects_unsafe_paths() {
        let root = std::env::temp_dir();
        let data = super::GraphSyncData {
            workspace: crate::commands::fs_cmds::logical_workspace_id(&root),
            categories: vec![super::GraphSyncCategory {
                name: "分类".into(),
                color: Some("#12aBef".into()),
            }],
            files: vec![super::GraphSyncFile {
                category: "分类".into(),
                path: "notes/map.tree".into(),
            }],
        };
        assert!(super::validate_graph_sync_data(&root, &data).is_ok());
        let mut invalid = data.clone();
        invalid.files[0].path = "../outside.tree".into();
        assert!(super::validate_graph_sync_data(&root, &invalid).is_err());
        invalid.files[0].path = "notes/map.md".into();
        assert!(super::validate_graph_sync_data(&root, &invalid).is_err());
        invalid.files[0].path = "notes/map.tree".into();
        invalid.files[0].category = "missing".into();
        assert!(super::validate_graph_sync_data(&root, &invalid).is_err());
    }

    #[test]
    fn category_edits_preserve_links_and_reject_duplicates() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        super::schema(&conn).unwrap();
        conn.execute(
            "INSERT INTO graph_categories(name) VALUES ('first'), ('occupied')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO graph_files(category,path) VALUES ('first','sample.tree')",
            [],
        )
        .unwrap();
        assert!(super::edit_category(&conn, "first", Some("occupied")).is_err());
        super::edit_category(&conn, "first", Some("FIRST")).unwrap();
        super::edit_category(&conn, "FIRST", Some("renamed")).unwrap();
        let category: String = conn
            .query_row("SELECT category FROM graph_files", [], |row| row.get(0))
            .unwrap();
        assert_eq!(category, "renamed");
        super::edit_category(&conn, "renamed", None).unwrap();
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM graph_files", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM graph_categories", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
    }

    #[test]
    fn links_only_tree_files_to_existing_categories_without_copying() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        super::schema(&conn).unwrap();
        conn.execute("INSERT INTO graph_categories(name) VALUES ('分类')", [])
            .unwrap();
        let folder = std::env::temp_dir().join(format!("nexusdesk-graph-{}", std::process::id()));
        std::fs::create_dir_all(&folder).unwrap();
        let path = folder.join("sample.tree");
        std::fs::write(&path, "根节点\n  子节点").unwrap();
        let paths = vec![path.to_string_lossy().to_string()];
        assert!(super::link_files(&conn, "", &paths).is_err());
        super::link_files(&conn, "分类", &paths).unwrap();
        super::link_files(&conn, "分类", &paths).unwrap();
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM graph_files", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "根节点\n  子节点");
        assert_eq!(std::fs::read_dir(&folder).unwrap().count(), 1);
        let invalid = folder.join("invalid.md");
        std::fs::write(&invalid, "text").unwrap();
        assert!(
            super::link_files(&conn, "分类", &[invalid.to_string_lossy().to_string()]).is_err()
        );
        std::fs::remove_dir_all(folder).unwrap();
    }
}
