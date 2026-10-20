# syntax=docker/dockerfile:1

FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:24-alpine AS test
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm test

# Bake the imported Onvif/OASIS/W3C schemas into the image, so the container
# starts without internet access (see scripts/vendor-schemas.js).
FROM node:24-alpine AS schemas
WORKDIR /app
COPY scripts ./scripts
RUN node scripts/vendor-schemas.js /app/wsdl/vendor

FROM node:24-alpine AS runtime
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json main.js ./
COPY src ./src
COPY wsdl ./wsdl
COPY --from=schemas /app/wsdl/vendor ./wsdl/vendor
COPY resources ./resources

ENV NODE_ENV=production

# WS-Discovery (udp/3702) plus each camera's own server/rtsp/snapshot ports,
# which are chosen in the config. Host or macvlan networking is expected.
EXPOSE 3702/udp

USER node

ENTRYPOINT ["node", "main.js"]
CMD ["/onvif.yaml"]
