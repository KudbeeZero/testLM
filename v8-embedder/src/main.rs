use anyhow::Result;
use clap::Parser;
use std::path::PathBuf;
use tracing::info;

mod host;

use host::V8Host;

#[derive(Parser, Debug)]
#[command(author, version, about, long_about = None)]
struct Args {
    /// Path to the JavaScript file to execute
    script: PathBuf,

    /// Create a snapshot from the script's initialization
    #[arg(long)]
    create_snapshot: bool,

    /// Path to snapshot blob for warm startup
    #[arg(long)]
    snapshot: Option<PathBuf>,

    /// Maximum heap size in MB
    #[arg(long, default_value_t = 128)]
    max_heap_mb: u32,
}

fn main() -> Result<()> {
    tracing_subscriber::fmt::init();
    let args = Args::parse();

    info!("Starting V8 host");
    info!("Script: {}", args.script.display());

    let mut host = V8Host::new(args.max_heap_mb)?;

    if let Some(ref snapshot_path) = args.snapshot {
        info!("Loading snapshot from {}", snapshot_path.display());
        host.load_snapshot(snapshot_path)?;
    }

    if args.create_snapshot {
        info!("Creating snapshot...");
        host.create_snapshot(&args.script, "snapshots/init_blob.bin")?;
        info!("Snapshot created at snapshots/init_blob.bin");
    } else {
        info!("Running script...");
        host.run_script(&args.script)?;
    }

    Ok(())
}
