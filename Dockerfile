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
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/readyz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "src/server-v2.js"]
