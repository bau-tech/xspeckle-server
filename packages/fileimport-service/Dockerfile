ARG NODE_ENV=production

FROM mcr.microsoft.com/dotnet/sdk:8.0-noble@sha256:59d7b5f3bff2318735c6f2dd95bb6a05908665f72dd25bfaf934ba78b3c4eae9 AS dotnet-build-stage
WORKDIR /app
COPY packages/fileimport-service/src/ifc-dotnet .
RUN dotnet publish ifc-converter.csproj -c Release -o output/

# Builds the `rvt` Python wheel (github.com/DrunkOnJava/rvt-rs, Apache-2.0,
# clean-room Revit reader, no Autodesk software involved) used by
# src/rvt/import_file.py. Built from a pinned upstream commit rather than
# installed from PyPI: our patches below (Revit 2025 beam axes, saved
# display meshes from Python) are not in a release, and upstream main moves
# well ahead of its releases. Only the wheel reaches the runtime image. Same
# OS as the runtime stage.
FROM ubuntu:24.04 AS rvt-build-stage
WORKDIR /build

# hadolint ignore=DL3008
RUN apt-get update -y \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y \
     --no-install-recommends \
     ca-certificates \
     curl \
     git \
     gcc \
     libc6-dev \
     python3 \
     python3-pip \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

ARG RUST_TOOLCHAIN=1.98.1
ARG MATURIN_VERSION=1.15.0
ENV PATH=/root/.cargo/bin:${PATH}
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
      | sh -s -- -y --profile minimal --default-toolchain ${RUST_TOOLCHAIN} \
    && pip install --break-system-packages --no-cache-dir maturin==${MATURIN_VERSION}

# rvt-rs main as of 2026-10-21 (after v0.6.1, the latest release: gable, hip
# and slope-arrow roofs as their planes and Revit 2025 roof slopes, MEP
# ports placed at their connector ends, masses written as their Export to
# IFC As entity, experimental releases flagged in the diagnostics). Was
# 6209fbf4d2 (2026-10-20).
ARG RVT_RS_GIT_URL=https://github.com/DrunkOnJava/rvt-rs.git
ARG RVT_RS_REVISION=b6086d41b9758fd9b92f42f0a47b8345b9c58056
RUN git clone --filter=blob:none ${RVT_RS_GIT_URL} . \
    && git checkout ${RVT_RS_REVISION}
# Our own small patches on top of that commit (see each patch for why);
# `git apply` fails the build if one no longer applies after a bump.
COPY packages/fileimport-service/src/rvt/rvt-rs-patches /rvt-rs-patches
RUN git apply --verbose /rvt-rs-patches/*.patch
# The build is memory hungry and small hosts running this can be tight on RAM
ARG CARGO_BUILD_JOBS=2
RUN CARGO_BUILD_JOBS=${CARGO_BUILD_JOBS} maturin build --release --out /wheels

FROM mcr.microsoft.com/dotnet/runtime:8.0-noble AS runtime
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

WORKDIR /speckle-server

# configure tini
ARG TINI_VERSION=v0.19.0

# hadolint ignore=DL3008
RUN apt-get update -y \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y \
     --no-install-recommends \
     ca-certificates \
     curl \
     gosu \
    && curl -fsSL https://github.com/krallin/tini/releases/download/${TINI_VERSION}/tini -o /usr/bin/tini \
    && chmod +x /usr/bin/tini \
    && curl -fsSL https://deb.nodesource.com/setup_22.x -o nodesource_setup.sh \
    && gosu root:root bash nodesource_setup.sh \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y \
     --no-install-recommends \
     nodejs \
    && npm install -g corepack@0.30.0 \
    && corepack enable \
    && DEBIAN_FRONTEND=noninteractive apt-get remove curl -y \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# download yarn dependencies for building shared libraries
COPY .yarnrc.yml .
COPY .yarn ./.yarn
COPY package.json yarn.lock ./

COPY packages/frontend-2/type-augmentations/stubs packages/frontend-2/type-augmentations/stubs/
COPY packages/shared/package.json packages/shared/
COPY packages/fileimport-service/package.json packages/fileimport-service/

RUN PUPPETEER_SKIP_DOWNLOAD=true PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 yarn workspaces focus --all

# build shared libraries
COPY packages/shared packages/shared/
COPY packages/fileimport-service packages/fileimport-service/
RUN yarn workspaces foreach -Wt run build

# Install python virtual env and python dependencies
RUN apt-get update -y \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y \
     --no-install-recommends \
     python3.12 \
     python3-pip \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

COPY packages/fileimport-service/requirements.txt /speckle-server/
RUN pip install --break-system-packages --disable-pip-version-check --no-cache-dir --requirement /speckle-server/requirements.txt

# rvt, built from source in rvt-build-stage above
COPY --from=rvt-build-stage /wheels /tmp/rvt-wheels
RUN pip install --break-system-packages --disable-pip-version-check --no-cache-dir /tmp/rvt-wheels/*.whl \
    && rm -rf /tmp/rvt-wheels

# Consume the ARG from the global scope
ARG NODE_ENV
ENV NODE_ENV=${NODE_ENV}
ARG NODE_BINARY_PATH=/usr/bin/node
ENV NODE_BINARY_PATH=${NODE_BINARY_PATH}
ARG PYTHON_BINARY_PATH=/usr/bin/python3
ENV PYTHON_BINARY_PATH=${PYTHON_BINARY_PATH}
ARG DOTNET_BINARY_PATH=/usr/bin/dotnet
ENV DOTNET_BINARY_PATH=${DOTNET_BINARY_PATH}

COPY --link --from=dotnet-build-stage /app/output packages/fileimport-service/src/ifc-dotnet
ENV IFC_DOTNET_DLL_PATH='/speckle-server/packages/fileimport-service/src/ifc-dotnet/ifc-converter.dll'

WORKDIR /speckle-server/packages/fileimport-service

ENTRYPOINT [ "tini", "--", "node", "--loader=./dist/src/aliasLoader.js", "bin/www.js"]
