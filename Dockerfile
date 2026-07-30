FROM node:22.18.0-alpine3.22

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY auth ./auth
COPY public ./public
COPY scripts ./scripts

RUN mkdir -p /var/lib/sirk-central \
    && chown -R node:node /app /var/lib/sirk-central \
    && chmod -R u=rwX,g=rX,o=rX /app \
    && chmod 0700 /var/lib/sirk-central

USER node
ENV NODE_ENV=production
EXPOSE 8080 8081
CMD ["node", "-r", "./src/workspace-bootstrap.js", "src/server.js"]
