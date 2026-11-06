use rusqlite::Connection;
use std::sync::{Arc, Mutex};

pub struct AppState {
    pub db_conn: Arc<Mutex<Option<Connection>>>,
}
