FROM rust:bookworm as builder

# Create a build directory and copy over all of the files
WORKDIR /build
COPY . ./

RUN --mount=type=cache,target=/usr/local/cargo/registry \
	--mount=type=cache,target=/build/target \
	cargo build --release && cp /build/target/release/moq-* /usr/local/cargo/bin

FROM rust:bookworm as cargo-watch-builder

# Build cargo-watch
RUN git clone https://github.com/watchexec/cargo-watch.git && \
	cd cargo-watch && \
	cargo build --release && \
	cp target/release/cargo-watch /usr/local/cargo/bin

# moq-rs image with just the binaries
FROM rust:bookworm

RUN apt-get update && \
	apt-get install -y --no-install-recommends ca-certificates curl libssl3 && \
	rm -rf /var/lib/apt/lists/*

COPY --from=builder /usr/local/cargo/bin/moq-* /usr/local/bin

# Install cargo-watch
COPY --from=cargo-watch-builder /usr/local/cargo/bin/cargo-watch /usr/local/bin

# Copy the entrypoint script
COPY entrypoint.sh /entrypoint.sh

ENTRYPOINT [ "/entrypoint.sh" ]
