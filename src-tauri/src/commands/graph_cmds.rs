use crate::state::AppState;
use rusqlite::{params, Connection};
use tauri::State;

#[derive(serde::Serialize)]
pub struct GraphCategory {
    name: String,
    files: Vec<String>,
    #[serde(rename = "missingFiles")]
    missing_files: Vec<String>,
    color: Option<String>,
}

fn color_db() -> Result<Connection, String> {
    let folder = dirs::home_dir().ok_or("Cannot find home directory")?.join(".note");
    std::fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
    let conn = Connection::open(folder.join("graph-colors.db")).map_err(|e| e.to_string())?;
    conn.execute_batch("CREATE TABLE IF NOT EXISTS colors (category TEXT PRIMARY KEY COLLATE NOCASE, color TEXT NOT NULL);").map_err(|e| e.to_string())?;
    Ok(conn)
}

#[tauri::command]
pub fn set_graph_category_color(category: String, color: Option<String>) -> Result<(), String> {
    let conn = color_db()?;
    if let Some(color) = color {
        if color.len() != 7 || !color.starts_with('#') || !color[1..].bytes().all(|c| c.is_ascii_hexdigit()) {
            return Err("Invalid color".into());
        }
        conn.execute("INSERT INTO colors(category,color) VALUES (?1,?2) ON CONFLICT(category) DO UPDATE SET color=excluded.color", params![category, color]).map_err(|e| e.to_string())?;
    } else {
        conn.execute("DELETE FROM colors WHERE category=?1", [category]).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch("CREATE TABLE IF NOT EXISTS graph_categories (name TEXT PRIMARY KEY COLLATE NOCASE);
        CREATE TABLE IF NOT EXISTS graph_files (category TEXT NOT NULL COLLATE NOCASE, path TEXT NOT NULL, PRIMARY KEY(category, path));")
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_graph_categories(state: State<'_, AppState>) -> Result<Vec<GraphCategory>, String> {
    let guard = state.db_conn.lock().unwrap();
    let Some(conn) = guard.as_ref() else { return Ok(vec![]); };
    schema(conn)?;
    let mut statement = conn.prepare("SELECT name FROM graph_categories ORDER BY name").map_err(|e| e.to_string())?;
    let names = statement.query_map([], |row| row.get::<_, String>(0)).map_err(|e| e.to_string())?;
    let mut categories = Vec::new();
    let colors = color_db()?;
    for name in names {
        let name = name.map_err(|e| e.to_string())?;
        let mut files = conn.prepare("SELECT path FROM graph_files WHERE category=?1 ORDER BY path").map_err(|e| e.to_string())?;
        let files = files.query_map([&name], |row| row.get(0)).map_err(|e| e.to_string())?
            .collect::<Result<Vec<String>, _>>().map_err(|e| e.to_string())?;
        use rusqlite::OptionalExtension;
        let color = colors.query_row("SELECT color FROM colors WHERE category=?1", [&name], |row| row.get(0)).optional().map_err(|e| e.to_string())?;
        let missing_files = files.iter().filter(|path| !std::path::Path::new(path).is_file()).cloned().collect();
        categories.push(GraphCategory { name, files, missing_files, color });
    }
    Ok(categories)
}

#[tauri::command]
pub fn create_graph_category(name: String, state: State<'_, AppState>) -> Result<(), String> {
    let name = name.trim();
    if name.is_empty() { return Err("请输入分类名称".into()); }
    let guard = state.db_conn.lock().unwrap();
    let conn = guard.as_ref().ok_or("请先打开项目")?;
    schema(conn)?;
    conn.execute("INSERT INTO graph_categories(name) VALUES (?1)", [name]).map_err(|e| e.to_string())?;
    Ok(())
}

fn link_files(conn: &Connection, category: &str, paths: &[String]) -> Result<(), String> {
    schema(conn)?;
    let exists: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM graph_categories WHERE name=?1)", [category], |row| row.get(0)).map_err(|e| e.to_string())?;
    if !exists { return Err("请将文件拖入图谱分类，不能放在根目录".into()); }
    let paths = paths.iter().map(|path| {
        let path = std::path::Path::new(path);
        if !path.is_file() || !path.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("tree")) {
            return Err("图谱分类仅接受 .tree 文件".to_string());
        }
        std::fs::canonicalize(path).map(|path| {
            let value = path.to_string_lossy().to_string();
            if let Some(unc) = value.strip_prefix(r"\\?\UNC\") { format!(r"\\{}", unc) }
            else { value.strip_prefix(r"\\?\").unwrap_or(&value).to_string() }
        }).map_err(|e| e.to_string())
    }).collect::<Result<Vec<_>, _>>()?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    for path in paths {
        tx.execute("INSERT OR IGNORE INTO graph_files(category, path) VALUES (?1, ?2)", params![category, path]).map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn link_graph_files(category: String, paths: Vec<String>, state: State<'_, AppState>) -> Result<(), String> {
    let guard = state.db_conn.lock().unwrap();
    let conn = guard.as_ref().ok_or("请先打开项目")?;
    link_files(conn, &category, &paths)
}

fn edit_category(conn: &Connection, name: &str, new_name: Option<&str>) -> Result<(), String> {
    schema(conn)?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    if let Some(new_name) = new_name {
        let new_name = new_name.trim();
        if new_name.is_empty() { return Err("请输入分类名称".into()); }
        let changed = tx.execute("UPDATE graph_categories SET name=?1 WHERE name=?2", params![new_name, name]).map_err(|e| e.to_string())?;
        if changed == 0 { return Err("图谱分类不存在".into()); }
        tx.execute("UPDATE graph_files SET category=?1 WHERE category=?2", params![new_name, name]).map_err(|e| e.to_string())?;
    } else {
        tx.execute("DELETE FROM graph_files WHERE category=?1", [name]).map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM graph_categories WHERE name=?1", [name]).map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn edit_graph_category(name: String, new_name: Option<String>, state: State<'_, AppState>) -> Result<(), String> {
    let guard = state.db_conn.lock().unwrap();
    let conn = guard.as_ref().ok_or("请先打开项目")?;
    edit_category(conn, &name, new_name.as_deref())
}

#[tauri::command]
pub fn remove_graph_file(category: String, path: String, state: State<'_, AppState>) -> Result<(), String> {
    let guard = state.db_conn.lock().unwrap();
    let conn = guard.as_ref().ok_or("请先打开项目")?;
    schema(conn)?;
    conn.execute("DELETE FROM graph_files WHERE category=?1 AND path=?2", params![category, path]).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn category_edits_preserve_links_and_reject_duplicates() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        super::schema(&conn).unwrap();
        conn.execute("INSERT INTO graph_categories(name) VALUES ('first'), ('occupied')", []).unwrap();
        conn.execute("INSERT INTO graph_files(category,path) VALUES ('first','sample.tree')", []).unwrap();
        assert!(super::edit_category(&conn, "first", Some("occupied")).is_err());
        super::edit_category(&conn, "first", Some("FIRST")).unwrap();
        super::edit_category(&conn, "FIRST", Some("renamed")).unwrap();
        let category: String = conn.query_row("SELECT category FROM graph_files", [], |row| row.get(0)).unwrap();
        assert_eq!(category, "renamed");
        super::edit_category(&conn, "renamed", None).unwrap();
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM graph_files", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM graph_categories", [], |row| row.get::<_, i64>(0)).unwrap(), 1);
    }

    #[test]
    fn links_only_tree_files_to_existing_categories_without_copying() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        super::schema(&conn).unwrap();
        conn.execute("INSERT INTO graph_categories(name) VALUES ('分类')", []).unwrap();
        let folder = std::env::temp_dir().join(format!("noteide-graph-{}", std::process::id()));
        std::fs::create_dir_all(&folder).unwrap();
        let path = folder.join("sample.tree");
        std::fs::write(&path, "根节点\n  子节点").unwrap();
        let paths = vec![path.to_string_lossy().to_string()];
        assert!(super::link_files(&conn, "", &paths).is_err());
        super::link_files(&conn, "分类", &paths).unwrap();
        super::link_files(&conn, "分类", &paths).unwrap();
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM graph_files", [], |row| row.get::<_, i64>(0)).unwrap(), 1);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "根节点\n  子节点");
        assert_eq!(std::fs::read_dir(&folder).unwrap().count(), 1);
        let invalid = folder.join("invalid.md");
        std::fs::write(&invalid, "text").unwrap();
        assert!(super::link_files(&conn, "分类", &[invalid.to_string_lossy().to_string()]).is_err());
        std::fs::remove_dir_all(folder).unwrap();
    }
}
