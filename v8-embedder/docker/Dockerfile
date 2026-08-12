FROM ubuntu:22.04

RUN apt-get update && apt-get install -y --no-install-recommends \
    git python3 g++ ninja-build cmake pkg-config \
    && rm -rf /var/lib/apt/lists/*

ENV DEPOT_TOOLS=/opt/depot_tools
RUN git clone https://chromium.googlesource.com/chromium/tools/depot_tools.git $DEPOT_TOOLS
ENV PATH=$DEPOT_TOOLS:$PATH

WORKDIR /v8
RUN fetch v8 && cd v8 && gclient sync && tools/dev/v8gen.py x64.release && ninja -C out.gn/x64.release v8_monolith

WORKDIR /project
COPY . .
RUN apt-get update && apt-get install -y --no-install-recommends \
    nodejs npm \
    && rm -rf /var/lib/apt/lists/*

RUN cd ts-runner && npm ci

WORKDIR /project/host
RUN mkdir -p build && cd build && \
    cmake .. -DCMAKE_BUILD_TYPE=Release -DV8_DIR=/v8/v8 && \
    cmake --build . --target host

ENTRYPOINT ["/project/host/build/host"]
