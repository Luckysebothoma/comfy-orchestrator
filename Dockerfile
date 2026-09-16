FROM node:20-alpine
WORKDIR /app
COPY package.json .
RUN npm install --omit=dev
COPY lib ./lib
COPY index.js worker.js ./
EXPOSE 3000
CMD ["node", "index.js"]
