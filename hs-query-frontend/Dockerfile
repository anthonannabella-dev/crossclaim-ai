FROM node:20-alpine AS builder
WORKDIR /app
COPY hs-query-frontend/package.json hs-query-frontend/package-lock.json ./
RUN npm ci --production=false
COPY hs-query-frontend/ .
ARG NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}
RUN npm run build

FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
COPY --from=builder /app/public ./public
EXPOSE 3001
CMD ./node_modules/.bin/next start -p 3001
