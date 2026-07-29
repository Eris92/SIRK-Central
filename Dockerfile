FROM node:22.18.0-alpine3.22
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY public ./public
COPY scripts ./scripts
RUN mkdir -p /var/lib/sirk-central && chown -R node:node /var/lib/sirk-central
USER node
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "src/server.js"]
