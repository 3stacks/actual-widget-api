FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY index.js shim.cjs ./
EXPOSE 3100
CMD ["node", "--require", "./shim.cjs", "index.js"]
