//! Per-device/firmware record of the last verified one-dB gain change.
use crate::autoeq::{self, Profile};
use crate::protocol;
use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Write};
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct GainChange {
    schema: u8,
    address: String,
    firmware: String,
    pub before: Profile,
    pub after: Profile,
}

#[derive(Clone, Debug, serde::Serialize)]
pub struct GainUndoInfo {
    pub preamp: f32,
}

#[derive(Default)]
pub struct GainRecordStore {
    root: Option<PathBuf>,
}

impl GainRecordStore {
    pub fn new(root: PathBuf) -> Self {
        Self { root: Some(root) }
    }

    fn path(&self, address: &str, firmware: &str) -> Result<PathBuf, String> {
        let root = self.root.as_ref().ok_or(
            "The app data folder is unavailable. Restart the app before adjusting gain.",
        )?;
        let address_key = address.replace(':', "").to_ascii_uppercase();
        if address_key.len() != 12 || !address_key.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err("Invalid Bluetooth address for the gain record.".into());
        }
        if firmware.is_empty() {
            return Err("Read the firmware before recording a gain change.".into());
        }
        // Encode bytes instead of accepting any path components from the device.
        let firmware_key: String = firmware
            .bytes()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        Ok(root
            .join(address_key)
            .join(firmware_key)
            .join("last-gain-change.json"))
    }

    pub fn load(&self, address: &str, firmware: &str) -> Result<Option<GainChange>, String> {
        let path = self.path(address, firmware)?;
        let bytes = match fs::read(path) {
            Ok(bytes) if bytes.len() <= 256 * 1024 => bytes,
            Ok(_) => return Err("Gain undo record is too large.".into()),
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(format!("Could not read gain undo record: {error}")),
        };
        let change: GainChange = serde_json::from_slice(&bytes)
            .map_err(|error| format!("Gain undo record is unreadable: {error}"))?;
        if change.schema != 1 || !change.address.eq_ignore_ascii_case(address) || change.firmware != firmware {
            return Err("Gain undo record does not match the device and firmware.".into());
        }
        autoeq::validate(&change.before)?;
        autoeq::validate(&change.after)?;
        let mut before = change.before.clone();
        let mut after = change.after.clone();
        before.preamp = 0.0;
        after.preamp = 0.0;
        if protocol::encode_eq(&before)? != protocol::encode_eq(&after)?
            || ((change.after.preamp - change.before.preamp).abs() - 1.0).abs() > 0.001
        {
            return Err("Gain undo record has unexpected filter or gain changes.".into());
        }
        Ok(Some(change))
    }

    pub fn stage(&self, address: &str, firmware: &str, before: &Profile, after: &Profile) -> Result<(), String> {
        // A corrupt existing record is preserved instead of silently overwritten.
        self.load(address, firmware)?;
        let path = self.path(address, firmware)?;
        let change = GainChange { schema: 1, address: address.into(), firmware: firmware.into(), before: before.clone(), after: after.clone() };
        let bytes = serde_json::to_vec_pretty(&change).map_err(|error| error.to_string())?;
        let nonce = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|error| error.to_string())?.as_nanos();
        let temporary = path.with_file_name(format!("gain-{}-{nonce}.tmp", std::process::id()));
        let mut file = OpenOptions::new().write(true).create_new(true).open(&temporary)
            .map_err(|error| format!("Could not prepare gain undo record: {error}"))?;
        file.write_all(&bytes).and_then(|_| file.sync_all())
            .map_err(|error| format!("Could not finish gain undo record: {error}"))?;
        drop(file);
        fs::rename(&temporary, &path).map_err(|error| format!("Could not commit gain undo record: {error}"))?;
        let saved = self.load(address, firmware)?.ok_or("Gain undo record disappeared.")?;
        if protocol::encode_eq(&saved.before)? != protocol::encode_eq(before)?
            || protocol::encode_eq(&saved.after)? != protocol::encode_eq(after)? {
            return Err("Gain undo record differs from the reviewed change.".into());
        }
        Ok(())
    }
}