use std::fs;
use std::path::{Component, Path};
use v8::*;

pub fn create_snapshot(init_js_path: &str, out_path: &str) -> anyhow::Result<()> {
    let platform = v8::new_default_platform(0, false).make_shared();
    v8::V8::initialize_platform(platform);
    v8::V8::initialize();

    let mut creator = v8::SnapshotCreator::new(None);

    {
        let isolate = creator.get_isolate();
        let handle_scope = &mut v8::HandleScope::new(isolate);
        let context = v8::Context::new(handle_scope);
        let scope = &mut v8::ContextScope::new(handle_scope, context);

        let code = fs::read_to_string(init_js_path)?;

        let src = v8::String::new(scope, &code).unwrap();
        let script = v8::Script::compile(scope, src, None).unwrap();
        script.run(scope).unwrap();

        creator.set_default_context(context);
    }

    let snapshot_blob = creator
        .create_blob(v8::FunctionCodeHandling::Keep)
        .expect("Snapshot creation failed");

    fs::write(out_path, snapshot_blob.as_slice())?;
    Ok(())
}

pub fn load_snapshot(snapshot_path: &str) -> anyhow::Result<v8::OwnedIsolate> {
    let data = fs::read(snapshot_path)?;
    let startup_data = v8::StartupData::new(&data);
    let params = v8::Isolate::create_params().snapshot_blob(startup_data);
    let isolate = v8::Isolate::new(params);
    Ok(isolate)
}
