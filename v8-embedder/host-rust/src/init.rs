use v8::*;

pub fn install_host_bindings(scope: &mut v8::HandleScope) {
    let context = scope.get_current_context();
    let global = context.global(scope);

    let log_fn = v8::FunctionTemplate::new(scope, |scope, args, _retval| {
        if let Some(val) = args.get(0) {
            let s = val.to_rust_string_lossy(scope);
            println!("[host log] {}", s);
        }
    });

    let key = v8::String::new(scope, "log").unwrap();
    let val = log_fn.get_function(scope).unwrap();
    global.set(scope, key.into(), val.into());
}
