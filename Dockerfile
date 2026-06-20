FROM node:20-alpine

RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    cairo-dev \
    pango-dev \
    jpeg-dev \
    giflib-dev

WORKDIR /app

COPY package*.json ./

RUN npm install --omit=optional

COPY . .

EXPOSE 3000

CMD ["node", "index.js"]
