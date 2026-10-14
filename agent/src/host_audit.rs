//! Minimal, durable, redacted local audit for explicitly authorized reads.
//! Not a tamper-proof log: local administrators can modify files. Never put
//! remote command parameters, filesystem paths, tokens or raw command IDs here.
use std::fs::{File, OpenOptions};
use std::io::{self, Write};
use std::path::Path;

use serde::Serialize;

use crate::host_readonly::ReadOnlyAuditEvent;

const SCHEMA_VERSION: u8 = 1;

#[derive(Serialize)]
struct AuditRecord<'a> {
    schema_version: u8,
    sequence: u64,
    event: &'a ReadOnlyAuditEvent,
}

pub(crate) struct DurableReadOnlyAudit {
    file: File,
    next_sequence: u64,
    #[cfg(test)]
    fail_writes: bool,
}

impl DurableReadOnlyAudit {
    /// Create a NEW journal in an operator-selected existing directory.
    /// The journal cannot be placed inside the remotely readable workspace:
    /// this prevents a remote fs.read from exfiltrating the audit itself.
    /// create_new also refuses an existing regular file or symlink.
    pub(crate) fn create(root: &Path, path: &Path) -> io::Result<Self> {
        if !root.is_absolute() || !path.is_absolute() || path.file_name().is_none() {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "invalid audit location"));
        }
        let workspace = root.canonicalize()?;
        let parent = path
            .parent()
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "missing audit parent"))?
            .canonicalize()?;
        if !workspace.is_dir() || !parent.is_dir() || parent.starts_with(&workspace) {
            return Err(io::Error::new(io::ErrorKind::PermissionDenied, "unsafe audit directory"));
        }

        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let file = options.open(path)?;
        file.sync_all()?;
        Ok(Self {
            file,
            next_sequence: 1,
            #[cfg(test)]
            fail_writes: false,
        })
    }

    /// Serialization happens before disk I/O. Each event is flushed to the
    /// underlying filesystem before authorization/execution is reported.
    pub(crate) fn append(&mut self, event: &ReadOnlyAuditEvent) -> io::Result<()> {
        #[cfg(test)]
        if self.fail_writes {
            return Err(io::Error::other("injected journal write failure"));
        }
        let next = self
            .next_sequence
            .checked_add(1)
            .ok_or_else(|| io::Error::other("journal sequence exhausted"))?;
        let mut line = serde_json::to_vec(&AuditRecord {
            schema_version: SCHEMA_VERSION,
            sequence: self.next_sequence,
            event,
        })
        .map_err(io::Error::other)?;
        line.push(b'\n');
        self.file.write_all(&line)?;
        self.file.sync_data()?;
        self.next_sequence = next;
        Ok(())
    }
}
