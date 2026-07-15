FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
# schema.sql is read at runtime by the migrate step.
COPY src/db/schema.sql ./dist/db/schema.sql
# Default to the API; override with `start:worker` to run the indexer.
CMD ["node", "dist/index.js"]
