FROM node:22-alpine

RUN apk add --no-cache bash git docker-cli docker-cli-compose curl python3
WORKDIR /opt/sirk-central
COPY updater/server.js /app/server.js
COPY updater/management-server.js /app/management-server.js
USER root
EXPOSE 8090 8091
CMD ["node", "/app/server.js"]
