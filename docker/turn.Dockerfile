FROM debian:bookworm-slim
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
    && apt-get install -y --no-install-recommends coturn python3 ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY nginx/turnserver.conf.tmpl /opt/callcenter-templates/turnserver.conf.tmpl
COPY docker/render-config.py /usr/local/bin/render-config.py
COPY docker/turn-entrypoint.sh /usr/local/bin/turn-entrypoint.sh
RUN chmod 755 /usr/local/bin/render-config.py /usr/local/bin/turn-entrypoint.sh
EXPOSE 3478/tcp 3478/udp 49160-49200/udp
ENTRYPOINT ["turn-entrypoint.sh"]
CMD ["turnserver", "-c", "/etc/coturn/turnserver.conf", "--proc-user=turnserver", "--proc-group=turnserver"]
