#include <v8.h>
#include <libplatform/libplatform.h>
#include <iostream>
#include <fstream>
#include <string>
#include <cstring>

using namespace v8;

std::string ReadFile(const char* path) {
  std::ifstream t(path);
  if (!t.is_open()) {
    std::cerr << "Cannot open " << path << "\n";
    return {};
  }
  std::string str((std::istreambuf_iterator<char>(t)), std::istreambuf_iterator<char>());
  return str;
}

void LogCallback(const FunctionCallbackInfo<Value>& args) {
  Isolate* isolate = args.GetIsolate();
  if (args.Length() > 0) {
    String::Utf8Value str(isolate, args[0]);
    std::cout << *str << std::endl;
  }
}

void CreateSnapshot(Isolate* isolate, Local<Context> context, const std::string& source) {
  Local<String> src = String::NewFromUtf8(isolate, source.c_str()).ToLocalChecked();
  Local<Script> script;
  if (!Script::Compile(context, src).ToLocal(&script)) return;
  script->Run(context).ToLocalChecked();

  StartupData blob = isolate->CreateSnapshotDataBlob(source.c_str());
  if (blob.data) {
    std::ofstream out("snapshots/init_blob.bin", std::ios::binary);
    out.write(blob.data, blob.raw_size);
    std::cout << "Snapshot written (" << blob.raw_size << " bytes)\n";
  }
}

int RunScript(Isolate* isolate, Local<Context> context, const std::string& source) {
  Local<String> src = String::NewFromUtf8(isolate, source.c_str()).ToLocalChecked();
  Local<Script> script;
  if (!Script::Compile(context, src).ToLocal(&script)) return 1;
  Local<Value> result;
  if (!script->Run(context).ToLocal(&result)) return 1;
  String::Utf8Value utf8(isolate, result);
  if (*utf8) std::cout << *utf8 << std::endl;
  return 0;
}

int main(int argc, char* argv[]) {
  if (argc < 2) {
    std::cerr << "Usage: host <script.js> [--create-snapshot]\n";
    return 1;
  }

  const bool create_snapshot = (argc >= 3 && std::strcmp(argv[2], "--create-snapshot") == 0);
  std::string script_path = argv[1];
  std::string source = ReadFile(script_path.c_str());
  if (source.empty()) return 1;

  V8::InitializeICUDefaultLocation(argv[0]);
  V8::InitializeExternalStartupData(argv[0]);
  std::unique_ptr<Platform> platform = platform::NewDefaultPlatform();
  V8::InitializePlatform(platform.get());
  V8::Initialize();

  Isolate::CreateParams create_params;
  create_params.array_buffer_allocator = ArrayBuffer::Allocator::NewDefaultAllocator();
  Isolate* isolate = Isolate::New(create_params);

  {
    Isolate::Scope isolate_scope(isolate);
    HandleScope handle_scope(isolate);

    Local<ObjectTemplate> global = ObjectTemplate::New(isolate);
    global->Set(String::NewFromUtf8Literal(isolate, "log"),
                FunctionTemplate::New(isolate, LogCallback));

    Local<Context> context = Context::New(isolate, nullptr, global);
    Context::Scope context_scope(context);

    if (create_snapshot) {
      CreateSnapshot(isolate, context, source);
    } else {
      return RunScript(isolate, context, source);
    }
  }

  isolate->Dispose();
  V8::Dispose();
  V8::ShutdownPlatform();
  delete create_params.array_buffer_allocator;
  return 0;
}
