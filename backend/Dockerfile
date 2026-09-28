FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json ./
RUN npm config set registry https://registry.npmmirror.com && npm install --production=false
COPY . .
RUN npx prisma generate
RUN npm run build

FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/package.json ./
COPY data/hs_codes.json ./data/hs_codes.json
COPY data/customsCodes.generated.json ./data/customsCodes.generated.json
COPY data/declElements.generated.json ./data/declElements.generated.json
RUN apk add --no-cache curl openssl postgresql16-client gzip
EXPOSE 3000
