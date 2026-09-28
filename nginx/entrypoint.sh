#!/bin/sh

# Generate self-signed cert if not exist
CERT_DIR=/etc/nginx/certs
CERT_KEY=$CERT_DIR/server.key
CERT_CRT=$CERT_DIR/server.crt

if [ ! -f "$CERT_KEY" ] || [ ! -f "$CERT_CRT" ]; then
    mkdir -p $CERT_DIR
    CN="${PUBLIC_HOST:-localhost}"
    openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
        -keyout "$CERT_KEY" \
        -out "$CERT_CRT" \
        -subj "/C=CN/ST=Beijing/L=Beijing/O=customs-saas/CN=$CN"
fi

exec nginx -g "daemon off;"
