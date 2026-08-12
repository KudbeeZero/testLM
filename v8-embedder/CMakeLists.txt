cmake_minimum_required(VERSION 3.16)
project(v8-host LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

find_package(Threads REQUIRED)

add_executable(host
  src/main.cpp
)

target_include_directories(host PRIVATE
  ${V8_INCLUDE_DIR}
  ${V8_INCLUDE_DIR}/libplatform
)

target_link_directories(host PRIVATE
  ${V8_LIB_DIR}
)

target_link_libraries(host PRIVATE
  v8_monolith
  Threads::Threads
)
