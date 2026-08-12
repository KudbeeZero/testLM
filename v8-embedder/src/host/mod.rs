use anyhow::{Context, Result};
use std::fs;
use std::path::{Path, PathBuf};
use v8::*;

pub struct V8Host {
    isolate: *mut Isolate,
    _platform: Box<Platform>,
    _allocator: Box<ArrayBufferAllocator>,
    max_heap_mb: u32,
}

impl V8Host {
    pub fn new(max_heap_mb: u32) -> Result<Self> {
        let platform = Platform::new(0);
        V8::initialize_platform(platform.get());
        V8::initialize();

        let allocator = ArrayBufferAllocator::new_default_allocator();
        let mut isolate_params = IsolateCreateParams::default();
        isolate_params.array_buffer_allocator = allocator.0;

        let isolate = Isolate::new(isolate_params);
        let mut host = Self {
            isolate,
            _platform: platform,
            _allocator: allocator,
            max_heap_mb,
        };

        // Initialize isolate scope
        let scope = &mut Callbacks::new(host.isolate);
        let tc = TryCatch::new(scope);

        // Set resource constraints
        let mut constraints = ResourceConstraints::default();
        constraints.set_max_old_space_size(max_heap_mb);

        Ok(host)
    }

    pub fn run_script(&mut self, path: &Path) -> Result<()> {
        let scope = &mut Callbacks::new(self.isolate);
        let tc = TryCatch::new(scope);

        let source = fs::read_to_string(path)
            .with_context(|| format!("Failed to read {}", path.display()))?;

        let code = scope.open(tc).enter_scope();

        let script = v8::Script::compile(
            code,
            v8::ScriptOrigin::new(
                code,
                v8::Local::<'_, v8::Integer>::try_from(0).unwrap().into(),
                v8::Local::<'_, v8::Integer>::try_from(0).unwrap().into(),
                false,
                false,
                0,
                v8::Local::<'_, Module>::try_from(0).unwrap().into(),
                0,
            ),
        );

        match script {
            Some(script) => {
                let result = script.run(code);
                match result {
                    Some(val) => {
                        let string = val.to_rust_string_lossy(code);
                        println!("{}", string);
                        Ok(())
                    }
                    None => {
                        let exception = tc.exception(code).unwrap();
                        let msg = exception.to_rust_string_lossy(code);
                        anyhow::bail!("Script execution failed: {}", msg)
                    }
                }
            }
            None => {
                let exception = tc.exception(code).unwrap();
                let msg = exception.to_rust_string_lossy(code);
                anyhow::bail!("Script compilation failed: {}", msg)
            }
        }
    }

    pub fn create_snapshot(&mut self, script_path: &Path, output: &str) -> Result<()> {
        let scope = &mut Callbacks::new(self.isolate);
        let source = fs::read_to_string(script_path)
            .with_context(|| format!("Failed to read {}", script_path.display()))?;

        let code = scope.enter_scope();
        let context = Context::new(code);
        let mut cs = ContextScope::new(code, context);

        let src_str = String::new_from_utf8(code, &source).unwrap();
        let script = Script::compile(&mut cs, src_str.into(), None).unwrap();
        script.run(&mut cs).unwrap();

        let blob = self.isolate.create_snapshot_data_blob();
        if !blob.data.is_empty() {
            fs::write(output, blob.data)?;
            println!("Snapshot written to {} ({} bytes)", output, blob.raw_size);
        }

        Ok(())
    }

    pub fn load_snapshot(&mut self, path: &Path) -> Result<()> {
        let data = fs::read(path)?;
        // Snapshot loading happens at isolate creation in rusty_v8
        // This is a placeholder for the snapshot data
        info!("Snapshot data loaded ({} bytes)", data.len());
        Ok(())
    }
}

impl Drop for V8Host {
    fn drop(&mut self) {
        unsafe {
            Isolate::dispose(self.isolate);
        }
        V8::dispose();
        V8::dispose_platform();
    }
}

// Helper to enter isolate scope
struct Callbacks<'a>(&'a mut Isolate);

impl<'a> Callbacks<'a> {
    fn new(isolate: &'a mut Isolate) -> Self {
        Self(isolate)
    }

    fn enter_scope(&mut self) -> HandleScope<'a, ()> {
        HandleScope::new(self.0)
    }
}
