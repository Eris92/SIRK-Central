FROM node:22-alpine

RUN apk add --no-cache bash git docker-cli docker-cli-compose curl python3 tar
WORKDIR /opt/sirk-central
COPY updater/server.js /app/server.js
COPY updater/gateway-server.js /app/gateway-server.js
COPY updater/management-server.js /app/management-server.js
COPY updater/backup-archive.js /app/backup-archive.js
COPY updater/restore-transaction.js /app/restore-transaction.js
USER root
EXPOSE 8090 8091 8092
CMD ["node", "/app/server.js"]
