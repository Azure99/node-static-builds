ARG ALPINE
FROM scratch AS sources
ARG NODE_URL
ARG NODE_SHA256
ARG MUSL_URL
ARG MUSL_SHA256
ADD --checksum=sha256:${NODE_SHA256} ${NODE_URL} /node.tar.xz
ADD --checksum=sha256:${MUSL_SHA256} ${MUSL_URL} /musl-COPYRIGHT

FROM ${ALPINE} AS toolchain
ENV TMPDIR=/var/tmp
COPY packages.txt /var/tmp/packages.txt
RUN xargs apk add --no-cache < /var/tmp/packages.txt \
    && apk info -vv | sort > /var/tmp/build-packages.txt
WORKDIR /var/tmp/build

FROM toolchain AS runtime
ARG NODE_ARCH
COPY --from=sources /node.tar.xz ./node.tar.xz
COPY scripts/build-node.sh ./build-node.sh
RUN sh build-node.sh "$NODE_ARCH"
COPY --from=sources /musl-COPYRIGHT /output/runtime/licenses/musl-COPYRIGHT
COPY --from=toolchain /var/tmp/build-packages.txt /output/runtime/build-packages.txt

FROM scratch
COPY --from=runtime /output/ /
