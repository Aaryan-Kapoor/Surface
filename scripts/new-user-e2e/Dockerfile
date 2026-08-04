# The machine a brand-new Surface user actually has: stock Ubuntu with real
# systemd + logind, a normal (non-root) user, and NO compiler toolchain — so
# a native dependency without a prebuilt binary fails here exactly like it
# does on a fresh laptop. Node is staged as a tarball for the user to unpack
# into their own home dir (the nvm-style layout almost every real user has).
FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    systemd dbus-user-session ca-certificates curl xz-utils \
  && rm -rf /var/lib/apt/lists/*
RUN arch="$(dpkg --print-architecture)" \
  && case "$arch" in amd64) narch=x64 ;; arm64) narch=arm64 ;; *) echo "unsupported arch $arch" >&2; exit 1 ;; esac \
  && name="$(curl -fsSL https://nodejs.org/dist/latest-v24.x/ | grep -o "node-v[0-9.]*-linux-$narch\.tar\.xz" | head -1)" \
  && curl -fsSL "https://nodejs.org/dist/latest-v24.x/$name" -o /opt/node.tar.xz
RUN useradd -m -s /bin/bash newbie
CMD ["/sbin/init"]
