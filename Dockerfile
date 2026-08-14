FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json .
RUN npm ci --omit=dev
COPY server.js .
USER node
EXPOSE 7100
CMD ["node", "server.js"]
