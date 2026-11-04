FROM debian:bookworm-slim
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       asterisk asterisk-modules asterisk-config asterisk-core-sounds-en-wav \
       asterisk-moh-opsound-wav openssh-server supervisor python3 ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --no-create-home --shell /usr/sbin/nologin ccrec \
    && mkdir -p /run/asterisk /run/sshd /run/callcenter-keys /run/callcenter-ssh \
       /srv/sftp/monitor /var/spool/asterisk/monitor /opt/callcenter-templates
COPY asterisk/conf/ /opt/callcenter-templates/asterisk/
COPY nginx/turnserver.conf.tmpl /opt/callcenter-templates/turnserver.conf.tmpl
COPY asterisk/sounds/fa/custom/ /usr/share/asterisk/sounds/fa/custom/
COPY docker/render-config.py /usr/local/bin/render-config.py
COPY docker/pbx-entrypoint.sh /usr/local/bin/pbx-entrypoint.sh
COPY docker/pbx-healthcheck.sh /usr/local/bin/pbx-healthcheck.sh
COPY docker/supervisord.conf /etc/supervisor/conf.d/callcenter.conf
COPY docker/sshd_config /opt/callcenter-templates/cc_sshd_config
RUN chmod 755 /usr/local/bin/render-config.py /usr/local/bin/pbx-entrypoint.sh \
       /usr/local/bin/pbx-healthcheck.sh
EXPOSE 8088 5038 2222 10000-10199/udp
ENTRYPOINT ["pbx-entrypoint.sh"]
CMD ["/usr/bin/supervisord", "-c", "/etc/supervisor/conf.d/callcenter.conf"]
