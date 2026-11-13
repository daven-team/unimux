//! The generated window.mc contract (scripts/gen-ipc-contract.mjs -> src-tauri/gen/ipc-contract.json), embedded at build time.

use std::collections::BTreeMap;
use std::sync::LazyLock;

use serde::Deserialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChannelKind {
    /// `ipcRenderer.invoke`: request and answer.
    Invoke,
    /// `ipcRenderer.send`: fire-and-forget, delivered in order per window.
    Send,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ChannelInfo {
    pub kind: ChannelKind,
    pub domain: String,
    pub methods: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct EventInfo {
    pub name: String,
    pub domain: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Contract {
    pub channels: BTreeMap<String, ChannelInfo>,
    pub events: Vec<EventInfo>,
    pub ports: Vec<String>,
}

static EMBEDDED: LazyLock<Contract> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../../gen/ipc-contract.json")).expect("src-tauri/gen/ipc-contract.json is valid")
});

impl Contract {
    /// The contract this binary was built with.
    pub fn embedded() -> &'static Contract {
        &EMBEDDED
    }
    pub fn channel(&self, name: &str) -> Option<&ChannelInfo> {
        self.channels.get(name)
    }
    pub fn has_event(&self, name: &str) -> bool {
        self.events.iter().any(|e| e.name == name)
    }
    /// The number of window.mc methods behind the channels (a multiplexed channel such as `db:pg` serves several).
    pub fn method_count(&self) -> usize {
        self.channels.values().map(|c| c.methods.len()).sum()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_contract_has_the_known_size() {
        let c = Contract::embedded();
        // api.d.ts of 1.1.4: 245 methods on 215 channels (177 invoke + 38 send), 43 events + window:maximized; W1 adds the
        // window:* caption members (250 methods + 3 sync members on 220 channels: 178 invoke + 42 send, 45 events); opening
        // files from the OS adds app:takeOpenFiles and the app:open-files event.
        assert_eq!(c.channels.len(), 221);
        assert_eq!(c.channels.values().filter(|x| x.kind == ChannelKind::Invoke).count(), 179);
        assert_eq!(c.channels.values().filter(|x| x.kind == ChannelKind::Send).count(), 42);
        assert_eq!(c.method_count(), 251);
        assert_eq!(c.events.len(), 46);
        assert!(c.has_event("app:open-files"));
        assert!(c.has_event("state:changed"));
        assert_eq!(c.channel("db:pg").unwrap().methods.len(), 14);
        assert_eq!(c.channel("db:redis").unwrap().methods.len(), 18);
    }
}
