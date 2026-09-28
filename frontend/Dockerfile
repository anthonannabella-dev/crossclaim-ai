FROM node:20-alpine AS builder
WORKDIR /app
COPY frontend/package.json ./
RUN npm install --no-package-lock --force
COPY frontend/ .
RUN npm run build

FROM nginx:alpine
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/dist /usr/share/nginx/html
