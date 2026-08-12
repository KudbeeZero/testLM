use anyhow::{Context, Result};
use clap::Parser;
use rusty_v8 as v8;
use std::fs;
use std::path::{Path, PathBuf};
use tracing::info;

mod init;
mod pool;
mod snapshot;

#[derive(Parser, Debug)]
#[command(author, version, about, long_about = None)]
struct Args {
    /// Path to the JavaScript file to execute
    script: Option<PathBuf>,

    /// Create a snapshot from init.js
    #[arg(long)]
    create_snapshot: bool,

    /// Path to snapshot blob for warm startup
    #[arg(long)]
    snapshot: Option<PathBuf>,

    /// Path to init.js for snapshot creation
    #[arg(long)]
    init: Option<PathBuf>,

    /// Warm pool size
    #[arg(long, default_value_t = 4)]
    pool_size: usize,

    /// Maximum heap size in MB
    #[arg(long, default_value_t = 128)]
    max_heap_mb: u32,
}

fn validate_script_path(path: &Path) -> Result<()> {
    let allowed_root = std::env::current_dir()?;
    let resolved = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    if !resolved.starts_with(allowed_root) {
        anyhow::bail!(
            "script path {:?} resolves outside allowed project root {:?}",
            resolved,
            allowed_root
        );
    }
    Ok(())
}

fn main() -> Result<()> {
    tracing_subscriber::fmt::init();
    let args = Args::parse();

    if args.create_snapshot {
        let init_js = args.init.expect("--init required for snapshot creation");
        let out = args.snapshot.expect("--snapshot output required for snapshot creation");
        info!("Creating snapshot from {} -> {}", init_js.display(), out);
        snapshot::create_snapshot(&init_js, &out)?;
        info!("Snapshot created");
        return Ok(());
    }

    let snapshot_path = args.snapshot.expect("--snapshot required");
    let script_path = args.script.expect("script path required");

    validate_script_path(&script_path)?;

    info!("Loading warm pool from {} (size {})", snapshot_path, args.pool_size);
    let pool = pool::WarmPool::new(&snapshot_path, args.pool_size);

    let src = fs::read_to_string(&script_path)?;
    info!("Running {}", script_path.display());

    let mut warm = pool.get();
    let isolate = &mut warm.isolate;

    let handle_scope = &mut v8::HandleScope::new(isolate);
    let context = v8::Local::new(handle_scope, isolate.get_current_context());
    let mut scope = v8::ContextScope::new(handle_scope, context);

    init::install_host_bindings(&mut scope);

    let code = v8::String::new(&mut scope, &src).unwrap();
    let script = v8::Script::compile(&mut scope, code, None).unwrap();
    let result = script.run(&mut scope).unwrap();

    if result.is_string() {
        let s = result.to_string(&mut scope).unwrap();
        println!("{}", s.to_rust_string_lossy(&mut scope));
    }

    pool.put(warm);
    Ok(())
}
