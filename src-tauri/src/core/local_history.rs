use rusqlite::{Connection, params, OptionalExtension};
use serde::{Serialize, Deserialize};

const RETENTION: i64 = 30 * 24 * 60 * 60 * 1000;
pub fn now() -> i64 { std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as i64 }
pub fn init(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch("CREATE TABLE IF NOT EXISTS local_history(id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL, created_at INTEGER NOT NULL, patch TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS local_history_path ON local_history(path,id DESC);
        CREATE TABLE IF NOT EXISTS local_history_heads(path TEXT PRIMARY KEY, content TEXT NOT NULL);")?;
    prune(conn)
}
pub fn prune(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM local_history WHERE created_at < ?1", [now()-RETENTION])?;
    conn.execute("DELETE FROM local_history_heads WHERE path NOT IN (SELECT path FROM local_history)", [])?;
    Ok(())
}
// A UTF-8 byte splice from the saved version back to its predecessor.
#[derive(Serialize, Deserialize)]
struct Patch { start: usize, end: usize, text: String }
fn patch(new: &str, old: &str) -> Patch {
    let mut start = new.bytes().zip(old.bytes()).take_while(|(a,b)| a==b).count();
    while !new.is_char_boundary(start) || !old.is_char_boundary(start) { start-=1; }
    let mut suffix = new[start..].bytes().rev().zip(old[start..].bytes().rev()).take_while(|(a,b)| a==b).count();
    while !new.is_char_boundary(new.len()-suffix) || !old.is_char_boundary(old.len()-suffix) { suffix-=1; }
    Patch { start, end: new.len()-suffix, text: old[start..old.len()-suffix].into() }
}
fn append(conn: &Connection, path: &str, old: &str, new: &str, time: i64) -> Result<(), String> {
    // Compare against the latest stored version, not just the current disk file.
    // Keep the first baseline, but never insert an identical adjacent version.
    let head: Option<String> = conn.query_row(
        "SELECT content FROM local_history_heads WHERE path=?1", [path], |r| r.get(0)
    ).optional().map_err(|e| e.to_string())?;
    if head.as_deref() == Some(new) { return Ok(()); }
    let data = serde_json::to_string(&patch(new,old)).map_err(|e| e.to_string())?;
    conn.execute("INSERT INTO local_history(path,created_at,patch) VALUES (?1,?2,?3)", params![path,time,data]).map_err(|e| e.to_string())?;
    conn.execute("INSERT INTO local_history_heads(path,content) VALUES (?1,?2) ON CONFLICT(path) DO UPDATE SET content=excluded.content", params![path,new]).map_err(|e| e.to_string())?;
    Ok(())
}
pub fn record(conn: &Connection, path: &str, old: &str, new: &str, original_time: i64) -> Result<(), String> {
    prune(conn).map_err(|e| e.to_string())?;
    let head: Option<String> = conn.query_row("SELECT content FROM local_history_heads WHERE path=?1", [path], |r| r.get(0)).optional().map_err(|e| e.to_string())?;
    let time=now();
    match head {
        None => append(conn,path,old,old,if original_time < time-RETENTION { time } else { original_time })?,
        Some(head) if head!=old => append(conn,path,&head,old,time)?,
        _ => ()
    }
    if old!=new { append(conn,path,old,new,time)?; }
    Ok(())
}
#[derive(Serialize)]
pub struct Entry { pub id: i64, pub created_at: i64 }
pub fn list(conn: &Connection, path: &str) -> Result<Vec<Entry>, String> {
    prune(conn).map_err(|e| e.to_string())?;
    conn.prepare("SELECT id,created_at FROM local_history WHERE path=?1 ORDER BY id DESC").map_err(|e| e.to_string())?
        .query_map([path], |r| Ok(Entry{id:r.get(0)?,created_at:r.get(1)?})).map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>,_>>().map_err(|e| e.to_string())
}
pub fn content(conn: &Connection, path: &str, id: i64) -> Result<String,String> {
    let mut text: String=conn.query_row("SELECT content FROM local_history_heads WHERE path=?1", [path], |r|r.get(0)).map_err(|e|e.to_string())?;
    let mut stmt=conn.prepare("SELECT id,patch FROM local_history WHERE path=?1 ORDER BY id DESC").map_err(|e|e.to_string())?;
    let rows=stmt.query_map([path], |r| Ok((r.get::<_,i64>(0)?,r.get::<_,String>(1)?))).map_err(|e|e.to_string())?;
    for row in rows {
        let (entry,data)=row.map_err(|e|e.to_string())?;
        if entry==id { return Ok(text); }
        let p: Patch=serde_json::from_str(&data).map_err(|e|e.to_string())?;
        if p.start>p.end || !text.is_char_boundary(p.start) || !text.is_char_boundary(p.end) { return Err("Invalid history patch".into()); }
        text.replace_range(p.start..p.end,&p.text);
    }
    Err("History version expired or missing".into())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn identical_adjacent_versions_are_not_stored() {
        let c = Connection::open_in_memory().unwrap();
        init(&c).unwrap();
        record(&c, "a", "", "", now()).unwrap();
        let baseline = list(&c, "a").unwrap();
        for _ in 0..3 { record(&c, "a", "", "", now()).unwrap(); }
        assert_eq!(list(&c, "a").unwrap().len(), 1);
        assert_eq!(list(&c, "a").unwrap()[0].id, baseline[0].id);

        record(&c, "a", "", "changed", now()).unwrap();
        let latest = list(&c, "a").unwrap()[0].id;
        for _ in 0..3 { record(&c, "a", "changed", "changed", now()).unwrap(); }
        // The insertion boundary also rejects duplicate content directly.
        append(&c, "a", "changed", "changed", now()).unwrap();
        let entries = list(&c, "a").unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].id, latest);
        assert_eq!(content(&c, "a", latest).unwrap(), "changed");

        // Returning to an older version is a real change and must be retained.
        record(&c, "a", "changed", "", now()).unwrap();
        let entries = list(&c, "a").unwrap();
        assert_eq!(entries.len(), 3);
        assert_eq!(content(&c, "a", entries[0].id).unwrap(), "");
        assert_eq!(content(&c, "a", entries[1].id).unwrap(), "changed");
        assert_eq!(content(&c, "a", entries[2].id).unwrap(), "");
    }
    #[test]
    fn round_trip_unicode_external_edits_and_retention() {
        let c=Connection::open_in_memory().unwrap(); init(&c).unwrap();
        record(&c,"a","\u{521d}\u{59cb}\r\n","\u{65b0}\u{1f642}\n",now()).unwrap();
        record(&c,"a","external","",now()).unwrap();
        let entries=list(&c,"a").unwrap();
        let texts:Vec<_>=entries.iter().map(|e|content(&c,"a",e.id).unwrap()).collect();
        assert_eq!(texts,vec!["","external","\u{65b0}\u{1f642}\n","\u{521d}\u{59cb}\r\n"]);
        c.execute("UPDATE local_history SET created_at=0 WHERE id=?1",[entries.last().unwrap().id]).unwrap();
        prune(&c).unwrap();
        assert_eq!(content(&c,"a",entries[2].id).unwrap(),"\u{65b0}\u{1f642}\n");
        assert!(content(&c,"a",entries[3].id).is_err());
        record(&c,"a","","",now()).unwrap(); assert_eq!(list(&c,"a").unwrap().len(),3);
        record(&c,"old","before","after",0).unwrap();
        let old=list(&c,"old").unwrap();
        assert_eq!(old.len(),2);
        assert_eq!(content(&c,"old",old[1].id).unwrap(),"before");
    }
}
