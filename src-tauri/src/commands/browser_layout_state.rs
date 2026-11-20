use std::collections::HashMap;

#[derive(Default)]
pub(super) struct BrowserWindow {
    panes: [BrowserPaneState; 2],
    revisions: HashMap<String, u64>,
    #[cfg(windows)]
    pub(super) fullscreen: Option<(String, bool)>,
}

#[derive(Default)]
struct BrowserPaneState {
    owner: Option<String>,
    revision: u64,
}

#[derive(Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BrowserPane {
    Left,
    Right,
}

pub(super) enum LayoutChange {
    Stale,
    Apply { hide_previous: Option<String> },
}

impl BrowserWindow {
    #[cfg(windows)]
    pub(super) fn owns_pane(&self, label: &str) -> bool {
        self.panes
            .iter()
            .any(|pane| pane.owner.as_deref() == Some(label))
    }

    pub(super) fn forget(&mut self, label: &str) {
        self.revisions.remove(label);
        for pane in &mut self.panes {
            if pane.owner.as_deref() == Some(label) {
                pane.owner = None;
            }
        }
    }

    pub(super) fn layout(
        &mut self,
        pane: BrowserPane,
        label: &str,
        revision: u64,
        active: bool,
        visible: bool,
    ) -> LayoutChange {
        let last = self.revisions.entry(label.into()).or_default();
        if revision <= *last {
            return LayoutChange::Stale;
        }
        *last = revision;
        let pane = &mut self.panes[match pane {
            BrowserPane::Left => 0,
            BrowserPane::Right => 1,
        }];
        if !active || !visible {
            if pane.owner.as_deref() == Some(label) {
                pane.owner = None;
            }
            return LayoutChange::Apply {
                hide_previous: None,
            };
        }
        if revision <= pane.revision {
            return LayoutChange::Stale;
        }
        pane.revision = revision;
        let previous = std::mem::replace(&mut pane.owner, Some(label.into()));
        LayoutChange::Apply {
            hide_previous: previous.filter(|previous| previous != label),
        }
    }
}
