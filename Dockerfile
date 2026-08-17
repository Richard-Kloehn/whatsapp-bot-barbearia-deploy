FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY dist ./dist
EXPOSE 3002
CMD ["node", "dist/index.js"]
