use super::{Hour, Settings};
use anyhow::{Context as _, Result, bail};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};

#[derive(Serialize, Deserialize)]
struct Manifest {
    version: u32,
    generation: u64,
    settings: Settings,
}

#[derive(Serialize, Deserialize)]
struct HourFile {
    version: u32,
    data: Hour,
}

pub(super) struct Store {
    root: PathBuf,
    generation: u64,
}

type Opened = (Store, Settings, BTreeMap<i64, Hour>, Vec<String>);

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    use std::io::Write as _;
    let temporary = path.with_extension("pending");
    let mut file = fs::File::create(&temporary)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    fs::rename(temporary, path)?;
    Ok(())
}

impl Store {
    pub(super) fn open() -> Result<Opened> {
        let root = crate::utils::dirs::app_home_dir()?
            .join("traffic-statistics")
            .join("v1");
        Self::open_at(root)
    }

    fn open_at(root: PathBuf) -> Result<Opened> {
        fs::create_dir_all(&root)?;
        let path = root.join("manifest.json");
        let manifest = if path.exists() {
            let manifest: Manifest = serde_json::from_slice(&fs::read(&path)?)
                .context("Statistics manifest is unreadable; refusing to replace it")?;
            if manifest.version != 1 {
                bail!("Unsupported statistics manifest version");
            }
            manifest
        } else {
            if fs::read_dir(&root)?.next().is_some() {
                bail!("Statistics manifest is missing from a nonempty store; refusing to replace existing data");
            }
            let manifest = Manifest {
                version: 1,
                generation: 0,
                settings: Settings::default(),
            };
            atomic_write(&path, &serde_json::to_vec(&manifest)?)?;
            manifest
        };
        let store = Self {
            root,
            generation: manifest.generation,
        };
        fs::create_dir_all(store.directory())?;
        let mut hours = BTreeMap::new();
        let mut warnings = Vec::new();
        for entry in fs::read_dir(store.directory())? {
            let path = entry?.path();
            if path.extension().and_then(|value| value.to_str()) != Some("json") {
                continue;
            }
            let parsed = (|| -> Result<_> {
                let key = path
                    .file_stem()
                    .and_then(|value| value.to_str())
                    .context("Invalid statistics filename")?
                    .parse::<i64>()?;
                let file: HourFile = serde_json::from_slice(&fs::read(&path)?)?;
                if file.version != 1 {
                    bail!("Unsupported statistics record version");
                }
                Ok((key, file.data))
            })();
            match parsed {
                Ok((key, hour)) => {
                    hours.insert(key, hour);
                }
                Err(error) => warnings.push(format!("Unreadable statistics file {}: {error}", path.display())),
            }
        }
        // A failed physical deletion remains visible after restart as well.
        for entry in fs::read_dir(&store.root)? {
            let entry = entry?;
            if entry.file_type()?.is_dir() && entry.path() != store.directory() {
                warnings
                    .push("Previously cleared statistics files still require deletion; clear again to retry".into());
                break;
            }
        }
        Ok((store, manifest.settings, hours, warnings))
    }

    fn directory(&self) -> PathBuf {
        self.root.join(format!("generation-{}", self.generation))
    }

    pub(super) fn write_hour(&self, hour: i64, data: &Hour) -> Result<()> {
        let path = self.directory().join(format!("{hour}.json"));
        if path.exists() {
            let existing: HourFile =
                serde_json::from_slice(&fs::read(&path)?).context("Refusing to overwrite unreadable statistics")?;
            if existing.version != 1 {
                bail!("Refusing to overwrite unsupported statistics");
            }
        }
        #[derive(Serialize)]
        struct File<'a> {
            version: u32,
            data: &'a Hour,
        }
        atomic_write(&path, &serde_json::to_vec(&File { version: 1, data })?)
    }

    pub(super) fn write_settings(&self, settings: &Settings) -> Result<()> {
        atomic_write(
            &self.root.join("manifest.json"),
            &serde_json::to_vec(&Manifest {
                version: 1,
                generation: self.generation,
                settings: settings.clone(),
            })?,
        )
    }

    pub(super) fn advance_generation(&mut self, settings: &Settings) -> Result<()> {
        let generation = self
            .generation
            .checked_add(1)
            .context("Statistics generation exhausted")?;
        fs::create_dir_all(self.root.join(format!("generation-{generation}")))?;
        atomic_write(
            &self.root.join("manifest.json"),
            &serde_json::to_vec(&Manifest {
                version: 1,
                generation,
                settings: settings.clone(),
            })?,
        )?;
        self.generation = generation;
        Ok(())
    }

    pub(super) fn remove_previous_generations(&self) -> Result<()> {
        for entry in fs::read_dir(&self.root)? {
            let entry = entry?;
            if entry.file_type()?.is_dir()
                && entry.path() != self.directory()
                && entry.file_name().to_string_lossy().starts_with("generation-")
            {
                fs::remove_dir_all(entry.path())
                    .context("Statistics cleared, but deleting old files failed; retry clear")?;
            }
        }
        Ok(())
    }

    pub(super) fn remove_hour(&self, hour: i64) -> Result<()> {
        let path = self.directory().join(format!("{hour}.json"));
        if path.exists() {
            fs::remove_file(path)?;
        }
        Ok(())
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn persistence_corruption_and_clear_are_isolated_from_other_application_data() {
        let base = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../target/traffic-statistics-tests")
            .join(nanoid::nanoid!());
        fs::create_dir_all(&base).unwrap();
        let profiles = base.join("profiles.yaml");
        fs::write(&profiles, "preserve profiles").unwrap();
        let root = base.join("traffic-statistics/v1");
        let (mut store, mut settings, _, _) = Store::open_at(root.clone()).unwrap();
        settings.enabled = true;
        store.write_settings(&settings).unwrap();
        store.write_hour(0, &Hour::default()).unwrap();
        let bad = store.directory().join("3600000.json");
        fs::write(&bad, br#"{"version":99,"data":{"records":[],"coverage":[]}}"#).unwrap();
        let before = fs::read(&bad).unwrap();
        let (_, loaded, hours, warnings) = Store::open_at(root.clone()).unwrap();
        assert!(loaded.enabled);
        assert!(hours.contains_key(&0));
        assert_eq!(warnings.len(), 1);
        assert!(store.write_hour(3_600_000, &Hour::default()).is_err());
        assert_eq!(fs::read(&bad).unwrap(), before);
        store.advance_generation(&settings).unwrap();
        assert!(Store::open_at(root.clone()).unwrap().2.is_empty());
        store.remove_previous_generations().unwrap();
        assert_eq!(fs::read_to_string(profiles).unwrap(), "preserve profiles");
        assert!(Store::open_at(root.clone()).unwrap().3.is_empty());
        fs::remove_file(root.join("manifest.json")).unwrap();
        assert!(Store::open_at(root).is_err());
        fs::remove_dir_all(base).unwrap();
    }
}
