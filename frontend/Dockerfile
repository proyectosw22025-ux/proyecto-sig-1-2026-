# Etapa 1: build de producción con Vite
FROM node:22-alpine AS build
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# Etapa 2: servir los archivos estáticos ya compilados con Nginx
FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
# Reverse proxy: sirve el frontend y reenvía /graphql/ al backend
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
