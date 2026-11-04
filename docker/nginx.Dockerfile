FROM nginx:1.28-alpine
RUN apk add --no-cache python3
COPY nginx/call-firuzo.conf.tmpl /opt/callcenter-templates/nginx.conf.tmpl
COPY docker/render-config.py /usr/local/bin/render-config.py
COPY docker/nginx-entrypoint.sh /usr/local/bin/callcenter-nginx-entrypoint.sh
RUN chmod 755 /usr/local/bin/render-config.py /usr/local/bin/callcenter-nginx-entrypoint.sh \
    && mkdir -p /etc/nginx/tls
EXPOSE 80 443
ENTRYPOINT ["callcenter-nginx-entrypoint.sh"]
CMD ["nginx", "-g", "daemon off;"]
