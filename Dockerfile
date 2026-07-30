# Node 22, not 20. better-sqlite3 12.x ships no prebuilt binary for the Node 20 ABI
# (v115), so npm ci falls back to node-gyp and fails for want of a compiler. Node 22 is
# ABI v127, which has a linuxmusl prebuild for both arm64 and x64.
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY index.js shim.cjs ./
EXPOSE 3100
CMD ["node", "--require", "./shim.cjs", "index.js"]
